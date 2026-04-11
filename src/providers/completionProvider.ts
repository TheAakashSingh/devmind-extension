import * as vscode from 'vscode';
import { DeepSeekClient } from '../utils/deepseekClient';
import { UsageTracker } from '../utils/usageTracker';

export class InlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private timer: NodeJS.Timeout | null = null;
  private reqId  = 0;
  private cache  = new Map<string, string>();

  constructor(
    private client: DeepSeekClient,
    private usage:  UsageTracker
  ) {}

  async provideInlineCompletionItems(
    doc:   vscode.TextDocument,
    pos:   vscode.Position,
    _ctx:  vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const cfg = vscode.workspace.getConfiguration('devmind');
    if (!cfg.get<boolean>('enableInline', true)) return null;
    if (!this.usage.canComplete())               return null;

    const delay = cfg.get<number>('inlineDelay', 350);
    await new Promise<void>(res => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(res, delay);
    });
    if (token.isCancellationRequested) return null;

    const line = doc.lineAt(pos.line).text.trim();
    if (line.length < 3) return null;

    const prefix = this.before(doc, pos, 50);
    const suffix = this.after(doc, pos, 10);
    const lang   = doc.languageId;
    const file   = doc.fileName.split(/[\\/]/).pop() || '';

    const cacheKey = `${lang}:${prefix.slice(-300)}`;
    if (this.cache.has(cacheKey)) {
      return this.wrap(this.cache.get(cacheKey)!, pos);
    }

    const id = ++this.reqId;
    try {
      const completion = await this.client.complete({ prefix, suffix, language: lang, fileName: file });
      if (token.isCancellationRequested || id !== this.reqId) return null;
      if (!completion.trim()) return null;

      this.cache.set(cacheKey, completion);
      setTimeout(() => this.cache.delete(cacheKey), 90_000);

      this.usage.record();
      return this.wrap(completion, pos);
    } catch {
      return null;
    }
  }

  private before(doc: vscode.TextDocument, pos: vscode.Position, n: number) {
    return doc.getText(new vscode.Range(Math.max(0, pos.line - n), 0, pos.line, pos.character));
  }

  private after(doc: vscode.TextDocument, pos: vscode.Position, n: number) {
    return doc.getText(new vscode.Range(pos.line, pos.character, Math.min(doc.lineCount - 1, pos.line + n), 0));
  }

  private wrap(text: string, pos: vscode.Position): vscode.InlineCompletionList {
    return new vscode.InlineCompletionList([
      new vscode.InlineCompletionItem(text, new vscode.Range(pos, pos)),
    ]);
  }
}
