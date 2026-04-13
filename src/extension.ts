import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { InlineCompletionProvider } from './providers/completionProvider';
import { SidebarProvider } from './providers/sidebarProvider';
import { DeepSeekClient } from './utils/deepseekClient';
import { UsageTracker } from './utils/usageTracker';
import { initIndexer, getIndexer } from './utils/codebaseIndexer';
import { getDiffProvider } from './providers/diffProvider';
import { evaluateRisk, toRiskMarkdown } from './utils/riskEngine';
import { runHybridImplementPlan } from './utils/planExecutor';
import { codeQualityIssues } from './utils/qualityGuards';
import {
  collectProjectContext,
  collectFileContext,
  buildContextPrompt,
  optimizePrompt,
} from './utils/contextCollector';

let client: DeepSeekClient;
let usage: UsageTracker;
let sidebar: SidebarProvider;
const execAsync = promisify(exec);

const DEFAULT_SERVER = 'https://api-devmind.singhjitech.com';
const DEFAULT_DASHBOARD = 'https://app-devmind.singhjitech.com';

// ── Enhanced Constants ──────────────────────────────────────────────────────
const EXTENDED_TIMEOUT = 30 * 60 * 1000; // 30 minutes in milliseconds
const FILE_WRITE_RETRY_ATTEMPTS = 3;
const FILE_WRITE_RETRY_DELAY = 500; // milliseconds

// ── File Creation Utilities ────────────────────────────────────────────────────

/**
 * Creates a directory recursively with retry logic
 */
async function ensureDirectoryExists(dirPath: string): Promise<boolean> {
  for (let attempt = 0; attempt < FILE_WRITE_RETRY_ATTEMPTS; attempt++) {
    try {
      if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
      }
      return true;
    } catch (e: any) {
      if (attempt === FILE_WRITE_RETRY_ATTEMPTS - 1) {
        console.error(`[DevMind] Failed to create directory after ${FILE_WRITE_RETRY_ATTEMPTS} attempts:`, e);
        throw new Error(`Cannot create directory: ${dirPath} (${e.message})`);
      }
      await delay(FILE_WRITE_RETRY_DELAY * (attempt + 1));
    }
  }
  return false;
}

/**
 * Writes file content with retry logic and proper error handling
 */
async function writeFileWithRetry(filePath: string, content: string): Promise<boolean> {
  const dirPath = path.dirname(filePath);
  await ensureDirectoryExists(dirPath);

  for (let attempt = 0; attempt < FILE_WRITE_RETRY_ATTEMPTS; attempt++) {
    try {
      // Use atomic write: write to temp file first, then rename
      const tempPath = `${filePath}.tmp`;
      fs.writeFileSync(tempPath, content, 'utf8');
      
      // Verify write was successful
      const written = fs.readFileSync(tempPath, 'utf8');
      if (written !== content) {
        throw new Error('Content verification failed');
      }
      
      // Atomic rename
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tempPath, filePath);
      
      console.log(`[DevMind] Successfully wrote: ${filePath}`);
      return true;
    } catch (e: any) {
      if (attempt === FILE_WRITE_RETRY_ATTEMPTS - 1) {
        console.error(`[DevMind] Failed to write file after ${FILE_WRITE_RETRY_ATTEMPTS} attempts:`, e);
        throw new Error(`Cannot write file: ${path.basename(filePath)} (${e.message})`);
      }
      await delay(FILE_WRITE_RETRY_DELAY * (attempt + 1));
    }
  }
  return false;
}

/**
 * Batch write multiple files with progress tracking
 */
async function writeMultipleFiles(
  files: Array<{ path: string; content: string }>,
  wsRoot: string,
  onProgress?: (current: number, total: number, filePath: string) => void
): Promise<Array<{ path: string; success: boolean; error?: string }>> {
  const results: Array<{ path: string; success: boolean; error?: string }> = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fullPath = path.join(wsRoot, file.path);
    
    onProgress?.(i + 1, files.length, file.path);

    try {
      await writeFileWithRetry(fullPath, file.content);
      results.push({ path: file.path, success: true });
    } catch (e: any) {
      results.push({ path: file.path, success: false, error: e.message });
      console.error(`[DevMind] Error writing ${file.path}:`, e);
    }
  }

  return results;
}

/**
 * Simple delay utility
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Opens file in editor after creation
 */
