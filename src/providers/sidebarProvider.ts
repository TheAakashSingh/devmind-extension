import * as fs   from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DeepSeekClient } from '../utils/deepseekClient';
import { UsageTracker }   from '../utils/usageTracker';

interface Attachment {
  type: 'file' | 'image';
  name: string;
  content?: string;
  path?: string;
  dataUrl?: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: Attachment[];
  timestamp?: number;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private isStreaming = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: DeepSeekClient,
    private readonly usage: UsageTracker,
    private readonly dashboardUrl: string
  ) {}

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    this.render();

    view.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'chat':          await this.handleChat(message.text, message.attachments || []); break;
        case 'clear':         this.clearChat(); break;
        case 'insertCode':    this.insertIntoEditor(message.code); break;
        case 'applyCode':     await this.applyCodeToFile(message.code, message.filePath, message.mode || 'insert'); break;
        case 'replaceCode':   await this.replaceCodeInFile(message.code, message.filePath, message.oldCode); break;
        case 'getUsage':      this.sendUsage(); break;
        case 'getFiles':      await this.sendOpenFiles(); break;
        case 'searchFiles':   await this.searchFilesHandler(message.query); break;
        case 'readFile':      await this.readFileHandler(message.path); break;
        case 'openDashboard': await vscode.env.openExternal(vscode.Uri.parse(this.dashboardUrl)); break;
        case 'openOnboarding':await vscode.commands.executeCommand('devmind.openOnboarding'); break;
        case 'setKey':        await vscode.commands.executeCommand('devmind.setKey'); break;
        case 'stopGeneration':this.isStreaming = false; break;
      }
    });

    this.usage.onChange(() => this.sendUsage());
  }

  refresh() {
    if (!this.view) { return; }
    this.render();
  }

  private render() {
    if (!this.view) { return; }
    this.view.webview.html = this.getHtml();
    this.sendUsage();
  }

  private hasApiKey(): boolean {
    return Boolean(vscode.workspace.getConfiguration('devmind').get<string>('apiKey', ''));
  }

  // ── File context helpers ──

  private parseMentions(text: string): { cleanText: string; mentions: string[] } {
    const mentions: string[] = [];
    const cleanText = text.replace(/@([^\s]+)/g, (_, name) => {
      mentions.push(name);
      return '';
    });
    return { cleanText: cleanText.trim(), mentions };
  }

  private async getActiveFileContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return ''; }

    const doc          = editor.document;
    const fileName     = path.basename(doc.fileName);
    const language     = doc.languageId;
    const content      = doc.getText();
    const selection    = editor.selection;
    const selectedCode = !selection.isEmpty ? doc.getText(selection) : '';
    const cursor       = editor.selection.active;

    let ctx = `\n\n=== ACTIVE FILE: ${fileName} (${language}) ===\n`;
    ctx    += `Cursor: Line ${cursor.line + 1}, Col ${cursor.character + 1}\n`;

    if (selectedCode) {
      ctx += `\n--- Selected (lines ${selection.start.line + 1}–${selection.end.line + 1}) ---\n${selectedCode}\n`;
    }
    ctx += `\n--- File Content ---\n${content}`;
    return ctx;
  }

  private async getProjectContext(): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) { return ''; }

    const root           = workspace.uri.fsPath;
    const packageJsonPath = path.join(root, 'package.json');
    let ctx = '\n\n=== PROJECT CONTEXT ===\n';

    try {
      if (fs.existsSync(packageJsonPath)) {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        ctx += `Project: ${pkg.name || 'Unknown'}\n`;
        ctx += `Scripts: ${Object.keys(pkg.scripts || {}).slice(0, 5).join(', ')}\n`;
      }
    } catch { /* ignore */ }

    const openFiles = vscode.workspace.textDocuments
      .filter(d => !d.isUntitled)
      .slice(0, 5)
      .map(d => path.basename(d.fileName));
    if (openFiles.length) { ctx += `Open files: ${openFiles.join(', ')}\n`; }

    return ctx;
  }

  private buildContextMessage(attachments: Attachment[]): string {
    return attachments
      .filter(a => a.type === 'file' && a.content)
      .map(a => {
        const ext = path.extname(a.name).slice(1) || 'text';
        return `\n\n=== ATTACHED FILE: ${a.name} ===\n\`\`\`${ext}\n${a.content}\n\`\`\``;
      })
      .join('');
  }

  // ── Chat handler ──

  private async handleChat(text: string, attachments: Attachment[]) {
    if (!this.hasApiKey()) {
      this.post({ type: 'error', text: 'Connect your DevMind account first. Open the dashboard, verify your email, and paste your API key.' });
      return;
    }
    if (!this.usage.canComplete()) {
      this.post({ type: 'error', text: 'Daily quota reached. Upgrade your plan in the DevMind dashboard to continue.' });
      return;
    }

    // Filter images — DeepSeek doesn't support them yet
    const fileAtts  = attachments.filter(a => a.type !== 'image');
    const imageAtts = attachments.filter(a => a.type === 'image');
    if (imageAtts.length) {
      this.post({ type: 'warning', text: `${imageAtts.length} image(s) skipped — image support coming soon!` });
    }

    this.isStreaming = true;
    const { cleanText } = this.parseMentions(text);
    const language = vscode.window.activeTextEditor?.document.languageId || 'typescript';

    this.post({ type: 'thinking', show: true });

    const fileCtx    = await this.getActiveFileContext();
    const projectCtx = await this.getProjectContext();
    const attCtx     = this.buildContextMessage(fileAtts);

    const enhancedContent = cleanText + projectCtx + fileCtx + attCtx;

    this.history.push({ role: 'user', content: enhancedContent, attachments: fileAtts, timestamp: Date.now() });

    let reply = '';
    try {
      reply = await this.client.chat(
        this.history.map(h => ({ role: h.role, content: h.content })),
        language,
        (token: string) => {
          if (this.isStreaming) { this.post({ type: 'token', text: token }); }
        }
      );
    } catch (error: any) {
      this.post({ type: 'thinking', show: false });
      this.post({ type: 'error', text: error.message || 'Request failed. Check your connection.' });
      this.history.pop();
      this.isStreaming = false;
      return;
    }

    this.isStreaming = false;
    this.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
    this.post({ type: 'done', text: reply });
    this.usage.record();
    this.sendUsage();
  }

  // ── Code actions ──

  private clearChat() {
    this.history    = [];
    this.isStreaming = false;
    this.post({ type: 'cleared' });
  }

  private insertIntoEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showWarningMessage('Open a file first to insert code.');
      return;
    }
    const extracted = this.extractCodeFromMarkdown(code);
    editor.edit(b => b.insert(editor.selection.active, extracted));
    vscode.window.showInformationMessage('DevMind: Code inserted at cursor.');
  }

  private extractCodeFromMarkdown(code: string): string {
    const block = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (block) { return block[1].trim(); }
    return code.trim();
  }

  private async applyCodeToFile(code: string, filePath?: string, _mode = 'insert') {
    try {
      const extracted = this.extractCodeFromMarkdown(code);
      if (filePath && fs.existsSync(filePath)) {
        const existing = fs.readFileSync(filePath, 'utf8');
        fs.writeFileSync(filePath, existing + '\n\n' + extracted, 'utf8');
        this.post({ type: 'applied', message: `Appended to ${path.basename(filePath)}`, filePath });
        await vscode.window.showTextDocument(vscode.Uri.file(filePath));
      } else {
        this.insertIntoEditor(extracted);
      }
    } catch (e: any) {
      this.post({ type: 'error', text: `Failed to apply code: ${e.message}` });
    }
  }

  private async replaceCodeInFile(code: string, filePath: string, oldCode: string) {
    try {
      if (!fs.existsSync(filePath)) {
        this.post({ type: 'error', text: 'File not found.' });
        return;
      }
      const full     = fs.readFileSync(filePath, 'utf8');
      const replaced = full.replace(oldCode, code);
      fs.writeFileSync(filePath, replaced, 'utf8');
      this.post({ type: 'applied', message: `Replaced code in ${path.basename(filePath)}`, filePath });
      await vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } catch (e: any) {
      this.post({ type: 'error', text: `Failed to replace code: ${e.message}` });
    }
  }

  // ── File utilities ──

  private async sendOpenFiles() {
    const files: Array<{ name: string; path: string; language: string }> = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isUntitled) {
        files.push({ name: path.basename(doc.fileName), path: doc.fileName, language: doc.languageId });
      }
    }
    const editor = vscode.window.activeTextEditor;
    if (editor && !files.find(f => f.path === editor.document.fileName)) {
      files.unshift({
        name:     path.basename(editor.document.fileName),
        path:     editor.document.fileName,
        language: editor.document.languageId,
      });
    }
    this.post({ type: 'files', files });
  }

  private async searchFilesHandler(query: string) {
    try {
      const results = await this.client.searchFiles(query);
      this.post({ type: 'searchResults', results });
    } catch {
      this.post({ type: 'searchResults', results: [] });
    }
  }

  private async readFileHandler(filePath: string) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      this.post({ type: 'fileContent', path: filePath, content });
    } catch (e: any) {
      this.post({ type: 'error', text: `Failed to read file: ${e.message}` });
    }
  }

  private sendUsage() {
    this.post({
      type:      'usage',
      remaining: this.usage.getRemaining(),
      plan:      this.usage.getPlan(),
      hasApiKey: this.hasApiKey(),
    });
  }

  private post(message: object) {
    this.view?.webview.postMessage(message);
  }

  // ── HTML loader ──

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'chat.html');

    try {
      const html    = fs.readFileSync(htmlPath, 'utf8');
      const webview = this.view!.webview;
      const logoUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.png')
      ).toString();

      return html
        .replace(/__HAS_API_KEY__/g,  this.hasApiKey() ? 'true' : 'false')
        .replace(/__CSP_SOURCE__/g,   webview.cspSource)
        .replace(/__LOGO_URI__/g,     logoUri);
    } catch {
      return '<html><body style="color:#e2e8f0;font-family:sans-serif;padding:20px;">Unable to load DevMind UI. Run <code>npm run build</code> and reload.</body></html>';
    }
  }
}