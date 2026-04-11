import * as vscode from 'vscode';

const LIMITS: Record<string, number> = {
  free: 20,
  solo: 100,
  pro:  500,
  team: 2000,
};

export class UsageTracker {
  private cbs: Array<() => void> = [];

  constructor(private ctx: vscode.ExtensionContext) {
    this.rolloverCheck();
  }

  canComplete(): boolean { return this.getRemaining() > 0; }

  record() {
    const key = this.todayKey();
    const cur = this.ctx.globalState.get<number>(key, 0);
    this.ctx.globalState.update(key, cur + 1);
    this.fire();
  }

  getRemaining(): number {
    const plan  = this.getPlan();
    const limit = LIMITS[plan] ?? LIMITS.free;
    const used  = this.ctx.globalState.get<number>(this.todayKey(), 0);
    return Math.max(0, limit - used);
  }

  getUsed(): number {
    return this.ctx.globalState.get<number>(this.todayKey(), 0);
  }

  getPlan(): string {
    return this.ctx.globalState.get<string>('plan', 'free');
  }

  setPlan(plan: string) {
    this.ctx.globalState.update('plan', plan);
    this.fire();
  }

  onChange(cb: () => void) { this.cbs.push(cb); }

  private todayKey() {
    return `usage_${new Date().toISOString().slice(0, 10)}`;
  }

  private rolloverCheck() {
    const last  = this.ctx.globalState.get<string>('lastDay', '');
    const today = new Date().toISOString().slice(0, 10);
    if (last !== today) {
      this.ctx.globalState.update('lastDay', today);
      this.ctx.globalState.update(this.todayKey(), 0);
    }
  }

  private fire() { this.cbs.forEach(c => c()); }
}
