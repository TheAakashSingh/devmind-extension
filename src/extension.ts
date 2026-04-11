import * as vscode from 'vscode';
import { InlineCompletionProvider } from './providers/completionProvider';
import { SidebarProvider } from './providers/sidebarProvider';
import { DeepSeekClient } from './utils/deepseekClient';
import { UsageTracker } from './utils/usageTracker';

let client: DeepSeekClient;
let usage: UsageTracker;

const DEFAULT_SERVER_URL = 'https://api-devmind.singhjitech.com';
const DEFAULT_DASHBOARD_URL = 'https://app-devmind.singhjitech.com';
export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('devmind');
  const apiKey = config.get<string>('apiKey', '');
  const serverUrl = config.get<string>('serverUrl', DEFAULT_SERVER_URL);
  const dashboardUrl = config.get<string>('dashboardUrl', DEFAULT_DASHBOARD_URL);

  client = new DeepSeekClient(serverUrl, apiKey);
  usage = new UsageTracker(context);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'devmind.openOnboarding';
  statusBar.show();
  context.subscriptions.push(statusBar);

  const sidebar = new SidebarProvider(context.extensionUri, client, usage, dashboardUrl);

  const refreshBar = () => {
    const currentKey = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!currentKey) {
      statusBar.text = '$(sparkle) DevMind';
      statusBar.tooltip = 'Open the DevMind dashboard, verify with Gmail OTP, and paste your API key.';
      return;
    }

    const remaining = usage.getRemaining();
    statusBar.text = `$(sparkle) DevMind ${remaining}`;
    statusBar.tooltip = `DevMind AI by SinghJitech - ${remaining} requests left today - Plan: ${usage.getPlan()}`;
  };

  const syncPlan = async () => {
    const currentKey = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!currentKey) {
      usage.setPlan('free');
      refreshBar();
      return;
    }

    try {
      const validation = await client.validate();
      if (validation.valid) {
        usage.setPlan(validation.plan || 'free');
      }
    } catch {
      // Keep the local plan when the server is unavailable.
    } finally {
      refreshBar();
      sidebar.refresh();
    }
  };

  refreshBar();
  usage.onChange(refreshBar);

  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      new InlineCompletionProvider(client, usage)
    )
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devmind.chatView', sidebar)
  );

  const openDashboard = async () => {
    await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
  };

  const openOnboarding = () => {
    const panel = vscode.window.createWebviewPanel(
      'devmindOnboarding',
      'DevMind AI by SinghJitech',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getOnboardingHtml(Boolean(vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '')));

    panel.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
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
    vscode.commands.registerCommand('devmind.explain', () => runAction('explain')),
    vscode.commands.registerCommand('devmind.fix', () => runAction('fix')),
    vscode.commands.registerCommand('devmind.refactor', () => runAction('refactor')),
    vscode.commands.registerCommand('devmind.generate', () => runGenerate()),
    vscode.commands.registerCommand('devmind.chat', () => vscode.commands.executeCommand('devmind.chatView.focus')),
    vscode.commands.registerCommand('devmind.openDashboard', () => openDashboard()),
    vscode.commands.registerCommand('devmind.openOnboarding', () => openOnboarding()),
    vscode.commands.registerCommand('devmind.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Sign out of DevMind?',
        { modal: true },
        'Sign out'
      );

      if (confirm !== 'Sign out') return;

      await vscode.workspace.getConfiguration('devmind').update('apiKey', '', true);
      client.setKey('');
      usage.setPlan('free');
      await syncPlan();
      vscode.window.showInformationMessage('You have been signed out of DevMind.');
    }),
    vscode.commands.registerCommand('devmind.setKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Paste your DevMind API key',
        placeHolder: 'dm_...',
        password: true,
      });

      if (!key) return;

      await vscode.workspace.getConfiguration('devmind').update('apiKey', key, true);
      client.setKey(key);
      await syncPlan();
      vscode.window.showInformationMessage('DevMind is connected. Open the sidebar to start coding.');
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('devmind')) return;

      const currentConfig = vscode.workspace.getConfiguration('devmind');
      client.updateConfig(
        currentConfig.get<string>('serverUrl', serverUrl),
        currentConfig.get<string>('apiKey', '')
      );

      await syncPlan();
    })
  );

  if (!apiKey) {
    setTimeout(openOnboarding, 700);
  } else {
    void syncPlan();
  }
}

async function runAction(action: 'explain' | 'fix' | 'refactor') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const code = editor.document.getText(editor.selection);
  if (!code.trim()) {
    vscode.window.showWarningMessage('Select some code first.');
    return;
  }

  const language = editor.document.languageId;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `DevMind: ${action}...` },
    async () => {
      try {
        const result = await client.action(action, code, language);
        const doc = await vscode.workspace.openTextDocument({
          content: result,
          language: action === 'explain' ? 'markdown' : language,
        });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
      } catch (error: any) {
        vscode.window.showErrorMessage(`DevMind: ${error.message}`);
      }
    }
  );
}

