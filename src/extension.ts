import * as vscode from 'vscode';
import * as path   from 'path';
import * as fs     from 'fs';
import { InlineCompletionProvider }  from './providers/completionProvider';
import { SidebarProvider }           from './providers/sidebarProvider';
import { DeepSeekClient }            from './utils/deepseekClient';
import { UsageTracker }              from './utils/usageTracker';
import {
  collectProjectContext,
  collectFileContext,
  buildContextPrompt,
  optimizePrompt,
} from './utils/contextCollector';

let client:  DeepSeekClient;
let usage:   UsageTracker;
let sidebar: SidebarProvider;

const DEFAULT_SERVER    = 'https://api-devmind.singhjitech.com';
const DEFAULT_DASHBOARD = 'https://app-devmind.singhjitech.com';

export function activate(context: vscode.ExtensionContext) {
  const cfg          = vscode.workspace.getConfiguration('devmind');
  const apiKey       = cfg.get<string>('apiKey', '');
  const serverUrl    = cfg.get<string>('serverUrl', DEFAULT_SERVER);
  const dashboardUrl = cfg.get<string>('dashboardUrl', DEFAULT_DASHBOARD);

  client  = new DeepSeekClient(serverUrl, apiKey);
  usage   = new UsageTracker(context);
  sidebar = new SidebarProvider(context.extensionUri, client, usage, dashboardUrl);

  // ── Status bar ─────────────────────────────────────────────────────────────
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = 'devmind.openOnboarding';
  bar.show();
  context.subscriptions.push(bar);

  function refreshBar() {
    const key    = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    const inline = vscode.workspace.getConfiguration('devmind').get<boolean>('enableInline', true);
    if (!key) {
      bar.text    = '$(sparkle) DevMind';
      bar.tooltip = 'DevMind AI — click to connect';
      return;
    }
    const rem  = usage.getRemaining();
    const plan = usage.getPlan().toUpperCase();
    bar.text    = `$(sparkle) DevMind ${rem} · ${plan}`;
    bar.tooltip = [
      `DevMind AI v2.1`,
      `Requests left: ${rem}`,
      `Plan: ${plan}`,
      `Inline: ${inline ? 'ON' : 'OFF'}`,
      `Click to manage account`,
    ].join('\n');
  }

  async function syncPlan() {
    const key = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!key) { usage.setPlan('free'); refreshBar(); return; }
    try {
      const v = await client.validate();
      if (v.valid && v.plan) { usage.setPlan(v.plan); }
    } catch {}
    refreshBar();
    sidebar.refresh();
  }

  refreshBar();
  usage.onChange(refreshBar);

  // ── Providers ──────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new InlineCompletionProvider(client, usage)
    ),
    vscode.window.registerWebviewViewProvider('devmind.chatView', sidebar)
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(

    // ── Explain selected code ──
    vscode.commands.registerCommand('devmind.explain', () => runAction('explain')),

    // ── Explain entire file ──
    vscode.commands.registerCommand('devmind.explainFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const doc  = editor.document;
      const proj = collectProjectContext();
      const file = collectFileContext();
      const ctx  = buildContextPrompt(proj, null);
      await withProgress('DevMind: Analysing file…', async () => {
        try {
          const result = await client.explainFile(doc.getText(), path.basename(doc.fileName), doc.languageId, ctx);
          await openResult(result, 'markdown');
        } catch (e: any) { showErr(e); }
      });
    }),

    // ── Fix bug ──
    vscode.commands.registerCommand('devmind.fix', () => runAction('fix')),

    // ── Refactor ──
    vscode.commands.registerCommand('devmind.refactor', () => runAction('refactor')),

    // ── Generate from prompt ──
    vscode.commands.registerCommand('devmind.generate', () => runGenerate()),

    // ── Generate tests ──
    vscode.commands.registerCommand('devmind.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) { return; }
      const code = editor.document.getText(editor.selection);
      if (!code.trim()) { vscode.window.showWarningMessage('DevMind: Select code to test first.'); return; }
      const proj = collectProjectContext();
      const file = collectFileContext();
      const ctx  = buildContextPrompt(proj, file);
      await withProgress('DevMind: Writing tests…', async () => {
        try {
          const tests = await client.generateTests(code, file?.language || 'typescript', file?.fileName || 'file', ctx);
          await openResult(tests, file?.language || 'typescript');
        } catch (e: any) { showErr(e); }
      });
    }),

    // ── Multi-file refactor ──
    vscode.commands.registerCommand('devmind.multiRefactor', async () => {
      const instruction = await vscode.window.showInputBox({
        prompt:         'Describe the refactor to apply across files',
        placeHolder:    'e.g. rename OrderService to TransactionService everywhere',
        ignoreFocusOut: true,
      });
      if (!instruction) { return; }

      const proj  = collectProjectContext();
      const ctx   = buildContextPrompt(proj, null);
      const opt   = optimizePrompt(instruction, proj);
      const docs  = vscode.workspace.textDocuments
        .filter(d => !d.isUntitled && !d.uri.path.includes('node_modules'))
        .slice(0, 10);

      if (!docs.length) {
        vscode.window.showWarningMessage('DevMind: Open the files you want to refactor first.');
        return;
      }

      const files = docs.map(d => ({ path: d.fileName, content: d.getText() }));

      await withProgress('DevMind: Refactoring files…', async () => {
        try {
          const result = await client.multiRefactor({ instruction: opt, files, language: proj.language, projectCtx: ctx });
          const apply  = await vscode.window.showInformationMessage(
            `DevMind: Ready to apply changes to ${result.files.length} file(s)?`,
            'Apply All', 'Cancel'
          );
          if (apply === 'Apply All') {
            for (const f of result.files) {
              try { fs.writeFileSync(f.path, f.content, 'utf8'); } catch {}
            }
            vscode.window.showInformationMessage(`DevMind: Applied to ${result.files.length} file(s).`);
          }
        } catch (e: any) { showErr(e); }
      });
    }),

    // ── Scaffold picker ──
    vscode.commands.registerCommand('devmind.scaffold', async () => {
      const type = await vscode.window.showQuickPick([
        { label: '$(shield) Auth System',      description: 'JWT register, login, refresh, reset',    id: 'auth'   },
        { label: '$(cloud) REST API',           description: 'Full CRUD REST endpoint',                id: 'api'    },
        { label: '$(database) CRUD Module',     description: 'Model, controller, routes, validation',  id: 'crud'   },
        { label: '$(table) DB Schema',          description: 'Database schema with relations',          id: 'schema' },
        { label: '$(gear) Admin Panel',         description: 'Admin routes and middleware',             id: 'admin'  },
        { label: '$(server) Express Server',    description: 'Boilerplate server with middleware',      id: 'server' },
        { label: '$(pencil) Custom Module',     description: 'Describe what you need',                 id: 'custom' },
      ], { placeHolder: 'What do you want to scaffold?' });

      if (!type) { return; }

      const name = await vscode.window.showInputBox({
        prompt:      `Module name for ${type.id}`,
        placeHolder: 'e.g. user, order, product',
        ignoreFocusOut: true,
      });
      if (!name) { return; }

      let extra = '';
      if (type.id === 'custom') {
        extra = await vscode.window.showInputBox({
          prompt:         'Describe what to generate',
          placeHolder:    'e.g. payment webhook with Razorpay signature verification',
          ignoreFocusOut: true,
        }) || '';
      }

      const proj      = collectProjectContext();
      const ctxPrompt = buildContextPrompt(proj, null);

      await withProgress(`DevMind: Scaffolding ${name} ${type.id}…`, async () => {
        try {
          const scaffoldType = type.id + (extra ? `:${extra}` : '');
          const result       = await client.scaffold({ type: scaffoldType, name, language: proj.language, projectCtx: ctxPrompt });
          const wsRoot       = proj.rootPath;

          for (const file of result.files) {
            let written = false;
            if (wsRoot) {
              const fp = path.join(wsRoot, file.path);
              try {
                const dir = path.dirname(fp);
                if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
                fs.writeFileSync(fp, file.content, 'utf8');
                const d = await vscode.workspace.openTextDocument(vscode.Uri.file(fp));
                await vscode.window.showTextDocument(d, { preview: false });
                written = true;
              } catch {}
            }
            if (!written) {
              const d = await vscode.workspace.openTextDocument({ content: `// ${file.path}\n${file.content}`, language: proj.language });
              await vscode.window.showTextDocument(d, { preview: false });
            }
          }
          vscode.window.showInformationMessage(`DevMind: Generated ${result.files.length} file(s) for ${name}.`);
        } catch (e: any) { showErr(e); }
      });
    }),

    // ── Quick scaffold shortcuts ──
    vscode.commands.registerCommand('devmind.createAuth',   () => quickScaffold('auth',   'auth')),
    vscode.commands.registerCommand('devmind.createApi',    () => quickScaffold('api',    'api')),
    vscode.commands.registerCommand('devmind.createCrud',   () => quickScaffold('crud',   'resource')),
    vscode.commands.registerCommand('devmind.createSchema', () => quickScaffold('schema', 'model')),
    vscode.commands.registerCommand('devmind.createAdmin',  () => quickScaffold('admin',  'admin')),
    vscode.commands.registerCommand('devmind.createServer', () => quickScaffold('server', 'server')),

    // ── Toggle inline ──
    vscode.commands.registerCommand('devmind.toggleInline', async () => {
      const cur = vscode.workspace.getConfiguration('devmind').get<boolean>('enableInline', true);
      await vscode.workspace.getConfiguration('devmind').update('enableInline', !cur, true);
      vscode.window.showInformationMessage(`DevMind: Inline autocomplete ${!cur ? 'enabled' : 'disabled'}.`);
      refreshBar();
    }),

    // ── Chat / Dashboard / Account ──
    vscode.commands.registerCommand('devmind.chat', () => vscode.commands.executeCommand('devmind.chatView.focus')),
    vscode.commands.registerCommand('devmind.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(dashboardUrl))),

    // ── Onboarding panel ──
    vscode.commands.registerCommand('devmind.openOnboarding', () => {
      const panel = vscode.window.createWebviewPanel(
        'devmindOnboarding', 'DevMind — Account',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const hasKey  = Boolean(vscode.workspace.getConfiguration('devmind').get<string>('apiKey', ''));
      const inline  = vscode.workspace.getConfiguration('devmind').get<boolean>('enableInline', true);
      const plan    = usage.getPlan();
      const remaining = usage.getRemaining();
      panel.webview.html = buildOnboardingHtml(hasKey, plan, remaining, inline);
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'openDashboard': await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl)); break;
          case 'setKey':        await vscode.commands.executeCommand('devmind.setKey'); break;
          case 'openSidebar':   await vscode.commands.executeCommand('devmind.chatView.focus'); panel.dispose(); break;
          case 'signOut':       await vscode.commands.executeCommand('devmind.signOut'); panel.dispose(); break;
          case 'toggleInline':  await vscode.commands.executeCommand('devmind.toggleInline'); break;
        }
      });
    }),

    // ── Set API key ──
    vscode.commands.registerCommand('devmind.setKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Paste your DevMind API key (from dashboard → API Keys)',
        placeHolder: 'dm_...', password: true, ignoreFocusOut: true,
      });
      if (!key) { return; }
      await vscode.workspace.getConfiguration('devmind').update('apiKey', key, true);
      client.setKey(key);
      await syncPlan();
      vscode.window.showInformationMessage('DevMind connected! Open the sidebar to start.');
    }),

    // ── Sign out ──
    vscode.commands.registerCommand('devmind.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage('Sign out of DevMind AI?', { modal: true }, 'Sign out');
      if (confirm !== 'Sign out') { return; }
      await vscode.workspace.getConfiguration('devmind').update('apiKey', '', true);
      client.setKey('');
      usage.setPlan('free');
      await syncPlan();
      vscode.window.showInformationMessage('Signed out of DevMind AI.');
    }),

    // ── Config watcher ──
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('devmind')) { return; }
      const c = vscode.workspace.getConfiguration('devmind');
      client.updateConfig(c.get<string>('serverUrl', serverUrl), c.get<string>('apiKey', ''));
      await syncPlan();
    })
  );

  // ── Startup ────────────────────────────────────────────────────────────────
  if (!apiKey) {
    setTimeout(() => vscode.commands.executeCommand('devmind.openOnboarding'), 1200);
  } else {
    void syncPlan();
  }
}

