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
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];

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
          await this.applyCodeToFile(message.code, message.filePath);
          break;
        case 'getUsage':
          this.sendUsage();
          break;
        case 'getFiles':
          await this.sendOpenFiles();
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
      }
    });

    this.usage.onChange(() => this.sendUsage());
  }

  refresh() {
    if (!this.view) {
      return;
    }
    this.render();
  }

  private render() {
    if (!this.view) {
      return;
    }
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

  private async getFileContext(filePath: string): Promise<string> {
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const content = doc.getText();
      const ext = path.extname(filePath);
      return `\n\nFile: ${filePath}\nLanguage: ${doc.languageId}\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\``;
    } catch {
      return '';
    }
  }

  private async getActiveFileContext(): Promise<string> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return '';

    const doc = editor.document;
    const fileName = doc.fileName;
    const language = doc.languageId;
    const content = doc.getText();
    const selection = editor.selection;
    const selectedCode = !selection.isEmpty ? doc.getText(selection) : '';

    let context = `\n\nActive file: ${fileName}\nLanguage: ${language}\n\`\`\`${language}\n${content}\n\`\`\``;

    if (selectedCode) {
      context += `\n\nSelected code:\n\`\`\`${language}\n${selectedCode}\n\`\`\``;
    }

    return context;
  }

  private buildContextMessage(attachments: Attachment[]): string {
    let context = '';
    
    for (const att of attachments) {
      if (att.type === 'file' && att.content) {
        const ext = path.extname(att.name);
        context += `\n\nFile: ${att.name}\n\`\`\`${ext.slice(1)}\n${att.content}\n\`\`\``;
      }
    }

    return context;
  }

  private async handleChat(text: string, attachments: Attachment[]) {
    if (!this.hasApiKey()) {
      this.post({
        type: 'error',
        text: 'Connect your DevMind account first. Use the dashboard to create an account, then paste your API key.',
      });
      return;
    }

    if (!this.usage.canComplete()) {
      this.post({
        type: 'error',
        text: 'Daily quota reached. Upgrade your plan in the DevMind dashboard to continue.',
      });
      return;
    }

    const { cleanText, mentions } = this.parseMentions(text);
    const language = vscode.window.activeTextEditor?.document.languageId || 'typescript';

    const fileContext = await this.getActiveFileContext();
    const attachmentContext = this.buildContextMessage(attachments);

    let enhancedContent = cleanText;
    if (fileContext || attachmentContext) {
      enhancedContent = `${cleanText}${fileContext}${attachmentContext}`;
    }

    this.history.push({ role: 'user', content: enhancedContent, attachments });

    let reply = '';
    try {
      reply = await this.client.chat(
        this.history.map(h => ({ role: h.role, content: h.content })),
        language,
        (token: string) => this.post({ type: 'token', text: token })
      );
    } catch (error: any) {
      this.post({ type: 'error', text: error.message || 'Request failed.' });
      this.history.pop();
      return;
    }

    this.history.push({ role: 'assistant', content: reply });
    this.post({ type: 'done', text: reply, hasCode: this.hasCodeBlock(reply) });
    this.usage.record();
    this.sendUsage();
  }

  private hasCodeBlock(text: string): boolean {
    return /```|function |const |class |interface |export |import |=>|<\w+/.test(text);
  }

  private clearChat() {
    this.history = [];
    this.post({ type: 'cleared' });
  }

  private insertIntoEditor(code: string) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      editor.edit((builder) => builder.insert(editor.selection.active, code));
    }
  }

  private async applyCodeToFile(code: string, filePath?: string) {
    if (filePath) {
      try {
        const safePath = vscode.workspace.asRelativePath(filePath);
        const doc = await vscode.workspace.openTextDocument(safePath);
        const fullDoc = await vscode.window.showTextDocument(doc);
        const fullContent = doc.getText();
        
        const codeBlockMatch = code.match(/```(?:\w+)?\n([\s\S]*?)```/);
        const extractedCode = codeBlockMatch ? codeBlockMatch[1].trim() : code;

        await fullDoc.edit((builder) => {
          const start = new vscode.Position(0, 0);
          const end = new vscode.Position(doc.lineCount, 0);
          builder.replace(new vscode.Range(start, end), extractedCode);
        });

        this.post({ type: 'applied', message: `Applied to ${path.basename(filePath)}` });
      } catch (e: any) {
        this.post({ type: 'error', text: `Failed to apply: ${e.message}` });
      }
    } else {
      this.insertIntoEditor(code);
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
      const doc = await vscode.workspace.openTextDocument(filePath);
      const content = doc.getText();
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