async function runGenerate() {
  const editor = vscode.window.activeTextEditor;
  const language = editor?.document.languageId || 'typescript';
  const prompt = await vscode.window.showInputBox({
    prompt: 'Describe what you want DevMind to generate',
    placeHolder: 'e.g. async function to fetch paginated user orders',
  });

  if (!prompt) return;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'DevMind: generating...' },
    async () => {
      try {
        const code = await client.generate(prompt, language);
        if (editor) {
          await editor.edit((builder) => builder.insert(editor.selection.active, code));
        }
      } catch (error: any) {
        vscode.window.showErrorMessage(`DevMind: ${error.message}`);
      }
    }
  );
}

function getOnboardingHtml(hasApiKey: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
    color: #edf4ff;
    background:
      radial-gradient(circle at top left, rgba(56,189,248,.24), transparent 22%),
      radial-gradient(circle at top right, rgba(244,114,182,.18), transparent 20%),
      linear-gradient(180deg, #07111f 0%, #08101b 100%);
  }
  .shell {
    min-height: 100vh;
    padding: 24px;
    display: grid;
    place-items: center;
  }
  .card {
    width: min(860px, 100%);
    padding: 28px;
    border-radius: 24px;
    border: 1px solid rgba(148,163,184,.16);
    background: rgba(8,16,30,.9);
    box-shadow: 0 22px 80px rgba(0,0,0,.3);
  }
  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-radius: 999px;
    background: rgba(56,189,248,.12);
    color: #8fe3ff;
    font-size: 12px;
    font-weight: 700;
  }
  h1 {
    margin: 16px 0 8px;
    font-size: clamp(28px, 4vw, 48px);
    line-height: 1;
    letter-spacing: -0.05em;
  }
  p {
    margin: 0;
    color: #9fb2ce;
    line-height: 1.7;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    margin-top: 24px;
  }
  .panel {
    padding: 20px;
    border-radius: 20px;
    border: 1px solid rgba(148,163,184,.14);
    background: rgba(255,255,255,.03);
  }
  .steps {
    display: grid;
    gap: 12px;
    margin-top: 14px;
  }
  .step {
    display: flex;
    gap: 12px;
    color: #dce7f7;
  }
  .step b {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: 999px;
    background: rgba(56,189,248,.12);
    color: #8fe3ff;
    flex: 0 0 auto;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 16px;
  }
  button {
    min-height: 44px;
    padding: 0 16px;
    border: 0;
    border-radius: 14px;
    cursor: pointer;
    font-weight: 700;
  }
  .primary { background: linear-gradient(135deg, #38bdf8, #818cf8 58%, #f472b6); color: white; }
  .secondary { background: rgba(255,255,255,.04); color: #ecf5ff; border: 1px solid rgba(148,163,184,.18); }
  .note { margin-top: 14px; color: #86efac; font-size: 13px; }
  @media (max-width: 760px) {
    .shell { padding: 16px; }
    .grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <span class="eyebrow">DevMind AI by SinghJitech</span>
      <h1>Sign up in the dashboard, then connect this extension.</h1>
      <p>
        The DevMind dashboard uses Gmail-only OTP verification. After you verify, copy your API key and paste it here.
      </p>

      <div class="grid">
        <div class="panel">
          <strong>How to get started</strong>
          <div class="steps">
            <div class="step"><b>1</b><span>Open the DevMind dashboard and create or sign in with your Gmail address.</span></div>
            <div class="step"><b>2</b><span>Enter the 6-digit OTP sent by SMTP and verify your workspace.</span></div>
            <div class="step"><b>3</b><span>Copy your API key from the dashboard's API key page.</span></div>
            <div class="step"><b>4</b><span>Paste the key with "DevMind: Set API Key" and start coding.</span></div>
          </div>
          <div class="actions">
            <button class="primary" onclick="post('openDashboard')">Open dashboard</button>
            <button class="secondary" onclick="post('setKey')">Paste API key</button>
          </div>
        </div>

        <div class="panel">
          <strong>Extension flow</strong>
          <p style="margin-top:14px;">
            Your AI chat, inline autocomplete, fix, refactor and generate features all use the same API key
            after you finish dashboard verification.
          </p>
          <div class="actions">
            <button class="secondary" onclick="post('openSidebar')">Open sidebar</button>
            <button class="secondary" onclick="post('signOut')">${hasApiKey ? 'Sign out' : 'Reset key'}</button>
          </div>
          <div class="note">${hasApiKey ? 'A key is already stored locally.' : 'No API key is stored yet.'}</div>
        </div>
      </div>
      <div class="note" style="color:#9fb2ce;margin-top:18px;">Aakash Singh, Founder</div>
    </div>
  </div>

<script>
const vscode = acquireVsCodeApi();
function post(type) {
  vscode.postMessage({ type });
}
</script>
</body>
</html>`;
}

export function deactivate() {}
