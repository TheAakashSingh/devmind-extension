import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/completionProvider';
import { SidebarProvider } from './providers/sidebarProvider';
import { DeepSeekClient } from './utils/deepseekClient';
import { UsageTracker } from './utils/usageTracker';

let client: DeepSeekClient;
let usage: UsageTracker;

const DEFAULT_SERVER_URL    = 'https://api-devmind.singhjitech.com';
const DEFAULT_DASHBOARD_URL = 'https://app-devmind.singhjitech.com';

export function activate(context: vscode.ExtensionContext) {
  const config       = vscode.workspace.getConfiguration('devmind');
  const apiKey       = config.get<string>('apiKey', '');
  const serverUrl    = config.get<string>('serverUrl', DEFAULT_SERVER_URL);
  const dashboardUrl = config.get<string>('dashboardUrl', DEFAULT_DASHBOARD_URL);

  client = new DeepSeekClient(serverUrl, apiKey);
  usage  = new UsageTracker(context);

  // ── Status bar ──
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'devmind.openOnboarding';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // ── Sidebar ──
  const sidebar = new SidebarProvider(context.extensionUri, client, usage, dashboardUrl);

  // ── Helpers ──
  const refreshBar = () => {
    const key = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!key) {
      statusBar.text    = '$(sparkle) DevMind';
      statusBar.tooltip = 'Open DevMind — verify with Gmail OTP and paste your API key.';
      return;
    }
    const rem = usage.getRemaining();
    statusBar.text    = `$(sparkle) DevMind ${rem}`;
    statusBar.tooltip = `DevMind AI — ${rem} requests left today · Plan: ${usage.getPlan()}`;
  };

  const syncPlan = async () => {
    const key = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!key) {
      usage.setPlan('free');
      refreshBar();
      return;
    }
    try {
      const v = await client.validate();
      if (v.valid) { usage.setPlan(v.plan || 'free'); }
    } catch {
      // Keep local plan when server is unreachable
    } finally {
      refreshBar();
      sidebar.refresh();
    }
  };

  refreshBar();
  usage.onChange(refreshBar);

  // ── Providers ──
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new InlineCompletionProvider(client, usage)
    ),
    vscode.window.registerWebviewViewProvider('devmind.chatView', sidebar)
  );

  // ── Commands ──
  const openDashboard = async () => {
    await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
  };

  const openOnboarding = () => {
    const panel = vscode.window.createWebviewPanel(
      'devmindOnboarding',
      'DevMind — Getting Started',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const hasKey = Boolean(
      vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '')
    );
    panel.webview.html = getOnboardingHtml(hasKey);

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'openDashboard':
          await openDashboard();
          break;
        case 'setKey':
          await vscode.commands.executeCommand('devmind.setKey');
          break;
        case 'openSidebar':
          await vscode.commands.executeCommand('devmind.chatView.focus');
          panel.dispose();
          break;
        case 'signOut':
          await vscode.commands.executeCommand('devmind.signOut');
          panel.dispose();
          break;
      }
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('devmind.explain',       () => runAction('explain')),
    vscode.commands.registerCommand('devmind.fix',           () => runAction('fix')),
    vscode.commands.registerCommand('devmind.refactor',      () => runAction('refactor')),
    vscode.commands.registerCommand('devmind.generate',      () => runGenerate()),
    vscode.commands.registerCommand('devmind.chat',          () =>
      vscode.commands.executeCommand('devmind.chatView.focus')),
    vscode.commands.registerCommand('devmind.openDashboard', openDashboard),
    vscode.commands.registerCommand('devmind.openOnboarding', openOnboarding),

    vscode.commands.registerCommand('devmind.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Sign out of DevMind?', { modal: true }, 'Sign out'
      );
      if (confirm !== 'Sign out') { return; }
      await vscode.workspace.getConfiguration('devmind').update('apiKey', '', true);
      client.setKey('');
      usage.setPlan('free');
      await syncPlan();
      vscode.window.showInformationMessage('Signed out of DevMind.');
    }),

    vscode.commands.registerCommand('devmind.setKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt:      'Paste your DevMind API key',
        placeHolder: 'dm_...',
        password:    true,
      });
      if (!key) { return; }
      await vscode.workspace.getConfiguration('devmind').update('apiKey', key, true);
      client.setKey(key);
      await syncPlan();
      vscode.window.showInformationMessage('DevMind connected! Open the sidebar to start.');
    }),

    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('devmind')) { return; }
      const cfg = vscode.workspace.getConfiguration('devmind');
      client.updateConfig(
        cfg.get<string>('serverUrl', serverUrl),
        cfg.get<string>('apiKey', '')
      );
      await syncPlan();
    })
  );

  // ── Startup ──
  if (!apiKey) {
    setTimeout(openOnboarding, 700);
  } else {
    void syncPlan();
  }
}

