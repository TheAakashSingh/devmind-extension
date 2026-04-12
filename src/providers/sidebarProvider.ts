import * as fs     from 'fs';
import * as path   from 'path';
import * as vscode from 'vscode';
import { DeepSeekClient }            from '../utils/deepseekClient';
import { UsageTracker }              from '../utils/usageTracker';
import { collectProjectContext, collectFileContext, buildContextPrompt, optimizePrompt } from '../utils/contextCollector';

interface Attachment { type: 'file'; name: string; content: string; }
interface ChatMsg    { role: 'user' | 'assistant'; content: string; }

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?:     vscode.WebviewView;
  private history:   ChatMsg[] = [];
  private streaming = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client:       DeepSeekClient,
    private readonly usage:        UsageTracker,
    private readonly dashboardUrl: string
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts:      true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'chat':           await this.handleChat(msg.text, msg.attachments || []); break;
        case 'slash':          await this.handleSlash(msg.command, msg.args || '');    break;
        case 'clear':          this.clearChat();                                       break;
        case 'insertCode':     this.insertCode(msg.code);                              break;
        case 'getUsage':       this.sendUsage();                                       break;
        case 'openOnboarding': vscode.commands.executeCommand('devmind.openOnboarding'); break;
        case 'openDashboard':  vscode.env.openExternal(vscode.Uri.parse(this.dashboardUrl)); break;
        case 'setKey':         vscode.commands.executeCommand('devmind.setKey');       break;
        case 'stopGeneration': this.streaming = false;                                 break;
        case 'scaffold':       vscode.commands.executeCommand('devmind.scaffold');     break;
      }
    });

    this.usage.onChange(() => this.sendUsage());
  }

  refresh() {
    if (!this.view) { return; }
    this.view.webview.html = this.buildHtml(this.view.webview);
    this.sendUsage();
  }

  // ── Slash command router ──────────────────────────────────────────────────
  private async handleSlash(command: string, args: string) {
    const cmds: Record<string, string> = {
      explain:     'devmind.explain',
      explainfile: 'devmind.explainFile',
      fix:         'devmind.fix',
      refactor:    'devmind.refactor',
      test:        'devmind.generateTests',
      tests:       'devmind.generateTests',
      scaffold:    'devmind.scaffold',
      auth:        'devmind.createAuth',
      crud:        'devmind.createCrud',
      api:         'devmind.createApi',
      schema:      'devmind.createSchema',
      clear:       '',
    };

    if (command === 'clear') { this.clearChat(); return; }

    if (command === 'generate' && args) {
      await this.handleChat(`Generate: ${args}`, []);
      return;
    }

    const vsCmd = cmds[command];
    if (vsCmd) {
      this.post({ type: 'info', text: `Running: /${command}…` });
      await vscode.commands.executeCommand(vsCmd);
    } else {
      // Unknown slash — treat as chat
      await this.handleChat(`/${command} ${args}`.trim(), []);
    }
  }

  // ── Main chat handler ──────────────────────────────────────────────────────
  private async handleChat(text: string, attachments: Attachment[]) {
    const apiKey = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!apiKey) {
      this.post({ type: 'error', text: 'Connect your account first — click the account icon above or run DevMind: Set API Key.' });
      return;
    }
    if (!this.usage.canComplete()) {
      this.post({ type: 'error', text: `Daily quota reached (${this.usage.getPlan()} plan). Upgrade at the DevMind dashboard.` });
      return;
    }

    this.streaming = true;

    // Build project + file context
    const proj      = collectProjectContext();
    const file      = collectFileContext();
    const ctxPrompt = buildContextPrompt(proj, file);
    const optimized = optimizePrompt(text, proj);

    // File attachment context
    const fileCtx = attachments
      .filter(a => a.content)
      .map(a => `\n\n[Attached: ${a.name}]\n\`\`\`\n${a.content}\n\`\`\``)
      .join('');

    const fullText = optimized + fileCtx;

    // Inject context as system context on first message
    if (this.history.length === 0) {
      this.history.push({ role: 'user', content: `[CONTEXT]\n${ctxPrompt}\n\n[QUESTION]\n${fullText}` });
    } else {
      this.history.push({ role: 'user', content: fullText });
    }

    this.post({ type: 'thinking', show: true });

    let reply = '';
    try {
      reply = await this.client.chat(
        this.history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        file?.language || proj.language || 'typescript',
        (token: string) => {
          if (this.streaming) { this.post({ type: 'token', text: token }); }
        }
      );
    } catch (err: any) {
      this.post({ type: 'thinking', show: false });
      this.post({ type: 'error', text: err.message || 'Request failed. Check your server connection and API key.' });
      this.history.pop();
      this.streaming = false;
      return;
    }

    this.streaming = false;
    this.history.push({ role: 'assistant', content: reply });
    this.post({ type: 'done', text: reply });
    this.usage.record();
    this.sendUsage();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private clearChat() {
    this.history   = [];
    this.streaming = false;
    this.post({ type: 'cleared' });
  }

  private insertCode(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { vscode.window.showWarningMessage('DevMind: Open a file to insert code into.'); return; }
    const clean = code.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '').trim();
    editor.edit(b => b.insert(editor.selection.active, clean));
    vscode.window.showInformationMessage('DevMind: Code inserted.');
  }

  private sendUsage() {
    const apiKey = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    let proj;
    try { proj = collectProjectContext(); } catch { proj = { framework:'', language:'typescript', database:'none', authSystem:'none' } as any; }
    this.post({
      type:       'usage',
      remaining:  this.usage.getRemaining(),
      plan:       this.usage.getPlan(),
      hasApiKey:  Boolean(apiKey),
      language:   proj.language,
      framework:  proj.framework,
      database:   proj.database,
      authSystem: proj.authSystem,
    });
  }

  private post(msg: object) { this.view?.webview.postMessage(msg); }

  // ── Build HTML ─────────────────────────────────────────────────────────────
  private buildHtml(webview: vscode.Webview): string {
    const logoUri   = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.png')).toString();
    const apiKey    = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    const cspSource = webview.cspSource;

    const candidates = [
      path.join(this.extensionUri.fsPath, 'src',  'webview', 'chat.html'),
      path.join(this.extensionUri.fsPath, 'dist', 'webview', 'chat.html'),
    ];
    let html = '';
    for (const p of candidates) {
      if (fs.existsSync(p)) { html = fs.readFileSync(p, 'utf8'); break; }
    }
    if (!html) {
      return `<html><body style="color:#e2e8f0;font-family:sans-serif;padding:20px">
        <h3>DevMind failed to load</h3>
        <p>Run <code>npm run build</code> in the extension folder and reload VS Code.</p>
      </body></html>`;
    }

    return html
      .replace(/__HAS_API_KEY__/g, Boolean(apiKey) ? 'true' : 'false')
      .replace(/__CSP_SOURCE__/g,  cspSource)
      .replace(/__LOGO_URI__/g,    logoUri);
  }
}
