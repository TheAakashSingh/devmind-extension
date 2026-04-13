import * as fs     from 'fs';
import * as path   from 'path';
import * as vscode from 'vscode';
import { DeepSeekClient }            from '../utils/deepseekClient';
import { UsageTracker }              from '../utils/usageTracker';
import { getIndexer }                from '../utils/codebaseIndexer';
import { getDiffProvider }           from './diffProvider';
import {
  collectProjectContext,
  collectFileContext,
  buildContextPrompt,
  optimizePrompt,
  buildCodebaseSummary,
} from '../utils/contextCollector';

interface Attachment { type: 'file'; name: string; content: string; language?: string; }
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
        case 'chat':            await this.handleChat(msg.text, msg.attachments || [], msg.mentionedFiles || []); break;
        case 'slash':           await this.handleSlash(msg.command, msg.args || ''); break;
        case 'clear':           this.clearChat(); break;
        case 'insertCode':      await this.insertCodeWithDiff(msg.code, msg.description || 'Insert code'); break;
        case 'applyToFile':     await this.applyToFileWithDiff(msg.filePath, msg.content, msg.description); break;
        case 'getUsage':        this.sendUsage(); break;
        case 'getFileTree':     this.sendFileTree(); break;
        case 'searchFiles':     this.sendFileSearch(msg.query || ''); break;
        case 'readFile':        this.sendFileContent(msg.path); break;
        case 'openOnboarding':  vscode.commands.executeCommand('devmind.openOnboarding'); break;
        case 'openDashboard':   vscode.env.openExternal(vscode.Uri.parse(this.dashboardUrl)); break;
        case 'setKey':          vscode.commands.executeCommand('devmind.setKey'); break;
        case 'stopGeneration':  this.streaming = false; break;
        case 'scaffold':        vscode.commands.executeCommand('devmind.scaffold'); break;
        case 'openFile':        this.openFileInEditor(msg.path); break;
      }
    });

    this.usage.onChange(() => this.sendUsage());

    // Send file tree after a short delay so the webview is ready
    setTimeout(() => { this.sendFileTree(); this.sendUsage(); }, 500);
  }

  refresh() {
    if (!this.view) return;
    this.view.webview.html = this.buildHtml(this.view.webview);
    setTimeout(() => { this.sendFileTree(); this.sendUsage(); }, 300);
  }

  // ── File tree ──────────────────────────────────────────────────────────────
  private sendFileTree() {
    const indexer = getIndexer();
    if (!indexer) return;
    const files = indexer.getFiles();
    this.post({
      type:  'fileTree',
      files: files.map(f => ({
        path:     f.path,
        name:     f.name,
        language: f.language,
        size:     f.size,
      })),
      rootPath: indexer.getRootPath(),
      summary:  indexer.getTreeSummary(40),
    });
  }

  // ── File search (for @ mention autocomplete) ──────────────────────────────
  private sendFileSearch(query: string) {
    const indexer = getIndexer();
    if (!indexer) { this.post({ type: 'fileSearchResults', results: [] }); return; }
    const results = indexer.searchFiles(query, 15).map(f => ({
      path:     f.path,
      name:     f.name,
      language: f.language,
    }));
    this.post({ type: 'fileSearchResults', results });
  }

  // ── Read file content and send to webview ─────────────────────────────────
  private sendFileContent(relPath: string) {
    const indexer = getIndexer();
    if (!indexer) return;
    const file = indexer.readFile(relPath);
    if (file) {
      this.post({ type: 'fileContent', path: relPath, name: file.name, content: file.content, language: file.language });
    }
  }

  // ── Open file in editor ───────────────────────────────────────────────────
  private async openFileInEditor(relPath: string) {
    const indexer = getIndexer();
    if (!indexer) return;
    const root    = indexer.getRootPath();
    const absPath = path.join(root, relPath);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absPath));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch {}
  }

  // ── Insert with diff (accept/reject) ─────────────────────────────────────
  private async insertCodeWithDiff(code: string, description: string) {
    const diffProvider = getDiffProvider();
    await diffProvider.insertWithDiff(code, description);
  }

  // ── Apply full file content with diff ─────────────────────────────────────
  private async applyToFileWithDiff(filePath: string, content: string, description: string) {
    const diffProvider = getDiffProvider();
    await diffProvider.applyToFileWithDiff(filePath, content, description);
  }

  // ── Slash command router ──────────────────────────────────────────────────
  private async handleSlash(command: string, args: string) {
    const map: Record<string, string> = {
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
      admin:       'devmind.createAdmin',
      server:      'devmind.createServer',
      clear:       '',
    };

    if (command === 'clear') { this.clearChat(); return; }
    if (command === 'tree')  { this.sendFileTree(); this.post({ type: 'info', text: 'File tree refreshed.' }); return; }
    if (command === 'index') {
      const indexer = getIndexer();
      if (indexer) {
        await indexer.rebuild();
        this.sendFileTree();
        this.post({ type: 'info', text: 'Codebase re-indexed.' });
      }
      return;
    }

    if (command === 'generate' && args) {
      await this.handleChat(`Generate: ${args}`, [], []);
      return;
    }

    const vsCmd = map[command];
    if (vsCmd) {
      this.post({ type: 'info', text: `Running /${command}…` });
      await vscode.commands.executeCommand(vsCmd);
    } else {
      await this.handleChat(`/${command} ${args}`.trim(), [], []);
    }
  }

  // ── Main chat handler ──────────────────────────────────────────────────────
  private async handleChat(
    text:           string,
    attachments:    Attachment[],
    mentionedFiles: Array<{ path: string }>
  ) {
    const apiKey = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!apiKey) {
      this.post({ type: 'error', text: 'Connect your account — click the account icon or run DevMind: Set API Key.' });
      return;
    }
    if (!this.usage.canComplete()) {
      this.post({ type: 'error', text: `Quota reached (${this.usage.getPlan()}). Upgrade at the DevMind dashboard.` });
      return;
    }

    this.streaming = true;

    const proj   = collectProjectContext();
    const file   = collectFileContext();
    const indexer = getIndexer();

    // Resolve @ mentioned files
    const resolvedMentions: Array<{ name: string; content: string }> = [];
    if (mentionedFiles.length && indexer) {
      for (const m of mentionedFiles.slice(0, 5)) {
        const rf = indexer.readFile(m.path);
        if (rf) resolvedMentions.push({ name: m.path, content: rf.content });
      }
    }

    // Attachment context
    const attContext = attachments
      .filter(a => a.content)
      .map(a => `\n\n[Attached: ${a.name}]\n\`\`\`${a.language || ''}\n${a.content}\n\`\`\``)
      .join('');

    const ctxPrompt = buildContextPrompt(proj, file, resolvedMentions);
    const optimized = optimizePrompt(text, proj);
    const fullText  = optimized + attContext;

    // Add codebase structure to first message if workspace is indexed
    let systemExtra = '';
    if (this.history.length === 0 && indexer && indexer.getFiles().length > 0) {
      systemExtra = '\n\n' + buildCodebaseSummary(indexer.getFiles().slice(0, 200), indexer.getRootPath());
    }

    if (this.history.length === 0) {
      this.history.push({ role: 'user', content: `[CONTEXT]\n${ctxPrompt}${systemExtra}\n\n[QUESTION]\n${fullText}` });
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
          if (this.streaming) this.post({ type: 'token', text: token });
        }
      );
    } catch (err: any) {
      this.post({ type: 'thinking', show: false });
      this.post({ type: 'error', text: err.message || 'Request failed. Check connection and API key.' });
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

  private sendUsage() {
    const apiKey = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    let proj;
    try { proj = collectProjectContext(); } catch { proj = { framework: '', language: 'typescript', database: 'none', authSystem: 'none' } as any; }
    const indexer = getIndexer();
    this.post({
      type:        'usage',
      remaining:   this.usage.getRemaining(),
      plan:        this.usage.getPlan(),
      hasApiKey:   Boolean(apiKey),
      language:    proj.language,
      framework:   proj.framework,
      database:    proj.database,
      authSystem:  proj.authSystem,
      fileCount:   indexer?.getFiles().length || 0,
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
        <h3>DevMind chat failed to load</h3>
        <p>Run <code>npm run build</code> in the extension folder and reload VS Code.</p>
      </body></html>`;
    }
    return html
      .replace(/__HAS_API_KEY__/g, Boolean(apiKey) ? 'true' : 'false')
      .replace(/__CSP_SOURCE__/g,  cspSource)
      .replace(/__LOGO_URI__/g,    logoUri);
  }
}
