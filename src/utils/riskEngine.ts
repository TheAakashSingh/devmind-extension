export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export type RiskReport = {
  confidencePct: number;
  risk: RiskLevel;
  blastRadius: 'focused' | 'medium' | 'wide';
  breakingFlags: string[];
  changedLines: number;
};

function countChangedLines(before: string, after: string): number {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  let changed = Math.abs(a.length - b.length);
  const overlap = Math.min(a.length, b.length);
  for (let i = 0; i < overlap; i++) {
    if (a[i] !== b[i]) changed++;
  }
  return changed;
}

export function evaluateRisk(before: string, after: string): RiskReport {
  const changedLines = countChangedLines(before, after);
  const merged = `${before}\n${after}`;
  const breakingFlags: string[] = [];
  if (/\b(export\s+interface|export\s+type|public\s+|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(merged)) {
    breakingFlags.push('public-api-or-schema-change');
  }
  if (/\b(delete|drop|remove)\b/i.test(after)) {
    breakingFlags.push('destructive-operation-hint');
  }
  if (/\b(rename|migrate|deprecate)\b/i.test(after)) {
    breakingFlags.push('migration-risk-hint');
  }

  let risk: RiskLevel = 'LOW';
  if (changedLines > 140 || breakingFlags.length >= 2) risk = 'HIGH';
  else if (changedLines > 45 || breakingFlags.length === 1) risk = 'MEDIUM';

  const confidenceBase = risk === 'LOW' ? 88 : risk === 'MEDIUM' ? 71 : 52;
  const confidencePct = Math.max(35, Math.min(96, confidenceBase - Math.floor(changedLines / 30)));
  const blastRadius = changedLines > 140 ? 'wide' : changedLines > 45 ? 'medium' : 'focused';

  return { confidencePct, risk, blastRadius, breakingFlags, changedLines };
}

export function toRiskMarkdown(action: string, report: RiskReport): string {
  return [
    '# Change Risk Report',
    '',
    `- Action: **${action}**`,
    `- Confidence: **${report.confidencePct}%**`,
    `- Risk level: **${report.risk}**`,
    `- Blast radius: **${report.blastRadius}**`,
    `- Changed lines estimate: **${report.changedLines}**`,
    `- Breaking flags: **${report.breakingFlags.length ? report.breakingFlags.join(', ') : 'none'}**`,
    '',
    '## Guidance',
    '- Auto-apply is safe only for LOW risk.',
    '- MEDIUM/HIGH should be reviewed in diff.',
  ].join('\n');
}
