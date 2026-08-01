# Task-Menu Capabilities Phase 1 Implementation Plan

> **Historical document — not current documentation.** This is a dated
> design/implementation record, kept as written. It describes the codebase as
> of its own date and is deliberately *not* updated when behavior changes.
> For how agentcall works today see [README.md](../../../README.md) and
> [CHANGELOG.md](../../../CHANGELOG.md).
>
> Known divergence since this was written: the OS sandbox (`sandbox-runtime` /
> Seatbelt, `~/.agentcall/srt.json`), task `write_paths` and `network`, and the
> T1/T2 task tier were all **removed on 2026-07-31**. The working directory is
> now configurable via `workdir` and is no longer an enforced boundary.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Callee-defined task menus with per-caller grants, published as agent cards, enforced at spawn time via task-scoped capability envelopes (agent flags + srt config), with structured refusals that never spawn an agent.

**Architecture:** Protocol additions live in `packages/shared` (zod schemas — single source of truth). The relay stores pushed cards in D1 and serves public/extended views; the Durable Object passes the new `task`/`offered` fields through opaquely. All policy decisions and enforcement happen in `packages/cli`: the listener resolves caller → offered task set → task → envelope *before* the caller's message reaches any model prompt, then spawns with only that envelope's tools/write-paths/network.

**Tech Stack:** TypeScript ESM everywhere, zod v4, Hono + Durable Objects + D1 (relay), vitest (`@cloudflare/vitest-pool-workers` in relay), commander + ws (CLI).

Spec: `docs/superpowers/specs/2026-07-16-task-menu-capabilities-design.md` (Phase 1 only — no dispatcher, no T2 approval flow; the `tier` field is carried but T2 tasks execute like T1 in this phase).

## Global Constraints

- Protocol/frame shapes change in `packages/shared/src/protocol.ts` FIRST; relay and CLI import them — never duplicate shapes locally (repo CLAUDE.md).
- TDD: write the failing test before implementation, always run it and see it fail first. No live `claude`/`codex` spawn in any test.
- Stage files explicitly (`git add <file> <file>`), never `git add -A` or `git add .`.
- Done means `pnpm -r test && pnpm -r typecheck && pnpm -r build` all pass at repo root.
- Handle regex `HANDLE_RE = /^[a-z0-9][a-z0-9-]{1,30}$/` (existing). New task-id regex `TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/`.
- The capability vocabulary is the agent-neutral enum `["read", "write", "fetch", "exec"]` (spec open question 1, resolved: agent-neutral).
- Built-in `ask` task: read-only, publicDir only, no network additions (spec open question 2, resolved: no WebFetch).
- SKILL.md content enters the claude/codex spawn embedded in the prompt text (spec open question 4, resolved for Phase 1: prompt embedding — no settings-dir machinery).
- Card staleness accepted: card is pushed by `setup` and `agentcall card push` only in Phase 1 (spec open question 3). Enforcement is local, so a stale card fails closed.
- All run/test commands below are run from the package directory named in the task (or with `pnpm -r` from root).

## Envelope semantics (used by Tasks 4, 6, 7, 10)

```ts
// packages/cli/src/tasks.ts
export const CAPS = ["read", "write", "fetch", "exec"] as const;
export type Cap = (typeof CAPS)[number];
export interface Envelope {
  caps: Cap[];            // "read" is always implied
  write_paths: string[];  // relative to ~/AgentCall (e.g. "public"); [] = no writes
  network: string[];      // extra srt allowedDomains on top of the model-API list
}
// Today's single-tier behavior, kept as the default for existing call sites:
export const FULL_ACCESS_ENVELOPE: Envelope = {
  caps: ["read", "write", "fetch", "exec"],
  write_paths: ["public"],
  network: [],
};
```

Claude cap → tool mapping (Task 7): `read` → `Read,Grep,Glob,LS`; `write` → `Write,Edit`; `fetch` → `WebFetch,WebSearch`; `exec` → `Bash`. Full-envelope list, in CAPS order with read first: `"Read,Grep,Glob,LS,Write,Edit,WebFetch,WebSearch,Bash"`.

---

### Task 1: Shared protocol — task fields, new error codes, card schemas

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Create: `packages/shared/src/card.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/task-protocol.test.ts` (new file)

**Interfaces:**
- Consumes: existing `HANDLE_RE`, zod.
- Produces (relied on by every later task): `TASK_ID_RE`; `ErrorCode` extended with `"blocked" | "task_not_offered" | "task_unknown"`; `CallRequest`/`IncomingCall`/`CallResult`/`CallReply` each gain `task?: string`; `CallFailed`/`CallError` each gain `offered?: string[]`; `CardTask`, `CardUpload`, `AgentCard` schemas + `CardTaskType`, `CardUploadType`, `AgentCardType`.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/test/task-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AgentCard, CallError, CallFailed, CallRequest, CallReply, CallResult,
  CardUpload, ErrorCode, IncomingCall, TASK_ID_RE,
} from "../src/index.js";

describe("task fields on call frames", () => {
  it("accepts call_request with an optional task id", () => {
    const ok = CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi", task: "schedule-meeting" });
    expect(ok.success).toBe(true);
    const noTask = CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi" });
    expect(noTask.success).toBe(true);
  });
  it("rejects a malformed task id", () => {
    const bad = CallRequest.safeParse({ type: "call_request", to: "ken", message: "hi", task: "Bad_Task!" });
    expect(bad.success).toBe(false);
  });
  it("carries task through incoming_call, call_result, and call_reply", () => {
    expect(IncomingCall.safeParse({ type: "incoming_call", call_id: "c1", from: "a", message: "m", task: "ask" }).success).toBe(true);
    expect(CallResult.safeParse({ type: "call_result", call_id: "c1", text: "t", task: "ask" }).success).toBe(true);
    expect(CallReply.safeParse({ type: "call_reply", call_id: "c1", text: "t", task: "ask" }).success).toBe(true);
  });
  it("carries offered[] on call_failed and call_error", () => {
    expect(CallFailed.safeParse({ type: "call_failed", call_id: "c1", code: "task_not_offered", offered: ["ask"] }).success).toBe(true);
    expect(CallError.safeParse({ type: "call_error", code: "blocked", offered: [] }).success).toBe(true);
  });
  it("accepts the new error codes", () => {
    for (const code of ["blocked", "task_not_offered", "task_unknown"]) {
      expect(ErrorCode.safeParse(code).success).toBe(true);
    }
  });
});

describe("TASK_ID_RE", () => {
  it("accepts kebab-case ids and rejects uppercase/underscore/empty", () => {
    expect(TASK_ID_RE.test("schedule-meeting")).toBe(true);
    expect(TASK_ID_RE.test("ask")).toBe(true);
    expect(TASK_ID_RE.test("Bad")).toBe(false);
    expect(TASK_ID_RE.test("a_b")).toBe(false);
    expect(TASK_ID_RE.test("")).toBe(false);
  });
});

describe("card schemas", () => {
  const task = { id: "ask", name: "Ask", description: "Answer questions." };
  it("round-trips a CardUpload and applies defaults", () => {
    const parsed = CardUpload.parse({ agent_kind: "claude", tasks: [task], default_offer: ["ask"] });
    expect(parsed.description).toBe("");
    expect(parsed.grants).toEqual({});
    expect(parsed.tasks[0]).toMatchObject({ id: "ask", tier: "T1", examples: [] });
  });
  it("rejects a grant keyed by an invalid handle", () => {
    const bad = CardUpload.safeParse({
      agent_kind: "claude", tasks: [task], default_offer: ["ask"], grants: { "Bad Handle": ["ask"] },
    });
    expect(bad.success).toBe(false);
  });
  it("rejects a task with a bad tier", () => {
    const bad = CardUpload.safeParse({
      agent_kind: "claude", tasks: [{ ...task, tier: "T9" }], default_offer: [],
    });
    expect(bad.success).toBe(false);
  });
  it("round-trips an AgentCard (the relay's GET response shape)", () => {
    const card = AgentCard.parse({
      handle: "ken", description: "", agent_kind: "claude",
      tasks: [{ ...task, examples: [], tier: "T1" }], updated_at: 1752600000000,
    });
    expect(card.tasks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/shared`): `pnpm test`
Expected: FAIL — `TASK_ID_RE`, `CardUpload`, `AgentCard` are not exported; `task`/`offered` fields stripped or rejected; `blocked` not in `ErrorCode`.

- [ ] **Step 3: Implement protocol additions**

In `packages/shared/src/protocol.ts`, add after `HANDLE_RE`:

```ts
export const TASK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
```

Replace the `ErrorCode` enum with:

```ts
export const ErrorCode = z.enum([
  "unknown_handle", "offline", "busy", "timeout", "agent_error",
  "unauthorized", "rate_limited", "message_too_large", "protocol_error",
  "blocked", "task_not_offered", "task_unknown",
]);
```

Add `task: z.string().regex(TASK_ID_RE).optional()` to `CallRequest`, `IncomingCall`, and `CallResult`; add `task: z.string().optional()` to `CallReply`. Add `offered: z.array(z.string()).optional()` to `CallFailed` and `CallError`. (CallReply's `task` needs no regex — the relay only echoes what the listener already validated.)

- [ ] **Step 4: Implement card schemas**

Create `packages/shared/src/card.ts`:

```ts
import { z } from "zod";
import { HANDLE_RE, TASK_ID_RE } from "./protocol.js";

export const MAX_CARD_TASKS = 50;

export const CardTask = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
  tier: z.enum(["T1", "T2"]).default("T1"),
});

// What a callee pushes to the relay: full task list + visibility policy.
export const CardUpload = z.object({
  description: z.string().max(500).default(""),
  agent_kind: z.enum(["claude", "codex"]),
  tasks: z.array(CardTask).max(MAX_CARD_TASKS),
  default_offer: z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS),
  grants: z.record(z.string().regex(HANDLE_RE), z.array(z.string().regex(TASK_ID_RE)).max(MAX_CARD_TASKS)).default({}),
});

// What a caller gets back from GET /v1/card/:handle — already filtered to
// the tasks visible to that caller (public view or authenticated extended view).
export const AgentCard = z.object({
  handle: z.string().regex(HANDLE_RE),
  description: z.string(),
  agent_kind: z.enum(["claude", "codex"]),
  tasks: z.array(CardTask),
  updated_at: z.number(),
});

export type CardTaskType = z.infer<typeof CardTask>;
export type CardUploadType = z.infer<typeof CardUpload>;
export type AgentCardType = z.infer<typeof AgentCard>;
```

In `packages/shared/src/index.ts`, add `export * from "./card.js";` alongside the existing `export * from "./protocol.js";`.

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/shared`): `pnpm test && pnpm typecheck`
Expected: PASS (including the pre-existing `protocol.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/card.ts packages/shared/src/index.ts packages/shared/test/task-protocol.test.ts
git commit -m "feat(shared): task fields, blocked/task_* error codes, agent card schemas"
```

---

### Task 2: Relay — cards table, PUT /v1/card, GET /v1/card/:handle

**Files:**
- Create: `apps/relay/migrations/0002_cards.sql`
- Modify: `apps/relay/src/index.ts`
- Test: `apps/relay/test/card.test.ts` (new file)

**Interfaces:**
- Consumes: `CardUpload`, `AgentCard` from `@benree/agentcall-shared`; existing `verifyHandleToken` from `./auth.js`; test helpers `registerHandle`, `wsAuth` from `./helpers.js`.
- Produces: `PUT /v1/card` (Bearer + `X-AgentCall-Handle` auth, body = CardUpload, upsert) and `GET /v1/card/:handle` (no auth → public view filtered to `default_offer`; valid Bearer auth → extended view adding `grants[viewer]`; present-but-invalid auth → 401; unknown handle → 404). Response body matches the `AgentCard` schema.

- [ ] **Step 1: Write the migration**

Create `apps/relay/migrations/0002_cards.sql`:

```sql
CREATE TABLE cards (
  handle TEXT PRIMARY KEY,
  card_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Check `apps/relay/test/apply-migrations.ts` — it applies the migrations directory to the test D1; a new numbered file is picked up automatically. If it hardcodes `0001_init.sql`, extend it to read the directory.

- [ ] **Step 2: Write the failing tests**

Create `apps/relay/test/card.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const UPLOAD = {
  description: "Ken's public agent",
  agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [], tier: "T1" },
    { id: "schedule-meeting", name: "Schedule", description: "Book a time.", examples: [], tier: "T2" },
  ],
  default_offer: ["ask"],
  grants: { mia: ["schedule-meeting"] },
};

