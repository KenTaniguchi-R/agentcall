# agentcall v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Call another person's Claude Code/Codex agent on their Mac across the public internet: `agentcall call ken@agentcall.benree.tech "msg"` → their Mac spawns a sandboxed one-shot agent → reply returns.

**Architecture:** Cloudflare Worker (Hono) + one Durable Object per handle (WebSocket Hibernation) + D1 for handle registry. Node CLI (`agentcall`) provides `setup/listen/call/status/uninstall`; a LaunchAgent keeps `agentcall listen` resident; calls spawn `srt claude -p` or `codex exec --sandbox` with cwd `~/AgentCall/public`.

**Tech Stack:** TypeScript (ESM, strict), pnpm workspace, zod 4, Hono 4, wrangler 4 + `@cloudflare/vitest-pool-workers`, `ws`, `commander`, vitest 3.

**Spec:** `docs/superpowers/specs/2026-07-13-agentcall-design.md` — read it first.

## Global Constraints

- macOS-only target for the CLI; Node >= 20 floor (`engines`).
- ESM everywhere (`"type": "module"`); TS `strict: true`.
- Relay domain literal: `agentcall.benree.tech` (default relay URL `https://agentcall.benree.tech`).
- Handle regex `^[a-z0-9][a-z0-9-]{1,30}$`; message ≤ 64_000 bytes; reply ≤ 256_000 bytes; rate limit 10 calls/hour per caller; relay call timeout 360_000 ms; listener agent timeout 300_000 ms; queue: 1 running + 5 pending.
- LaunchAgent label: `tech.benree.agentcall.listener`.
- Commit after every task (explicit file staging — `git add <paths>`, never `-A`). All commits end with the two Co-Authored-By/Claude-Session trailer lines used in this repo's history.
- Every protocol frame validated with the zod schemas from `@agentcall/shared` on both ends.
- Test isolation: CLI honors `AGENTCALL_HOME` (defaults to `~`) — ALL filesystem paths derive from it.

---

### Task 1: Workspace scaffold + shared protocol package

**Files:**
- Create: `pnpm-workspace.yaml`, `package.json`, `tsconfig.base.json`, `.gitignore`
- Create: `packages/shared/package.json`, `packages/shared/tsconfig.json`, `packages/shared/src/protocol.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/test/protocol.test.ts`

**Interfaces:**
- Produces (used by every later task): everything exported from `@agentcall/shared`:
  `HANDLE_RE`, `RESERVED_HANDLES`, `MAX_MESSAGE_BYTES=64_000`, `MAX_REPLY_BYTES=256_000`,
  `RELAY_CALL_TIMEOUT_MS=360_000`, `AGENT_TIMEOUT_MS=300_000`, `RATE_LIMIT_PER_HOUR=10`,
  `ErrorCode` (zod enum), `CallRequest`, `CallStatus`, `CallReply`, `CallError`,
  `IncomingCall`, `CallAnswer`, `CallResult`, `CallFailed`,
  `CallerFrame`, `ListenerToRelayFrame`, `RelayToCallerFrame`, `RelayToListenerFrame` (discriminated unions),
  `RegisterRequest`, `RegisterResponse`, `parseAddress(addr): {handle, host} | null`,
  `safeParseFrame<T>(schema, raw): T | null`, and inferred TS types (`z.infer`) re-exported with same names + `Type` suffix.

- [ ] **Step 1: Scaffold workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

Root `package.json`:
```json
{
  "name": "agentcall-monorepo",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "test": "pnpm -r test", "build": "pnpm -r build", "typecheck": "pnpm -r typecheck" },
  "packageManager": "pnpm@11.5.2"
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "skipLibCheck": true, "declaration": true,
    "forceConsistentCasingInFileNames": true, "verbatimModuleSyntax": true
  }
}
```

`.gitignore`:
```
node_modules/
dist/
.wrangler/
*.log
.dev.vars
```

`packages/shared/package.json`:
```json
{
  "name": "@agentcall/shared",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "zod": "^4.0.0" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```

`packages/shared/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "outDir": "dist", "rootDir": "src" }, "include": ["src"] }
```

- [ ] **Step 2: Write the failing test** — `packages/shared/test/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  CallRequest, CallerFrame, RelayToCallerFrame, ListenerToRelayFrame,
  HANDLE_RE, RESERVED_HANDLES, MAX_MESSAGE_BYTES, parseAddress, safeParseFrame,
} from "../src/index.js";

describe("handle rules", () => {
  it("accepts valid handles", () => {
    for (const h of ["ken", "a1", "my-agent-01"]) expect(HANDLE_RE.test(h)).toBe(true);
  });
  it("rejects invalid handles", () => {
    for (const h of ["K", "-a", "a", "a".repeat(32), "a_b", "a b", ""]) expect(HANDLE_RE.test(h)).toBe(false);
  });
  it("reserves system names", () => {
    expect(RESERVED_HANDLES).toContain("admin");
    expect(RESERVED_HANDLES).toContain("www");
  });
});

describe("parseAddress", () => {
  it("splits handle@host", () => {
    expect(parseAddress("ken@agentcall.benree.tech")).toEqual({ handle: "ken", host: "agentcall.benree.tech" });
  });
  it("rejects garbage", () => {
    expect(parseAddress("ken")).toBeNull();
    expect(parseAddress("KEN@x.y")).toBeNull();
    expect(parseAddress("ken@")).toBeNull();
  });
});

describe("frames", () => {
  it("round-trips a call_request", () => {
    const f = { type: "call_request", to: "ken", message: "hi" };
    expect(CallRequest.parse(f)).toEqual(f);
    expect(safeParseFrame(CallerFrame, JSON.stringify(f))).toEqual(f);
  });
  it("rejects unknown type via safeParseFrame", () => {
    expect(safeParseFrame(CallerFrame, JSON.stringify({ type: "nope" }))).toBeNull();
    expect(safeParseFrame(CallerFrame, "not json")).toBeNull();
  });
  it("relay->caller union covers status/reply/error", () => {
    expect(safeParseFrame(RelayToCallerFrame, JSON.stringify({ type: "call_status", state: "ringing" }))).not.toBeNull();
    expect(safeParseFrame(RelayToCallerFrame, JSON.stringify({ type: "call_reply", call_id: "x", text: "y" }))).not.toBeNull();
    expect(safeParseFrame(RelayToCallerFrame, JSON.stringify({ type: "call_error", code: "offline" }))).not.toBeNull();
  });
  it("listener->relay union covers answer/result/failed", () => {
    expect(safeParseFrame(ListenerToRelayFrame, JSON.stringify({ type: "call_answer", call_id: "x" }))).not.toBeNull();
    expect(safeParseFrame(ListenerToRelayFrame, JSON.stringify({ type: "call_result", call_id: "x", text: "t" }))).not.toBeNull();
    expect(safeParseFrame(ListenerToRelayFrame, JSON.stringify({ type: "call_failed", call_id: "x", code: "busy" }))).not.toBeNull();
  });
  it("exposes size constants", () => {
    expect(MAX_MESSAGE_BYTES).toBe(64_000);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `cd packages/shared && pnpm install && pnpm test` → FAIL (module not found).

- [ ] **Step 4: Implement** — `packages/shared/src/protocol.ts`:

```ts
import { z } from "zod";

export const HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
export const RESERVED_HANDLES = [
  "admin", "www", "relay", "api", "install", "help", "support", "root",
  "agentcall", "system", "status", "info",
] as const;
export const MAX_MESSAGE_BYTES = 64_000;
export const MAX_REPLY_BYTES = 256_000;
export const RELAY_CALL_TIMEOUT_MS = 360_000;
export const AGENT_TIMEOUT_MS = 300_000;
export const RATE_LIMIT_PER_HOUR = 10;

export const ErrorCode = z.enum([
  "unknown_handle", "offline", "busy", "timeout", "agent_error",
  "unauthorized", "rate_limited", "message_too_large", "protocol_error",
]);

export const CallRequest = z.object({
  type: z.literal("call_request"),
  to: z.string().regex(HANDLE_RE),
  message: z.string().min(1),
  session_id: z.string().optional(),
});
export const CallStatus = z.object({
  type: z.literal("call_status"),
  state: z.enum(["ringing", "answered", "working"]),
});
export const CallReply = z.object({
  type: z.literal("call_reply"),
  call_id: z.string(),
  text: z.string(),
  session_id: z.string().optional(),
});
export const CallError = z.object({
  type: z.literal("call_error"),
  code: ErrorCode,
  detail: z.string().optional(),
});
export const IncomingCall = z.object({
  type: z.literal("incoming_call"),
  call_id: z.string(),
  from: z.string(),
  message: z.string(),
  session_id: z.string().optional(),
});
export const CallAnswer = z.object({ type: z.literal("call_answer"), call_id: z.string() });
export const CallResult = z.object({
  type: z.literal("call_result"),
  call_id: z.string(),
  text: z.string(),
  session_id: z.string().optional(),
});
export const CallFailed = z.object({
  type: z.literal("call_failed"),
  call_id: z.string(),
  code: ErrorCode,
  detail: z.string().optional(),
});

export const CallerFrame = z.discriminatedUnion("type", [CallRequest]);
export const ListenerToRelayFrame = z.discriminatedUnion("type", [CallAnswer, CallResult, CallFailed]);
export const RelayToCallerFrame = z.discriminatedUnion("type", [CallStatus, CallReply, CallError]);
export const RelayToListenerFrame = z.discriminatedUnion("type", [IncomingCall]);

export const RegisterRequest = z.object({
  handle: z.string().regex(HANDLE_RE),
  agent_kind: z.enum(["claude", "codex"]),
});
export const RegisterResponse = z.object({ token: z.string(), address: z.string() });

export type ErrorCodeType = z.infer<typeof ErrorCode>;
export type CallRequestType = z.infer<typeof CallRequest>;
export type CallReplyType = z.infer<typeof CallReply>;
export type CallErrorType = z.infer<typeof CallError>;
export type IncomingCallType = z.infer<typeof IncomingCall>;
export type CallResultType = z.infer<typeof CallResult>;
export type CallFailedType = z.infer<typeof CallFailed>;
export type RegisterRequestType = z.infer<typeof RegisterRequest>;
export type RegisterResponseType = z.infer<typeof RegisterResponse>;
export type RelayToCallerFrameType = z.infer<typeof RelayToCallerFrame>;
export type ListenerToRelayFrameType = z.infer<typeof ListenerToRelayFrame>;

export function parseAddress(addr: string): { handle: string; host: string } | null {
  const at = addr.indexOf("@");
  if (at <= 0) return null;
  const handle = addr.slice(0, at);
  const host = addr.slice(at + 1);
  if (!HANDLE_RE.test(handle)) return null;
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)) return null;
  return { handle, host };
}