async function openFileInEditor(filePath: string): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e: any) {
    console.warn(`[DevMind] Could not open file in editor:`, e);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('[DevMind] Extension activating...');
  const cfg = vscode.workspace.getConfiguration('devmind');
  const apiKey = cfg.get<string>('apiKey', '');
  const serverUrl = cfg.get<string>('serverUrl', DEFAULT_SERVER);
  const dashboardUrl = cfg.get<string>('dashboardUrl', DEFAULT_DASHBOARD);

  client = new DeepSeekClient(serverUrl, apiKey);
  usage = new UsageTracker(context);
  sidebar = new SidebarProvider(context, context.extensionUri, client, usage, dashboardUrl);

  // ── Init codebase indexer ──────────────────────────────────────────────────
  const indexer = initIndexer(context);
  context.subscriptions.push({ dispose: () => indexer.dispose() });
  indexer.start().catch(() => {});

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => indexer.rebuild())
  );

  // ── Status bar ─────────────────────────────────────────────────────────────
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  bar.command = 'devmind.openOnboarding';
  bar.show();
  context.subscriptions.push(bar);

  function refreshBar() {
    const key = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    const inline = vscode.workspace.getConfiguration('devmind').get<boolean>('enableInline', true);
    if (!key) {
      bar.text = '$(sparkle) DevMind';
      bar.tooltip = 'DevMind AI — click to connect';
      return;
    }
    const rem = usage.getRemaining();
    const plan = usage.getPlan().toUpperCase();
    const files = getIndexer()?.getFiles().length || 0;
    bar.text = `$(sparkle) DevMind ${rem}`;
    bar.tooltip = [
      `DevMind AI v2.3 (Enhanced)`,
      `Requests left: ${rem}`,
      `Plan: ${plan}`,
      `Inline: ${inline ? 'ON' : 'OFF'}`,
      `Indexed: ${files} files`,
      `Click to manage account`,
    ].join('\n');
  }

  async function syncPlan() {
    const key = vscode.workspace.getConfiguration('devmind').get<string>('apiKey', '');
    if (!key) {
      usage.setPlan('free');
      refreshBar();
      return;
    }
    try {
      const v = await client.validate();
      if (v.valid && v.plan) usage.setPlan(v.plan);
    } catch { }
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
    vscode.window.registerWebviewViewProvider('devmind.chatView', sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  // ── Commands ───────────────────────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand('devmind.explain', () => runAction('explain')),
    vscode.commands.registerCommand('devmind.fix', () => runAction('fix')),
    vscode.commands.registerCommand('devmind.refactor', () => runAction('refactor')),
    vscode.commands.registerCommand('devmind.generate', () => runGenerate()),
    vscode.commands.registerCommand('devmind.plan', () => runPlan()),
    vscode.commands.registerCommand('devmind.verifyWorkspace', () => runVerifyWorkspace()),
    vscode.commands.registerCommand('devmind.autoHeal', () => runAutoHeal()),
    vscode.commands.registerCommand('devmind.prSummary', () => runPrSummary()),
    vscode.commands.registerCommand('devmind.implementPlan', () => runImplementPlan()),

    vscode.commands.registerCommand('devmind.explainFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const doc = editor.document;
      const proj = collectProjectContext();
      const ctx = buildContextPrompt(proj, null);
      await withProgress('DevMind: Analysing file…', async () => {
        try {
          const result = await client.explainFile(doc.getText(), path.basename(doc.fileName), doc.languageId, ctx);
          await openResult(result, 'markdown');
        } catch (e: any) {
          showErr(e);
        }
      });
    }),

    vscode.commands.registerCommand('devmind.generateTests', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const code = editor.document.getText(editor.selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('DevMind: Select code to test first.');
        return;
      }
      const proj = collectProjectContext();
      const file = collectFileContext();
      const ctx = buildContextPrompt(proj, file);
      await withProgress('DevMind: Writing tests…', async () => {
        try {
          const tests = await client.generateTests(code, file?.language || 'typescript', file?.fileName || 'file', ctx);
          await openResult(tests, file?.language || 'typescript');
          await autoVerifyIfEnabled();
        } catch (e: any) {
          showErr(e);
        }
      });
    }),

    vscode.commands.registerCommand('devmind.multiRefactor', async () => {
      const instruction = await vscode.window.showInputBox({
        prompt: 'Refactor instruction across files',
        placeHolder: 'e.g. rename OrderService to TransactionService everywhere',
        ignoreFocusOut: true,
      });
      if (!instruction) return;

      const proj = collectProjectContext();
      const ctx = buildContextPrompt(proj, null);
      const opt = optimizePrompt(instruction, proj);
      const docs = vscode.workspace.textDocuments
        .filter(d => !d.isUntitled && !d.uri.path.includes('node_modules'))
        .slice(0, 10);

      if (!docs.length) {
        vscode.window.showWarningMessage('DevMind: Open files to refactor first.');
        return;
      }

      const files = docs.map(d => ({ path: d.fileName, content: d.getText() }));
      await withProgress('DevMind: Refactoring…', async () => {
        try {
          const result = await client.multiRefactor({ instruction: opt, files, language: proj.language, projectCtx: ctx });
          const diffProvider = getDiffProvider();
          const edits = result.files.map(f => ({
            id: f.path,
            filePath: vscode.workspace.asRelativePath(f.path),
            fileName: path.basename(f.path),
            oldContent: files.find(x => x.path === f.path)?.content || '',
            newContent: f.content,
            description: f.summary || instruction,
          }));
          const { accepted, rejected } = await diffProvider.proposeMultiEdit(edits, instruction);
          vscode.window.showInformationMessage(`DevMind: Applied ${accepted} file(s), skipped ${rejected}.`);
          if (accepted > 0) await autoVerifyIfEnabled();
        } catch (e: any) {
          showErr(e);
        }
      });
    }),

    vscode.commands.registerCommand('devmind.scaffold', async () => {
      const type = await vscode.window.showQuickPick([
        { label: '$(shield) Auth System', description: 'JWT register, login, refresh', id: 'auth' },
        { label: '$(cloud) REST API', description: 'Full CRUD REST endpoint', id: 'api' },
        { label: '$(database) CRUD Module', description: 'Model, controller, routes', id: 'crud' },
        { label: '$(table) DB Schema', description: 'Schema with relations', id: 'schema' },
        { label: '$(gear) Admin Panel', description: 'Admin routes and middleware', id: 'admin' },
        { label: '$(server) Express Server', description: 'Boilerplate server', id: 'server' },
        { label: '$(pencil) Custom Module', description: 'Describe what you need', id: 'custom' },
      ], { placeHolder: 'What to scaffold?' });
      if (!type) return;

      const name = await vscode.window.showInputBox({
        prompt: `Module name`,
        placeHolder: 'e.g. user, order, product',
        ignoreFocusOut: true,
      });
      if (!name) return;

      let extra = '';
      if (type.id === 'custom') {
        extra = await vscode.window.showInputBox({
          prompt: 'Describe what to generate',
          ignoreFocusOut: true,
        }) || '';
      }

      const proj = collectProjectContext();
      const ctxPrompt = buildContextPrompt(proj, null);
      await withProgress(`DevMind: Scaffolding ${name} ${type.id}…`, async () => {
        try {
          const scaffoldType = type.id + (extra ? `:${extra}` : '');
          const result = await client.scaffold({
            type: scaffoldType,
            name,
            language: proj.language,
            projectCtx: ctxPrompt,
          });
          const wsRoot = proj.rootPath;

          if (!wsRoot) {
            vscode.window.showWarningMessage('DevMind: No workspace folder found. Opening files in temp documents.');
            for (const file of result.files) {
              const d = await vscode.workspace.openTextDocument({
                content: `// ${file.path}\n${file.content}`,
                language: proj.language,
              });
              await vscode.window.showTextDocument(d, { preview: false });
            }
            return;
          }

          // Enhanced: Use batch file writing with progress tracking
          const filesToWrite = result.files.map(f => ({
            path: f.path,
            content: f.content,
          }));

          const writeResults = await writeMultipleFiles(filesToWrite, wsRoot, (current, total, filePath) => {
            console.log(`[DevMind] Writing file ${current}/${total}: ${filePath}`);
          });

          // Count successes and failures
          const successful = writeResults.filter(r => r.success);
          const failed = writeResults.filter(r => !r.success);

          // Open the first file in editor
          if (successful.length > 0) {
            const firstFile = path.join(wsRoot, successful[0].path);
            await openFileInEditor(firstFile);
          }

          // Re-index workspace
          getIndexer()?.rebuild();

          // Show results
          if (failed.length === 0) {
            vscode.window.showInformationMessage(
              `DevMind: Generated ${successful.length} file(s) for ${name}. All files created successfully!`
            );
          } else {
            vscode.window.showWarningMessage(
              `DevMind: Generated ${successful.length}/${result.files.length} file(s). ${failed.length} file(s) failed.`
            );
            console.warn('[DevMind] Failed files:', failed);
          }

          await autoVerifyIfEnabled();
        } catch (e: any) {
          showErr(e);
        }
      });
    }),

    vscode.commands.registerCommand('devmind.createAuth', () => quickScaffold('auth', 'auth')),
    vscode.commands.registerCommand('devmind.createApi', () => quickScaffold('api', 'api')),
    vscode.commands.registerCommand('devmind.createCrud', () => quickScaffold('crud', 'resource')),
    vscode.commands.registerCommand('devmind.createSchema', () => quickScaffold('schema', 'model')),
    vscode.commands.registerCommand('devmind.createAdmin', () => quickScaffold('admin', 'admin')),
    vscode.commands.registerCommand('devmind.createServer', () => quickScaffold('server', 'server')),

    vscode.commands.registerCommand('devmind.indexCodebase', async () => {
      const indexer = getIndexer();
      if (!indexer) return;
      await withProgress('DevMind: Indexing codebase…', async () => {
        await indexer.rebuild();
        sidebar.refresh();
      });
      const count = indexer.getFiles().length;
      vscode.window.showInformationMessage(`DevMind: Indexed ${count} files.`);
      refreshBar();
    }),

    vscode.commands.registerCommand('devmind.toggleInline', async () => {
      const cur = vscode.workspace.getConfiguration('devmind').get<boolean>('enableInline', true);
      await vscode.workspace.getConfiguration('devmind').update('enableInline', !cur, true);
      vscode.window.showInformationMessage(`DevMind: Inline ${!cur ? 'enabled' : 'disabled'}.`);
      refreshBar();
    }),

    vscode.commands.registerCommand('devmind.chat', () => vscode.commands.executeCommand('devmind.chatView.focus')),
    vscode.commands.registerCommand('devmind.openDashboard', () => vscode.env.openExternal(vscode.Uri.parse(dashboardUrl))),

    vscode.commands.registerCommand('devmind.checkConnection', async () => {
      await withProgress('DevMind: Checking server and login…', async () => {
        const health = await client.health();
        const valid = await client.validate();
        if (!health.ok) {
          vscode.window.showErrorMessage('DevMind: Server is unreachable. Check `devmind.serverUrl` and internet.');
          return;
        }
        if (!valid.valid) {
          vscode.window.showWarningMessage('DevMind: Server is up, but API key is invalid/expired. Run DevMind: Set API Key.');
          return;
        }
        vscode.window.showInformationMessage(
          `DevMind: Connected. Plan ${String(valid.plan || 'free').toUpperCase()}, ${valid.remaining ?? 0} requests left.`
        );
      });
    }),

    vscode.commands.registerCommand('devmind.openOnboarding', () => {
      const panel = vscode.window.createWebviewPanel(
        'devmindOnboarding',
        'DevMind — Account',
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const hasKey = Boolean(vscode.workspace.getConfiguration('devmind').get<string>('apiKey', ''));
      const inline = vscode.workspace.getConfiguration('devmind').get<boolean>('enableInline', true);
      const plan = usage.getPlan();
      const remaining = usage.getRemaining();
      const files = getIndexer()?.getFiles().length || 0;
      panel.webview.html = buildOnboardingHtml(hasKey, plan, remaining, inline, files);
      panel.webview.onDidReceiveMessage(async (msg) => {
        switch (msg.type) {
          case 'openDashboard':
            await vscode.env.openExternal(vscode.Uri.parse(dashboardUrl));
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
          case 'toggleInline':
            await vscode.commands.executeCommand('devmind.toggleInline');
            break;
          case 'reindex':
            await vscode.commands.executeCommand('devmind.indexCodebase');
            break;
        }
      });
    }),

    vscode.commands.registerCommand('devmind.setKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Paste your DevMind API key (from dashboard → API Keys)',
        placeHolder: 'dm_...',
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      await vscode.workspace.getConfiguration('devmind').update('apiKey', key, true);
      client.setKey(key);
      await syncPlan();
      vscode.window.showInformationMessage('DevMind connected! Open the sidebar to start coding with AI.');
    }),

    vscode.commands.registerCommand('devmind.signOut', async () => {
      const confirm = await vscode.window.showWarningMessage('Sign out of DevMind AI?', { modal: true }, 'Sign out');
      if (confirm !== 'Sign out') return;
      await vscode.workspace.getConfiguration('devmind').update('apiKey', '', true);
      client.setKey('');
      usage.setPlan('free');
      await syncPlan();
      vscode.window.showInformationMessage('Signed out of DevMind AI.');
    }),

    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (!e.affectsConfiguration('devmind')) return;
      const c = vscode.workspace.getConfiguration('devmind');
      client.updateConfig(c.get<string>('serverUrl', serverUrl), c.get<string>('apiKey', ''));
      await syncPlan();
    })
  );

  console.log('[DevMind] Activation complete, checking API key...');
  if (!apiKey) {
    setTimeout(() => vscode.commands.executeCommand('devmind.openOnboarding'), 1200);
  } else {
    void syncPlan();
    void client.validate().then((v) => {
      if (!v.valid) {
        vscode.window.showWarningMessage('DevMind: Stored API key looks invalid. Run DevMind: Set API Key.');
      }
    }).catch(() => { });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runAction(action: 'explain' | 'fix' | 'refactor') {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const code = editor.document.getText(editor.selection);
  if (!code.trim()) {
    vscode.window.showWarningMessage('DevMind: Select some code first.');
    return;
  }
  const proj = collectProjectContext();
  const file = collectFileContext();
  const ctx = buildContextPrompt(proj, file);
  await withProgress(`DevMind: ${action}ing…`, async () => {
    try {
      const result = await client.action(action, code, file?.language || 'text', ctx);
      if (action === 'fix' || action === 'refactor') {
        const qualityIssues = codeQualityIssues(result, file?.language || 'text');
        if (qualityIssues.length >= 3) {
          vscode.window.showWarningMessage(
            `DevMind: quality guard flagged output (${qualityIssues.join(', ')}). Review carefully.`
          );
        }
        const diffProvider = getDiffProvider();
        const risk = toRiskMarkdown(action, evaluateRisk(code, result));
        await openResult(risk, 'markdown');
        await diffProvider.insertWithDiff(result, `${action} code`);
        await autoVerifyIfEnabled();
      } else {
        await openResult(result, action === 'explain' ? 'markdown' : (file?.language || 'text'));
      }
    } catch (e: any) {
      showErr(e);
    }
  });
}

async function runGenerate() {
  const editor = vscode.window.activeTextEditor;
  const proj = collectProjectContext();
  const file = collectFileContext();
  const lang = file?.language || proj.language || 'typescript';
  const rawPrompt = await vscode.window.showInputBox({
    prompt: 'Describe what to generate',
    placeHolder: 'e.g. async function to fetch paginated orders with JWT auth',
    ignoreFocusOut: true,
  });
  if (!rawPrompt) return;
  const optimized = optimizePrompt(rawPrompt, proj);
  const ctx = buildContextPrompt(proj, file);
  await withProgress('DevMind: Generating…', async () => {
    try {
      const code = await client.generate(optimized, lang, ctx);
      const qualityIssues = codeQualityIssues(code, lang);
      if (qualityIssues.length >= 3) {
        vscode.window.showWarningMessage(`DevMind: generated code quality warning (${qualityIssues.join(', ')}).`);
      }
      const diffProvider = getDiffProvider();
      const baseline = editor?.document.getText() || '';
      const risk = toRiskMarkdown('generate', evaluateRisk(baseline, code));
      await openResult(risk, 'markdown');
      await diffProvider.insertWithDiff(code, rawPrompt);
      await autoVerifyIfEnabled();
    } catch (e: any) {
      showErr(e);
    }
  });
}

async function runPlan() {
  const proj = collectProjectContext();
  const file = collectFileContext();
  const target = await vscode.window.showInputBox({
    prompt: 'Describe what to implement',
    placeHolder: 'e.g. migrate auth to refresh tokens and RBAC',
    ignoreFocusOut: true,
  });
  if (!target) return;
  const planningPrompt = [
    `Create an implementation plan for this request: ${target}`,
    `Return markdown with sections:`,
    `1) Goals`,
    `2) Files likely to change`,
    `3) Risk assessment (low/med/high per area)`,
    `4) Step-by-step execution`,
    `5) Verification checklist (lint/test/build/manual)`,
  ].join('\n');
  const ctx = buildContextPrompt(proj, file);
  await withProgress('DevMind: Building implementation plan…', async () => {
    try {
      const md = await client.action('explain', planningPrompt, file?.language || proj.language || 'text', ctx);
      await openResult(md, 'markdown');
    } catch (e: any) {
      showErr(e);
    }
  });
}

async function runVerifyWorkspace() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    vscode.window.showWarningMessage('DevMind: Open a workspace folder first.');
    return;
  }
  const checks = collectVerificationCommands(root);
  if (!checks.length) {
    vscode.window.showWarningMessage('DevMind: No lint/test/build scripts found.');
    return;
  }
  const results: Array<{ cwd: string; command: string; ok: boolean; out: string }> = [];
  await withProgress('DevMind: Running verify loop…', async () => {
    for (const item of checks) {
      try {
        // Enhanced: Extended timeout to 30 minutes
        const { stdout, stderr } = await execAsync(item.command, {
          cwd: item.cwd,
          timeout: EXTENDED_TIMEOUT,
        });
        results.push({ cwd: item.cwd, command: item.command, ok: true, out: `${stdout}\n${stderr}`.trim() });
      } catch (e: any) {
        const out = `${e?.stdout || ''}\n${e?.stderr || ''}\n${e?.message || ''}`.trim();
        results.push({ cwd: item.cwd, command: item.command, ok: false, out });
      }
    }
  });
  const md = buildVerifyReport(results, root);
  await openResult(md, 'markdown');
  const failed = results.filter(r => !r.ok).length;
  if (!failed) vscode.window.showInformationMessage(`DevMind: Verification passed (${results.length} checks).`);
  else vscode.window.showWarningMessage(`DevMind: Verification found ${failed} failing check(s).`);
}

