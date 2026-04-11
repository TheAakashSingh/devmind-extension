import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DeepSeekClient } from '../utils/deepseekClient';
import { UsageTracker } from '../utils/usageTracker';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

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
          await this.handleChat(message.text);
          break;
        case 'clear':
          this.clearChat();
          break;
        case 'insertCode':
          this.insertIntoEditor(message.code);
          break;
        case 'getUsage':
          this.sendUsage();
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

  private async handleChat(text: string) {
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

    const language = vscode.window.activeTextEditor?.document.languageId || 'typescript';
    this.history.push({ role: 'user', content: text });

    let reply = '';
    try {
      reply = await this.client.chat(
        this.history,
        language,
        (token: string) => this.post({ type: 'token', text: token })
      );
    } catch (error: any) {
      this.post({ type: 'error', text: error.message || 'Request failed.' });
      this.history.pop();
      return;
    }

    this.history.push({ role: 'assistant', content: reply });
    this.post({ type: 'done', text: reply });
    this.usage.record();
    this.sendUsage();
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