// ── Helper functions ──────────────────────────────────────────────────────────

async function runAction(action: 'explain' | 'fix' | 'refactor') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }
  const code = editor.document.getText(editor.selection);
  if (!code.trim()) { vscode.window.showWarningMessage('DevMind: Select some code first.'); return; }
  const proj = collectProjectContext();
  const file = collectFileContext();
  const ctx  = buildContextPrompt(proj, file);
  await withProgress(`DevMind: ${action}ing…`, async () => {
    try {
      const result = await client.action(action, code, file?.language || 'text', ctx);
      await openResult(result, action === 'explain' ? 'markdown' : (file?.language || 'text'));
    } catch (e: any) { showErr(e); }
  });
}

async function runGenerate() {
  const editor     = vscode.window.activeTextEditor;
  const proj       = collectProjectContext();
  const file       = collectFileContext();
  const lang       = file?.language || proj.language || 'typescript';
  const rawPrompt  = await vscode.window.showInputBox({
    prompt:         'Describe what to generate',
    placeHolder:    'e.g. create order controller with pagination and JWT middleware',
    ignoreFocusOut: true,
  });
  if (!rawPrompt) { return; }
  const optimized = optimizePrompt(rawPrompt, proj);
  const ctx       = buildContextPrompt(proj, file);
  await withProgress('DevMind: Generating…', async () => {
    try {
      const code = await client.generate(optimized, lang, ctx);
      if (editor) {
        await editor.edit(b => b.insert(editor.selection.active, '\n' + code + '\n'));
        vscode.window.showInformationMessage('DevMind: Code inserted.');
      } else {
        await openResult(code, lang);
      }
    } catch (e: any) { showErr(e); }
  });
}

