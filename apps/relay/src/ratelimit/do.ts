import { DurableObject } from "cloudflare:workers";

type CheckRequest = { key: string; now: number; limit: number; windowMs: number };

function validCheck(value: unknown): value is CheckRequest {
  if (!value || typeof value !== "object") return false;
  const { key, now, limit, windowMs } = value as Partial<CheckRequest>;
  if (typeof key !== "string" || key.length === 0 || key.length > 512) return false;
  return Number.isSafeInteger(now) && Number.isSafeInteger(limit) && Number.isSafeInteger(windowMs) &&
    Number.isSafeInteger((now as number) + (windowMs as number)) &&
    (now as number) >= 0 && (limit as number) > 0 && (windowMs as number) > 0;
}

/** Exact keyed sliding-window limits inside one bounded SQLite shard. */
export class RateLimiterDO extends DurableObject {
  private readonly usesTestClock: boolean;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.usesTestClock = typeof (env as { RATE_LIMIT_NOW?: unknown }).RATE_LIMIT_NOW === "number";
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (key TEXT NOT NULL, at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    );
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS hits_key_at ON hits (key, at)");
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS hits_expires_at ON hits (expires_at)");
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("not found", { status: 404 });
    }
    const body: unknown = await request.json().catch(() => null);
    if (!validCheck(body)) return Response.json({ error: "invalid request" }, { status: 400 });

    const success = this.ctx.storage.transactionSync(() => {
      // Clean the whole shard, not just this key, so rotating attacker keys do
      // not accumulate rows between alarm runs.
      this.ctx.storage.sql.exec("DELETE FROM hits WHERE expires_at <= ?", body.now);
      const { count } = this.ctx.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM hits WHERE key = ? AND at > ?",
        body.key, body.now - body.windowMs,
      ).one();
      if (count >= body.limit) return false;
      this.ctx.storage.sql.exec(
        "INSERT INTO hits (key, at, expires_at) VALUES (?, ?, ?)",
        body.key, body.now, body.now + body.windowMs,
      );
      return true;
    });
    await this.scheduleCleanup();
    return Response.json({ success });
  }

  private async scheduleCleanup(): Promise<void> {
    // Test requests use an injected historical clock; scheduling those values
    // against the runtime's real alarm clock would fire immediately.
    if (this.usesTestClock) return;
    const { next } = this.ctx.storage.sql.exec<{ next: number | null }>(
      "SELECT MIN(expires_at) AS next FROM hits",
    ).one();
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM hits WHERE expires_at <= ?", Date.now());
    await this.scheduleCleanup();
  }
}