async function runAutoHeal() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const selected = editor.document.getText(editor.selection);
  if (!selected.trim()) {
    vscode.window.showWarningMessage('DevMind: Select code first for auto-heal.');
    return;
  }
  const proj = collectProjectContext();
  const file = collectFileContext();
  const ctx = buildContextPrompt(proj, file);
  await withProgress('DevMind: Auto-heal cycle…', async () => {
    try {
      let fixed = await client.action('fix', selected, file?.language || 'text', ctx);
      await getDiffProvider().insertWithDiff(fixed, 'Auto-heal: first fix pass');
      const first = await runVerifyWorkspaceInternal();
      if (first.failed === 0) {
        vscode.window.showInformationMessage('DevMind: Auto-heal passed on first cycle.');
        return;
      }
      const failureText = first.report.slice(0, 4000);
      fixed = await client.action(
        'fix',
        `${fixed}\n\nFix remaining failures from verification:\n${failureText}`,
        file?.language || 'text',
        ctx
      );
      await getDiffProvider().insertWithDiff(fixed, 'Auto-heal: retry fix pass');
      const second = await runVerifyWorkspaceInternal();
      const msg = second.failed === 0
        ? 'DevMind: Auto-heal succeeded after retry.'
        : `DevMind: Auto-heal finished with ${second.failed} remaining failure(s).`;
      vscode.window.showInformationMessage(msg);
      await openResult(second.report, 'markdown');
    } catch (e: any) {
      showErr(e);
    }
  });
}