// ── Action runner ──
async function runAction(action: 'explain' | 'fix' | 'refactor') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) { return; }

  const code = editor.document.getText(editor.selection);
  if (!code.trim()) {
    vscode.window.showWarningMessage('Select some code first.');
    return;
  }

  const language = editor.document.languageId;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DevMind: ${action}…` },
    async () => {
      try {
        const result = await (client as any).action(action, code, language);
        const doc = await vscode.workspace.openTextDocument({
          content:  result,
          language: action === 'explain' ? 'markdown' : language,
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch (err: any) {
        vscode.window.showErrorMessage(`DevMind: ${err.message}`);
      }
    }
  );
}

// ── Generate runner ──
async function runGenerate() {
  const editor   = vscode.window.activeTextEditor;
  const language = editor?.document.languageId || 'typescript';

  const prompt = await vscode.window.showInputBox({
    prompt:      'Describe what you want DevMind to generate',
    placeHolder: 'e.g. async function to fetch paginated user orders',
  });
  if (!prompt) { return; }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DevMind: generating…' },
    async () => {
      try {
        const code = await (client as any).generate(prompt, language);
        if (editor) {
          await editor.edit((b) => b.insert(editor.selection.active, code));
        }
      } catch (err: any) {
        vscode.window.showErrorMessage(`DevMind: ${err.message}`);
      }
    }
  );
}

// ── Onboarding HTML ──
function getOnboardingHtml(hasApiKey: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    color: #e2e8f0;
    background: #0d1117;
    min-height: 100vh;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 32px 16px;
  }
  .card {
    width: 100%;
    max-width: 680px;
    background: #161b22;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 16px;
    padding: 28px;
  }
  .badge {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 5px 12px; border-radius: 20px;
    background: rgba(79,142,247,0.12);
    border: 1px solid rgba(79,142,247,0.25);
    color: #7eb8f9; font-size: 11px; font-weight: 600;
    margin-bottom: 18px;
  }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: #34d399; }
  h1 {
    font-size: 22px; font-weight: 700;
    letter-spacing: -0.04em; line-height: 1.2;
    margin-bottom: 10px; color: #f1f5f9;
    white-space: normal; word-wrap: break-word;
  }
  .sub {
    color: #8b909e; line-height: 1.65; margin-bottom: 24px;
    white-space: normal; word-wrap: break-word;
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }
  .panel {
    background: rgba(255,255,255,0.03);
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 12px;
    padding: 18px;
  }
  .panel-title {
    font-size: 12px; font-weight: 600;
    color: #cbd5e1; margin-bottom: 14px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .steps { display: flex; flex-direction: column; gap: 10px; }
  .step { display: flex; gap: 10px; align-items: flex-start; }
  .step-num {
    width: 22px; height: 22px; border-radius: 50%;
    background: rgba(79,142,247,0.15);
    color: #7eb8f9; font-size: 10px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0; margin-top: 1px;
  }
  .step-text {
    font-size: 12px; color: #94a3b8; line-height: 1.55;
    white-space: normal; word-wrap: break-word;
  }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  button {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 14px; border-radius: 8px;
    font-size: 12px; font-weight: 600;
    cursor: pointer; border: none; font-family: inherit;
    transition: all 0.15s; white-space: nowrap;
  }
  .btn-primary {
    background: #4f8ef7; color: #fff;
  }
  .btn-primary:hover { background: #3b7ef6; }
  .btn-secondary {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.1);
    color: #cbd5e1;
  }
  .btn-secondary:hover { background: rgba(255,255,255,0.1); }
  .status-note {
    display: flex; align-items: center; gap: 6px;
    margin-top: 14px; font-size: 11px;
    color: ${hasApiKey ? '#34d399' : '#f87171'};
  }
  .status-dot {
    width: 6px; height: 6px; border-radius: 50; flex-shrink: 0;
    background: ${hasApiKey ? '#34d399' : '#f87171'};
    border-radius: 50%;
  }
  .footer {
    margin-top: 22px; padding-top: 16px;
    border-top: 1px solid rgba(255,255,255,0.06);
    font-size: 11px; color: #555b6a;
  }
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="dot"></span>DevMind AI by SinghJitech</div>
  <h1>Sign up in the dashboard, then connect this extension.</h1>
  <p class="sub">The DevMind dashboard uses Gmail-only OTP verification. After you verify, copy your API key and paste it below.</p>

  <div class="grid">
    <div class="panel">
      <div class="panel-title">How to get started</div>
      <div class="steps">
        <div class="step"><span class="step-num">1</span><span class="step-text">Open the DevMind dashboard and sign in with your Gmail address.</span></div>
        <div class="step"><span class="step-num">2</span><span class="step-text">Enter the 6-digit OTP sent by email to verify your workspace.</span></div>
        <div class="step"><span class="step-num">3</span><span class="step-text">Copy your API key from the dashboard's API Keys page.</span></div>
        <div class="step"><span class="step-num">4</span><span class="step-text">Click "Paste API key" below and start coding with AI.</span></div>
      </div>
      <div class="actions">
        <button class="btn-primary" onclick="post('openDashboard')">Open dashboard</button>
        <button class="btn-secondary" onclick="post('setKey')">Paste API key</button>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">Extension features</div>
      <div class="steps">
        <div class="step"><span class="step-num">✦</span><span class="step-text">AI chat sidebar — ask anything about your code.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Inline autocomplete — tab to accept suggestions.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Explain, fix, and refactor via right-click menu.</span></div>
        <div class="step"><span class="step-num">✦</span><span class="step-text">Generate code from a natural language description.</span></div>
      </div>
      <div class="actions">
        <button class="btn-secondary" onclick="post('openSidebar')">Open sidebar</button>
        <button class="btn-secondary" onclick="post('signOut')">${hasApiKey ? 'Sign out' : 'Reset key'}</button>
      </div>
      <div class="status-note">
        <span class="status-dot"></span>
        ${hasApiKey ? 'API key is connected and active.' : 'No API key stored — paste one to connect.'}
      </div>
    </div>
  </div>

  <div class="footer">Aakash Singh, Founder · DevMind AI by SinghJitech</div>
</div>

<script>
const vscode = acquireVsCodeApi();
function post(type) { vscode.postMessage({ type }); }
</script>
</body>
</html>`;
}

export function deactivate() {}