export function safeParseFrame<S extends z.ZodTypeAny>(schema: S, raw: string): z.infer<S> | null {
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
```

`packages/shared/src/index.ts`:
```ts
export * from "./protocol.js";
```

- [ ] **Step 5: Run tests + typecheck** — `pnpm test && pnpm typecheck` → PASS.
- [ ] **Step 6: Commit** — `git add pnpm-workspace.yaml package.json tsconfig.base.json .gitignore packages/shared pnpm-lock.yaml && git commit -m "feat(shared): workspace scaffold + protocol schemas"`.

---

### Task 2: Relay scaffold, D1 migration, auth util, /v1/register

**Files:**
- Create: `apps/relay/package.json`, `apps/relay/tsconfig.json`, `apps/relay/wrangler.jsonc`,
  `apps/relay/migrations/0001_init.sql`, `apps/relay/vitest.config.ts`,
  `apps/relay/test/apply-migrations.ts`, `apps/relay/test/env.d.ts`,
  `apps/relay/src/auth.ts`, `apps/relay/src/index.ts`, `apps/relay/src/do.ts` (stub)
- Test: `apps/relay/test/register.test.ts`

**Interfaces:**
- Consumes: `RegisterRequest`, `RESERVED_HANDLES`, `HANDLE_RE` from `@agentcall/shared`.
- Produces: `sha256Hex(s: string): Promise<string>`; `generateToken(): string` (32 rand bytes base64url);
  `verifyHandleToken(db: D1Database, handle: string, token: string): Promise<boolean>`;
  Worker `Env` type `{ DB: D1Database; HANDLE_DO: DurableObjectNamespace }`;
  route `POST /v1/register` → 200 `{token, address}` | 400 | 409. `HandleDO` class exists (stub `fetch` → 501).

- [ ] **Step 1: Scaffold config files**

`apps/relay/package.json`:
```json
{
  "name": "@agentcall/relay",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": { "hono": "^4.6.0", "@agentcall/shared": "workspace:*", "zod": "^4.0.0" },
  "devDependencies": {
    "wrangler": "^4.23.0",
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20260601.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

`apps/relay/wrangler.jsonc`:
```jsonc
{
  "name": "agentcall-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "d1_databases": [{
    "binding": "DB",
    "database_name": "agentcall",
    "database_id": "00000000-0000-0000-0000-000000000000",
    "migrations_dir": "migrations"
  }],
  "durable_objects": { "bindings": [{ "name": "HANDLE_DO", "class_name": "HandleDO" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["HandleDO"] }],
  "routes": [{ "pattern": "agentcall.benree.tech", "custom_domain": true }]
}
```
(The `database_id` placeholder is replaced at deploy time — Task 13.)

`apps/relay/migrations/0001_init.sql`:
```sql
CREATE TABLE handles (
  handle TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  agent_kind TEXT NOT NULL CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL
);
```

`apps/relay/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist", "noEmit": true, "types": ["@cloudflare/workers-types/2023-07-01"],
    "moduleResolution": "Bundler", "module": "ESNext", "verbatimModuleSyntax": false
  },
  "include": ["src", "test"]
}
```

`apps/relay/vitest.config.ts`:
```ts
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
        },
      },
    },
  };
});
```

`apps/relay/test/apply-migrations.ts`:
```ts
import { applyD1Migrations, env } from "cloudflare:test";
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`apps/relay/test/env.d.ts`:
```ts
declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    HANDLE_DO: DurableObjectNamespace;
    TEST_MIGRATIONS: import("wrangler").D1Migration[];
  }
}
```

- [ ] **Step 2: Write the failing test** — `apps/relay/test/register.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function register(body: unknown) {
  return SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/register", () => {
  it("registers a handle and returns token + address", async () => {
    const res = await register({ handle: "ken", agent_kind: "claude" });
    expect(res.status).toBe(200);
    const json = await res.json<{ token: string; address: string }>();
    expect(json.token.length).toBeGreaterThanOrEqual(40);
    expect(json.address).toBe("ken@agentcall.benree.tech");
  });
  it("409s on duplicate handle", async () => {
    await register({ handle: "dup", agent_kind: "claude" });
    const res = await register({ handle: "dup", agent_kind: "codex" });
    expect(res.status).toBe(409);
  });
  it("400s on invalid handle and reserved handle", async () => {
    expect((await register({ handle: "Bad_Handle", agent_kind: "claude" })).status).toBe(400);
    expect((await register({ handle: "admin", agent_kind: "claude" })).status).toBe(400);
    expect((await register({ handle: "ok-handle", agent_kind: "vim" })).status).toBe(400);
  });
});
```

- [ ] **Step 3: Run to verify failure** — `cd apps/relay && pnpm install && pnpm test` → FAIL.

- [ ] **Step 4: Implement**

`apps/relay/src/auth.ts`:
```ts
export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function verifyHandleToken(db: D1Database, handle: string, token: string): Promise<boolean> {
  const row = await db.prepare("SELECT token_hash FROM handles WHERE handle = ?").bind(handle).first<{ token_hash: string }>();
  if (!row) return false;
  return row.token_hash === (await sha256Hex(token));
}
```

`apps/relay/src/do.ts` (stub for now):
```ts
import { DurableObject } from "cloudflare:workers";
export class HandleDO extends DurableObject {
  override async fetch(_req: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
```

`apps/relay/src/index.ts`:
```ts
import { Hono } from "hono";
import { RegisterRequest, RESERVED_HANDLES } from "@agentcall/shared";
import { generateToken, sha256Hex } from "./auth.js";

export { HandleDO } from "./do.js";

export type Env = { DB: D1Database; HANDLE_DO: DurableObjectNamespace };
export const RELAY_HOST = "agentcall.benree.tech";

const app = new Hono<{ Bindings: Env }>();

app.post("/v1/register", async (c) => {
  const body = RegisterRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid request" }, 400);
  const { handle, agent_kind } = body.data;
  if ((RESERVED_HANDLES as readonly string[]).includes(handle)) return c.json({ error: "handle reserved" }, 400);
  const token = generateToken();
  try {
    await c.env.DB.prepare(
      "INSERT INTO handles (handle, token_hash, agent_kind, created_at) VALUES (?, ?, ?, ?)",
    ).bind(handle, await sha256Hex(token), agent_kind, Date.now()).run();
  } catch {
    return c.json({ error: "handle taken" }, 409);
  }
  return c.json({ token, address: `${handle}@${RELAY_HOST}` });
});

export default app;
```

- [ ] **Step 5: Run tests + typecheck** → PASS.
- [ ] **Step 6: Commit** — `git add apps/relay pnpm-lock.yaml && git commit -m "feat(relay): scaffold, D1 registry, /v1/register"`.

---

### Task 3: HandleDO — listener attach, replacement, /status, WS auth in Worker

**Files:**
- Modify: `apps/relay/src/do.ts`, `apps/relay/src/index.ts`
- Test: `apps/relay/test/ws.test.ts` (new), plus shared helper `apps/relay/test/helpers.ts`

**Interfaces:**
- Consumes: `verifyHandleToken` (Task 2).
- Produces:
  - Worker route `GET /v1/status/:handle` → `{online: boolean}` (404 unknown handle).
  - Worker route `GET /v1/ws?role=listen` — headers `Authorization: Bearer <token>`, `X-AgentCall-Handle: <handle>`; 401 bad creds; upgrades and forwards to `HANDLE_DO.get(idFromName(handle))` with internal header `X-Verified-From: <handle>`.
  - Worker route `GET /v1/ws?role=call&to=<handle>` — same caller auth headers; 404 if `to` not registered; forwards to the **target's** DO with `X-Verified-From: <callerHandle>`.
  - DO internal contract: `GET /status` → `{online}`; upgrade requests carry `?role=` and `X-Verified-From`. New listener replaces old (old closed with code 4000).
- `test/helpers.ts` produces: `registerHandle(handle, kind): Promise<string /* token */>`; `openWs(path, headers): Promise<WebSocket>` (fetch with Upgrade, accept, return); `nextFrame(ws): Promise<any>` (one JSON message); `wsAuth(handle, token)` header builder.

- [ ] **Step 1: Write the failing test** — `apps/relay/test/helpers.ts`:

```ts
import { SELF } from "cloudflare:test";
import { expect } from "vitest";

export async function registerHandle(handle: string, kind: "claude" | "codex" = "claude"): Promise<string> {
  const res = await SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, agent_kind: kind }),
  });
  expect(res.status).toBe(200);
  return (await res.json<{ token: string }>()).token;
}

export function wsAuth(handle: string, token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "X-AgentCall-Handle": handle };
}

export async function openWs(path: string, headers: Record<string, string>): Promise<WebSocket> {
  const res = await SELF.fetch(`https://relay.test${path}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

export function nextFrame(ws: WebSocket, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("nextFrame timeout")), timeoutMs);
    ws.addEventListener("message", (e) => { clearTimeout(t); resolve(JSON.parse(e.data as string)); }, { once: true });
  });
}

export function closed(ws: WebSocket, timeoutMs = 5000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("close timeout")), timeoutMs);
    ws.addEventListener("close", (e) => { clearTimeout(t); resolve({ code: e.code }); }, { once: true });
  });
}
```

`apps/relay/test/ws.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth, openWs, closed } from "./helpers.js";

describe("listener attach + status", () => {
  it("401s a listener with a bad token", async () => {
    await registerHandle("bob");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=listen", {
      headers: { Upgrade: "websocket", ...wsAuth("bob", "wrong-token") },
    });
    expect(res.status).toBe(401);
  });

  it("status flips online when a listener attaches", async () => {
    const token = await registerHandle("carol");
    let status = await SELF.fetch("https://relay.test/v1/status/carol");
    expect((await status.json<{ online: boolean }>()).online).toBe(false);

    await openWs("/v1/ws?role=listen", wsAuth("carol", token));
    status = await SELF.fetch("https://relay.test/v1/status/carol");
    expect((await status.json<{ online: boolean }>()).online).toBe(true);
  });

  it("404s status for unknown handle", async () => {
    const res = await SELF.fetch("https://relay.test/v1/status/nobody");
    expect(res.status).toBe(404);
  });

  it("replaces an existing listener (old socket closed with 4000)", async () => {
    const token = await registerHandle("dave");
    const first = await openWs("/v1/ws?role=listen", wsAuth("dave", token));
    const firstClosed = closed(first);
    await openWs("/v1/ws?role=listen", wsAuth("dave", token));
    expect((await firstClosed).code).toBe(4000);
  });

  it("404s a call to an unregistered target", async () => {
    const token = await registerHandle("erin");
    const res = await SELF.fetch("https://relay.test/v1/ws?role=call&to=ghost", {
      headers: { Upgrade: "websocket", ...wsAuth("erin", token) },
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL (routes missing / DO 501).

- [ ] **Step 3: Implement**

Add to `apps/relay/src/index.ts` (after the register route):
```ts
import { verifyHandleToken } from "./auth.js";

async function handleExists(db: D1Database, handle: string): Promise<boolean> {
  return !!(await db.prepare("SELECT 1 FROM handles WHERE handle = ?").bind(handle).first());
}

app.get("/v1/status/:handle", async (c) => {
  const handle = c.req.param("handle");
  if (!(await handleExists(c.env.DB, handle))) return c.json({ error: "unknown handle" }, 404);
  const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(handle));
  return stub.fetch("https://do/status");
});

app.get("/v1/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.json({ error: "expected websocket" }, 426);
  const role = c.req.query("role");
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);

  let target: string;
  if (role === "listen") {
    target = handle;
  } else if (role === "call") {
    const to = c.req.query("to") ?? "";
    if (!(await handleExists(c.env.DB, to))) return c.json({ error: "unknown handle" }, 404);
    target = to;
  } else {
    return c.json({ error: "bad role" }, 400);
  }

  const stub = c.env.HANDLE_DO.get(c.env.HANDLE_DO.idFromName(target));
  const url = new URL(c.req.raw.url);
  const fwd = new Request(`https://do/ws?role=${role}`, c.req.raw);
  fwd.headers.set("X-Verified-From", handle);
  void url;
  return stub.fetch(fwd);
});
```

Replace `apps/relay/src/do.ts` with the real listener/status half (call flow lands in Task 4):
```ts
import { DurableObject } from "cloudflare:workers";

