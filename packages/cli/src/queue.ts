type Job = { key: string; run: (signal: AbortSignal) => Promise<void> };

export class SerialQueue {
  private jobs: Job[] = [];
  private active = false;
  private idleResolvers: Array<() => void> = [];
  private runningKey: string | undefined;
  private runningAbort: AbortController | undefined;
  private closed = false;

  constructor(private maxPending: number) {}

  get pending(): number { return this.jobs.length; }
  get running(): boolean { return this.active; }

  tryEnqueue(key: string, run: (signal: AbortSignal) => Promise<void>): boolean {
    if (this.closed) return false;
    if (this.active && this.jobs.length >= this.maxPending) return false;
    this.jobs.push({ key, run });
    void this.drain();
    return true;
  }

  /**
   * Pending jobs are dropped outright — they never spawned, so there is
   * nothing to confirm. A running job is only *signalled* here; the caller
   * must wait for the job's own promise to settle before telling anyone the
   * work is cancelled, because the process is not gone until then.
   */
  cancel(key: string): "pending" | "running" | "unknown" {
    const i = this.jobs.findIndex((j) => j.key === key);
    if (i >= 0) { this.jobs.splice(i, 1); return "pending"; }
    if (this.runningKey === key) { this.runningAbort?.abort(); return "running"; }
    return "unknown";
  }

  onIdle(): Promise<void> {
    if (!this.active && this.jobs.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleResolvers.push(r));
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.jobs = [];
    this.runningAbort?.abort();
    await this.onIdle();
  }

  private async drain(): Promise<void> {
    if (this.active) return;
    this.active = true;
    while (this.jobs.length > 0) {
      const job = this.jobs.shift()!;
      this.runningKey = job.key;
      this.runningAbort = new AbortController();
      try { await job.run(this.runningAbort.signal); } catch { /* job errors are the job's problem */ }
      this.runningKey = undefined;
      this.runningAbort = undefined;
    }
    this.active = false;
    for (const r of this.idleResolvers.splice(0)) r();
  }
}
