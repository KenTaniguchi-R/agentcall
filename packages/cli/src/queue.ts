export class SerialQueue {
  private jobs: Array<() => Promise<void>> = [];
  private active = false;
  private idleResolvers: Array<() => void> = [];

  constructor(private maxPending: number) {}

  get pending(): number { return this.jobs.length; }
  get running(): boolean { return this.active; }

  tryEnqueue(job: () => Promise<void>): boolean {
    if (this.active && this.jobs.length >= this.maxPending) return false;
    this.jobs.push(job);
    void this.drain();
    return true;
  }

  onIdle(): Promise<void> {
    if (!this.active && this.jobs.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      try { await job(); } catch { /* job errors are the job's problem */ }
    }
    this.active = false;
    for (const r of this.idleResolvers.splice(0)) r();
  }
}