type CallerAttachment = { kind: "caller"; from: string; call_id?: string };
type ListenerAttachment = { kind: "listener" };

export class HandleDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ online: this.ctx.getWebSockets("listener").length > 0 });
    }
    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role");
      const from = req.headers.get("X-Verified-From") ?? "";
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (role === "listen") {
        for (const old of this.ctx.getWebSockets("listener")) old.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["listener"]);
        server.serializeAttachment({ kind: "listener" } satisfies ListenerAttachment);
      } else {
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({ kind: "caller", from } satisfies CallerAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }
}
```

- [ ] **Step 4: Run tests** → PASS (register tests must still pass).
- [ ] **Step 5: Commit** — `git add apps/relay/src apps/relay/test && git commit -m "feat(relay): WS auth, listener attach/replace, status endpoint"`.

---

### Task 4: HandleDO — full call flow (happy path, offline, size, rate limit, failure passthrough, timeout via alarm)

**Files:**
- Modify: `apps/relay/src/do.ts`
- Test: `apps/relay/test/callflow.test.ts`

**Interfaces:**
- Consumes: helpers from Task 3; schemas from shared.
- Produces (wire behavior the CLI relies on):
  1. Caller sends `call_request` → if no listener: `call_error offline` + close(1000). If listener: caller gets `call_status ringing`; listener gets `incoming_call {call_id, from, message, session_id?}`.
  2. Listener `call_answer {call_id}` → caller gets `call_status answered`.
  3. Listener `call_result {call_id, text, session_id?}` → caller gets `call_reply {call_id, text, session_id?}`, caller socket closed (1000); call record deleted.
  4. Listener `call_failed {call_id, code, detail}` → caller gets `call_error {code, detail}`, closed.
  5. message > 64_000 bytes → `call_error message_too_large`. 11th call in an hour from same caller → `call_error rate_limited`.
  6. No result before deadline (360s) → alarm fires → caller gets `call_error timeout`. (Test with a 100ms deadline injected via `X-Test-Timeout-Ms` internal header set by the Worker from query param `test_timeout_ms` — only honored when the header is present; keeps tests fast without faking clocks.)
  7. Second `call_request` on the same socket → `call_error protocol_error`, closed.
  8. Listener disconnect does NOT fail in-flight calls (reply can arrive on a reconnected listener socket).

- [ ] **Step 1: Write the failing test** — `apps/relay/test/callflow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth, openWs, nextFrame, closed } from "./helpers.js";

async function setupPair(callee: string, caller: string) {
  const calleeToken = await registerHandle(callee);
  const callerToken = await registerHandle(caller);
  const listener = await openWs("/v1/ws?role=listen", wsAuth(callee, calleeToken));
  return { calleeToken, callerToken, listener };
}

