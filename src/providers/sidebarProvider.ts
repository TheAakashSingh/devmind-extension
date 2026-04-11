import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DeepSeekClient } from '../utils/deepseekClient';
import { UsageTracker } from '../utils/usageTracker';

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
        case 'chat':
          await this.handleChat(message.text, message.attachments || []);
          break;
        case 'clear':
          this.clearChat();
          break;
        case 'insertCode':
          this.insertIntoEditor(message.code);
          break;
        case 'applyCode':
          await this.applyCodeToFile(message.code, message.filePath, message.mode || 'insert');
          break;
        case 'replaceCode':
          await this.replaceCodeInFile(message.code, message.filePath, message.oldCode);
          break;
        case 'getUsage':
          this.sendUsage();
          break;
        case 'getFiles':
          await this.sendOpenFiles();
          break;
        case 'getProjectContext':
          await this.sendProjectContext();
          break;
        case 'searchFiles':
          await this.searchFilesHandler(message.query);
          break;
        case 'readFile':
          await this.readFileHandler(message.path);
          break;
        case 'openDashboard':
          await vscode.env.openExternal(vscode.Uri.parse(this.dashboardUrl));
          break;
        case 'openOnboarding':
          await vscode.commands.executeCommand('devmind.openOnboarding');
          break;
        case 'setKey':
          await vscode.commands.executeCommand('devmind.setKey');
          break;
        case 'stopGeneration':
          this.isStreaming = false;
          break;
      }
    });

    this.usage.onChange(() => this.sendUsage());
  }

  refresh() {
    if (!this.view) return;
    this.render();
  }

  private render() {
    if (!this.view) return;
    this.view.webview.html = this.getHtml();
    this.sendUsage();
  }

  private hasApiKey(): boolean {
    return Boolean(vscode.workspace.getConfiguration('devmind').get<string>('apiKey', ''));
  }

  private parseMentions(text: string): { cleanText: string; mentions: string[] } {
    const mentionRegex = /@([^\s]+)/g;
    const mentions: string[] = [];
    const cleanText = text.replace(mentionRegex, (_match, name) => {
      mentions.push(name);
      return '';
    });
    return { cleanText: cleanText.trim(), mentions };
  }

  private async getActiveFileContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';

    const doc = editor.document;
    const fileName = path.basename(doc.fileName);
    const language = doc.languageId;
    const content = doc.getText();
    const selection = editor.selection;
    const selectedCode = !selection.isEmpty ? doc.getText(selection) : '';
    const cursorPosition = editor.selection.active;

    let context = `\n\n=== ACTIVE FILE: ${fileName} (${language}) ===\n`;
    context += `Cursor: Line ${cursorPosition.line + 1}, Column ${cursorPosition.character + 1}\n`;
    
    if (selectedCode) {
      context += `\n--- Selected Code (lines ${selection.start.line + 1}-${selection.end.line + 1}) ---\n${selectedCode}\n`;
    }
    
    context += `\n--- Full File Content ---\n${content}`;

    return context;
  }

  private async getProjectContext(): Promise<string> {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return '';

    const rootPath = workspace.uri.fsPath;
    const packageJsonPath = path.join(rootPath, 'package.json');
    const tsconfigPath = path.join(rootPath, 'tsconfig.json');

    let context = '\n\n=== PROJECT CONTEXT ===\n';

    try {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        context += `Project: ${packageJson.name || 'Unknown'}\n`;
        context += `Type: ${packageJson.type || 'module'}\n`;
        context += `Scripts: ${Object.keys(packageJson.scripts || {}).slice(0, 5).join(', ')}\n`;
      }
    } catch {}

    const openFiles = vscode.workspace.textDocuments
      .filter(d => !d.isUntitled)
      .slice(0, 5)
      .map(d => path.basename(d.fileName));
    
    if (openFiles.length > 0) {
      context += `Open files: ${openFiles.join(', ')}\n`;
    }

    return context;
  }

  private buildContextMessage(attachments: Attachment[]): string {
    let context = '';
    
    for (const att of attachments) {
      if (att.type === 'file' && att.content) {
        const ext = path.extname(att.name).slice(1) || 'text';
        context += `\n\n=== ATTACHED FILE: ${att.name} ===\n\`\`\`${ext}\n${att.content}\n\`\`\``;
      } else if (att.type === 'image') {
        context += `\n\n[Image attached: ${att.name}]`;
      }
    }

    return context;
  }

  private async handleChat(text: string, attachments: Attachment[]) {
    if (!this.hasApiKey()) {
      this.post({ type: 'error', text: 'Connect your DevMind account first. Use the dashboard to create an account, then paste your API key.' });
      return;
    }

    if (!this.usage.canComplete()) {
      this.post({ type: 'error', text: 'Daily quota reached. Upgrade your plan in the DevMind dashboard to continue.' });
      return;
    }

    this.isStreaming = true;
    const { cleanText } = this.parseMentions(text);
    const language = vscode.window.activeTextEditor?.document.languageId || 'typescript';

    this.post({ type: 'thinking', show: true });

    const fileContext = await this.getActiveFileContext();
    const projectContext = await this.getProjectContext();
    const attachmentContext = this.buildContextMessage(attachments);

    let enhancedContent = cleanText;
    if (fileContext || projectContext || attachmentContext) {
      enhancedContent = `${cleanText}${projectContext}${fileContext}${attachmentContext}`;
    }

    this.history.push({ role: 'user', content: enhancedContent, attachments, timestamp: Date.now() });

    let reply = '';
    try {
      reply = await this.client.chat(
        this.history.map(h => ({ role: h.role, content: h.content })),
        language,
        (token: string) => {
          if (this.isStreaming) {
            this.post({ type: 'token', text: token });
          }
        }
      );
    } catch (error: any) {
      this.post({ type: 'thinking', show: false });
      this.post({ type: 'error', text: error.message || 'Request failed.' });
      this.history.pop();
      this.isStreaming = false;
      return;
    }

    this.isStreaming = false;
    this.post({ type: 'thinking', show: false });
    this.history.push({ role: 'assistant', content: reply, timestamp: Date.now() });
    this.post({ type: 'done', text: reply, hasCode: this.hasCodeBlock(reply) });
    this.usage.record();
    this.sendUsage();
  }

  private hasCodeBlock(text: string): boolean {
    return /```|function |const |class |interface |export |import |=>|<\w+|def |async |public |private/.test(text);
  }

  private clearChat() {
    this.history = [];
    this.isStreaming = false;
    this.post({ type: 'cleared' });
  }

  private insertIntoEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const extractedCode = this.extractCodeFromMarkdown(code);
      editor.edit((builder) => builder.insert(editor.selection.active, extractedCode));
      vscode.window.showInformationMessage('Code inserted at cursor');
    }
  }

  private extractCodeFromMarkdown(code: string): string {
    const codeBlockMatch = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
    if (codeBlockMatch) return codeBlockMatch[1].trim();
    
    const inlineCodeMatch = code.match(/`([^`]+)`/g);
    if (inlineCodeMatch && inlineCodeMatch.length > 2) {
      return code.replace(/`/g, '');
    }
    
    return code.trim();
  }

  private async applyCodeToFile(code: string, filePath?: string, mode: string = 'insert') {
    try {
      const extractedCode = this.extractCodeFromMarkdown(code);
      
      if (filePath && fs.existsSync(filePath)) {
        const fullContent = fs.readFileSync(filePath, 'utf8');
        fs.writeFileSync(filePath, fullContent + '\n\n' + extractedCode, 'utf8');
        this.post({ type: 'applied', message: `Code appended to ${path.basename(filePath)}`, filePath });
        vscode.window.showTextDocument(vscode.Uri.file(filePath));
      } else {
        this.insertIntoEditor(extractedCode);
      }
    } catch (e: any) {
      this.post({ type: 'error', text: `Failed to apply: ${e.message}` });
    }
  }

  private async replaceCodeInFile(code: string, filePath: string, oldCode: string) {
    try {
      if (!fs.existsSync(filePath)) {
        this.post({ type: 'error', text: 'File not found' });
        return;
      }

      const fullContent = fs.readFileSync(filePath, 'utf8');
      const newContent = fullContent.replace(oldCode, code);
      
      fs.writeFileSync(filePath, newContent, 'utf8');
      this.post({ type: 'applied', message: `Code replaced in ${path.basename(filePath)}`, filePath });
      vscode.window.showTextDocument(vscode.Uri.file(filePath));
    } catch (e: any) {
      this.post({ type: 'error', text: `Failed to replace: ${e.message}` });
    }
  }

  private async sendOpenFiles() {
    const files: Array<{ name: string; path: string; language: string }> = [];
    
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isUntitled) {
        files.push({
          name: path.basename(doc.fileName),
          path: doc.fileName,
          language: doc.languageId,
        });
      }
    }

    const editor = vscode.window.activeTextEditor;
    if (editor && !files.find(f => f.path === editor.document.fileName)) {
      files.unshift({
        name: path.basename(editor.document.fileName),
        path: editor.document.fileName,
        language: editor.document.languageId,
      });
    }

    this.post({ type: 'files', files });
  }

  private async sendProjectContext() {
    const context = await this.getProjectContext();
    const activeFile = await this.getActiveFileContext();
    this.post({ type: 'projectContext', context: context + activeFile });
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
      this.post({ type: 'error', text: `Failed to read: ${e.message}` });
    }
  }

  private sendUsage() {
    this.post({
      type: 'usage',
      remaining: this.usage.getRemaining(),
      plan: this.usage.getPlan(),
      hasApiKey: this.hasApiKey(),
    });
  }

  private post(message: object) {
    this.view?.webview.postMessage(message);
  }

  private getHtml(): string {
    const htmlPath = path.join(this.extensionUri.fsPath, 'src', 'webview', 'chat.html');

    try {
      const html = fs.readFileSync(htmlPath, 'utf8');
      const webview = this.view!.webview;
      const logoUri = webview.asWebviewUri(
        vscode.Uri.joinPath(this.extensionUri, 'assets', 'logo.png')
      ).toString() || '';

      return html
        .replace(/__HAS_API_KEY__/g, this.hasApiKey() ? 'true' : 'false')
        .replace(/__CSP_SOURCE__/g, webview.cspSource)
        .replace(/__LOGO_URI__/g, logoUri);
    } catch {
      return '<html><body>Unable to load DevMind chat UI. Run the build again.</body></html>';
    }
  }
}