async function runPrSummary() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  await withProgress('DevMind: Preparing PR summary…', async () => {
    try {
      // Enhanced: Extended timeout to 30 minutes
      const [status, log, diff] = await Promise.all([
        execAsync('git status --short', { cwd: root, timeout: EXTENDED_TIMEOUT }),
        execAsync('git log -8 --oneline', { cwd: root, timeout: EXTENDED_TIMEOUT }),
        execAsync('git diff -- .', { cwd: root, timeout: EXTENDED_TIMEOUT }),
      ]);
      const verify = await runVerifyWorkspaceInternal();
      const statusLines = (status.stdout || '(clean)').trim().split('\n').filter(Boolean);
      const grouped = [
        `- feature: ${statusLines.filter((l) => l.includes('A ') || l.includes('M ')).length} file(s)`,
        `- cleanup: ${statusLines.filter((l) => l.includes('D ')).length} file(s)`,
      ].join('\n');
      const summary = [
        '# PR Summary Draft',
        '',
        '## Change overview',
        '- Describe why this change is needed',
        '- Mention impacted modules and behavior',
        '',
        '## Branch status',
        '```',
        (status.stdout || '(clean)').trim().slice(0, 2000),
        '```',
        '',
        '## Commit suggestions (grouped)',
        grouped,
        '',
        '## Recent commits',
        '```',
        (log.stdout || '').trim().slice(0, 2000),
        '```',
        '',
        '## Diff highlights',
        '```',
        (diff.stdout || '').trim().slice(0, 6000),
        '```',
        '',
        '## Verification evidence',
        '```',
        verify.report.slice(0, 4000),
        '```',
        '',
        '## Test plan checklist',
        `- [${verify.failed === 0 ? 'x' : ' '}] Build/lint/test checks`,
        '- [ ] Core workflow manually tested',
        '- [ ] Regression checks completed',
      ].join('\n');
      await openResult(summary, 'markdown');
    } catch (e: any) {
      showErr(e);
    }
  });
}