describe("call flow", () => {
  it("relays a full happy-path call", async () => {
    const { callerToken, listener } = await setupPair("h-callee", "h-caller");
    const caller = await openWs("/v1/ws?role=call&to=h-callee", wsAuth("h-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "h-callee", message: "what is 2+2?" }));

    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "ringing" });
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({ type: "incoming_call", from: "h-caller", message: "what is 2+2?" });

    listener.send(JSON.stringify({ type: "call_answer", call_id: incoming.call_id }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_status", state: "answered" });

    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "4", session_id: "s1" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "4", session_id: "s1" });
    expect((await closed(caller)).code).toBe(1000);
  });

  it("returns offline immediately when no listener", async () => {
    await registerHandle("off-callee");
    const t = await registerHandle("off-caller");
    const caller = await openWs("/v1/ws?role=call&to=off-callee", wsAuth("off-caller", t));
    caller.send(JSON.stringify({ type: "call_request", to: "off-callee", message: "hi" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "offline" });
  });

  it("relays call_failed as call_error", async () => {
    const { callerToken, listener } = await setupPair("f-callee", "f-caller");
    const caller = await openWs("/v1/ws?role=call&to=f-callee", wsAuth("f-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "f-callee", message: "hi" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({ type: "call_failed", call_id: incoming.call_id, code: "busy" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "busy" });
  });

  it("rejects oversized messages", async () => {
    const { callerToken } = await setupPair("big-callee", "big-caller");
    const caller = await openWs("/v1/ws?role=call&to=big-callee", wsAuth("big-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "big-callee", message: "x".repeat(65_000) }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "message_too_large" });
  });

  it("rate limits the 11th call in an hour", async () => {
    const { callerToken, listener } = await setupPair("rl-callee", "rl-caller");
    for (let i = 0; i < 10; i++) {
      const c = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
      c.send(JSON.stringify({ type: "call_request", to: "rl-callee", message: `call ${i}` }));
      await nextFrame(c); // ringing
      const inc = await nextFrame(listener);
      listener.send(JSON.stringify({ type: "call_result", call_id: inc.call_id, text: "ok" }));
      await nextFrame(c); // reply
    }
    const eleventh = await openWs("/v1/ws?role=call&to=rl-callee", wsAuth("rl-caller", callerToken));
    eleventh.send(JSON.stringify({ type: "call_request", to: "rl-callee", message: "one too many" }));
    expect(await nextFrame(eleventh)).toMatchObject({ type: "call_error", code: "rate_limited" });
  });

  it("times out a call whose listener never replies", async () => {
    const { callerToken } = await setupPair("to-callee", "to-caller");
    const caller = await openWs("/v1/ws?role=call&to=to-callee&test_timeout_ms=100", wsAuth("to-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "to-callee", message: "hello?" }));
    await nextFrame(caller); // ringing
    expect(await nextFrame(caller, 10_000)).toMatchObject({ type: "call_error", code: "timeout" });
  });

  it("rejects a second call_request on the same socket", async () => {
    const { callerToken } = await setupPair("p-callee", "p-caller");
    const caller = await openWs("/v1/ws?role=call&to=p-callee", wsAuth("p-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "p-callee", message: "one" }));
    await nextFrame(caller); // ringing
    caller.send(JSON.stringify({ type: "call_request", to: "p-callee", message: "two" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_error", code: "protocol_error" });
  });

  it("survives listener reconnect mid-call", async () => {
    const { calleeToken, callerToken, listener } = await setupPair("rc-callee", "rc-caller");
    const caller = await openWs("/v1/ws?role=call&to=rc-callee", wsAuth("rc-caller", callerToken));
    caller.send(JSON.stringify({ type: "call_request", to: "rc-callee", message: "slow one" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.close(1000, "network blip");
    const listener2 = await openWs("/v1/ws?role=listen", wsAuth("rc-callee", calleeToken));
    listener2.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "late but here" }));
    expect(await nextFrame(caller)).toMatchObject({ type: "call_reply", text: "late but here" });
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.

- [ ] **Step 3: Implement** — extend `apps/relay/src/do.ts`. Also pass `test_timeout_ms` through in `index.ts` `/v1/ws` route: `fwd` URL becomes `https://do/ws?role=${role}&test_timeout_ms=${c.req.query("test_timeout_ms") ?? ""}`.

```ts
import { DurableObject } from "cloudflare:workers";
import {
  CallerFrame, ListenerToRelayFrame, MAX_MESSAGE_BYTES, MAX_REPLY_BYTES,
  RATE_LIMIT_PER_HOUR, RELAY_CALL_TIMEOUT_MS, safeParseFrame,
  type ErrorCodeType,
} from "@agentcall/shared";

type CallerAttachment = { kind: "caller"; from: string; call_id?: string; timeoutMs?: number };
type ListenerAttachment = { kind: "listener" };
type CallRecord = { call_id: string; from: string; deadline: number };

export class HandleDO extends DurableObject {
  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/status") {
      return Response.json({ online: this.ctx.getWebSockets("listener").length > 0 });
    }
    if (url.pathname === "/ws") {
      const role = url.searchParams.get("role");
      const from = req.headers.get("X-Verified-From") ?? "";
      const testTimeout = Number(url.searchParams.get("test_timeout_ms") || "") || undefined;
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      if (role === "listen") {
        for (const old of this.ctx.getWebSockets("listener")) old.close(4000, "replaced");
        this.ctx.acceptWebSocket(server, ["listener"]);
        server.serializeAttachment({ kind: "listener" } satisfies ListenerAttachment);
      } else {
        this.ctx.acceptWebSocket(server, ["caller"]);
        server.serializeAttachment({ kind: "caller", from, timeoutMs: testTimeout } satisfies CallerAttachment);
      }
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response("not found", { status: 404 });
  }

  private send(ws: WebSocket, frame: unknown): void {
    try { ws.send(JSON.stringify(frame)); } catch { /* socket gone */ }
  }

  private fail(ws: WebSocket, code: ErrorCodeType, detail?: string, close = true): void {
    this.send(ws, { type: "call_error", code, detail });
    if (close) { try { ws.close(1000, code); } catch { /* already closed */ } }
  }

  private callerFor(callId: string): WebSocket | undefined {
    return this.ctx.getWebSockets("caller").find(
      (w) => (w.deserializeAttachment() as CallerAttachment | null)?.call_id === callId,
    );
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    const att = ws.deserializeAttachment() as CallerAttachment | ListenerAttachment | null;
    if (!att) return;

    if (att.kind === "caller") {
      const frame = safeParseFrame(CallerFrame, raw);
      if (!frame || att.call_id) return this.fail(ws, "protocol_error");
      if (new TextEncoder().encode(frame.message).byteLength > MAX_MESSAGE_BYTES) {
        return this.fail(ws, "message_too_large");
      }
      const now = Date.now();
      const rlKey = `rl:${att.from}`;
      const stamps = ((await this.ctx.storage.get<number[]>(rlKey)) ?? []).filter((t) => now - t < 3_600_000);
      if (stamps.length >= RATE_LIMIT_PER_HOUR) return this.fail(ws, "rate_limited");
      const listener = this.ctx.getWebSockets("listener")[0];
      if (!listener) return this.fail(ws, "offline");

      stamps.push(now);
      await this.ctx.storage.put(rlKey, stamps);
      const call_id = crypto.randomUUID();
      const deadline = now + (att.timeoutMs ?? RELAY_CALL_TIMEOUT_MS);
      ws.serializeAttachment({ ...att, call_id });
      await this.ctx.storage.put<CallRecord>(`call:${call_id}`, { call_id, from: att.from, deadline });
      await this.scheduleNextAlarm();
      this.send(ws, { type: "call_status", state: "ringing" });
      this.send(listener, {
        type: "incoming_call", call_id, from: att.from,
        message: frame.message, session_id: frame.session_id,
      });
      return;
    }

    // listener frames
    const frame = safeParseFrame(ListenerToRelayFrame, raw);
    if (!frame) return;
    const record = await this.ctx.storage.get<CallRecord>(`call:${frame.call_id}`);
    if (!record) return; // stale/unknown call
    const caller = this.callerFor(frame.call_id);

    if (frame.type === "call_answer") {
      if (caller) this.send(caller, { type: "call_status", state: "answered" });
      return;
    }
    if (frame.type === "call_result") {
      const text = frame.text.length > MAX_REPLY_BYTES ? frame.text.slice(0, MAX_REPLY_BYTES) : frame.text;
      if (caller) {
        this.send(caller, { type: "call_reply", call_id: frame.call_id, text, session_id: frame.session_id });
        try { caller.close(1000, "done"); } catch { /* closed */ }
      }
      await this.ctx.storage.delete(`call:${frame.call_id}`);
      return;
    }
    if (frame.type === "call_failed") {
      if (caller) this.fail(caller, frame.code, frame.detail);
      await this.ctx.storage.delete(`call:${frame.call_id}`);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as CallerAttachment | ListenerAttachment | null;
    if (att?.kind === "caller" && att.call_id) {
      await this.ctx.storage.delete(`call:${att.call_id}`);
    }
    // listener close: keep in-flight calls; a reconnected listener may still deliver results.
  }

  private async scheduleNextAlarm(): Promise<void> {
    const calls = await this.ctx.storage.list<CallRecord>({ prefix: "call:" });
    let min = Infinity;
    for (const rec of calls.values()) min = Math.min(min, rec.deadline);
    if (min !== Infinity) await this.ctx.storage.setAlarm(min);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const calls = await this.ctx.storage.list<CallRecord>({ prefix: "call:" });
    for (const rec of calls.values()) {
      if (rec.deadline <= now) {
        const caller = this.callerFor(rec.call_id);
        if (caller) this.fail(caller, "timeout");
        await this.ctx.storage.delete(`call:${rec.call_id}`);
      }
    }
    await this.scheduleNextAlarm();
  }
}
```

- [ ] **Step 4: Run all relay tests** → PASS (`pnpm test` in `apps/relay`; register + ws + callflow).
- [ ] **Step 5: Commit** — `git add apps/relay/src apps/relay/test && git commit -m "feat(relay): full call relay in HandleDO (offline/busy/rate-limit/timeout)"`.

---

### Task 5: install.sh route

**Files:**
- Create: `apps/relay/src/install-sh.ts`
- Modify: `apps/relay/src/index.ts`
- Test: `apps/relay/test/install.test.ts`

**Interfaces:**
- Produces: `GET /install.sh` → 200, `content-type: text/x-shellscript`, body = `INSTALL_SH` export.

- [ ] **Step 1: Failing test** — `apps/relay/test/install.test.ts`:
```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("GET /install.sh", () => {
  it("serves a shell script", async () => {
    const res = await SELF.fetch("https://relay.test/install.sh");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/x-shellscript");
    const body = await res.text();
    expect(body).toContain("#!/bin/sh");
    expect(body).toContain("npm install -g agentcall");
    expect(body).toContain("agentcall setup");
    expect(body).toContain("/dev/tty");
    expect(body).toContain("Darwin");
  });
});
```
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** — `apps/relay/src/install-sh.ts`:
```ts
export const INSTALL_SH = `#!/bin/sh
set -eu

if [ "$(uname)" != "Darwin" ]; then
  echo "agentcall currently supports macOS only." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "agentcall needs Node.js >= 20 (it ships with Claude Code / Codex setups)." >&2
  echo "Install it first: https://nodejs.org or 'brew install node'." >&2
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "agentcall needs Node.js >= 20 (found $(node --version))." >&2
  exit 1
fi

echo "Installing agentcall..."
npm install -g agentcall

if [ -t 0 ]; then
  exec agentcall setup "$@"
else
  exec agentcall setup "$@" < /dev/tty
fi
`;
```
In `index.ts`: `import { INSTALL_SH } from "./install-sh.js";` and
```ts
app.get("/install.sh", (c) => c.text(INSTALL_SH, 200, { "content-type": "text/x-shellscript; charset=utf-8" }));
```
- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git add apps/relay/src apps/relay/test && git commit -m "feat(relay): serve install.sh bootstrap"`.

---

### Task 6: CLI scaffold, paths, config IO, HTTP api client

**Files:**
- Create: `packages/cli/package.json`, `packages/cli/tsconfig.json`, `packages/cli/vitest.config.ts`,
  `packages/cli/src/paths.ts`, `packages/cli/src/config.ts`, `packages/cli/src/api.ts`, `packages/cli/bin/agentcall.js`
- Test: `packages/cli/test/config.test.ts`, `packages/cli/test/api.test.ts`

**Interfaces:**
- Produces:
  - `paths.ts`: `getPaths(home = process.env.AGENTCALL_HOME ?? os.homedir())` →
    `{ home, dir: ~/.agentcall, configFile, srtFile, callsLog, listenerLog, publicDir: ~/AgentCall/public, plistFile: ~/Library/LaunchAgents/tech.benree.agentcall.listener.plist }` (all under `home`).
  - `config.ts`: `type Config = { handle: string; token: string; agent_kind: "claude" | "codex"; relay: string }`;
    `loadConfig(p): Config` (throws friendly Error if missing); `saveConfig(p, cfg): void` (dir 0700, file 0600);
    `relayUrl(cfg?): string` — `process.env.AGENTCALL_RELAY ?? cfg?.relay ?? "https://agentcall.benree.tech"`.
  - `api.ts`: `registerHandle(relay, handle, agentKind): Promise<{token, address}>` (throws `Error` with `.code = "handle_taken" | "invalid" | "network"`);
    `getStatus(relay, handle): Promise<{online: boolean}>` (throws `.code = "unknown_handle"` on 404).
  - `bin/agentcall.js`: `#!/usr/bin/env node` + `import("../dist/index.js")`.

`packages/cli/package.json`:
```json
{
  "name": "agentcall",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agentcall": "./bin/agentcall.js" },
  "files": ["bin", "dist"],
  "engines": { "node": ">=20" },
  "os": ["darwin"],
  "scripts": { "build": "tsc -p tsconfig.json", "test": "vitest run", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@agentcall/shared": "workspace:*", "commander": "^12.0.0", "ws": "^8.18.0", "zod": "^4.0.0" },
  "devDependencies": { "@types/node": "^22.0.0", "@types/ws": "^8.5.0", "typescript": "^5.6.0", "vitest": "^3.0.0" }
}
```
(`tsconfig.json` extends base, `outDir: dist, rootDir: src`, include src. `vitest.config.ts` default node environment, `test: { include: ["test/**/*.test.ts"] }`.)

- [ ] **Step 1: Failing tests**

`packages/cli/test/config.test.ts`:
```ts
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import { loadConfig, saveConfig, relayUrl } from "../src/config.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-test-")); }

describe("paths", () => {
  it("derives everything from home", () => {
    const p = getPaths("/tmp/fakehome");
    expect(p.configFile).toBe("/tmp/fakehome/.agentcall/config.json");
    expect(p.publicDir).toBe("/tmp/fakehome/AgentCall/public");
    expect(p.plistFile).toBe("/tmp/fakehome/Library/LaunchAgents/tech.benree.agentcall.listener.plist");
  });
});

describe("config", () => {
  it("round-trips and sets 0600/0700 perms", () => {
    const p = getPaths(tempHome());
    const cfg = { handle: "ken", token: "t".repeat(43), agent_kind: "claude" as const, relay: "https://agentcall.benree.tech" };
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
    expect(statSync(p.configFile).mode & 0o777).toBe(0o600);
    expect(statSync(p.dir).mode & 0o777).toBe(0o700);
  });
  it("throws a friendly error when config missing", () => {
    const p = getPaths(tempHome());
    expect(() => loadConfig(p)).toThrow(/agentcall setup/);
  });
  it("relayUrl: env > config > default", () => {
    const cfg = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://custom.example" };
    expect(relayUrl(cfg)).toBe("https://custom.example");
    expect(relayUrl(undefined)).toBe("https://agentcall.benree.tech");
    process.env.AGENTCALL_RELAY = "http://localhost:8787";
    try { expect(relayUrl(cfg)).toBe("http://localhost:8787"); }
    finally { delete process.env.AGENTCALL_RELAY; }
  });
});
```

`packages/cli/test/api.test.ts` (spin a throwaway `node:http` server per test):
```ts
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { registerHandle, getStatus } from "../src/api.js";

let server: Server;
afterEach(() => server?.close());

function serve(status: number, body: unknown): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

describe("api client", () => {
  it("registers", async () => {
    const relay = await serve(200, { token: "tok", address: "ken@agentcall.benree.tech" });
    expect(await registerHandle(relay, "ken", "claude")).toEqual({ token: "tok", address: "ken@agentcall.benree.tech" });
  });
  it("maps 409 to handle_taken", async () => {
    const relay = await serve(409, { error: "handle taken" });
    await expect(registerHandle(relay, "ken", "claude")).rejects.toMatchObject({ code: "handle_taken" });
  });
  it("gets status and maps 404", async () => {
    const relay = await serve(200, { online: true });
    expect(await getStatus(relay, "ken")).toEqual({ online: true });
    const relay2 = await serve(404, { error: "unknown handle" });
    await expect(getStatus(relay2, "ghost")).rejects.toMatchObject({ code: "unknown_handle" });
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement**

`packages/cli/src/paths.ts`:
```ts
import os from "node:os";
import { join } from "node:path";

export interface Paths {
  home: string; dir: string; configFile: string; srtFile: string;
  callsLog: string; listenerLog: string; publicDir: string; plistFile: string;
}

export function getPaths(home: string = process.env.AGENTCALL_HOME ?? os.homedir()): Paths {
  const dir = join(home, ".agentcall");
  return {
    home, dir,
    configFile: join(dir, "config.json"),
    srtFile: join(dir, "srt.json"),
    callsLog: join(dir, "calls.log"),
    listenerLog: join(dir, "listener.log"),
    publicDir: join(home, "AgentCall", "public"),
    plistFile: join(home, "Library", "LaunchAgents", "tech.benree.agentcall.listener.plist"),
  };
}
```

`packages/cli/src/config.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import type { Paths } from "./paths.js";

export interface Config {
  handle: string;
  token: string;
  agent_kind: "claude" | "codex";
  relay: string;
}

export const DEFAULT_RELAY = "https://agentcall.benree.tech";

export function loadConfig(p: Paths): Config {
  if (!existsSync(p.configFile)) {
    throw new Error(`No agentcall config found. Run \`agentcall setup\` first.`);
  }
  return JSON.parse(readFileSync(p.configFile, "utf8")) as Config;
}

export function saveConfig(p: Paths, cfg: Config): void {
  mkdirSync(p.dir, { recursive: true, mode: 0o700 });
  chmodSync(p.dir, 0o700);
  writeFileSync(p.configFile, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(p.configFile, 0o600);
}

export function relayUrl(cfg?: Config): string {
  return process.env.AGENTCALL_RELAY ?? cfg?.relay ?? DEFAULT_RELAY;
}
```

`packages/cli/src/api.ts`:
```ts
export class ApiError extends Error {
  constructor(message: string, public code: "handle_taken" | "invalid" | "unknown_handle" | "network") {
    super(message);
  }
}

export async function registerHandle(
  relay: string, handle: string, agentKind: "claude" | "codex",
): Promise<{ token: string; address: string }> {
  let res: Response;
  try {
    res = await fetch(`${relay}/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handle, agent_kind: agentKind }),
    });
  } catch (e) {
    throw new ApiError(`Cannot reach relay ${relay}: ${String(e)}`, "network");
  }
  if (res.status === 409) throw new ApiError(`Handle "${handle}" is already taken.`, "handle_taken");
  if (!res.ok) throw new ApiError(`Registration failed (${res.status}).`, "invalid");
  return (await res.json()) as { token: string; address: string };
}

export async function getStatus(relay: string, handle: string): Promise<{ online: boolean }> {
  let res: Response;
  try {
    res = await fetch(`${relay}/v1/status/${handle}`);
  } catch (e) {
    throw new ApiError(`Cannot reach relay ${relay}: ${String(e)}`, "network");
  }
  if (res.status === 404) throw new ApiError(`No agent registered as "${handle}".`, "unknown_handle");
  if (!res.ok) throw new ApiError(`Status check failed (${res.status}).`, "network");
  return (await res.json()) as { online: boolean };
}
```

`packages/cli/bin/agentcall.js`:
```js
#!/usr/bin/env node
import("../dist/index.js");
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git add packages/cli pnpm-lock.yaml && git commit -m "feat(cli): scaffold, paths, config, relay api client"`.

---

### Task 7: Runner — prompt preamble, spawn spec, output parsing, srt settings

**Files:**
- Create: `packages/cli/src/prompt.ts`, `packages/cli/src/runner.ts`, `packages/cli/src/srt.ts`
- Test: `packages/cli/test/runner.test.ts`

**Interfaces:**
- Produces:
  - `buildPrompt(handle: string, from: string, message: string): string` — preamble exactly:
    `You are ${handle}'s public agent, answering a one-shot call from "${from}" via agentcall. You can only access the current directory (~/AgentCall/public). Do not attempt to access anything else. Answer helpfully and concisely. The caller's message follows after the divider.\n---\n${message}`
  - `buildSpawnSpec(kind, prompt, paths): { cmd: string; args: string[]; cwd: string }` —
    claude → `npx ["-y","@anthropic-ai/sandbox-runtime","--settings",paths.srtFile,"--","claude","-p",prompt,"--output-format","json"]`, cwd publicDir;
    codex → `codex ["exec","--sandbox","workspace-write","--cd",paths.publicDir,"--skip-git-repo-check","--json",prompt]`, cwd publicDir.
  - `parseClaudeJson(stdout: string): { text: string; session_id?: string }` — parses JSON, uses `.result` and `.session_id`; throws on unparseable/missing result.
  - `parseCodexJsonl(stdout: string): { text: string; session_id?: string }` — scans JSONL lines, takes the LAST `item.completed` event whose `item.type === "agent_message"` → `item.text`; captures `session_id` from any `session.created`/`thread.started` event field `session_id` or `thread_id`; falls back to trimmed raw stdout if no JSON events found (still succeeds unless empty).
  - `runAgent(kind, prompt, paths, timeoutMs = AGENT_TIMEOUT_MS): Promise<{ text: string; session_id?: string }>` — `child_process.spawn`, collects stdout/stderr, SIGTERM at timeout then SIGKILL after 10s, rejects with `AgentRunError` (`.code = "timeout" | "agent_error"`); truncates text to `MAX_REPLY_BYTES`.
  - `srtSettings(paths): object` — the srt.json content:

```json
{
  "permissions": {
    "filesystem": {
      "allowWrite": ["<publicDir>", "~/.claude", "~/.claude.json", "/tmp", "/private/tmp", "/var/folders"],
      "denyRead": ["~/.ssh", "~/.aws", "~/.gnupg", "~/.agentcall", "~/.config"]
    },
    "network": { "allowedDomains": ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io", "claude.ai"] }
  }
}
```
(Implementer note: verify key names against the installed `@anthropic-ai/sandbox-runtime` README at implementation time (`npm view @anthropic-ai/sandbox-runtime readme | head -100`); if the schema differs, match the real schema and keep the same intent — this exact JSON is the intent, not gospel.)

- [ ] **Step 1: Failing tests** — `packages/cli/test/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../src/prompt.js";
import { buildSpawnSpec, parseClaudeJson, parseCodexJsonl, runAgent } from "../src/runner.js";
import { getPaths } from "../src/paths.js";

const p = getPaths("/tmp/fakehome");

describe("buildPrompt", () => {
  it("includes handle, caller, divider, and message", () => {
    const out = buildPrompt("ken", "shusaku", "review my plan");
    expect(out).toContain("ken's public agent");
    expect(out).toContain('"shusaku"');
    expect(out).toContain("\n---\nreview my plan");
  });
});

describe("buildSpawnSpec", () => {
  it("wraps claude in srt with settings file", () => {
    const s = buildSpawnSpec("claude", "PROMPT", p);
    expect(s.cmd).toBe("npx");
    expect(s.args).toEqual([
      "-y", "@anthropic-ai/sandbox-runtime", "--settings", p.srtFile, "--",
      "claude", "-p", "PROMPT", "--output-format", "json",
    ]);
    expect(s.cwd).toBe(p.publicDir);
  });
  it("uses codex native sandbox", () => {
    const s = buildSpawnSpec("codex", "PROMPT", p);
    expect(s.cmd).toBe("codex");
    expect(s.args).toEqual([
      "exec", "--sandbox", "workspace-write", "--cd", p.publicDir, "--skip-git-repo-check", "--json", "PROMPT",
    ]);
  });
});

describe("output parsing", () => {
  it("parses claude json output", () => {
    const stdout = JSON.stringify({ type: "result", result: "The answer is 4.", session_id: "abc-123", is_error: false });
    expect(parseClaudeJson(stdout)).toEqual({ text: "The answer is 4.", session_id: "abc-123" });
  });
  it("throws on claude error output", () => {
    expect(() => parseClaudeJson("total garbage")).toThrow();
  });
  it("parses codex jsonl, taking the last agent_message", () => {
    const lines = [
      JSON.stringify({ type: "thread.started", thread_id: "th_1" }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "first" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
    ].join("\n");
    expect(parseCodexJsonl(lines)).toEqual({ text: "final answer", session_id: "th_1" });
  });
  it("falls back to raw stdout for codex without json events", () => {
    expect(parseCodexJsonl("plain text answer\n")).toEqual({ text: "plain text answer", session_id: undefined });
  });
});

describe("runAgent (with a fake agent binary)", () => {
  it("times out a hung process", async () => {
    // fake spec via kind override: use claude spec but point PATH at a script? Simpler:
    // runAgent accepts an optional spawnSpec override for tests.
    await expect(
      runAgent("claude", "x", p, 300, { cmd: "sleep", args: ["5"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "timeout" });
  }, 15_000);
  it("captures stdout of a real process", async () => {
    const fakeOut = JSON.stringify({ type: "result", result: "hi", session_id: "s" });
    const res = await runAgent("claude", "x", p, 5000, {
      cmd: "node", args: ["-e", `console.log(${JSON.stringify(fakeOut)})`], cwd: "/tmp",
    });
    expect(res.text).toBe("hi");
  });
  it("rejects agent_error on nonzero exit", async () => {
    await expect(
      runAgent("claude", "x", p, 5000, { cmd: "node", args: ["-e", "process.exit(3)"], cwd: "/tmp" }),
    ).rejects.toMatchObject({ code: "agent_error" });
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** `prompt.ts`, `srt.ts`, `runner.ts`:

`packages/cli/src/prompt.ts`:
```ts
export function buildPrompt(handle: string, from: string, message: string): string {
  return (
    `You are ${handle}'s public agent, answering a one-shot call from "${from}" via agentcall. ` +
    `You can only access the current directory (~/AgentCall/public). Do not attempt to access anything else. ` +
    `Answer helpfully and concisely. The caller's message follows after the divider.\n---\n${message}`
  );
}
```

`packages/cli/src/srt.ts`:
```ts
import type { Paths } from "./paths.js";

export function srtSettings(p: Paths): object {
  return {
    permissions: {
      filesystem: {
        allowWrite: [p.publicDir, "~/.claude", "~/.claude.json", "/tmp", "/private/tmp", "/var/folders"],
        denyRead: ["~/.ssh", "~/.aws", "~/.gnupg", "~/.agentcall", "~/.config"],
      },
      network: { allowedDomains: ["api.anthropic.com", "statsig.anthropic.com", "*.sentry.io", "claude.ai"] },
    },
  };
}
```

`packages/cli/src/runner.ts`:
```ts
import { spawn } from "node:child_process";
import { MAX_REPLY_BYTES } from "@agentcall/shared";
import type { Paths } from "./paths.js";

export type AgentKind = "claude" | "codex";
export interface SpawnSpec { cmd: string; args: string[]; cwd: string }
export interface AgentOutput { text: string; session_id?: string }

export class AgentRunError extends Error {
  constructor(message: string, public code: "timeout" | "agent_error") { super(message); }
}

export function buildSpawnSpec(kind: AgentKind, prompt: string, p: Paths): SpawnSpec {
  if (kind === "claude") {
    return {
      cmd: "npx",
      args: ["-y", "@anthropic-ai/sandbox-runtime", "--settings", p.srtFile, "--",
        "claude", "-p", prompt, "--output-format", "json"],
      cwd: p.publicDir,
    };
  }
  return {
    cmd: "codex",
    args: ["exec", "--sandbox", "workspace-write", "--cd", p.publicDir, "--skip-git-repo-check", "--json", prompt],
    cwd: p.publicDir,
  };
}

export function parseClaudeJson(stdout: string): AgentOutput {
  const parsed = JSON.parse(stdout.trim()) as { result?: string; session_id?: string; is_error?: boolean };
  if (typeof parsed.result !== "string") throw new Error("claude output missing result");
  return { text: parsed.result, session_id: parsed.session_id };
}

export function parseCodexJsonl(stdout: string): AgentOutput {
  let text: string | undefined;
  let session: string | undefined;
  let sawJson = false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const evt = JSON.parse(trimmed) as any;
      sawJson = true;
      if (evt.thread_id ?? evt.session_id) session = evt.thread_id ?? evt.session_id;
      if (evt.type === "item.completed" && evt.item?.type === "agent_message" && typeof evt.item.text === "string") {
        text = evt.item.text;
      }
    } catch { /* not a json line */ }
  }
  if (text !== undefined) return { text, session_id: session };
  const raw = stdout.trim();
  if (!sawJson && raw) return { text: raw, session_id: session };
  throw new Error("codex output had no agent_message");
}

export function runAgent(
  kind: AgentKind, prompt: string, p: Paths, timeoutMs: number, specOverride?: SpawnSpec,
): Promise<AgentOutput> {
  const spec = specOverride ?? buildSpawnSpec(kind, prompt, p);
  return new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(new AgentRunError(String(e), "agent_error")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new AgentRunError(`agent timed out after ${timeoutMs}ms`, "timeout"));
      if (code !== 0) return reject(new AgentRunError(`agent exited ${code}: ${stderr.slice(0, 2000)}`, "agent_error"));
      try {
        const out = kind === "claude" ? parseClaudeJson(stdout) : parseCodexJsonl(stdout);
        resolve({ ...out, text: out.text.slice(0, MAX_REPLY_BYTES) });
      } catch (e) {
        reject(new AgentRunError(`could not parse agent output: ${String(e)}`, "agent_error"));
      }
    });
  });
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git add packages/cli/src packages/cli/test && git commit -m "feat(cli): sandboxed agent runner + output parsers"`.

---

### Task 8: Call client (caller side over WS)

**Files:**
- Create: `packages/cli/src/callClient.ts`
- Test: `packages/cli/test/callClient.test.ts`

**Interfaces:**
- Consumes: shared frames; `ws` package.
- Produces: `callAgent(opts: { relay: string; from: string; token: string; to: string; message: string; sessionId?: string; onStatus?: (state: string) => void; timeoutMs?: number }): Promise<CallReplyType>`; throws `CallError` class (`.code: ErrorCodeType`, message human-readable). Converts `relay` http(s)→ws(s). Connects `\${wsRelay}/v1/ws?role=call&to=\${to}` with headers `{Authorization, X-AgentCall-Handle}`; sends `call_request` on open; resolves on `call_reply`; rejects on `call_error`, close-before-reply, HTTP 401/404 during upgrade (map: 401→unauthorized, 404→unknown_handle), or client timeout (default 420_000ms).

- [ ] **Step 1: Failing test** — `packages/cli/test/callClient.test.ts` uses a real `WebSocketServer` from `ws` as fake relay:

```ts
import { createServer, type Server } from "node:http";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { callAgent, CallError } from "../src/callClient.js";

let httpServer: Server;
afterEach(() => new Promise<void>((r) => httpServer?.close(() => r())));

type Script = (ws: import("ws").WebSocket, req: import("node:http").IncomingMessage) => void;

function fakeRelay(script: Script): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer((_q, s) => { s.writeHead(404); s.end(); });
    const wss = new WebSocketServer({ server: httpServer, path: "/v1/ws" });
    wss.on("connection", script);
    httpServer.listen(0, "127.0.0.1", () => {
      const { port } = httpServer.address() as { port: number };
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

const base = { from: "me", token: "tok", to: "ken", message: "hi" };

describe("callAgent", () => {
  it("resolves with the reply and reports statuses", async () => {
    const relay = await fakeRelay((ws, req) => {
      expect(req.headers.authorization).toBe("Bearer tok");
      expect(req.headers["x-agentcall-handle"]).toBe("me");
      ws.on("message", (raw) => {
        const f = JSON.parse(String(raw));
        expect(f).toMatchObject({ type: "call_request", to: "ken", message: "hi" });
        ws.send(JSON.stringify({ type: "call_status", state: "ringing" }));
        ws.send(JSON.stringify({ type: "call_status", state: "answered" }));
        ws.send(JSON.stringify({ type: "call_reply", call_id: "c1", text: "yo", session_id: "s9" }));
        ws.close(1000);
      });
    });
    const states: string[] = [];
    const reply = await callAgent({ relay, ...base, onStatus: (s) => states.push(s) });
    expect(reply.text).toBe("yo");
    expect(reply.session_id).toBe("s9");
    expect(states).toEqual(["ringing", "answered"]);
  });

  it("rejects with the relay's error code", async () => {
    const relay = await fakeRelay((ws) => {
      ws.on("message", () => ws.send(JSON.stringify({ type: "call_error", code: "offline" })));
    });
    await expect(callAgent({ relay, ...base })).rejects.toMatchObject({ code: "offline" });
  });

  it("rejects when the socket closes before a reply", async () => {
    const relay = await fakeRelay((ws) => { ws.on("message", () => ws.close(1011)); });
    await expect(callAgent({ relay, ...base })).rejects.toBeInstanceOf(CallError);
  });

  it("times out client-side", async () => {
    const relay = await fakeRelay(() => { /* say nothing */ });
    await expect(callAgent({ relay, ...base, timeoutMs: 200 })).rejects.toMatchObject({ code: "timeout" });
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** — `packages/cli/src/callClient.ts`:

```ts
import WebSocket from "ws";
import { RelayToCallerFrame, safeParseFrame, type CallReplyType, type ErrorCodeType } from "@agentcall/shared";

export class CallError extends Error {
  constructor(message: string, public code: ErrorCodeType | "connection_failed") { super(message); }
}

const HUMAN: Record<string, string> = {
  offline: "That agent is offline right now.",
  unknown_handle: "No agent is registered at that address.",
  busy: "That agent is busy (queue full). Try again in a few minutes.",
  timeout: "The call timed out.",
  rate_limited: "You are calling this agent too often. Try later.",
  unauthorized: "Your credentials were rejected. Re-run `agentcall setup`.",
  agent_error: "The remote agent hit an error while answering.",
  message_too_large: "Your message is too large (64KB max).",
  protocol_error: "Protocol error.",
};

export interface CallOpts {
  relay: string; from: string; token: string; to: string; message: string;
  sessionId?: string; onStatus?: (state: string) => void; timeoutMs?: number;
}

export function callAgent(opts: CallOpts): Promise<CallReplyType> {
  const wsUrl = opts.relay.replace(/^http/, "ws") + `/v1/ws?role=call&to=${encodeURIComponent(opts.to)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, {
      headers: { Authorization: `Bearer ${opts.token}`, "X-AgentCall-Handle": opts.from },
    });
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); try { ws.close(); } catch {} } };
    const timer = setTimeout(
      () => finish(() => reject(new CallError(HUMAN.timeout, "timeout"))),
      opts.timeoutMs ?? 420_000,
    );

    ws.on("unexpected-response", (_req, res) => {
      const code: ErrorCodeType = res.statusCode === 404 ? "unknown_handle" : "unauthorized";
      finish(() => reject(new CallError(HUMAN[code], code)));
    });
    ws.on("error", (e) => finish(() => reject(new CallError(`Connection failed: ${e.message}`, "connection_failed"))));
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "call_request", to: opts.to, message: opts.message, session_id: opts.sessionId }));
    });
    ws.on("message", (raw) => {
      const frame = safeParseFrame(RelayToCallerFrame, String(raw));
      if (!frame) return;
      if (frame.type === "call_status") opts.onStatus?.(frame.state);
      else if (frame.type === "call_reply") finish(() => resolve(frame));
      else if (frame.type === "call_error") finish(() => reject(new CallError(frame.detail ?? HUMAN[frame.code] ?? frame.code, frame.code)));
    });
    ws.on("close", () => finish(() => reject(new CallError("Connection closed before a reply arrived.", "connection_failed"))));
  });
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git add packages/cli/src packages/cli/test && git commit -m "feat(cli): caller websocket client"`.

---

### Task 9: Listener (queue + WS client + audit log)

**Files:**
- Create: `packages/cli/src/queue.ts`, `packages/cli/src/listener.ts`
- Test: `packages/cli/test/queue.test.ts`, `packages/cli/test/listener.test.ts`

**Interfaces:**
- Consumes: `runAgent`, `buildPrompt`, config/paths, shared frames.
- Produces:
  - `queue.ts`: `class SerialQueue { constructor(maxPending: number); tryEnqueue(job: () => Promise<void>): boolean; get pending(): number; get running(): boolean; onIdle(): Promise<void> }` — runs jobs one at a time in order; `tryEnqueue` returns false when `pending >= maxPending` while running.
  - `listener.ts`: `startListener(deps: { relay: string; config: Config; paths: Paths; run?: typeof runAgent; maxPending?: number; backoffMs?: (attempt: number) => number }): { stop(): void }`.
    Behavior: connect `role=listen` with auth headers; send text `ping` every 30s (relay auto-responds `pong`); on `incoming_call` → if `tryEnqueue` fails send `call_failed busy`; else send `call_answer`, `run(kind, buildPrompt(handle, from, message), paths, AGENT_TIMEOUT_MS)`, then `call_result` (or `call_failed` with `timeout`/`agent_error`); append a JSONL audit line `{ts, call_id, from, message, status, duration_ms}` to `paths.callsLog`; reconnect with capped exponential backoff on close (default `min(1000*2^n, 60_000)` + jitter, injectable for tests).

- [ ] **Step 1: Failing tests**

`packages/cli/test/queue.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { SerialQueue } from "../src/queue.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SerialQueue", () => {
  it("runs jobs one at a time, in order", async () => {
    const q = new SerialQueue(5);
    const order: number[] = [];
    let concurrent = 0, maxConcurrent = 0;
    for (let i = 0; i < 3; i++) {
      q.tryEnqueue(async () => {
        concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(20); order.push(i); concurrent--;
      });
    }
    await q.onIdle();
    expect(order).toEqual([0, 1, 2]);
    expect(maxConcurrent).toBe(1);
  });
  it("rejects beyond maxPending while busy", async () => {
    const q = new SerialQueue(2);
    q.tryEnqueue(() => sleep(100));            // running
    expect(q.tryEnqueue(() => sleep(1))).toBe(true);  // pending 1
    expect(q.tryEnqueue(() => sleep(1))).toBe(true);  // pending 2
    expect(q.tryEnqueue(() => sleep(1))).toBe(false); // over cap
    await q.onIdle();
  });
});
```

`packages/cli/test/listener.test.ts` (fake relay again, fake runner):
```ts
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { startListener } from "../src/listener.js";
import { getPaths } from "../src/paths.js";
import type { Config } from "../src/config.js";

let httpServer: Server;
let stopper: { stop(): void } | undefined;
afterEach(() => { stopper?.stop(); return new Promise<void>((r) => httpServer?.close(() => r())); });

function fakeRelay(onConn: (ws: WsSocket) => void): Promise<string> {
  return new Promise((resolve) => {
    httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer, path: "/v1/ws" });
    wss.on("connection", onConn);
    httpServer.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(httpServer.address() as { port: number }).port}`);
    });
  });
}

const cfg: Config = { handle: "ken", token: "tok", agent_kind: "claude", relay: "unused" };

function frames(ws: WsSocket, n: number): Promise<any[]> {
  return new Promise((resolve) => {
    const got: any[] = [];
    ws.on("message", (raw) => {
      const s = String(raw);
      if (s === "ping") return;
      got.push(JSON.parse(s));
      if (got.length === n) resolve(got);
    });
  });
}

describe("startListener", () => {
  it("answers an incoming call: answer -> run -> result, and audits", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async () => ({ text: "the answer", session_id: "s1" }),
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "shusaku", message: "q?" }));
    const [answer, result] = await expectFrames;
    expect(answer).toMatchObject({ type: "call_answer", call_id: "c1" });
    expect(result).toMatchObject({ type: "call_result", call_id: "c1", text: "the answer", session_id: "s1" });
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c1", from: "shusaku", status: "ok" });
  });

  it("reports busy when the queue is full", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    let resolveRun!: () => void;
    const running = new Promise<void>((r) => (resolveRun = r));
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths, maxPending: 0,
          run: async () => { await running; return { text: "slow" }; },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 3); // answer(c1), failed(c2,busy), result(c1)
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "a", message: "long job" }));
    await new Promise((r) => setTimeout(r, 50));
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "b", message: "hi" }));
    await new Promise((r) => setTimeout(r, 50));
    resolveRun();
    const got = await expectFrames;
    expect(got.find((f) => f.call_id === "c2")).toMatchObject({ type: "call_failed", code: "busy" });
  });

  it("maps runner failures to call_failed with the runner's code", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    const { AgentRunError } = await import("../src/runner.js");
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async () => { throw new AgentRunError("boom", "timeout"); },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c9", from: "x", message: "y" }));
    const got = await expectFrames;
    expect(got[1]).toMatchObject({ type: "call_failed", call_id: "c9", code: "timeout" });
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement**

`packages/cli/src/queue.ts`:
```ts
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
```

`packages/cli/src/listener.ts`:
```ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import WebSocket from "ws";
import {
  AGENT_TIMEOUT_MS, RelayToListenerFrame, safeParseFrame,
} from "@agentcall/shared";
import type { Config } from "./config.js";
import type { Paths } from "./paths.js";
import { buildPrompt } from "./prompt.js";
import { AgentRunError, runAgent } from "./runner.js";
import { SerialQueue } from "./queue.js";

export interface ListenerDeps {
  relay: string;
  config: Config;
  paths: Paths;
  run?: typeof runAgent;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
}

export function startListener(deps: ListenerDeps): { stop(): void } {
  const run = deps.run ?? runAgent;
  const queue = new SerialQueue(deps.maxPending ?? 5);
  const backoff = deps.backoffMs ?? ((n) => Math.min(1000 * 2 ** n, 60_000) + Math.random() * 500);
  let stopped = false;
  let attempt = 0;
  let ws: WebSocket | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const audit = (entry: Record<string, unknown>) => {
    mkdirSync(dirname(deps.paths.callsLog), { recursive: true });
    appendFileSync(deps.paths.callsLog, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  };

  const connect = () => {
    if (stopped) return;
    const url = deps.relay.replace(/^http/, "ws") + "/v1/ws?role=listen";
    ws = new WebSocket(url, {
      headers: { Authorization: `Bearer ${deps.config.token}`, "X-AgentCall-Handle": deps.config.handle },
    });
    ws.on("open", () => {
      attempt = 0;
      pingTimer = setInterval(() => { try { ws?.send("ping"); } catch { /* dead */ } }, 30_000);
    });
    ws.on("message", (raw) => {
      const s = String(raw);
      if (s === "pong") return;
      const frame = safeParseFrame(RelayToListenerFrame, s);
      if (!frame) return;
      const { call_id, from, message } = frame;
      const started = Date.now();
      const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };
      const accepted = queue.tryEnqueue(async () => {
        send({ type: "call_answer", call_id });
        try {
          const out = await run(
            deps.config.agent_kind,
            buildPrompt(deps.config.handle, from, message),
            deps.paths,
            AGENT_TIMEOUT_MS,
          );
          send({ type: "call_result", call_id, text: out.text, session_id: out.session_id });
          audit({ call_id, from, message: message.slice(0, 500), status: "ok", duration_ms: Date.now() - started });
        } catch (e) {
          const code = e instanceof AgentRunError ? e.code : "agent_error";
          send({ type: "call_failed", call_id, code, detail: String(e).slice(0, 500) });
          audit({ call_id, from, message: message.slice(0, 500), status: code, duration_ms: Date.now() - started });
        }
      });
      if (!accepted) {
        send({ type: "call_failed", call_id, code: "busy" });
        audit({ call_id, from, message: message.slice(0, 500), status: "busy", duration_ms: 0 });
      }
    });
    const scheduleReconnect = () => {
      if (pingTimer) clearInterval(pingTimer);
      if (stopped) return;
      setTimeout(connect, backoff(attempt++)).unref?.();
    };
    ws.on("close", scheduleReconnect);
    ws.on("error", () => { /* close fires next */ });
  };

  connect();
  return {
    stop() {
      stopped = true;
      if (pingTimer) clearInterval(pingTimer);
      try { ws?.close(); } catch { /* fine */ }
    },
  };
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git add packages/cli/src packages/cli/test && git commit -m "feat(cli): resident listener with serial queue and audit log"`.

---

### Task 10: launchd install/uninstall + CLAUDE.md snippet

**Files:**
- Create: `packages/cli/src/launchd.ts`, `packages/cli/src/snippet.ts`
- Test: `packages/cli/test/launchd.test.ts`, `packages/cli/test/snippet.test.ts`

**Interfaces:**
- Produces:
  - `plistContent(nodeBin: string, cliScript: string, paths: Paths): string` — full XML plist:
    Label `tech.benree.agentcall.listener`; ProgramArguments `[nodeBin, cliScript, "listen"]`;
    `RunAtLoad true`, `KeepAlive true`, `StandardOutPath`/`StandardErrorPath` → `paths.listenerLog`,
    `EnvironmentVariables: { PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", HOME: paths.home }`.
  - `installLaunchAgent(paths, execCmd?): void` — writes plist (mkdir -p LaunchAgents), then via injectable `execCmd(cmd: string[])` runs `launchctl bootout gui/$UID/tech.benree.agentcall.listener` (ignore failure) then `launchctl bootstrap gui/$UID <plist>`. Uses `process.execPath` for nodeBin and resolves the CLI entry as `new URL("../dist/index.js", import.meta.url)` → absolute path via `fileURLToPath`.
  - `uninstallLaunchAgent(paths, execCmd?): void` — bootout (ignore failure) + delete plist if present.
  - `snippet.ts`: `SNIPPET: string` (see content below) and `appendSnippet(file: string): "appended" | "already_present"` — creates parent dir/file if needed, idempotent via marker `<!-- agentcall -->`.

SNIPPET content:
```markdown
<!-- agentcall -->
## Calling other people's agents (agentcall)

You can call another person's coding agent by address, like a phone call:

- `agentcall call <handle@host> "<message>"` — sends the message to that person's
  agent (runs sandboxed on their machine) and prints its reply. Takes 30s-5min.
- `agentcall status <handle@host>` — check if their agent is online first.

Use this when the user asks you to "ask <name>'s agent" something or gives you
an address like `ken@agentcall.benree.tech`. Relay errors are printed to stderr
(offline / busy / timeout) — report them to the user, don't retry more than once.
<!-- /agentcall -->
```

- [ ] **Step 1: Failing tests**

`packages/cli/test/launchd.test.ts`:
```ts
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { plistContent, installLaunchAgent, uninstallLaunchAgent } from "../src/launchd.js";
import { getPaths } from "../src/paths.js";

describe("plistContent", () => {
  it("renders a valid-looking plist", () => {
    const p = getPaths("/Users/ken");
    const xml = plistContent("/usr/local/bin/node", "/g/agentcall/dist/index.js", p);
    expect(xml).toContain("<key>Label</key>");
    expect(xml).toContain("tech.benree.agentcall.listener");
    expect(xml).toContain("<string>/usr/local/bin/node</string>");
    expect(xml).toContain("<string>/g/agentcall/dist/index.js</string>");
    expect(xml).toContain("<string>listen</string>");
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain(p.listenerLog);
    expect(xml).toContain("<key>HOME</key>");
  });
});

describe("install/uninstall", () => {
  it("writes plist and calls launchctl bootstrap", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    const calls: string[][] = [];
    installLaunchAgent(p, (cmd) => { calls.push(cmd); });
    expect(existsSync(p.plistFile)).toBe(true);
    expect(calls.some((c) => c[1]?.startsWith("bootout"))).toBe(true);
    expect(calls.some((c) => c[1]?.startsWith("bootstrap"))).toBe(true);
    expect(readFileSync(p.plistFile, "utf8")).toContain("agentcall");
  });
  it("uninstall removes the plist", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-ld-")));
    mkdirSync(join(p.home, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(p.plistFile, "x");
    uninstallLaunchAgent(p, () => {});
    expect(existsSync(p.plistFile)).toBe(false);
  });
});
```

`packages/cli/test/snippet.test.ts`:
```ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendSnippet, SNIPPET } from "../src/snippet.js";

describe("appendSnippet", () => {
  it("creates the file and appends once", () => {
    const file = join(mkdtempSync(join(tmpdir(), "agentcall-sn-")), "CLAUDE.md");
    expect(appendSnippet(file)).toBe("appended");
    expect(appendSnippet(file)).toBe("already_present");
    const content = readFileSync(file, "utf8");
    expect(content).toContain("agentcall call");
    expect(content.match(/<!-- agentcall -->/g)?.length).toBe(1);
    expect(SNIPPET).toContain("agentcall status");
  });
});
```

- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement**

`packages/cli/src/launchd.ts`:
```ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Paths } from "./paths.js";

export const LAUNCH_LABEL = "tech.benree.agentcall.listener";
type ExecCmd = (cmd: string[]) => void;

const defaultExec: ExecCmd = (cmd) => {
  execFileSync(cmd[0]!, cmd.slice(1), { stdio: "ignore" });
};

export function plistContent(nodeBin: string, cliScript: string, p: Paths): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${cliScript}</string>
    <string>listen</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${p.listenerLog}</string>
  <key>StandardErrorPath</key><string>${p.listenerLog}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>${p.home}</string>
  </dict>
</dict>
</plist>
`;
}

export function installLaunchAgent(p: Paths, execCmd: ExecCmd = defaultExec): void {
  const cliScript = fileURLToPath(new URL("../dist/index.js", import.meta.url));
  mkdirSync(dirname(p.plistFile), { recursive: true });
  writeFileSync(p.plistFile, plistContent(process.execPath, cliScript, p));
  try { execCmd(["launchctl", `bootout gui/${process.getuid?.() ?? 501}/${LAUNCH_LABEL}`]); } catch { /* not loaded */ }
  execCmd(["launchctl", `bootstrap gui/${process.getuid?.() ?? 501}`, p.plistFile]);
}

export function uninstallLaunchAgent(p: Paths, execCmd: ExecCmd = defaultExec): void {
  try { execCmd(["launchctl", `bootout gui/${process.getuid?.() ?? 501}/${LAUNCH_LABEL}`]); } catch { /* not loaded */ }
  if (existsSync(p.plistFile)) rmSync(p.plistFile);
}
```
(Implementer note: `launchctl` args must actually be separate array elements — `["launchctl", "bootout", `gui/${uid}/${LAUNCH_LABEL}`]` etc. Write the real implementation with properly split args; the test only asserts `c[1]?.startsWith("bootout"|"bootstrap")`, so pass `["launchctl","bootout",…]` and adjust the test index if needed — keep test and impl consistent.)

`packages/cli/src/snippet.ts`:
```ts
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export const SNIPPET = `<!-- agentcall -->
## Calling other people's agents (agentcall)

You can call another person's coding agent by address, like a phone call:

- \`agentcall call <handle@host> "<message>"\` — sends the message to that person's
  agent (runs sandboxed on their machine) and prints its reply. Takes 30s-5min.
- \`agentcall status <handle@host>\` — check if their agent is online first.

Use this when the user asks you to "ask <name>'s agent" something or gives you
an address like \`ken@agentcall.benree.tech\`. Relay errors are printed to stderr
(offline / busy / timeout) — report them to the user, don't retry more than once.
<!-- /agentcall -->
`;

export function appendSnippet(file: string): "appended" | "already_present" {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && readFileSync(file, "utf8").includes("<!-- agentcall -->")) return "already_present";
  appendFileSync(file, (existsSync(file) ? "\n" : "") + SNIPPET);
  return "appended";
}
```

- [ ] **Step 4: Run tests** → PASS. **Step 5: Commit** — `git add packages/cli/src packages/cli/test && git commit -m "feat(cli): launchd install + agent-facing usage snippet"`.

---

### Task 11: Commands — setup, call, status, listen, uninstall + commander wiring

**Files:**
- Create: `packages/cli/src/setup.ts`, `packages/cli/src/index.ts`
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `runSetup(opts: { handle?: string; agent?: "claude" | "codex"; yes?: boolean; snippet?: boolean; relay?: string; skipLaunchd?: boolean; io?: { ask(q: string): Promise<string> } }): Promise<void>` — pure-ish, testable: detect agents (`which claude` / `which codex` via injectable `hasBin(name): boolean`), prompt for missing handle via `io.ask` (default readline on /dev/tty), call `registerHandle`, `saveConfig`, write `srt.json` (`srtSettings`), `mkdirSync(publicDir, {recursive: true})`, `installLaunchAgent` (unless `skipLaunchd`), `appendSnippet` on `~/.claude/CLAUDE.md` + `~/.codex/AGENTS.md` when `snippet !== false`, print address block.
  - `index.ts` — commander program `agentcall` v0.1.0 with subcommands:
    - `setup [--handle <h>] [--agent <claude|codex>] [--relay <url>] [--no-snippet] [--skip-launchd]`
    - `call <address> <message...>` — parseAddress; spinner-ish stderr lines on status (`ringing...`, `answered, agent working...`); reply text → stdout; errors → stderr + exit 1. `--json` prints full reply envelope.
    - `status <address>` — prints `online` / `offline`, exit 0/2.
    - `listen` — `loadConfig`, `startListener`, log to console, stay alive (`setInterval(() => {}, 1 << 30)`), SIGTERM → stop + exit.
    - `uninstall [--purge]`.

- [ ] **Step 1: Failing test** — `packages/cli/test/setup.test.ts`:
```ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSetup } from "../src/setup.js";
import { getPaths } from "../src/paths.js";

let server: Server;
afterEach(() => server?.close());

function fakeRelay(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { handle } = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "tok-123", address: `${handle}@agentcall.benree.tech` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

describe("runSetup", () => {
  it("registers, writes config + srt.json, creates public dir (non-interactive)", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg).toMatchObject({ handle: "ken", token: "tok-123", agent_kind: "claude", relay });
      expect(existsSync(p.srtFile)).toBe(true);
      expect(existsSync(p.publicDir)).toBe(true);
      const srt = JSON.parse(readFileSync(p.srtFile, "utf8"));
      expect(JSON.stringify(srt)).toContain(".ssh");
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });
});
```
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** `setup.ts` per the interface above (write srt.json with `JSON.stringify(srtSettings(p), null, 2)`), then `index.ts`:

```ts
import { Command } from "commander";
import { parseAddress } from "@agentcall/shared";
import { getPaths } from "./paths.js";
import { loadConfig, relayUrl } from "./config.js";
import { callAgent, CallError } from "./callClient.js";
import { getStatus, ApiError } from "./api.js";
import { startListener } from "./listener.js";
import { runSetup } from "./setup.js";
import { uninstallLaunchAgent } from "./launchd.js";
import { rmSync } from "node:fs";

const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.1.0");

program.command("setup")
  .option("--handle <handle>").option("--agent <agent>").option("--relay <url>")
  .option("--no-snippet").option("--skip-launchd")
  .action(async (o) => {
    await runSetup({ handle: o.handle, agent: o.agent, relay: o.relay, snippet: o.snippet, skipLaunchd: o.skipLaunchd });
  });

program.command("call")
  .argument("<address>").argument("<message...>")
  .option("--json", "print full reply envelope")
  .action(async (address: string, messageParts: string[], o: { json?: boolean }) => {
    const parsed = parseAddress(address);
    if (!parsed) { console.error(`Invalid address: ${address} (expected handle@host)`); process.exit(1); }
    const paths = getPaths();
    const cfg = loadConfig(paths);
    const message = messageParts.join(" ");
    try {
      const reply = await callAgent({
        relay: relayUrl(cfg), from: cfg.handle, token: cfg.token, to: parsed.handle, message,
        onStatus: (s) => console.error(s === "ringing" ? "ringing..." : "answered, agent working..."),
      });
      console.log(o.json ? JSON.stringify(reply) : reply.text);
    } catch (e) {
      console.error(e instanceof CallError ? `Call failed (${e.code}): ${e.message}` : String(e));
      process.exit(1);
    }
  });

program.command("status")
  .argument("<address>")
  .action(async (address: string) => {
    const parsed = parseAddress(address);
    if (!parsed) { console.error(`Invalid address: ${address}`); process.exit(1); }
    const paths = getPaths();
    let cfgRelay: string | undefined;
    try { cfgRelay = relayUrl(loadConfig(paths)); } catch { cfgRelay = relayUrl(undefined); }
    try {
      const { online } = await getStatus(cfgRelay, parsed.handle);
      console.log(online ? "online" : "offline");
      process.exit(online ? 0 : 2);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exit(1);
    }
  });

program.command("listen").action(() => {
  const paths = getPaths();
  const cfg = loadConfig(paths);
  console.log(`agentcall listener starting for ${cfg.handle} -> ${relayUrl(cfg)}`);
  const l = startListener({ relay: relayUrl(cfg), config: cfg, paths });
  process.on("SIGTERM", () => { l.stop(); process.exit(0); });
  process.on("SIGINT", () => { l.stop(); process.exit(0); });
  setInterval(() => {}, 1 << 30);
});

program.command("uninstall")
  .option("--purge", "also delete ~/.agentcall")
  .action((o: { purge?: boolean }) => {
    const paths = getPaths();
    uninstallLaunchAgent(paths);
    if (o.purge) rmSync(paths.dir, { recursive: true, force: true });
    console.log("agentcall listener removed." + (o.purge ? " Config purged." : ""));
  });

program.parseAsync().catch((e) => { console.error(String(e)); process.exit(1); });
```

- [ ] **Step 4: Run full CLI test suite + build** — `pnpm test && pnpm build` in `packages/cli` → PASS.
- [ ] **Step 5: Commit** — `git add packages/cli && git commit -m "feat(cli): setup/call/status/listen/uninstall commands"`.

---

### Task 12: README + repo polish

**Files:**
- Create: `README.md`, `CLAUDE.md` (repo dev guide, brief)

- [ ] **Step 1: Write README.md** — cover: what it is (one paragraph + the sequence diagram from the spec), install (`curl -fsSL https://agentcall.benree.tech/install.sh | sh`), usage (`agentcall call ken@agentcall.benree.tech "..."`, `status`), how the callee side works (LaunchAgent, sandbox, `~/AgentCall/public`, audit log), security model section copied from spec ("Security model (v1, explicit)"), development (pnpm install / test / wrangler dev), limitations (macOS only, one-shot, relay sees plaintext).
- [ ] **Step 2: Write CLAUDE.md** — monorepo layout, test commands per package, "protocol types live in @agentcall/shared — change schemas there first", TDD expectation, no `git add -A`.
- [ ] **Step 3: Run full workspace check** — `pnpm -r test && pnpm -r typecheck && pnpm -r build` at root → all PASS.
- [ ] **Step 4: Commit** — `git add README.md CLAUDE.md && git commit -m "docs: README + repo dev guide"`.

---

### Task 13: Deploy relay to agentcall.benree.tech + live smoke test

**Files:**
- Modify: `apps/relay/wrangler.jsonc` (real `database_id`)

- [ ] **Step 1: Verify wrangler auth** — `cd apps/relay && npx wrangler whoami`. If not authenticated, STOP and leave a note in the final report (deploy is blocked on human OAuth; everything else proceeds).
- [ ] **Step 2: Create D1 + apply migrations** — `npx wrangler d1 create agentcall` → copy `database_id` into `wrangler.jsonc`; `npx wrangler d1 migrations apply agentcall --remote`.
- [ ] **Step 3: Deploy** — `npx wrangler deploy`. Custom domain `agentcall.benree.tech` provisions automatically if the `benree.tech` zone is on this account (spec says it is). If the zone is missing, deploy without the route and report.
- [ ] **Step 4: Live smoke** —
  `curl -s https://agentcall.benree.tech/install.sh | head -3` → shebang;
  `curl -s -X POST https://agentcall.benree.tech/v1/register -H 'content-type: application/json' -d '{"handle":"smoke-test-1","agent_kind":"claude"}'` → token JSON;
  `curl -s https://agentcall.benree.tech/v1/status/smoke-test-1` → `{"online":false}`.
- [ ] **Step 5: Local end-to-end (no live agents)** — in one shell `AGENTCALL_RELAY` pointing at prod, register two throwaway handles via CLI, start `agentcall listen` with a stub... SKIP stub: instead run the real flow with `--skip-launchd` setup for handle `smoke-callee`, run `agentcall listen` in background for ≤2 min, then `agentcall call smoke-callee@agentcall.benree.tech "Reply with exactly: pong"` from a second setup (`AGENTCALL_HOME` pointing at two temp homes). This exercises relay+listener+runner end-to-end with a real `claude -p` spawn. If no API-key/subscription available in the shell, record the failure mode and stop — the relay-level smoke (Step 4) is the gate.
- [ ] **Step 6: Commit** — `git add apps/relay/wrangler.jsonc && git commit -m "chore(relay): production D1 id + deploy"`.

---

## Self-Review Notes

- Spec coverage: register/status/ws-auth (T2-3), call flow incl. offline/busy/rate/timeout/size (T4), install.sh (T5, T12), config/paths (T6), sandbox spawn claude+codex (T7), caller client (T8), listener+queue+audit (T9), launchd+snippet (T10), commands+setup (T11), README (T12), deploy+smoke (T13). v1.5 session_id flows through schemas (T1), runner (T7), client (T8) — deferred CLI flag only.
- Known judgment calls delegated to implementers (flagged inline): exact srt.json schema keys (verify against installed package README), launchctl arg splitting.
- Types cross-checked: `Paths`, `Config`, `SpawnSpec`, `AgentOutput`, frame names consistent across tasks.