async function quickScaffold(type: string, defaultName: string) {
  const name = await vscode.window.showInputBox({
    prompt: `Name for the ${type} module`, value: defaultName, ignoreFocusOut: true,
  });
  if (!name) { return; }
  const proj      = collectProjectContext();
  const ctxPrompt = buildContextPrompt(proj, null);
  await withProgress(`DevMind: Scaffolding ${name}…`, async () => {
    try {
      const result = await client.scaffold({ type, name, language: proj.language, projectCtx: ctxPrompt });
      for (const file of result.files) {
        const d = await vscode.workspace.openTextDocument({ content: `// ${file.path}\n${file.content}`, language: proj.language });
        await vscode.window.showTextDocument(d, { preview: false });
      }
      vscode.window.showInformationMessage(`DevMind: ${result.files.length} file(s) generated for ${name}.`);
    } catch (e: any) { showErr(e); }
  });
}

async function openResult(content: string, language: string) {
  const doc = await vscode.workspace.openTextDocument({ content, language });
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
}

async function withProgress(title: string, fn: () => Promise<void>) {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    fn
  );
}

function showErr(e: any) {
  vscode.window.showErrorMessage(`DevMind: ${e?.message || 'Request failed'}`);
}

// ── Onboarding HTML ───────────────────────────────────────────────────────────
function buildOnboardingHtml(hasApiKey: boolean, plan: string, remaining: number, inline: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #e2e8f0; background: #0d1117; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 28px 16px; }
  .card { width: 100%; max-width: 740px; background: #161b22; border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 28px; }
  .badge { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 20px; background: rgba(79,142,247,.12); border: 1px solid rgba(79,142,247,.25); color: #7eb8f9; font-size: 11px; font-weight: 600; margin-bottom: 18px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: ${hasApiKey ? '#34d399' : '#f87171'}; flex-shrink: 0; }
  h1 { font-size: 20px; font-weight: 700; color: #f1f5f9; margin-bottom: 8px; }
  .sub { color: #8b909e; line-height: 1.65; margin-bottom: 22px; }
  .stat-row { display: flex; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .stat { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07); border-radius: 8px; padding: 10px 14px; flex: 1; min-width: 110px; }
  .stat-label { font-size: 10px; color: #666; margin-bottom: 3px; }
  .stat-val { font-size: 18px; font-weight: 700; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media(max-width:560px) { .grid { grid-template-columns: 1fr; } }
  .panel { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07); border-radius: 12px; padding: 18px; }
  .panel-title { font-size: 11px; font-weight: 700; color: #cbd5e1; margin-bottom: 14px; text-transform: uppercase; letter-spacing: .05em; }
  .steps { display: flex; flex-direction: column; gap: 9px; }
  .step { display: flex; gap: 10px; align-items: flex-start; }
  .step-num { width: 20px; height: 20px; border-radius: 50%; background: rgba(79,142,247,.15); color: #7eb8f9; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .step-text { font-size: 12px; color: #94a3b8; line-height: 1.55; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  button { display: inline-flex; align-items: center; gap: 5px; padding: 7px 13px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; font-family: inherit; transition: all .15s; }
  .btn-p { background: #4f8ef7; color: #fff; } .btn-p:hover { background: #3b7ef6; }
  .btn-s { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: #cbd5e1; } .btn-s:hover { background: rgba(255,255,255,.1); }
  .btn-r { background: rgba(248,113,113,.1); border: 1px solid rgba(248,113,113,.3); color: #f87171; } .btn-r:hover { background: rgba(248,113,113,.2); }
  .kbds { display: flex; flex-direction: column; gap: 5px; }
  .kbd-row { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-radius: 5px; background: rgba(255,255,255,.03); }
  .kbd-desc { font-size: 11px; color: #94a3b8; }
  .kbd { font-family: monospace; font-size: 10px; background: #21262d; padding: 2px 6px; border-radius: 3px; color: #7eb8f9; border: 1px solid rgba(255,255,255,.1); }
  .footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.06); font-size: 11px; color: #555b6a; }
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="dot"></span>DevMind AI by SinghJitech · v2.1</div>
  <h1>${hasApiKey ? 'Account connected' : 'Connect your DevMind account'}</h1>
  <p class="sub">AI coding assistant — inline autocomplete, project-aware generation, scaffolding, multi-file refactoring, and test generation. Better than Copilot.</p>

  ${hasApiKey ? `
  <div class="stat-row">
    <div class="stat"><div class="stat-label">Plan</div><div class="stat-val">${plan.toUpperCase()}</div></div>
    <div class="stat"><div class="stat-label">Requests left today</div><div class="stat-val">${remaining}</div></div>
    <div class="stat"><div class="stat-label">Inline autocomplete</div><div class="stat-val" style="color:${inline?'#34d399':'#f87171'};font-size:14px">${inline ? 'ON' : 'OFF'}</div></div>
  </div>` : ''}

  <div class="grid">
    <div class="panel">
      <div class="panel-title">${hasApiKey ? 'Features' : 'Getting started'}</div>
      <div class="steps">
        ${!hasApiKey ? `
        <div class="step"><span class="step-num">1</span><span class="step-text">Open the dashboard and enter your Gmail address.</span></div>
        <div class="step"><span class="step-num">2</span><span class="step-text">Enter the 6-digit OTP sent to your Gmail (passwordless).</span></div>
        <div class="step"><span class="step-num">3</span><span class="step-text">Copy your API key from the dashboard.</span></div>
        <div class="step"><span class="step-num">4</span><span class="step-text">Click "Paste API key" and start coding with AI.</span></div>
        ` : `
        <div class="step"><span class="step-num">✦</span><span class="step-text">Inline autocomplete — Tab to accept AI suggestions as you type.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Chat sidebar — project-aware AI that reads your active file.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Scaffold — generate Auth, CRUD, API, Admin in seconds.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Multi-file refactor — rename services across the entire project.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Test generation — write unit tests for any selected code.</span></div>
        `}
      </div>
      <div class="actions">
        <button class="btn-p" onclick="post('openDashboard')">Open dashboard</button>
        <button class="btn-s" onclick="post('setKey')">${hasApiKey ? 'Update API key' : 'Paste API key'}</button>
        ${hasApiKey ? '<button class="btn-s" onclick="post(\'openSidebar\')">Open chat</button>' : ''}
        ${hasApiKey ? `<button class="btn-s" onclick="post('toggleInline')">${inline ? 'Disable' : 'Enable'} inline</button>` : ''}
        ${hasApiKey ? '<button class="btn-r" onclick="post(\'signOut\')">Sign out</button>' : ''}
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">Keyboard shortcuts</div>
      <div class="kbds">
        <div class="kbd-row"><span class="kbd-desc">Explain code</span><span class="kbd">Ctrl+Shift+E</span></div>
        <div class="kbd-row"><span class="kbd-desc">Fix bug</span><span class="kbd">Ctrl+Shift+F</span></div>
        <div class="kbd-row"><span class="kbd-desc">Generate</span><span class="kbd">Ctrl+Shift+G</span></div>
        <div class="kbd-row"><span class="kbd-desc">Explain file</span><span class="kbd">Ctrl+Shift+D</span></div>
        <div class="kbd-row"><span class="kbd-desc">Write tests</span><span class="kbd">Ctrl+Shift+T</span></div>
        <div class="kbd-row"><span class="kbd-desc">Scaffold</span><span class="kbd">Ctrl+Shift+S</span></div>
      </div>
      <div style="margin-top:12px;font-size:11px;color:#555b6a;line-height:1.7">
        Right-click selected code for context menu.<br>
        Use <strong style="color:#7eb8f9">/</strong> in chat for slash commands.<br>
        All commands available in Command Palette (Ctrl+Shift+P → DevMind).
      </div>
    </div>
  </div>

  <div class="footer">Aakash Singh, Founder · DevMind AI by SinghJitech · Made in India 🇮🇳</div>
</div>
<script>
const vscode = acquireVsCodeApi();
function post(t) { vscode.postMessage({ type: t }); }
</script>
</body>
</html>`;
}

export function deactivate() {}
