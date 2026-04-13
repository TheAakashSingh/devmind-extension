import * as vscode from 'vscode';
import * as path from 'path';
import { DeepSeekClient } from './deepseekClient';
import { getDiffProvider } from '../providers/diffProvider';
import { evaluateRisk } from './riskEngine';

export type VerifyFn = () => Promise<{ failed: number; report: string }>;
export type OpenResultFn = (content: string, language: string) => Promise<void>;

export async function runHybridImplementPlan(params: {
  client: DeepSeekClient;
  target: string;
  language: string;
  contextPrompt: string;
  verify: VerifyFn;
  openResult: OpenResultFn;
}): Promise<void> {
  const { client, target, language, contextPrompt, verify, openResult } = params;
  const planPrompt = [
    `Create an execution task graph for: ${target}`,
    `Return markdown with checklist and concrete file targets.`,
  ].join('\n');
  const planMd = await client.action('explain', planPrompt, language, contextPrompt);
  await openResult(planMd, 'markdown');

  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!ws) return;
  const relCandidates = ['server/src/routes/ai.ts', 'extension/src/extension.ts', 'dashboard/src/pages/Admin.tsx'];
  const edits = relCandidates
    .map((rel) => {
      const abs = path.join(ws, rel);
      const uri = vscode.Uri.file(abs);
      return { rel, uri };
    });

  let applied = 0;
  for (const e of edits) {
    let oldContent = '';
    try {
      const doc = await vscode.workspace.openTextDocument(e.uri);
      oldContent = doc.getText();
    } catch {
      continue;
    }
    const patchPrompt = [
      `Implement this request in file ${e.rel}: ${target}`,
      `Return only full updated code for this file.`,
    ].join('\n');
    const next = await client.generate(patchPrompt, language, `${contextPrompt}\nTarget file: ${e.rel}`);
    if (!next.trim()) continue;
    const risk = evaluateRisk(oldContent, next);
    if (risk.risk === 'LOW' && risk.confidencePct >= 75) {
      await vscode.workspace.fs.writeFile(e.uri, Buffer.from(next, 'utf8'));
      applied++;
      continue;
    }
    const ok = await getDiffProvider().applyToFileWithDiff(e.rel, next, `Implement plan: ${target}`);
    if (ok) applied++;
  }

  const first = await verify();
  if (first.failed > 0) {
    const retryPrompt = [
      `Fix remaining verification failures for request: ${target}`,
      first.report.slice(0, 4500),
      `Return concise markdown with fix strategy.`,
    ].join('\n\n');
    const retryPlan = await client.action('explain', retryPrompt, language, contextPrompt);
    await openResult(retryPlan, 'markdown');
    await verify();
  }
  vscode.window.showInformationMessage(`DevMind: implement-plan finished. Applied ${applied} file update(s).`);
}