async function putCard(handle: string, token: string, body: unknown = UPLOAD) {
  return SELF.fetch("https://relay.test/v1/card", {
    method: "PUT",
    headers: { "content-type": "application/json", ...wsAuth(handle, token) },
    body: JSON.stringify(body),
  });
}

describe("PUT /v1/card", () => {
  it("stores a card for an authenticated handle", async () => {
    const token = await registerHandle("ken");
    expect((await putCard("ken", token)).status).toBe(200);
  });
  it("401s on a bad token", async () => {
    await registerHandle("ken2");
    expect((await putCard("ken2", "wrong-token")).status).toBe(401);
  });
  it("400s on an invalid card body", async () => {
    const token = await registerHandle("ken3");
    expect((await putCard("ken3", token, { agent_kind: "vim", tasks: [], default_offer: [] })).status).toBe(400);
  });
  it("upserts: a second push replaces the first", async () => {
    const token = await registerHandle("ken4");
    await putCard("ken4", token);
    await putCard("ken4", token, { ...UPLOAD, description: "updated" });
    const res = await SELF.fetch("https://relay.test/v1/card/ken4");
    expect((await res.json<{ description: string }>()).description).toBe("updated");
  });
});

describe("GET /v1/card/:handle", () => {
  it("404s when no card was pushed", async () => {
    await registerHandle("nocard");
    expect((await SELF.fetch("https://relay.test/v1/card/nocard")).status).toBe(404);
  });
  it("public view shows only default_offer tasks", async () => {
    const token = await registerHandle("pub");
    await putCard("pub", token);
    const res = await SELF.fetch("https://relay.test/v1/card/pub");
    expect(res.status).toBe(200);
    const card = await res.json<{ handle: string; tasks: { id: string }[] }>();
    expect(card.handle).toBe("pub");
    expect(card.tasks.map((t) => t.id)).toEqual(["ask"]);
  });
  it("extended view adds the viewer's granted tasks", async () => {
    const token = await registerHandle("ext");
    await putCard("ext", token);
    const miaToken = await registerHandle("mia");
    const res = await SELF.fetch("https://relay.test/v1/card/ext", { headers: wsAuth("mia", miaToken) });
    const card = await res.json<{ tasks: { id: string }[] }>();
    expect(card.tasks.map((t) => t.id).sort()).toEqual(["ask", "schedule-meeting"]);
  });
  it("a different authenticated viewer does NOT see another caller's grants", async () => {
    const token = await registerHandle("ext2");
    await putCard("ext2", token);
    const otherToken = await registerHandle("other");
    const res = await SELF.fetch("https://relay.test/v1/card/ext2", { headers: wsAuth("other", otherToken) });
    const card = await res.json<{ tasks: { id: string }[] }>();
    expect(card.tasks.map((t) => t.id)).toEqual(["ask"]);
  });
  it("401s when auth headers are present but invalid", async () => {
    const token = await registerHandle("ext3");
    await putCard("ext3", token);
    const res = await SELF.fetch("https://relay.test/v1/card/ext3", { headers: wsAuth("mia", "bad") });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run (from `apps/relay`): `pnpm test -- card`
Expected: FAIL — 404 on `PUT /v1/card` (route doesn't exist).

- [ ] **Step 4: Implement the routes**

In `apps/relay/src/index.ts`, change the shared import to include the card schema, and add the routes after the `/v1/status/:handle` route:

```ts
import { CardUpload, RegisterRequest, RESERVED_HANDLES } from "@benree/agentcall-shared";
```

```ts
app.put("/v1/card", async (c) => {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) return c.json({ error: "unauthorized" }, 401);
  const body = CardUpload.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json({ error: "invalid card" }, 400);
  await c.env.DB.prepare(
    "INSERT INTO cards (handle, card_json, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(handle) DO UPDATE SET card_json = excluded.card_json, updated_at = excluded.updated_at",
  ).bind(handle, JSON.stringify(body.data), Date.now()).run();
  return c.json({ ok: true });
});

app.get("/v1/card/:handle", async (c) => {
  const handle = c.req.param("handle");
  const row = await c.env.DB.prepare("SELECT card_json, updated_at FROM cards WHERE handle = ?")
    .bind(handle).first<{ card_json: string; updated_at: number }>();
  if (!row) return c.json({ error: "no card" }, 404);

  // Optional caller auth selects the extended view (A2A "extended agent
  // card" pattern): the viewer sees default_offer plus their own grants,
  // never the full ACL. Present-but-invalid credentials are rejected
  // rather than silently downgraded to the public view.
  let viewer = "";
  const viewerHandle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (viewerHandle || token) {
    if (!(await verifyHandleToken(c.env.DB, viewerHandle, token))) return c.json({ error: "unauthorized" }, 401);
    viewer = viewerHandle;
  }

  const upload = CardUpload.parse(JSON.parse(row.card_json));
  const visible = new Set([...upload.default_offer, ...(viewer ? (upload.grants[viewer] ?? []) : [])]);
  return c.json({
    handle,
    description: upload.description,
    agent_kind: upload.agent_kind,
    tasks: upload.tasks.filter((t) => visible.has(t.id)),
    updated_at: row.updated_at,
  });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `apps/relay`): `pnpm test && pnpm typecheck`
Expected: PASS (all relay tests, not just the new file).

- [ ] **Step 6: Update the production D1 schema note and commit**

The new migration must be applied to the deployed D1 before the next relay deploy: `wrangler d1 migrations apply <db-name> --remote` (do NOT run this now — deployment is a separate manual step; just note it in the commit body).

```bash
git add apps/relay/migrations/0002_cards.sql apps/relay/src/index.ts apps/relay/test/card.test.ts
git commit -m "feat(relay): store and serve agent cards (public + extended views)

Deploy note: run wrangler d1 migrations apply --remote before deploying."
```

---

### Task 3: Relay DO — pass task and offered through the call flow

**Files:**
- Modify: `apps/relay/src/do.ts`
- Test: `apps/relay/test/task-passthrough.test.ts` (new file)

**Interfaces:**
- Consumes: Task 1's frame fields (`CallRequest.task`, `IncomingCall.task`, `CallResult.task`, `CallReply.task`, `CallFailed.offered`, `CallError.offered`) — already parsed by the existing `CallerFrame`/`ListenerToRelayFrame` unions.
- Produces: `incoming_call` frames carry the caller's `task`; `call_reply` frames carry the listener's `task`; `call_error` frames carry the listener's `offered`.

- [ ] **Step 1: Write the failing tests**

Create `apps/relay/test/task-passthrough.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { closed, nextFrame, openWs, registerHandle, wsAuth } from "./helpers.js";

async function setupPair() {
  const kenToken = await registerHandle("ken");
  const bobToken = await registerHandle("bob");
  const listener = await openWs("/v1/ws?role=listen", wsAuth("ken", kenToken));
  const caller = await openWs("/v1/ws?role=call&to=ken", wsAuth("bob", bobToken));
  return { listener, caller };
}

describe("task/offered passthrough", () => {
  it("forwards call_request.task to the listener and echoes call_result.task in call_reply", async () => {
    const { listener, caller } = await setupPair();
    caller.send(JSON.stringify({ type: "call_request", to: "ken", message: "next tue?", task: "schedule-meeting" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    expect(incoming).toMatchObject({ type: "incoming_call", task: "schedule-meeting" });
    listener.send(JSON.stringify({ type: "call_result", call_id: incoming.call_id, text: "booked", task: "schedule-meeting" }));
    const reply = await nextFrame(caller);
    expect(reply).toMatchObject({ type: "call_reply", text: "booked", task: "schedule-meeting" });
  });

  it("forwards call_failed.offered to the caller as call_error.offered", async () => {
    const { listener, caller } = await setupPair();
    caller.send(JSON.stringify({ type: "call_request", to: "ken", message: "hi", task: "deploy-prod" }));
    await nextFrame(caller); // ringing
    const incoming = await nextFrame(listener);
    listener.send(JSON.stringify({
      type: "call_failed", call_id: incoming.call_id, code: "task_not_offered", offered: ["ask", "owner-introduction"],
    }));
    const err = await nextFrame(caller);
    expect(err).toMatchObject({ type: "call_error", code: "task_not_offered", offered: ["ask", "owner-introduction"] });
    await closed(caller);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `apps/relay`): `pnpm test -- task-passthrough`
Expected: FAIL — `incoming.task` is `undefined` (DO doesn't forward it) and `err.offered` is `undefined`.

- [ ] **Step 3: Implement the passthrough**

In `apps/relay/src/do.ts`:

1. Extend `fail` to carry `offered` (signature change; existing call sites are unaffected because the new parameter comes after `detail` and `close` gains an explicit position):

```ts
private fail(ws: WebSocket, code: ErrorCodeType, detail?: string, offered?: string[], close = true): void {
  this.send(ws, { type: "call_error", code, detail, offered });
  if (close) { try { ws.close(1000, code); } catch { /* already closed */ } }
}
```

(Grep for existing `this.fail(` call sites passing a 4th argument `false` for `close` — there are none today, `close` is only ever defaulted — but verify before committing.)

2. In the caller branch of `webSocketMessage`, include `task` in the forwarded frame:

```ts
this.send(listener, {
  type: "incoming_call", call_id, from: att.from,
  message: frame.message, session_id: frame.session_id, task: frame.task,
});
```

3. In the `call_result` branch, include `task` in the reply:

```ts
this.send(caller, { type: "call_reply", call_id: frame.call_id, text, session_id: frame.session_id, task: frame.task });
```

4. In the `call_failed` branch, pass `offered` through:

```ts
if (caller) this.fail(caller, frame.code, frame.detail, frame.offered);
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `apps/relay`): `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/do.ts apps/relay/test/task-passthrough.test.ts
git commit -m "feat(relay): pass task and offered fields through the call flow"
```

---

### Task 4: CLI — paths additions and tasks module (manifests, loader, built-in ask)

**Files:**
- Modify: `packages/cli/src/paths.ts`
- Create: `packages/cli/src/tasks.ts`
- Test: `packages/cli/test/tasks.test.ts` (new file)

**Interfaces:**
- Consumes: `TASK_ID_RE` from shared; `Paths` from `./paths.js`.
- Produces: `Paths.tasksDir` (`~/AgentCall/tasks`) and `Paths.policyFile` (`~/.agentcall/policy.json`); `CAPS`, `Cap`, `Envelope`, `FULL_ACCESS_ENVELOPE`, `TaskManifest` (zod), `Task` (interface with `skill: string`), `ASK_TASK`, `loadTasks(p: Paths, warn?: (msg: string) => void): Task[]`.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/tasks.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ASK_TASK, FULL_ACCESS_ENVELOPE, loadTasks, TaskManifest } from "../src/tasks.js";
import { getPaths } from "../src/paths.js";

function tempHome() { return mkdtempSync(join(tmpdir(), "agentcall-tasks-")); }

function writeTask(home: string, id: string, manifest: object, skill = "# How to do it\n") {
  const dir = join(home, "AgentCall", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "SKILL.md"), skill);
}

describe("paths", () => {
  it("exposes tasksDir and policyFile", () => {
    const p = getPaths("/tmp/fakehome");
    expect(p.tasksDir).toBe("/tmp/fakehome/AgentCall/tasks");
    expect(p.policyFile).toBe("/tmp/fakehome/.agentcall/policy.json");
  });
});

describe("TaskManifest", () => {
  it("applies envelope defaults (read-only, no writes, no network)", () => {
    const m = TaskManifest.parse({ id: "intro", name: "Intro", description: "Introduce the owner." });
    expect(m.envelope).toEqual({ tools: ["read"], write_paths: [], network: [] });
    expect(m.tier).toBe("T1");
  });
  it("rejects write_paths that try to escape ~/AgentCall", () => {
    const bad = TaskManifest.safeParse({
      id: "x", name: "X", description: "d", envelope: { tools: ["write"], write_paths: ["../.ssh"], network: [] },
    });
    expect(bad.success).toBe(false);
  });
  it("rejects a timeout above the 300s cap", () => {
    const bad = TaskManifest.safeParse({ id: "x", name: "X", description: "d", timeout_s: 999 });
    expect(bad.success).toBe(false);
  });
});

describe("loadTasks", () => {
  it("always includes the built-in ask task, even with no tasks dir", () => {
    const tasks = loadTasks(getPaths(tempHome()), () => {});
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(ASK_TASK.envelope).toEqual({ caps: ["read"], write_paths: [], network: [] });
  });
  it("loads a task dir with manifest + SKILL.md, mapping tools -> caps", () => {
    const home = tempHome();
    writeTask(home, "schedule-meeting", {
      id: "schedule-meeting", name: "Schedule", description: "Book a time.",
      envelope: { tools: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] },
      timeout_s: 120,
    }, "# Check the calendar first\n");
    const tasks = loadTasks(getPaths(home), () => {});
    const t = tasks.find((x) => x.id === "schedule-meeting")!;
    expect(t.envelope).toEqual({ caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] });
    expect(t.skill).toContain("Check the calendar");
    expect(t.timeout_s).toBe(120);
  });
  it("skips a dir whose name doesn't match the manifest id, with a warning", () => {
    const home = tempHome();
    writeTask(home, "wrong-dir", { id: "other-id", name: "X", description: "d" });
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(warnings.some((w) => w.includes("wrong-dir"))).toBe(true);
  });
  it("skips invalid manifests and a task trying to shadow the built-in ask", () => {
    const home = tempHome();
    writeTask(home, "bad", { id: "bad" }); // missing name/description
    writeTask(home, "ask", { id: "ask", name: "Evil", description: "override" });
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(tasks[0]!.name).toBe(ASK_TASK.name);
    expect(warnings).toHaveLength(2);
  });
});

describe("FULL_ACCESS_ENVELOPE", () => {
  it("matches today's single-tier behavior", () => {
    expect(FULL_ACCESS_ENVELOPE).toEqual({
      caps: ["read", "write", "fetch", "exec"], write_paths: ["public"], network: [],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- tasks`
Expected: FAIL — `../src/tasks.js` does not exist; `p.tasksDir` undefined.

- [ ] **Step 3: Implement paths additions**

In `packages/cli/src/paths.ts`, add to the `Paths` interface: `tasksDir: string; policyFile: string;` and to the returned object in `getPaths`:

```ts
policyFile: join(dir, "policy.json"),
tasksDir: join(home, "AgentCall", "tasks"),
```

- [ ] **Step 4: Implement the tasks module**

Create `packages/cli/src/tasks.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TASK_ID_RE } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

export const CAPS = ["read", "write", "fetch", "exec"] as const;
export type Cap = (typeof CAPS)[number];

export interface Envelope {
  caps: Cap[];
  write_paths: string[];
  network: string[];
}

// Today's single-tier behavior; the default envelope for call sites that
// predate task scoping (runner/srt defaults) so nothing changes until a
// resolved task passes a narrower one.
export const FULL_ACCESS_ENVELOPE: Envelope = {
  caps: ["read", "write", "fetch", "exec"],
  write_paths: ["public"],
  network: [],
};

// write_paths are relative to ~/AgentCall; the character set forbids "." so
// "../" traversal can't be expressed at all, and a leading "/" is rejected
// by the first-character class.
const WRITE_PATH_RE = /^[a-z0-9][a-z0-9/_-]*$/;
// Hostnames for srt allowedDomains ("*.example.com" wildcards allowed).
const DOMAIN_RE = /^(\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/;

export const TaskManifest = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().min(1).max(100),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
  tier: z.enum(["T1", "T2"]).default("T1"),
  envelope: z
    .object({
      tools: z.array(z.enum(CAPS)).default(["read"]),
      write_paths: z.array(z.string().regex(WRITE_PATH_RE)).default([]),
      network: z.array(z.string().regex(DOMAIN_RE)).default([]),
    })
    .default({ tools: ["read"], write_paths: [], network: [] }),
  timeout_s: z.number().int().positive().max(300).optional(),
});
export type TaskManifestType = z.infer<typeof TaskManifest>;

export interface Task {
  id: string;
  name: string;
  description: string;
  examples: string[];
  tier: "T1" | "T2";
  envelope: Envelope;
  timeout_s?: number;
  skill: string; // SKILL.md content, embedded into the spawn prompt
}

export const ASK_TASK: Task = {
  id: "ask",
  name: "Ask a question",
  description: "Answer questions using the files in the public directory.",
  examples: [],
  tier: "T1",
  envelope: { caps: ["read"], write_paths: [], network: [] },
  skill: "",
};

// Reads ~/AgentCall/tasks/<id>/{task.json,SKILL.md}. Invalid or duplicate
// entries are skipped with a warning rather than failing the whole listener:
// one broken manifest must not take every other task offline.
export function loadTasks(p: Paths, warn: (msg: string) => void = console.error): Task[] {
  const tasks: Task[] = [ASK_TASK];
  if (!existsSync(p.tasksDir)) return tasks;
  for (const entry of readdirSync(p.tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(p.tasksDir, entry.name);
    const manifestFile = join(dir, "task.json");
    if (!existsSync(manifestFile)) {
      warn(`agentcall: task "${entry.name}": missing task.json, skipped`);
      continue;
    }
    let m: TaskManifestType;
    try {
      m = TaskManifest.parse(JSON.parse(readFileSync(manifestFile, "utf8")));
    } catch (e) {
      warn(`agentcall: task "${entry.name}": invalid task.json, skipped (${String(e).slice(0, 200)})`);
      continue;
    }
    if (m.id !== entry.name) {
      warn(`agentcall: task "${entry.name}": directory name must equal manifest id "${m.id}", skipped`);
      continue;
    }
    if (tasks.some((t) => t.id === m.id)) {
      warn(`agentcall: task "${m.id}": duplicate or reserved id, skipped`);
      continue;
    }
    const skillFile = join(dir, "SKILL.md");
    tasks.push({
      id: m.id,
      name: m.name,
      description: m.description,
      examples: m.examples,
      tier: m.tier,
      envelope: { caps: m.envelope.tools, write_paths: m.envelope.write_paths, network: m.envelope.network },
      timeout_s: m.timeout_s,
      skill: existsSync(skillFile) ? readFileSync(skillFile, "utf8") : "",
    });
  }
  return tasks;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- tasks` then the full `pnpm test && pnpm typecheck`
Expected: PASS. (The `paths` expectation lives in this test file; existing suites are unaffected because `Paths` only gained fields.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/paths.ts packages/cli/src/tasks.ts packages/cli/test/tasks.test.ts
git commit -m "feat(cli): task manifests, loader, and built-in ask task"
```

---

### Task 5: CLI — policy module (load, offeredFor, resolveTask)

**Files:**
- Create: `packages/cli/src/policy.ts`
- Test: `packages/cli/test/policy.test.ts` (new file)

**Interfaces:**
- Consumes: `Task`, `ASK_TASK` from `./tasks.js`; `Paths`.
- Produces: `PolicySchema`, `Policy`, `DEFAULT_POLICY`, `loadPolicy(p: Paths): Policy` (missing file → `DEFAULT_POLICY`; malformed file → **throws**, fail closed), `offeredFor(policy, from): string[] | "blocked"`, `TaskResolution`, `resolveTask(policy, tasks, from, requested?): TaskResolution`.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/policy.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, loadPolicy, offeredFor, resolveTask, type Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import { getPaths } from "../src/paths.js";

const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: [], tier: "T1", envelope: { caps: ["read"], write_paths: [], network: [] }, skill: "",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], tier: "T2", envelope: { caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] }, skill: "",
};
const TASKS = [ASK_TASK, intro, meet];

const policy: Policy = {
  description: "",
  default_offer: ["ask", "owner-introduction"],
  callers: {
    ken: { offer: ["schedule-meeting"], block: false },
    spammer: { offer: [], block: true },
  },
};

describe("loadPolicy", () => {
  it("returns DEFAULT_POLICY when the file doesn't exist", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    expect(loadPolicy(p)).toEqual(DEFAULT_POLICY);
    expect(DEFAULT_POLICY.default_offer).toEqual(["ask"]);
  });
  it("throws on a malformed policy file (fail closed, never silently default)", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, "{not json");
    expect(() => loadPolicy(p)).toThrow();
  });
  it("accepts +-prefixed offer entries (spec syntax) by stripping the prefix", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask"], callers: { ken: { offer: ["+schedule-meeting"] } },
    }));
    expect(offeredFor(loadPolicy(p), "ken")).toEqual(["ask", "schedule-meeting"]);
  });
});

describe("offeredFor", () => {
  it("returns default_offer for unknown callers", () => {
    expect(offeredFor(policy, "stranger")).toEqual(["ask", "owner-introduction"]);
  });
  it("adds per-caller grants to the default offer", () => {
    expect(offeredFor(policy, "ken")).toEqual(["ask", "owner-introduction", "schedule-meeting"]);
  });
  it("returns 'blocked' for blocked callers", () => {
    expect(offeredFor(policy, "spammer")).toBe("blocked");
  });
});

describe("resolveTask", () => {
  it("blocked caller -> blocked, offered stays empty (no menu leak to blocked callers)", () => {
    expect(resolveTask(policy, TASKS, "spammer", "ask")).toEqual({ ok: false, code: "blocked", offered: [] });
  });
  it("explicit granted task resolves", () => {
    const r = resolveTask(policy, TASKS, "ken", "schedule-meeting");
    expect(r).toMatchObject({ ok: true, task: { id: "schedule-meeting" } });
  });
  it("explicit existing-but-ungranted task -> task_not_offered with the caller's menu", () => {
    expect(resolveTask(policy, TASKS, "stranger", "schedule-meeting")).toEqual({
      ok: false, code: "task_not_offered", offered: ["ask", "owner-introduction"],
    });
  });
  it("explicit nonexistent task -> task_unknown with the caller's menu", () => {
    expect(resolveTask(policy, TASKS, "ken", "no-such-task")).toEqual({
      ok: false, code: "task_unknown", offered: ["ask", "owner-introduction", "schedule-meeting"],
    });
  });
  it("no task requested -> falls back to ask when offered", () => {
    expect(resolveTask(policy, TASKS, "stranger")).toMatchObject({ ok: true, task: { id: "ask" } });
  });
  it("no task requested, single non-ask offer -> that task", () => {
    const p: Policy = { description: "", default_offer: ["owner-introduction"], callers: {} };
    expect(resolveTask(p, TASKS, "x")).toMatchObject({ ok: true, task: { id: "owner-introduction" } });
  });
  it("no task requested, multiple offers, no ask -> task_not_offered (caller must pick)", () => {
    const p: Policy = { description: "", default_offer: ["owner-introduction", "schedule-meeting"], callers: {} };
    expect(resolveTask(p, TASKS, "x")).toEqual({
      ok: false, code: "task_not_offered", offered: ["owner-introduction", "schedule-meeting"],
    });
  });
  it("offered ids with no matching task on disk are dropped from the menu", () => {
    const p: Policy = { description: "", default_offer: ["ask", "deleted-task"], callers: {} };
    expect(resolveTask(p, TASKS, "x", "deleted-task")).toEqual({
      ok: false, code: "task_unknown", offered: ["ask"],
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- policy`
Expected: FAIL — `../src/policy.js` does not exist.

- [ ] **Step 3: Implement the policy module**

Create `packages/cli/src/policy.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Paths } from "./paths.js";
import type { Task } from "./tasks.js";

export const PolicySchema = z.object({
  description: z.string().max(500).default(""),
  default_offer: z.array(z.string()).default(["ask"]),
  callers: z
    .record(
      z.string(),
      z.object({
        offer: z.array(z.string()).default([]),
        block: z.boolean().default(false),
      }),
    )
    .default({}),
});
export type Policy = z.infer<typeof PolicySchema>;

export const DEFAULT_POLICY: Policy = { description: "", default_offer: ["ask"], callers: {} };

// Missing file -> safe default (fresh install). Malformed file -> THROW:
// silently falling back to DEFAULT_POLICY would grant `ask` to callers the
// owner explicitly blocked. The listener maps the throw to a call_failed
// agent_error without spawning anything.
export function loadPolicy(p: Paths): Policy {
  if (!existsSync(p.policyFile)) return DEFAULT_POLICY;
  return PolicySchema.parse(JSON.parse(readFileSync(p.policyFile, "utf8")));
}

// Grant entries may carry the spec's "+" prefix ("+schedule-meeting");
// semantics are additive either way, so the prefix is just stripped.
const stripPlus = (id: string) => id.replace(/^\+/, "");

export function offeredFor(policy: Policy, from: string): string[] | "blocked" {
  const entry = policy.callers[from];
  if (entry?.block) return "blocked";
  const ids = new Set(policy.default_offer.map(stripPlus));
  for (const id of entry?.offer ?? []) ids.add(stripPlus(id));
  return [...ids];
}

export type TaskResolution =
  | { ok: true; task: Task }
  | { ok: false; code: "blocked" | "task_not_offered" | "task_unknown"; offered: string[] };

// CaMeL invariant: this runs on relay-verified `from` and local files only,
// BEFORE the caller's message is placed in any prompt. The message cannot
// influence which task (and therefore which envelope) is chosen.
export function resolveTask(policy: Policy, tasks: Task[], from: string, requested?: string): TaskResolution {
  const offered = offeredFor(policy, from);
  if (offered === "blocked") return { ok: false, code: "blocked", offered: [] };
  // Menu = offered ids that actually exist on disk; stale grants are dropped.
  const menu = offered.filter((id) => tasks.some((t) => t.id === id));
  if (requested !== undefined) {
    const task = tasks.find((t) => t.id === requested);
    if (!task) return { ok: false, code: "task_unknown", offered: menu };
    if (!menu.includes(requested)) return { ok: false, code: "task_not_offered", offered: menu };
    return { ok: true, task };
  }
  if (menu.length === 1) return { ok: true, task: tasks.find((t) => t.id === menu[0])! };
  if (menu.includes("ask")) return { ok: true, task: tasks.find((t) => t.id === "ask")! };
  return { ok: false, code: "task_not_offered", offered: menu };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- policy && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/policy.ts packages/cli/test/policy.test.ts
git commit -m "feat(cli): caller policy - offers, blocks, and pre-spawn task resolution"
```

---

### Task 6: CLI — envelope-driven srt settings

**Files:**
- Modify: `packages/cli/src/srt.ts`
- Test: `packages/cli/test/srt.test.ts` (append new describe block)

**Interfaces:**
- Consumes: `Envelope`, `FULL_ACCESS_ENVELOPE` from `./tasks.js`.
- Produces: `srtSettings(p, agentKind, extraReadDirs?: string[], envelope?: Envelope)` and `writeSrtSettings(p, agentKind, envelope?: Envelope)` — both defaulting to `FULL_ACCESS_ENVELOPE` so every existing call site and test keeps today's behavior.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/srt.test.ts` (add `FULL_ACCESS_ENVELOPE` and `Envelope` to imports from `../src/tasks.js`):

```ts
import { FULL_ACCESS_ENVELOPE, type Envelope } from "../src/tasks.js";

describe("srtSettings with a task envelope", () => {
  const READ_ONLY: Envelope = { caps: ["read"], write_paths: [], network: [] };

  it("read-only envelope removes publicDir from allowWrite but keeps agent state writable", () => {
    const s = srtSettings(getPaths("/tmp/fakehome"), "claude", [], READ_ONLY) as any;
    expect(s.filesystem.allowWrite).not.toContain("/tmp/fakehome/AgentCall/public");
    expect(s.filesystem.allowWrite).toContain("~/.claude"); // claude -p must still run
    expect(s.filesystem.allowRead).toContain("/tmp/fakehome/AgentCall/public"); // reads stay
  });

  it("write_paths map to dirs under ~/AgentCall", () => {
    const env: Envelope = { caps: ["read", "write"], write_paths: ["public/inbox"], network: [] };
    const s = srtSettings(getPaths("/tmp/fakehome"), "claude", [], env) as any;
    expect(s.filesystem.allowWrite).toContain("/tmp/fakehome/AgentCall/public/inbox");
    expect(s.filesystem.allowWrite).not.toContain("/tmp/fakehome/AgentCall/public");
  });

  it("envelope network domains are appended to the agent-kind allowlist", () => {
    const env: Envelope = { caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] };
    const s = srtSettings(getPaths("/tmp/fakehome"), "claude", [], env) as any;
    expect(s.network.allowedDomains).toContain("api.anthropic.com");
    expect(s.network.allowedDomains).toContain("calendar.google.com");
  });

  it("defaults to FULL_ACCESS_ENVELOPE, reproducing today's allowWrite exactly", () => {
    const withDefault = srtSettings(getPaths("/tmp/fakehome"), "claude") as any;
    const explicit = srtSettings(getPaths("/tmp/fakehome"), "claude", [], FULL_ACCESS_ENVELOPE) as any;
    expect(withDefault.filesystem.allowWrite).toEqual(explicit.filesystem.allowWrite);
    expect(withDefault.filesystem.allowWrite).toContain("/tmp/fakehome/AgentCall/public");
  });

  it("writeSrtSettings persists the envelope-scoped settings", () => {
    const home = tempHome();
    const p = getPaths(home);
    mkdirSync(p.dir, { recursive: true });
    writeSrtSettings(p, "claude", READ_ONLY);
    const written = JSON.parse(readFileSync(p.srtFile, "utf8"));
    expect(written.filesystem.allowWrite).not.toContain(join(home, "AgentCall", "public"));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- srt`
Expected: FAIL — TypeScript/arity errors (4th parameter doesn't exist) or `allowWrite` still contains publicDir.

- [ ] **Step 3: Implement**

In `packages/cli/src/srt.ts`:

1. Add the import: `import { FULL_ACCESS_ENVELOPE, type Envelope } from "./tasks.js";`
2. Change `srtSettings` to:

```ts
export function srtSettings(
  p: Paths, agentKind: "claude" | "codex", extraReadDirs: string[] = [], envelope: Envelope = FULL_ACCESS_ENVELOPE,
): object {
  const home = AGENT_HOME[agentKind];
  const homeDir = "~/" + home.dotDir;
  // Task envelopes name their writable dirs relative to ~/AgentCall
  // ("public" -> p.publicDir). WRITE_PATH_RE in tasks.ts forbids "." so
  // traversal outside ~/AgentCall cannot be expressed.
  const taskWriteDirs = envelope.write_paths.map((wp) => join(p.home, "AgentCall", wp));
  return {
    filesystem: {
      denyRead: ["~"],
      allowRead: [
        ...new Set([p.publicDir, homeDir, ...home.extraAllow, "/tmp", "/private/tmp", "/var/folders", ...extraReadDirs]),
      ],
      allowWrite: [...taskWriteDirs, homeDir, ...home.extraAllow, "/tmp", "/private/tmp", "/var/folders"],
      denyWrite: home.protected.map((e) => `~/${home.dotDir}/${e.rel}`),
    },
    network: {
      allowedDomains: [...ALLOWED_DOMAINS[agentKind], ...envelope.network],
      deniedDomains: [],
    },
  };
}
```

3. Change `writeSrtSettings` to:

```ts
export function writeSrtSettings(p: Paths, agentKind: "claude" | "codex", envelope: Envelope = FULL_ACCESS_ENVELOPE): void {
  writeFileSync(p.srtFile, JSON.stringify(srtSettings(p, agentKind, toolchainReadDirs(agentKind), envelope), null, 2) + "\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- srt && pnpm typecheck`
Expected: PASS — including every pre-existing srt test (the default envelope reproduces the old allowWrite list byte-for-byte: `join(home, "AgentCall", "public")` === `p.publicDir`).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/srt.ts packages/cli/test/srt.test.ts
git commit -m "feat(cli): envelope-scoped srt settings (write paths + network per task)"
```

---

### Task 7: CLI — envelope-driven spawn spec and runAgent

**Files:**
- Modify: `packages/cli/src/runner.ts`
- Test: `packages/cli/test/runner.test.ts` (modify two existing assertions + append new describe block)

**Interfaces:**
- Consumes: `Envelope`, `FULL_ACCESS_ENVELOPE`, `CAPS`, `Cap` from `./tasks.js`.
- Produces: `claudeAllowedTools(envelope): string`; `buildSpawnSpec(kind, prompt, p, resolveBin?, envelope?)`; `runAgent(kind, prompt, p, timeoutMs?, specOverride?, envelope?)` — envelope defaults to `FULL_ACCESS_ENVELOPE` everywhere. Task 10's listener calls `runAgent(kind, prompt, paths, timeoutMs, undefined, task.envelope)`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/runner.test.ts`, first update the two existing `buildSpawnSpec` assertions (the claude/codex arg arrays change):

```ts
// claude test — expected args become:
expect(s.args).toEqual([
  "-y", "@anthropic-ai/sandbox-runtime@0.0.65", "--settings", p.srtFile, "--",
  "/abs/path/to/claude", "-p", "PROMPT", "--output-format", "json",
  "--permission-mode", "dontAsk",
  "--allowedTools", "Read,Grep,Glob,LS,Write,Edit,WebFetch,WebSearch,Bash",
]);
```

(The codex expected args are unchanged — full envelope still maps to `--sandbox workspace-write`.)

Then append:

```ts
import { claudeAllowedTools } from "../src/runner.js"; // add to the existing import list
import { FULL_ACCESS_ENVELOPE, type Envelope } from "../src/tasks.js";

describe("envelope-scoped spawn spec", () => {
  const READ_ONLY: Envelope = { caps: ["read"], write_paths: [], network: [] };

  it("claudeAllowedTools maps caps to tool lists, read always included, CAPS order", () => {
    expect(claudeAllowedTools(READ_ONLY)).toBe("Read,Grep,Glob,LS");
    expect(claudeAllowedTools({ caps: ["fetch"], write_paths: [], network: [] })).toBe("Read,Grep,Glob,LS,WebFetch,WebSearch");
    expect(claudeAllowedTools(FULL_ACCESS_ENVELOPE)).toBe("Read,Grep,Glob,LS,Write,Edit,WebFetch,WebSearch,Bash");
  });

  it("read-only envelope restricts claude's allowedTools", () => {
    const s = buildSpawnSpec("claude", "PROMPT", p, () => "/abs/claude", READ_ONLY);
    const idx = s.args.indexOf("--allowedTools");
    expect(s.args[idx + 1]).toBe("Read,Grep,Glob,LS");
    expect(s.args).toContain("dontAsk");
  });

  it("codex gets --sandbox read-only when the envelope has no write cap", () => {
    const s = buildSpawnSpec("codex", "PROMPT", p, () => "/abs/codex", READ_ONLY);
    const idx = s.args.indexOf("--sandbox");
    expect(s.args[idx + 1]).toBe("read-only");
  });

  it("codex keeps workspace-write when the envelope has the write cap", () => {
    const s = buildSpawnSpec("codex", "PROMPT", p, () => "/abs/codex", FULL_ACCESS_ENVELOPE);
    const idx = s.args.indexOf("--sandbox");
    expect(s.args[idx + 1]).toBe("workspace-write");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- runner`
Expected: FAIL — the updated claude arg assertion fails (no `--permission-mode` in current args); `claudeAllowedTools` not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/runner.ts`:

1. Add import: `import { CAPS, FULL_ACCESS_ENVELOPE, type Cap, type Envelope } from "./tasks.js";`
2. Add above `buildSpawnSpec`:

```ts
// Cap -> Claude Code tool names, used with --allowedTools + --permission-mode
// dontAsk: listed tools are pre-approved, everything else is denied instead
// of prompting (headless -p can't prompt). "read" is always included — an
// agent that can't read its own cwd can't answer anything.
const CLAUDE_TOOLS: Record<Cap, string[]> = {
  read: ["Read", "Grep", "Glob", "LS"],
  write: ["Write", "Edit"],
  fetch: ["WebFetch", "WebSearch"],
  exec: ["Bash"],
};

export function claudeAllowedTools(envelope: Envelope): string {
  const caps = new Set<Cap>(["read", ...envelope.caps]);
  return CAPS.filter((c) => caps.has(c)).flatMap((c) => CLAUDE_TOOLS[c]).join(",");
}
```

3. Change `buildSpawnSpec`'s signature and bodies:

```ts
export function buildSpawnSpec(
  kind: AgentKind, prompt: string, p: Paths,
  resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  envelope: Envelope = FULL_ACCESS_ENVELOPE,
): SpawnSpec {
  if (kind === "claude") {
    return {
      cmd: "npx",
      // (keep the existing pinning comment)
      args: ["-y", "@anthropic-ai/sandbox-runtime@0.0.65", "--settings", p.srtFile, "--",
        resolveBin(kind), "-p", prompt, "--output-format", "json",
        "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools(envelope)],
      cwd: p.publicDir,
    };
  }
  // (keep the existing codex comment) Codex has no per-tool granularity;
  // the envelope's write cap maps onto its sandbox level, and srt (Task 6)
  // still enforces the exact write paths and network domains underneath.
  const sandbox = envelope.caps.includes("write") ? "workspace-write" : "read-only";
  return {
    cmd: "npx",
    args: ["-y", "@anthropic-ai/sandbox-runtime@0.0.65", "--settings", p.srtFile, "--",
      resolveBin(kind), "exec", "--sandbox", sandbox, "--cd", p.publicDir, "--skip-git-repo-check", "--json", prompt],
    cwd: p.publicDir,
  };
}
```

4. Change `runAgent`'s signature and the two envelope-consuming lines:

```ts
export function runAgent(
  kind: AgentKind, prompt: string, p: Paths, timeoutMs: number = AGENT_TIMEOUT_MS,
  specOverride?: SpawnSpec, envelope: Envelope = FULL_ACCESS_ENVELOPE,
): Promise<AgentOutput> {
  if (!specOverride) {
    ensureDenyWriteTargetsExist(kind);
    writeSrtSettings(p, kind, envelope);
  }
  const spec = specOverride ?? buildSpawnSpec(kind, prompt, p, resolveAgentBin, envelope);
  // ... rest unchanged
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- runner && pnpm typecheck`
Expected: PASS, including all pre-existing runner tests (they use `specOverride`, unaffected by the new trailing parameter).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/runner.ts packages/cli/test/runner.test.ts
git commit -m "feat(cli): task-envelope-scoped agent spawns (allowedTools / codex sandbox)"
```

---

### Task 8: CLI — task-aware prompt

**Files:**
- Modify: `packages/cli/src/prompt.ts`
- Test: `packages/cli/test/runner.test.ts` (extend the existing `buildPrompt` describe block)

**Interfaces:**
- Consumes: `Task` from `./tasks.js`.
- Produces: `buildPrompt(handle: string, from: string, message: string, task?: Task): string`. Existing 3-arg calls keep working.

- [ ] **Step 1: Write the failing tests**

Add to the `buildPrompt` describe block in `packages/cli/test/runner.test.ts`:

```ts
import type { Task } from "../src/tasks.js"; // add to imports

it("embeds the task name, id, and SKILL.md content when a non-ask task is given", () => {
  const task: Task = {
    id: "schedule-meeting", name: "Schedule a meeting", description: "Book a time.",
    examples: [], tier: "T1", envelope: { caps: ["read"], write_paths: [], network: [] },
    skill: "# Steps\nCheck the calendar first.",
  };
  const out = buildPrompt("ken", "shusaku", "next tue?", task);
  expect(out).toContain('task "Schedule a meeting" (schedule-meeting)');
  expect(out).toContain("Check the calendar first.");
  expect(out).toContain("must not perform any other task");
  expect(out).toContain("\n---\nnext tue?");
});

it("adds no task section for the built-in ask task or when no task is given", () => {
  const { ASK_TASK } = await import("../src/tasks.js");
  expect(buildPrompt("ken", "shusaku", "q?", ASK_TASK)).not.toContain("TASK-INSTRUCTIONS");
  expect(buildPrompt("ken", "shusaku", "q?")).not.toContain("TASK-INSTRUCTIONS");
});
```

(Note: the second test's `await import` requires the enclosing `it` callback to be `async` — write it as `it("...", async () => { ... })`, or hoist `ASK_TASK` into the top-level import from `../src/tasks.js`; prefer the top-level import.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- runner`
Expected: FAIL — `buildPrompt` ignores the 4th argument.

- [ ] **Step 3: Implement**

Replace `packages/cli/src/prompt.ts`:

```ts
import type { Task } from "./tasks.js";

// The task section is behavior-shaping only — enforcement lives in the
// spawn envelope (runner.ts) and srt config (srt.ts), which were fixed
// before this prompt was built. SKILL.md content is fenced between markers
// so the model can tell the owner's instructions from the caller's message.
export function buildPrompt(handle: string, from: string, message: string, task?: Task): string {
  const taskSection =
    task && task.id !== "ask"
      ? `You are performing the task "${task.name}" (${task.id}) for this call and must not perform any other task. ` +
        `The owner's instructions for this task follow between the markers.\n` +
        `<<TASK-INSTRUCTIONS>>\n${task.skill}\n<<END-TASK-INSTRUCTIONS>>\n`
      : "";
  return (
    `You are ${handle}'s public agent, answering a one-shot call from "${from}" via agentcall. ` +
    `You can only access the current directory (~/AgentCall/public). Do not attempt to access anything else. ` +
    `Answer helpfully and concisely. ${taskSection}The caller's message follows after the divider.\n---\n${message}`
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- runner && pnpm typecheck`
Expected: PASS — the pre-existing `buildPrompt` tests still pass (no-task output is unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/prompt.ts packages/cli/test/runner.test.ts
git commit -m "feat(cli): embed task skill instructions in the spawn prompt"
```

---

### Task 9: CLI — card building and relay card API client

**Files:**
- Create: `packages/cli/src/card.ts`
- Modify: `packages/cli/src/api.ts`
- Test: `packages/cli/test/card.test.ts` (new file), `packages/cli/test/api.test.ts` (append)

**Interfaces:**
- Consumes: `CardUploadType`, `AgentCard`, `AgentCardType` from shared; `Config`, `Policy`, `Task`.
- Produces: `buildCardUpload(cfg: Config, policy: Policy, tasks: Task[]): CardUploadType`; `pushCard(relay: string, auth: { handle: string; token: string }, upload: CardUploadType, opts?: { timeoutMs?: number }): Promise<void>`; `fetchCard(relay: string, handle: string, auth?: { handle: string; token: string }, opts?: { timeoutMs?: number }): Promise<AgentCardType>`.

- [ ] **Step 1: Write the failing card-builder tests**

Create `packages/cli/test/card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildCardUpload } from "../src/card.js";
import { ASK_TASK, type Task } from "../src/tasks.js";
import type { Policy } from "../src/policy.js";
import type { Config } from "../src/config.js";

const cfg: Config = { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };
const intro: Task = {
  id: "owner-introduction", name: "Intro", description: "Introduce the owner.",
  examples: ["who is ken?"], tier: "T1", envelope: { caps: ["read"], write_paths: [], network: [] }, skill: "secret steps",
};
const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], tier: "T2", envelope: { caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] }, skill: "",
};

describe("buildCardUpload", () => {
  const policy: Policy = {
    description: "Ken's agent",
    default_offer: ["ask", "owner-introduction"],
    callers: { mia: { offer: ["+schedule-meeting"], block: false }, spammer: { offer: [], block: true } },
  };

  it("includes card metadata but never envelopes or SKILL.md content", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload).toMatchObject({ description: "Ken's agent", agent_kind: "claude", default_offer: ["ask", "owner-introduction"] });
    const introEntry = upload.tasks.find((t) => t.id === "owner-introduction")!;
    expect(introEntry).toEqual({ id: "owner-introduction", name: "Intro", description: "Introduce the owner.", examples: ["who is ken?"], tier: "T1" });
    expect(JSON.stringify(upload)).not.toContain("secret steps");
    expect(JSON.stringify(upload)).not.toContain("caps");
  });

  it("maps caller grants (stripping + prefixes) and omits blocked callers", () => {
    const upload = buildCardUpload(cfg, policy, [ASK_TASK, intro, meet]);
    expect(upload.grants).toEqual({ mia: ["schedule-meeting"] });
  });

  it("drops offered/granted ids that have no task on disk", () => {
    const stale: Policy = { description: "", default_offer: ["ask", "gone"], callers: { mia: { offer: ["also-gone"], block: false } } };
    const upload = buildCardUpload(cfg, stale, [ASK_TASK]);
    expect(upload.default_offer).toEqual(["ask"]);
    expect(upload.grants).toEqual({});
    expect(upload.tasks.map((t) => t.id)).toEqual(["ask"]);
  });
});
```

- [ ] **Step 2: Write the failing API-client tests**

Append to `packages/cli/test/api.test.ts` (it already spins up a local `node:http` server for `registerHandle`/`getStatus` — follow the same pattern; if its helper differs, adapt the server construction to match the file's existing style):

```ts
import { fetchCard, pushCard } from "../src/api.js"; // add to the existing import

describe("pushCard / fetchCard", () => {
  it("PUTs the upload with bearer auth and succeeds on 200", async () => {
    let seen: { method?: string; url?: string; auth?: string; body?: string } = {};
    const relay = await startServer((req, res, body) => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization as string, body };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await pushCard(relay, { handle: "ken", token: "tok" }, {
      description: "", agent_kind: "claude",
      tasks: [{ id: "ask", name: "Ask", description: "d", examples: [], tier: "T1" }],
      default_offer: ["ask"], grants: {},
    });
    expect(seen.method).toBe("PUT");
    expect(seen.url).toBe("/v1/card");
    expect(seen.auth).toBe("Bearer tok");
    expect(JSON.parse(seen.body!)).toMatchObject({ default_offer: ["ask"] });
  });

  it("fetchCard parses and returns the card; 404 -> ApiError unknown_handle", async () => {
    const card = {
      handle: "ken", description: "", agent_kind: "claude",
      tasks: [{ id: "ask", name: "Ask", description: "d", examples: [], tier: "T1" }], updated_at: 1,
    };
    const relay = await startServer((req, res) => {
      if (req.url === "/v1/card/ken") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(card));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no card" }));
      }
    });
    expect(await fetchCard(relay, "ken")).toMatchObject({ handle: "ken" });
    await expect(fetchCard(relay, "ghost")).rejects.toMatchObject({ code: "unknown_handle" });
  });
});
```

(`startServer` here stands for whatever local-HTTP-server helper `api.test.ts` already uses — reuse it verbatim, including its body-collection style; only the handler bodies above are new. If the file has no reusable helper, add one local to the new describe block using `createServer` from `node:http` exactly like `setup.test.ts`'s `fakeRelay`.)

- [ ] **Step 3: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- card && pnpm test -- api`
Expected: FAIL — `../src/card.js` missing; `pushCard`/`fetchCard` not exported.

- [ ] **Step 4: Implement the card builder**

Create `packages/cli/src/card.ts`:

```ts
import type { CardUploadType } from "@benree/agentcall-shared";
import type { Config } from "./config.js";
import type { Policy } from "./policy.js";
import type { Task } from "./tasks.js";

const stripPlus = (id: string) => id.replace(/^\+/, "");

// The upload contains only advertisement fields (id/name/description/
// examples/tier) — never envelopes or SKILL.md content. Envelopes are
// enforcement detail that stays on the callee's machine; the card and the
// enforcement both derive from the same task.json, so they cannot disagree.
export function buildCardUpload(cfg: Config, policy: Policy, tasks: Task[]): CardUploadType {
  const exists = (id: string) => tasks.some((t) => t.id === id);
  const defaultOffer = policy.default_offer.map(stripPlus).filter(exists);

  const grants: Record<string, string[]> = {};
  for (const [caller, entry] of Object.entries(policy.callers)) {
    if (entry.block) continue;
    const ids = entry.offer.map(stripPlus).filter(exists);
    if (ids.length > 0) grants[caller] = ids;
  }

  const referenced = new Set([...defaultOffer, ...Object.values(grants).flat()]);
  return {
    description: policy.description,
    agent_kind: cfg.agent_kind,
    tasks: tasks
      .filter((t) => referenced.has(t.id))
      .map(({ id, name, description, examples, tier }) => ({ id, name, description, examples, tier })),
    default_offer: defaultOffer,
    grants,
  };
}
```

- [ ] **Step 5: Implement the API client functions**

Append to `packages/cli/src/api.ts` (add `AgentCard, type AgentCardType, type CardUploadType` to the shared import):

```ts
export async function pushCard(
  relay: string, auth: { handle: string; token: string }, upload: CardUploadType,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const res = await relayFetch(
    relay,
    "/v1/card",
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        "X-AgentCall-Handle": auth.handle,
      },
      body: JSON.stringify(upload),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (!res.ok) throw new ApiError(`Card push failed (${res.status}).`, "network");
}

export async function fetchCard(
  relay: string, handle: string, auth?: { handle: string; token: string },
  opts: { timeoutMs?: number } = {},
): Promise<AgentCardType> {
  const headers: Record<string, string> = auth
    ? { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle }
    : {};
  const res = await relayFetch(relay, `/v1/card/${handle}`, { headers }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 404) throw new ApiError(`No card published for "${handle}".`, "unknown_handle");
  if (!res.ok) throw new ApiError(`Card fetch failed (${res.status}).`, "network");
  return AgentCard.parse(await res.json());
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/card.ts packages/cli/src/api.ts packages/cli/test/card.test.ts packages/cli/test/api.test.ts
git commit -m "feat(cli): build card uploads from policy+tasks; push/fetch card API client"
```

---

### Task 10: CLI — listener task resolution and scoped spawn

**Files:**
- Modify: `packages/cli/src/listener.ts`
- Test: `packages/cli/test/listener.test.ts` (append)

**Interfaces:**
- Consumes: `loadPolicy`, `resolveTask` (Task 5); `loadTasks` (Task 4); `buildPrompt(handle, from, message, task)` (Task 8); `runAgent(kind, prompt, p, timeoutMs, specOverride, envelope)` (Task 7); `IncomingCall.task` (Task 1).
- Produces: refusal paths (`blocked` / `task_not_offered` / `task_unknown` / policy-error → `agent_error`) that send `call_failed` **without enqueueing or spawning**; success path passes `task.envelope` and per-task timeout to `run`, sends `call_result` with `task: task.id`, and audits `task` + `status`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/listener.test.ts` (reuse the existing `fakeRelay`/`frames`/`cfg` helpers; add these imports: `mkdirSync`, `writeFileSync` from `node:fs`, and `join`... `join` is already imported):

```ts
function seedPolicy(paths: ReturnType<typeof getPaths>, policy: object) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(paths.policyFile, JSON.stringify(policy));
}

function seedTask(paths: ReturnType<typeof getPaths>, id: string, manifest: object, skill = "do it\n") {
  const dir = join(paths.tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "task.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "SKILL.md"), skill);
}

describe("startListener task resolution", () => {
  it("refuses a blocked caller without spawning, and audits it", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    seedPolicy(paths, { default_offer: ["ask"], callers: { spammer: { block: true } } });
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({ relay: url, config: cfg, paths, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c1", from: "spammer", message: "hi" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c1", code: "blocked" });
    expect(spawned).toBe(false);
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c1", from: "spammer", status: "blocked" });
  });

  it("refuses an ungranted task with the caller's offered menu, without spawning", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    seedTask(paths, "schedule-meeting", { id: "schedule-meeting", name: "S", description: "d" });
    seedPolicy(paths, { default_offer: ["ask"], callers: {} });
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({ relay: url, config: cfg, paths, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c2", from: "stranger", message: "book", task: "schedule-meeting" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c2", code: "task_not_offered", offered: ["ask"] });
    expect(spawned).toBe(false);
  });

  it("runs a granted task with its envelope and timeout, echoing task in call_result", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    seedTask(paths, "schedule-meeting", {
      id: "schedule-meeting", name: "Schedule", description: "d",
      envelope: { tools: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] },
      timeout_s: 60,
    }, "check the calendar\n");
    seedPolicy(paths, { default_offer: ["ask"], callers: { shusaku: { offer: ["schedule-meeting"] } } });
    const seen: { prompt?: string; timeout?: number; envelope?: unknown } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async (_k, prompt, _p, timeoutMs, _spec, envelope) => {
            seen.prompt = prompt; seen.timeout = timeoutMs; seen.envelope = envelope;
            return { text: "booked" };
          },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c3", from: "shusaku", message: "tue?", task: "schedule-meeting" }));
    const [, result] = await expectFrames;
    expect(result).toMatchObject({ type: "call_result", call_id: "c3", text: "booked", task: "schedule-meeting" });
    expect(seen.prompt).toContain("check the calendar");
    expect(seen.timeout).toBe(60_000);
    expect(seen.envelope).toEqual({ caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] });
    const audit = readFileSync(paths.callsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit[0]).toMatchObject({ call_id: "c3", task: "schedule-meeting", status: "ok" });
  });

  it("falls back to the ask task (read-only envelope) for a plain message", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    const seen: { envelope?: unknown } = {};
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({
          relay: url, config: cfg, paths,
          run: async (_k, _prompt, _p, _t, _spec, envelope) => { seen.envelope = envelope; return { text: "hi" }; },
        });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 2);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c4", from: "anyone", message: "q?" }));
    const [, result] = await expectFrames;
    expect(result).toMatchObject({ type: "call_result", task: "ask" });
    expect(seen.envelope).toEqual({ caps: ["read"], write_paths: [], network: [] });
  });

  it("maps a corrupt policy file to call_failed agent_error without spawning", async () => {
    const paths = getPaths(mkdtempSync(join(tmpdir(), "agentcall-l-")));
    mkdirSync(paths.dir, { recursive: true });
    writeFileSync(paths.policyFile, "{corrupt");
    let spawned = false;
    const relayReady = new Promise<WsSocket>((resolveWs) => {
      void fakeRelay((ws) => resolveWs(ws)).then((url) => {
        stopper = startListener({ relay: url, config: cfg, paths, run: async () => { spawned = true; return { text: "x" }; } });
      });
    });
    const ws = await relayReady;
    const expectFrames = frames(ws, 1);
    ws.send(JSON.stringify({ type: "incoming_call", call_id: "c5", from: "a", message: "hi" }));
    const [failed] = await expectFrames;
    expect(failed).toMatchObject({ type: "call_failed", call_id: "c5", code: "agent_error" });
    expect(spawned).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- listener`
Expected: FAIL — no refusal frames (the listener answers everything today); `call_result` has no `task`; envelope/timeout not passed.

- [ ] **Step 3: Implement**

In `packages/cli/src/listener.ts`, add imports:

```ts
import { loadPolicy, resolveTask } from "./policy.js";
import { loadTasks } from "./tasks.js";
```

Replace the body of the `ws.on("message", ...)` handler's post-parse section (from `const { call_id, from, message } = frame;` down to the `if (!accepted)` block) with:

```ts
const { call_id, from, message, task: requestedTask } = frame;
const started = Date.now();
const send = (obj: unknown) => { try { ws?.send(JSON.stringify(obj)); } catch { /* dead */ } };

// Resolve caller -> task -> envelope BEFORE the message is placed in any
// prompt (see policy.ts). Refusals never enqueue and never spawn: no
// tokens are burned by blocked callers or menu probing.
let resolution: ReturnType<typeof resolveTask>;
try {
  resolution = resolveTask(loadPolicy(deps.paths), loadTasks(deps.paths), from, requestedTask);
} catch (e) {
  send({ type: "call_failed", call_id, code: "agent_error", detail: `policy error: ${String(e).slice(0, 300)}` });
  audit({ call_id, from, message: message.slice(0, 500), status: "policy_error", duration_ms: 0 });
  return;
}
if (!resolution.ok) {
  send({ type: "call_failed", call_id, code: resolution.code, offered: resolution.offered });
  audit({ call_id, from, message: message.slice(0, 500), task: requestedTask, status: resolution.code, duration_ms: 0 });
  return;
}
const task = resolution.task;
const timeoutMs = task.timeout_s !== undefined ? task.timeout_s * 1000 : AGENT_TIMEOUT_MS;

const accepted = queue.tryEnqueue(async () => {
  send({ type: "call_answer", call_id });
  try {
    const out = await run(
      deps.config.agent_kind,
      buildPrompt(deps.config.handle, from, message, task),
      deps.paths,
      timeoutMs,
      undefined,
      task.envelope,
    );
    send({ type: "call_result", call_id, text: out.text, session_id: out.session_id, task: task.id });
    audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "ok", duration_ms: Date.now() - started });
  } catch (e) {
    const code = e instanceof AgentRunError ? e.code : "agent_error";
    send({ type: "call_failed", call_id, code, detail: String(e).slice(0, 500) });
    audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: code, duration_ms: Date.now() - started });
  }
});
if (!accepted) {
  send({ type: "call_failed", call_id, code: "busy" });
  audit({ call_id, from, message: message.slice(0, 500), task: task.id, status: "busy", duration_ms: 0 });
}
```

(The existing `const send = ...` line inside the old block is replaced by the one above; keep everything else in the file untouched.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- listener && pnpm typecheck`
Expected: PASS, including the three pre-existing listener tests (no policy file → DEFAULT_POLICY offers `ask`, plain messages fall back to `ask`, so "answers an incoming call" still gets a `call_result` — now with `task: "ask"`, which `toMatchObject` tolerates).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/listener.ts packages/cli/test/listener.test.ts
git commit -m "feat(cli): listener resolves caller policy and task before spawning"
```

---

### Task 11: CLI — caller side: --task flag, offered in errors, card command

**Files:**
- Modify: `packages/cli/src/callClient.ts`, `packages/cli/src/index.ts`
- Test: `packages/cli/test/callClient.test.ts` (append)

**Interfaces:**
- Consumes: `CallError`/`CallReply` `offered`/`task` fields (Task 1); `fetchCard`, `pushCard` (Task 9); `buildCardUpload` (Task 9); `loadPolicy` (Task 5); `loadTasks` (Task 4).
- Produces: `CallOpts.task?: string`; `CallError` class gains `offered?: string[]`; `agentcall call --task <id>`; `agentcall card <target>` where target is `handle@host` (fetch) or `push` (publish own card).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/callClient.test.ts` (reuse its existing fake-relay WebSocket server helper — same pattern as `listener.test.ts`'s `fakeRelay` but for the caller side; adapt names to what the file already uses):

```ts
it("sends the task field in call_request when opts.task is set", async () => {
  // Arrange a fake relay that captures the first frame, then replies.
  let captured: any;
  const url = await fakeRelayCapture((ws, frame) => {
    captured = frame;
    ws.send(JSON.stringify({ type: "call_reply", call_id: "c1", text: "ok", task: frame.task }));
  });
  const reply = await callAgent({ relay: url, from: "bob", token: "t", to: "ken", message: "tue?", task: "schedule-meeting" });
  expect(captured).toMatchObject({ type: "call_request", task: "schedule-meeting" });
  expect(reply.task).toBe("schedule-meeting");
});

it("surfaces offered[] from call_error on the thrown CallError", async () => {
  const url = await fakeRelayCapture((ws) => {
    ws.send(JSON.stringify({ type: "call_error", code: "task_not_offered", offered: ["ask", "owner-introduction"] }));
  });
  const err = await callAgent({ relay: url, from: "bob", token: "t", to: "ken", message: "x", task: "deploy" })
    .then(() => null, (e) => e);
  expect(err.code).toBe("task_not_offered");
  expect(err.offered).toEqual(["ask", "owner-introduction"]);
  expect(err.message).toContain("ask");
});
```

Where `fakeRelayCapture(handler)` is a small helper: start an `http` server + `WebSocketServer` on `/v1/ws`, and on each connection `ws.on("message", (raw) => handler(ws, JSON.parse(String(raw))))` (skip `"ping"` strings). If `callClient.test.ts` already has an equivalent helper, use it instead of adding a new one.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- callClient`
Expected: FAIL — `task` missing from the captured `call_request`; `err.offered` undefined.

- [ ] **Step 3: Implement callClient changes**

In `packages/cli/src/callClient.ts`:

1. `CallError` gains `offered`:

```ts
export class CallError extends Error {
  constructor(message: string, public code: ErrorCodeType | "connection_failed", public offered?: string[]) {
    super(message);
  }
}
```

2. Add the new human messages to `HUMAN`:

```ts
blocked: "This agent's owner has blocked calls from your handle.",
task_not_offered: "That task isn't offered to you.",
task_unknown: "That task doesn't exist on this agent.",
```

3. `CallOpts` gains `task?: string;` and the `call_request` send includes it:

```ts
ws.send(JSON.stringify({ type: "call_request", to: opts.to, message: opts.message, session_id: opts.sessionId, task: opts.task }));
```

4. The `call_error` branch appends the offered menu to the message and threads it through:

```ts
else if (frame.type === "call_error") {
  const base = frame.detail ?? HUMAN[frame.code] ?? frame.code;
  const msg = frame.offered?.length ? `${base} Tasks offered to you: ${frame.offered.join(", ")}` : base;
  finish(() => reject(new CallError(msg, frame.code, frame.offered)));
}
```

- [ ] **Step 4: Wire the CLI commands**

In `packages/cli/src/index.ts`:

1. `call` gains the flag and passes it through:

```ts
.option("--task <id>", "task from the callee's card to perform (see: agentcall card <address>)")
```

and in the action, add `task: o.task,` to the `callAgent({...})` options (and `task?: string` to the action's options type).

2. Add the `card` command after `status`:

```ts
program
  .command("card")
  .description("show an agent's task menu, or publish your own (agentcall card push)")
  .argument("<target>", "handle@host to fetch, or 'push' to publish your card")
  .action(async (target: string) => {
    const paths = getPaths();
    if (target === "push") {
      const cfg = loadConfig(paths);
      const { loadPolicy } = await import("./policy.js");
      const { loadTasks } = await import("./tasks.js");
      const { buildCardUpload } = await import("./card.js");
      const { pushCard } = await import("./api.js");
      await pushCard(relayUrl(cfg), { handle: cfg.handle, token: cfg.token }, buildCardUpload(cfg, loadPolicy(paths), loadTasks(paths)));
      console.log("Card published.");
      return;
    }
    const parsed = parseAddress(target);
    if (!parsed) {
      console.error(`Invalid address: ${target} (expected handle@host, or 'push')`);
      process.exitCode = 1;
      return;
    }
    const { fetchCard } = await import("./api.js");
    let cfg;
    try { cfg = loadConfig(paths); } catch { cfg = undefined; }
    try {
      const card = await fetchCard(
        cfg ? relayUrl(cfg) : relayUrl(undefined),
        parsed.handle,
        cfg ? { handle: cfg.handle, token: cfg.token } : undefined,
      );
      console.log(`${card.handle} (${card.agent_kind})${card.description ? ` — ${card.description}` : ""}`);
      for (const t of card.tasks) {
        console.log(`  ${t.id} [${t.tier}] — ${t.description}`);
        for (const ex of t.examples) console.log(`      e.g. ${ex}`);
      }
      console.log(`\nCall with: agentcall call ${target} --task <id> "<message>"`);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });
```

(Use static top-of-file imports instead of dynamic `await import(...)` if preferred — match the file's existing style, which imports statically; static imports of `loadPolicy`, `loadTasks`, `buildCardUpload`, `pushCard`, `fetchCard` at the top are the cleaner choice.)

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS. (index.ts has no unit tests — the build + typecheck gate it; callClient tests cover the protocol behavior.)

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/callClient.ts packages/cli/src/index.ts packages/cli/test/callClient.test.ts
git commit -m "feat(cli): call --task, offered-menu errors, and agentcall card command"
```

---

### Task 12: CLI — setup seeds policy + tasks dir and publishes the card

**Files:**
- Modify: `packages/cli/src/setup.ts`
- Test: `packages/cli/test/setup.test.ts` (append)

**Interfaces:**
- Consumes: `DEFAULT_POLICY`, `loadPolicy` (Task 5); `loadTasks` (Task 4); `buildCardUpload`, `pushCard` (Task 9); `Paths.tasksDir`/`policyFile` (Task 4).
- Produces: after `runSetup`, `~/.agentcall/policy.json` exists (DEFAULT_POLICY, only if missing), `~/AgentCall/tasks/` exists, and the card was PUT to the relay (best-effort: failures warn, never abort setup).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/setup.test.ts` inside the `runSetup` describe block. The existing `fakeRelay` helper answers every request with the register payload, which also satisfies the card PUT (200 + JSON body) — extend a new local server to record requests:

```ts
function fakeRelayRecording(requests: { method?: string; url?: string; body?: string }[]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "tok-123", address: "ken@agentcall.benree.tech", ok: true }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}

it("seeds policy.json + tasks dir and publishes the card", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  try {
    const requests: { method?: string; url?: string; body?: string }[] = [];
    const relay = await fakeRelayRecording(requests);
    await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
    const p = getPaths(home);
    expect(existsSync(p.tasksDir)).toBe(true);
    const policy = JSON.parse(readFileSync(p.policyFile, "utf8"));
    expect(policy.default_offer).toEqual(["ask"]);
    const cardPut = requests.find((r) => r.method === "PUT" && r.url === "/v1/card");
    expect(cardPut).toBeDefined();
    expect(JSON.parse(cardPut!.body!)).toMatchObject({ agent_kind: "claude", default_offer: ["ask"] });
  } finally {
    delete process.env.AGENTCALL_HOME;
  }
});

it("does not overwrite an existing policy.json on re-run", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
  process.env.AGENTCALL_HOME = home;
  try {
    const relay = await fakeRelay();
    await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
    const p = getPaths(home);
    const custom = { description: "custom", default_offer: ["ask"], callers: { mia: { offer: ["x"], block: false } } };
    writeFileSync(p.policyFile, JSON.stringify(custom));
    await runSetup({ handle: "ken", agent: "claude", relay, snippet: false, skipLaunchd: true });
    expect(JSON.parse(readFileSync(p.policyFile, "utf8"))).toEqual(custom);
  } finally {
    delete process.env.AGENTCALL_HOME;
  }
});
```

(`writeFileSync` must be added to the test file's `node:fs` import.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- setup`
Expected: FAIL — no `policy.json`, no tasks dir, no PUT to `/v1/card`.

- [ ] **Step 3: Implement**

In `packages/cli/src/setup.ts`:

1. Extend imports: add `existsSync` to the `node:fs` import; add:

```ts
import { pushCard } from "./api.js";
import { buildCardUpload } from "./card.js";
import { DEFAULT_POLICY, loadPolicy } from "./policy.js";
import { loadTasks } from "./tasks.js";
```

(`registerHandle` is already imported from `./api.js` — merge into that import.)

2. After the `mkdirSync(paths.publicDir, { recursive: true });` line, add:

```ts
mkdirSync(paths.tasksDir, { recursive: true });
if (!existsSync(paths.policyFile)) {
  writeFileSync(paths.policyFile, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n");
}

// Publish the agent card (task menu) to the relay so callers can discover
// what this agent offers before calling. Best-effort: a relay hiccup here
// must not abort setup — `agentcall card push` re-publishes any time.
try {
  await pushCard(
    relayUrl(cfg),
    { handle: cfg.handle, token: cfg.token },
    buildCardUpload(cfg, loadPolicy(paths), loadTasks(paths)),
  );
} catch (e) {
  console.error(`Warning: could not publish the agent card (${String(e)}). Run \`agentcall card push\` later.`);
}
```

(`relayUrl` is already imported from `./config.js`.)

- [ ] **Step 4: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test -- setup && pnpm typecheck`
Expected: PASS, including all pre-existing setup tests. (`fakeRelay` 200s the card PUT; `fakeRelay409` makes `pushCard` throw, which the try/catch downgrades to a warning — the reuse test still passes.)

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): setup seeds policy + tasks dir and publishes the agent card"
```

---

### Task 13: Full verification and manual e2e checklist

**Files:**
- Modify: none expected (fixes only if verification fails)

- [ ] **Step 1: Full repo gate**

Run (from repo root): `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all three PASS for all three packages. Fix anything that fails before proceeding.

- [ ] **Step 2: Spec cross-check**

Re-read `docs/superpowers/specs/2026-07-16-task-menu-capabilities-design.md` Phase 1 bullet ("Manifests, policy.json, card push/fetch, `task` field, task-scoped envelopes, structured refusals, built-in `ask`") and confirm each item maps to a merged task above. Confirm no Phase 2/3 feature (dispatcher, T2 approval gating) crept in.

- [ ] **Step 3: Manual e2e (cannot be automated — no live agent spawn in CI)**

Record results in the PR/commit message; these verify the two behaviors unit tests cannot: real `claude -p` accepting the new flags, and srt enforcing the envelope.

1. `agentcall setup` on this machine (reuse path) → confirm `~/.agentcall/policy.json` seeded, card push warning-free.
2. `agentcall card <own-address>` → menu shows `ask`.
3. Create a real task dir (e.g. `owner-introduction` with `envelope: { tools: ["read"] }`), `agentcall card push`, re-fetch → menu shows both.
4. From a second registered handle: `agentcall call <address> --task owner-introduction "who are you?"` → reply arrives, `~/.agentcall/calls.log` shows `task: "owner-introduction"`.
5. `agentcall call <address> --task schedule-meeting "..."` (ungranted/unknown) → structured refusal with the offered menu, and `calls.log` shows no spawn.
6. **Flag check (spec open question 4 spike):** confirm the installed `claude` version accepts `--permission-mode dontAsk --allowedTools ...` under `-p` (step 4 exercises it end-to-end). If the installed claude rejects `dontAsk`, file the fallback: use `--disallowedTools` derived from the complement of the envelope instead — do not silently drop enforcement.
7. **Envelope check:** with a read-only task, ask the agent to write a file into the public dir → the write must fail (denied by both allowedTools and srt).

- [ ] **Step 4: Commit any verification fixes**

```bash
git add <specific files touched>
git commit -m "fix: <what the full-repo gate or e2e surfaced>"
```

## Self-Review (completed at plan-writing time)

- **Spec coverage:** manifests (T4), policy (T5), card schemas/push/fetch (T1/T2/T9), task field + refusal codes (T1/T3), envelopes → srt (T6) and spawn flags (T7), prompt embedding (T8), listener refusals-without-spawn + audit (T10), `--task` + `card` CLI (T11), setup seeding (T12), tier carried but not gated (T1/T4 — Phase 3 gating explicitly out).
- **Type consistency:** `Envelope {caps, write_paths, network}` (manifest `tools` maps to `caps` in `loadTasks`); `runAgent(kind, prompt, p, timeoutMs, specOverride, envelope)`; `resolveTask(policy, tasks, from, requested?)`; `buildPrompt(handle, from, message, task?)`; `buildCardUpload(cfg, policy, tasks)` — verified consistent across tasks.
- **Known intentional deviations from spec text:** `offer` entries are additive with or without the `+` prefix (prefix stripped — simpler, spec syntax still accepted); relay stores the full grants map (relay already sees all message plaintext, so this leaks nothing new — noted in spec's security model).