async function runImplementPlan() {
  const proj = collectProjectContext();
  const file = collectFileContext();
  const target = await vscode.window.showInputBox({
    prompt: 'Implement full plan for request',
    placeHolder: 'e.g. add audit logging with admin filters and dashboard view',
    ignoreFocusOut: true,
  });
  if (!target) return;
  const ctx = buildContextPrompt(proj, file);
  await withProgress('DevMind: Implementing plan (hybrid mode)…', async () => {
    try {
      await runHybridImplementPlan({
        client,
        target,
        language: file?.language || proj.language || 'typescript',
        contextPrompt: ctx,
        verify: runVerifyWorkspaceInternal,
        openResult,
      });
    } catch (e: any) {
      showErr(e);
    }
  });
}

async function runVerifyWorkspaceInternal(): Promise<{ failed: number; report: string }> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
  const checks = collectVerificationCommands(root);
  const results: Array<{ cwd: string; command: string; ok: boolean; out: string }> = [];
  for (const item of checks) {
    try {
      // Enhanced: Extended timeout to 30 minutes
      const { stdout, stderr } = await execAsync(item.command, {
        cwd: item.cwd,
        timeout: EXTENDED_TIMEOUT,
      });
      results.push({ cwd: item.cwd, command: item.command, ok: true, out: `${stdout}\n${stderr}`.trim() });
    } catch (e: any) {
      const out = `${e?.stdout || ''}\n${e?.stderr || ''}\n${e?.message || ''}`.trim();
      results.push({ cwd: item.cwd, command: item.command, ok: false, out });
    }
  }
  const report = buildVerifyReport(results, root);
  return { failed: results.filter(r => !r.ok).length, report };
}

