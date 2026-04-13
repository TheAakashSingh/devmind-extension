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
interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMsg[];
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private streaming = false;
  private readonly sessionsKey = 'devmind.chatSessions.v1';
  private readonly activeSessionKey = 'devmind.activeChatSession.v1';
  private readonly intentKey = 'devmind.intent.v1';
  private readonly memoryKey = 'devmind.memory.v1';
  private intent: 'build' | 'debug' | 'refactor' | 'optimize' | 'secure' = 'build';
  private projectMemory = '';

  constructor(
    private readonly context:      vscode.ExtensionContext,
    private readonly extensionUri: vscode.Uri,
    private readonly client:       DeepSeekClient,
    private readonly usage:        UsageTracker,
    private readonly dashboardUrl: string
  ) {
    this.loadSessions();
    this.intent = this.context.workspaceState.get<typeof this.intent>(this.intentKey, 'build');
    this.projectMemory = this.context.workspaceState.get<string>(this.memoryKey, '');
  }

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
        case 'newSession':      this.createSession(); break;
        case 'switchSession':   this.switchSession(String(msg.id || '')); break;
        case 'deleteSession':   this.deleteSession(String(msg.id || '')); break;
        case 'renameSession':   this.renameSession(String(msg.id || ''), String(msg.title || '')); break;
        case 'getSessions':     this.sendSessions(); break;
        case 'setIntent':       this.setIntent(String(msg.intent || 'build')); break;
        case 'setProjectMemory': this.setProjectMemory(String(msg.memory || '')); break;
        case 'getChatSettings': this.sendChatSettings(); break;
      }
    });

    this.usage.onChange(() => this.sendUsage());

    // Send file tree after a short delay so the webview is ready
    setTimeout(() => {
      this.sendFileTree();
      this.sendUsage();
      this.post({ type: 'history', messages: this.getHistory() });
      this.sendSessions();
      this.sendChatSettings();
    }, 500);
    void this.syncRemotePreferences();
  }

  refresh() {
    if (!this.view) return;
    setTimeout(() => {
      this.sendFileTree();
      this.sendUsage();
      this.post({ type: 'history', messages: this.getHistory() });
      this.sendSessions();
      this.sendChatSettings();
    }, 100);
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

    const optimized = optimizePrompt(text, proj);
    const fullText  = optimized + attContext;

    // Add codebase structure to first message if workspace is indexed
    let systemExtra = '';
    const history = this.getHistory();
    if (history.length === 0 && indexer && indexer.getFiles().length > 0) {
      systemExtra = '\n\n' + buildCodebaseSummary(indexer.getFiles().slice(0, 200), indexer.getRootPath());
    }

    // Auto-retrieve top relevant files when user did not explicitly @mention files.
    if (!resolvedMentions.length && indexer) {
      const autoFiles = indexer.searchFiles(text, 4);
      for (const f of autoFiles) {
        const rf = indexer.readFile(f.path);
        if (rf?.content) {
          resolvedMentions.push({
            name: f.path,
            content: rf.content.slice(0, 5000),
          });
        }
      }
    }
    const ctxPrompt = buildContextPrompt(proj, file, resolvedMentions);

    if (history.length === 0) {
      history.push({ role: 'user', content: `[CONTEXT]\n${ctxPrompt}${systemExtra}\n\n[QUESTION]\n${fullText}` });
    } else {
      history.push({ role: 'user', content: fullText });
    }
    this.persistSessions();
    this.updateSessionMetadataFromPrompt(text);

    this.post({ type: 'thinking', show: true });

    let reply = '';
    try {
      reply = await this.client.chat(
        history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
        file?.language || proj.language || 'typescript',
        (token: string) => {
          if (this.streaming) this.post({ type: 'token', text: token });
        },
        this.intent,
        this.projectMemory
      );
    } catch (err: any) {
      this.post({ type: 'thinking', show: false });
      const msg = String(err?.message || 'Request failed. Check connection and API key.');
      this.post({ type: 'error', text: msg });
      if (msg.toLowerCase().includes('api key is invalid') || msg.toLowerCase().includes('authentication failed')) {
        this.post({ type: 'warning', text: 'Use DevMind: Set API Key to reconnect your account.' });
      }
      history.pop();
      this.persistSessions();
      this.streaming = false;
      return;
    }

    this.streaming = false;
    history.push({ role: 'assistant', content: reply });
    this.persistSessions();
    this.touchActiveSession();
    this.post({ type: 'done', text: reply });
    this.sendSessions();
    this.usage.record();
    this.sendUsage();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  private clearChat() {
    const active = this.getActiveSession();
    active.messages = [];
    active.updatedAt = Date.now();
    this.streaming = false;
    this.persistSessions();
    this.sendSessions();
    this.post({ type: 'cleared' });
  }

  private loadSessions() {
    const saved = this.context.workspaceState.get<ChatSession[]>(this.sessionsKey, []);
    const active = this.context.workspaceState.get<string>(this.activeSessionKey, '');
    this.sessions = Array.isArray(saved) ? saved : [];
    if (!this.sessions.length) {
      const first = this.makeSession('New chat');
      this.sessions = [first];
      this.activeSessionId = first.id;
      this.persistSessions();
      return;
    }
    this.activeSessionId = this.sessions.some(s => s.id === active) ? active : this.sessions[0].id;
  }

  private persistSessions() {
    void this.context.workspaceState.update(this.sessionsKey, this.sessions);
    void this.context.workspaceState.update(this.activeSessionKey, this.activeSessionId);
  }

  private makeSession(title: string): ChatSession {
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title,
      updatedAt: Date.now(),
      messages: [],
    };
  }

  private getActiveSession(): ChatSession {
    const existing = this.sessions.find(s => s.id === this.activeSessionId);
    if (existing) return existing;
    const created = this.makeSession('New chat');
    this.sessions.unshift(created);
    this.activeSessionId = created.id;
    this.persistSessions();
    return created;
  }

  private getHistory(): ChatMsg[] {
    return this.getActiveSession().messages;
  }

  private createSession() {
    const next = this.makeSession('New chat');
    this.sessions.unshift(next);
    this.activeSessionId = next.id;
    this.persistSessions();
    this.sendSessions();
    this.post({ type: 'cleared' });
  }

  private switchSession(id: string) {
    if (!id || !this.sessions.some(s => s.id === id)) return;
    this.activeSessionId = id;
    this.persistSessions();
    this.sendSessions();
    this.post({ type: 'history', messages: this.getHistory() });
  }

  private deleteSession(id: string) {
    if (!id) return;
    if (this.sessions.length === 1) {
      this.clearChat();
      return;
    }
    this.sessions = this.sessions.filter(s => s.id !== id);
    if (!this.sessions.some(s => s.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
    }
    this.persistSessions();
    this.sendSessions();
    this.post({ type: 'history', messages: this.getHistory() });
  }

  private renameSession(id: string, title: string) {
    const clean = title.trim().slice(0, 40);
    if (!clean) return;
    const s = this.sessions.find(x => x.id === id);
    if (!s) return;
    s.title = clean;
    s.updatedAt = Date.now();
    this.persistSessions();
    this.sendSessions();
  }

  private touchActiveSession() {
    const s = this.getActiveSession();
    s.updatedAt = Date.now();
  }

  private updateSessionMetadataFromPrompt(text: string) {
    const s = this.getActiveSession();
    if (s.title === 'New chat') {
      s.title = text.trim().replace(/\s+/g, ' ').slice(0, 34) || 'New chat';
    }
    s.updatedAt = Date.now();
  }

  private sendSessions() {
    const sessions = [...this.sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(s => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
    this.post({ type: 'sessions', sessions, activeId: this.activeSessionId });
  }

  private setIntent(intent: string) {
    const allowed = new Set(['build', 'debug', 'refactor', 'optimize', 'secure']);
    const next = allowed.has(intent) ? intent as typeof this.intent : 'build';
    this.intent = next;
    void this.context.workspaceState.update(this.intentKey, this.intent);
    this.sendChatSettings();
  }

  private setProjectMemory(memory: string) {
    this.projectMemory = memory.slice(0, 12000);
    void this.context.workspaceState.update(this.memoryKey, this.projectMemory);
  }

  private sendChatSettings() {
    this.post({
      type: 'chatSettings',
      intent: this.intent,
      hasProjectMemory: Boolean(this.projectMemory.trim()),
    });
  }

  private async syncRemotePreferences() {
    try {
      const pref = await this.client.getPreferences();
      if (pref?.defaultIntent) {
        this.intent = pref.defaultIntent;
        void this.context.workspaceState.update(this.intentKey, this.intent);
      }
      if (typeof pref?.projectMemory === 'string') {
        this.projectMemory = pref.projectMemory.slice(0, 12000);
        void this.context.workspaceState.update(this.memoryKey, this.projectMemory);
      }
      this.sendChatSettings();
    } catch {
      // Keep local settings when server prefs are unavailable.
    }
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
