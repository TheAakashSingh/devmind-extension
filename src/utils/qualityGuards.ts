export function codeQualityIssues(code: string, language: string): string[] {
  const issues: string[] = [];
  const text = String(code || '');
  if (!text.trim()) issues.push('empty-output');
  if (text.length < 24) issues.push('too-short');
  if (/(TODO|FIXME)\b/.test(text)) issues.push('contains-todo-markers');
  if ((language === 'typescript' || language === 'javascript') && /\bconsole\.log\(/.test(text)) {
    issues.push('debug-log-present');
  }
  if (/\b<any>\b/.test(text)) issues.push('unsafe-any-cast');
  return issues;
}

export function improveAssistantReply(reply: string): string {
  const r = String(reply || '').trim();
  if (!r) return 'No response generated. Please retry with more context.';
  const hasList = /(^- |\n- )/.test(r);
  const hasVerify = /\b(test|verify|lint|build)\b/i.test(r);
  if (hasList && hasVerify) return r;
  return `${r}\n\n- Quick verify: run lint/tests after applying these changes.`;
}