function collectVerificationCommands(root: string): Array<{ cwd: string; command: string }> {
  const candidates = [root, path.join(root, 'server'), path.join(root, 'extension'), path.join(root, 'dashboard')];
  const checks: Array<{ cwd: string; command: string }> = [];
  for (const dir of candidates) {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      const scripts = json?.scripts || {};
      for (const name of ['lint', 'test', 'build']) {
        if (scripts[name]) checks.push({ cwd: dir, command: `npm run ${name}` });
      }
    } catch { }
  }
  return checks;
}

function buildVerifyReport(
  rows: Array<{ cwd: string; command: string; ok: boolean; out: string }>,
  root: string
): string {
  const ok = rows.filter(r => r.ok).length;
  const fail = rows.length - ok;
  const lines: string[] = [
    '# DevMind Verification Report',
    '',
    `- Workspace: \`${root}\``,
    `- Checks: **${rows.length}**`,
    `- Passed: **${ok}**`,
    `- Failed: **${fail}**`,
    '',
  ];
  for (const r of rows) {
    lines.push(`## ${r.ok ? 'PASS' : 'FAIL'} — \`${path.basename(r.cwd)}\` · \`${r.command}\``);
    lines.push('```');
    lines.push((r.out || '(no output)').slice(0, 4000));
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

async function autoVerifyIfEnabled() {
  try {
    const pref = await client.getPreferences();
    if (pref?.autoVerify) await runVerifyWorkspace();
  } catch { }
}

async function quickScaffold(type: string, defaultName: string) {
  const name = await vscode.window.showInputBox({
    prompt: `Name for the ${type} module`,
    value: defaultName,
    ignoreFocusOut: true,
  });
  if (!name) return;
  const proj = collectProjectContext();
  const ctxPrompt = buildContextPrompt(proj, null);
  await withProgress(`DevMind: Scaffolding ${name}…`, async () => {
    try {
      const result = await client.scaffold({ type, name, language: proj.language, projectCtx: ctxPrompt });
      const wsRoot = proj.rootPath;

      if (!wsRoot) {
        for (const file of result.files) {
          const d = await vscode.workspace.openTextDocument({
            content: `// ${file.path}\n${file.content}`,
            language: proj.language,
          });
          await vscode.window.showTextDocument(d, { preview: false });
        }
        vscode.window.showInformationMessage(`DevMind: ${result.files.length} file(s) generated for ${name} (no workspace).`);
        return;
      }

      // Enhanced: Use batch file writing
      const filesToWrite = result.files.map(f => ({
        path: f.path,
        content: f.content,
      }));

      const writeResults = await writeMultipleFiles(filesToWrite, wsRoot);
      const successful = writeResults.filter(r => r.success);
      const failed = writeResults.filter(r => !r.success);

      if (successful.length > 0) {
        const firstFile = path.join(wsRoot, successful[0].path);
        await openFileInEditor(firstFile);
      }

      getIndexer()?.rebuild();

      if (failed.length === 0) {
        vscode.window.showInformationMessage(`DevMind: ${result.files.length} file(s) generated for ${name}.`);
      } else {
        vscode.window.showWarningMessage(`DevMind: ${successful.length}/${result.files.length} file(s) created. ${failed.length} failed.`);
      }
    } catch (e: any) {
      showErr(e);
    }
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
function buildOnboardingHtml(
  hasApiKey: boolean,
  plan: string,
  remaining: number,
  inline: boolean,
  fileCount: number
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 13px; color: #e2e8f0; background: #0d1117; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 28px 16px; }
  .card { width: 100%; max-width: 760px; background: #161b22; border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 28px; }
  .badge { display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px; border-radius: 20px; background: rgba(79,142,247,.12); border: 1px solid rgba(79,142,247,.25); color: #7eb8f9; font-size: 11px; font-weight: 600; margin-bottom: 18px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: ${hasApiKey ? '#34d399' : '#f87171'}; }
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
  .sn { width: 20px; height: 20px; border-radius: 50%; background: rgba(79,142,247,.15); color: #7eb8f9; font-size: 10px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; margin-top: 1px; }
  .st { font-size: 12px; color: #94a3b8; line-height: 1.55; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  button { display: inline-flex; align-items: center; gap: 5px; padding: 7px 13px; border-radius: 7px; font-size: 12px; font-weight: 600; cursor: pointer; border: none; font-family: inherit; transition: all .15s; }
  .btn-p { background: #4f8ef7; color: #fff; } .btn-p:hover { background: #3b7ef6; }
  .btn-s { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); color: #cbd5e1; } .btn-s:hover { background: rgba(255,255,255,.1); }
  .btn-r { background: rgba(248,113,113,.1); border: 1px solid rgba(248,113,113,.3); color: #f87171; }
  .kbds { display: flex; flex-direction: column; gap: 5px; }
  .krow { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-radius: 5px; background: rgba(255,255,255,.03); }
  .kdsc { font-size: 11px; color: #94a3b8; }
  .kbd  { font-family: monospace; font-size: 10px; background: #21262d; padding: 2px 6px; border-radius: 3px; color: #7eb8f9; border: 1px solid rgba(255,255,255,.1); }
  .footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,.06); font-size: 11px; color: #555b6a; }
</style>
</head>
<body>
<div class="card">
  <div class="badge"><span class="dot"></span> DevMind AI by SinghJitech · v2.3</div>
  <h1>${hasApiKey ? 'Account connected' : 'Connect your DevMind account'}</h1>
  <p class="sub">Full codebase AI — reads all your files, writes directly to editor with accept/reject diff view. Now with enhanced file creation & 30min timeout!</p>

  ${hasApiKey ? `
  <div class="stat-row">
    <div class="stat"><div class="stat-label">Plan</div><div class="stat-val">${plan.toUpperCase()}</div></div>
    <div class="stat"><div class="stat-label">Requests left</div><div class="stat-val">${remaining}</div></div>
    <div class="stat"><div class="stat-label">Inline</div><div class="stat-val" style="color:${inline ? '#34d399' : '#f87171'};font-size:14px">${inline ? 'ON' : 'OFF'}</div></div>
    <div class="stat"><div class="stat-label">Files indexed</div><div class="stat-val">${fileCount}</div></div>
  </div>` : ''}

  <div class="grid">
    <div class="panel">
      <div class="panel-title">${hasApiKey ? 'What DevMind can do' : 'Getting started'}</div>
      <div class="steps">
        ${!hasApiKey ? `
        <div class="step"><span class="sn">1</span><span class="st">Open the DevMind dashboard and enter your Gmail.</span></div>
        <div class="step"><span class="sn">2</span><span class="st">Enter the 6-digit OTP sent to your Gmail inbox.</span></div>
        <div class="step"><span class="sn">3</span><span class="st">Copy your API key from the dashboard API Keys page.</span></div>
        <div class="step"><span class="sn">4</span><span class="st">Click "Paste API key" below — done!</span></div>
        ` : `
        <div class="step"><span class="sn">✦</span><span class="st">Reads entire codebase — @mention any file in chat.</span></div>
        <div class="step"><span class="sn">✦</span><span class="st">Writes to editor with accept/reject diff view.</span></div>
        <div class="step"><span class="sn">✦</span><span class="st">Scaffold Auth, CRUD, API, Schema in one command.</span></div>
        <div class="step"><span class="sn">✦</span><span class="st">Multi-file refactor with side-by-side diff.</span></div>
        <div class="step"><span class="sn">✦</span><span class="st">Inline autocomplete — Tab to accept suggestions.</span></div>
        <div class="step"><span class="sn">✦</span><span class="st">Project-aware — knows your framework, DB, and auth.</span></div>
        <div class="step"><span class="sn">✨</span><span class="st">NEW: Auto-creates files/directories with atomic writes.</span></div>
        <div class="step"><span class="sn">⏱️</span><span class="st">NEW: 30-minute timeout for long operations.</span></div>
        `}
      </div>
      <div class="actions">
        <button class="btn-p" onclick="post('openDashboard')">Open dashboard</button>
        <button class="btn-s" onclick="post('setKey')">${hasApiKey ? 'Update API key' : 'Paste API key'}</button>
        ${hasApiKey ? `<button class="btn-s" onclick="post('openSidebar')">Open chat</button>` : ''}
        ${hasApiKey ? `<button class="btn-s" onclick="post('toggleInline')">${inline ? 'Disable' : 'Enable'} inline</button>` : ''}
        ${hasApiKey ? `<button class="btn-s" onclick="post('reindex')">Re-index codebase</button>` : ''}
        ${hasApiKey ? `<button class="btn-r" onclick="post('signOut')">Sign out</button>` : ''}
      </div>
    </div>
    <div class="panel">
      <div class="panel-title">Keyboard shortcuts</div>
      <div class="kbds">
        <div class="krow"><span class="kdsc">Explain code</span><span class="kbd">Ctrl+Shift+E</span></div>
        <div class="krow"><span class="kdsc">Fix bug</span><span class="kbd">Ctrl+Shift+F</span></div>
        <div class="krow"><span class="kdsc">Generate</span><span class="kbd">Ctrl+Shift+G</span></div>
        <div class="krow"><span class="kdsc">Explain file</span><span class="kbd">Ctrl+Shift+D</span></div>
        <div class="krow"><span class="kdsc">Write tests</span><span class="kbd">Ctrl+Shift+T</span></div>
        <div class="krow"><span class="kdsc">Scaffold</span><span class="kbd">Ctrl+Shift+S</span></div>
      </div>
      <div style="margin-top:12px;font-size:11px;color:#555b6a;line-height:1.7">
        Use <strong style="color:#7eb8f9">@filename</strong> in chat to mention any file from your codebase.<br>
        Use <strong style="color:#7eb8f9">/</strong> for slash commands (explain, fix, scaffold…).<br>
        All commands in Command Palette → <strong style="color:#7eb8f9">DevMind</strong>.
      </div>
    </div>
  </div>
  <div class="footer">Aakash Singh, Founder · DevMind AI by SinghJitech · Made in India 🇮🇳 · v2.3 Enhanced</div>
</div>
<script>
const vscode = acquireVsCodeApi();
function post(t) { vscode.postMessage({ type: t }); }
</script>
</body>
</html>`;
}

export function deactivate() { }