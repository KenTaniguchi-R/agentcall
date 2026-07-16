# Caller-only Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user register a handle and call other agents without exposing their own machine — no agent binary, no launchd listener, no srt.json.

**Architecture:** "Caller-only" is represented as an *absent* `agent_kind` end-to-end: optional in the shared `RegisterRequest` zod schema, nullable in the relay's D1 `handles` table, optional in the CLI's `Config`. Setup decides callable-vs-caller-only before agent detection; everything listener-related is gated on `cfg.agent_kind`. Spec: `docs/superpowers/specs/2026-07-16-caller-only-mode-design.md`.

**Tech Stack:** TypeScript ESM, pnpm workspace, zod 4, Hono on Cloudflare Workers (D1, Durable Objects), vitest (`@cloudflare/vitest-pool-workers` in apps/relay), commander in packages/cli.

## Global Constraints

- TDD: write the failing test, run it to see it fail, implement, run to see it pass, commit. Every task.
- `pnpm -r test && pnpm -r typecheck && pnpm -r build` must pass at the repo root before the work is called done.
- Stage files explicitly (`git add <file> <file>`) — never `git add -A` or `git add .`.
- Protocol shapes change in `packages/shared` first; relay and CLI import from `@benree/agentcall-shared`, never duplicate schemas.
- `apps/relay` and `packages/cli` resolve `@benree/agentcall-shared` from its `dist/` — after editing `packages/shared/src`, run `pnpm --filter @benree/agentcall-shared build` before running dependent packages' tests.
- No live `claude`/`codex` spawn in tests — CLI tests use `hasBin`/`resolveBin`/`io`/`installLaunchAgentFn` seams and fake HTTP relays.
- Rollout order (documented, executed by the user): deploy the relay (including the D1 migration) **before** publishing the CLI — the old relay rejects a register request missing `agent_kind`.

---

### Task 1: shared — `RegisterRequest.agent_kind` becomes optional

**Files:**
- Modify: `packages/shared/src/protocol.ts:66-69`
- Test: `packages/shared/test/protocol.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `RegisterRequest` zod schema that parses `{ handle }` with no `agent_kind`; `RegisterRequestType.agent_kind` becomes `"claude" | "codex" | undefined`. Tasks 2 and 3 rely on this.

- [ ] **Step 1: Write the failing test**

Add to the `describe("frames", ...)` block-level scope of `packages/shared/test/protocol.test.ts` (as a new top-level describe), importing `RegisterRequest` from `../src/index.js` (add it to the existing import list):

```ts
describe("RegisterRequest", () => {
  it("parses with and without agent_kind (absent = caller-only)", () => {
    expect(RegisterRequest.parse({ handle: "ken", agent_kind: "claude" }))
      .toEqual({ handle: "ken", agent_kind: "claude" });
    expect(RegisterRequest.parse({ handle: "solo" })).toEqual({ handle: "solo" });
  });
  it("still rejects invalid agent kinds", () => {
    expect(RegisterRequest.safeParse({ handle: "ken", agent_kind: "vim" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm test`
Expected: FAIL — `parses with and without agent_kind` throws a ZodError on `{ handle: "solo" }` (agent_kind required).

- [ ] **Step 3: Write minimal implementation**

In `packages/shared/src/protocol.ts`, change the `RegisterRequest` schema:

```ts
export const RegisterRequest = z.object({
  handle: z.string().regex(HANDLE_RE),
  // Absent = caller-only: the handle can call others but is not callable.
  agent_kind: z.enum(["claude", "codex"]).optional(),
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/shared && pnpm test && pnpm typecheck && pnpm build`
Expected: all PASS (the build also refreshes `dist/` for tasks 2-3).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/test/protocol.test.ts
git commit -m "feat(shared): make RegisterRequest.agent_kind optional for caller-only handles"
```

---

### Task 2: relay — nullable `agent_kind` column + register accepts caller-only

**Files:**
- Create: `apps/relay/migrations/0002_agent_kind_nullable.sql`
- Modify: `apps/relay/src/index.ts:28`
- Test: `apps/relay/test/register.test.ts`, `apps/relay/test/ws.test.ts`

**Interfaces:**
- Consumes: Task 1's optional `RegisterRequest.agent_kind` (rebuild shared first if not done: `pnpm --filter @benree/agentcall-shared build`).
- Produces: `POST /v1/register` accepts `{ handle }` alone and stores `agent_kind = NULL`; caller-only handles authenticate on `/v1/ws?role=call` exactly like full ones. No relay API shape changes.

- [ ] **Step 1: Write the failing tests**

In `apps/relay/test/register.test.ts`, add `env` to the `cloudflare:test` import (`import { env, SELF } from "cloudflare:test";`) and add inside `describe("POST /v1/register", ...)`:

```ts
it("registers caller-only (no agent_kind) and stores NULL", async () => {
  const res = await register({ handle: "solo" });
  expect(res.status).toBe(200);
  const json = await res.json<{ token: string; address: string }>();
  expect(json.token.length).toBeGreaterThanOrEqual(40);
  expect(json.address).toBe("solo@agentcall.benree.tech");
  const row = await env.DB.prepare("SELECT agent_kind FROM handles WHERE handle = ?")
    .bind("solo").first<{ agent_kind: string | null }>();
  expect(row?.agent_kind).toBeNull();
});
it("409s a duplicate caller-only handle", async () => {
  await register({ handle: "solo-dup" });
  expect((await register({ handle: "solo-dup" })).status).toBe(409);
});
```

In `apps/relay/test/ws.test.ts`, add (uses existing helpers `registerHandle`, `wsAuth`, `openWs`, `nextFrame` — extend the import from `./helpers.js` with `nextFrame`):

```ts
it("a caller-only handle can authenticate and place a call", async () => {
  // Callee: a normal, callable registration with a listener attached.
  const hostToken = await registerHandle("host1");
  const listener = await openWs("/v1/ws?role=listen", wsAuth("host1", hostToken));
  const incoming = nextFrame(listener);

  // Caller: registered with no agent_kind at all.
  const res = await SELF.fetch("https://relay.test/v1/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "solo2" }),
  });
  expect(res.status).toBe(200);
  const { token } = await res.json<{ token: string }>();

  const caller = await openWs("/v1/ws?role=call&to=host1", wsAuth("solo2", token));
  caller.send(JSON.stringify({ type: "call_request", to: "host1", message: "hi" }));
  const frame = await incoming;
  expect(frame.type).toBe("incoming_call");
  expect(frame.from).toBe("solo2");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/relay && pnpm test`
Expected: FAIL — with Task 1's shared build in place the schema accepts `{ handle }`, but the D1 `NOT NULL` constraint makes the INSERT throw, which the handler maps to a 409 "handle taken". All three new tests fail (status 409 instead of 200/101).

- [ ] **Step 3: Write minimal implementation**

Create `apps/relay/migrations/0002_agent_kind_nullable.sql` (SQLite can't drop a NOT NULL/CHECK in place, so rebuild the table):

```sql
-- Caller-only handles register without an agent_kind; make the column nullable.
CREATE TABLE handles_new (
  handle TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  agent_kind TEXT CHECK (agent_kind IN ('claude','codex')),
  created_at INTEGER NOT NULL
);
INSERT INTO handles_new SELECT handle, token_hash, agent_kind, created_at FROM handles;
DROP TABLE handles;
ALTER TABLE handles_new RENAME TO handles;
```

In `apps/relay/src/index.ts`, change the INSERT bind (line 28) to pass NULL through:

```ts
    ).bind(handle, await sha256Hex(token), agent_kind ?? null, Date.now()).run();
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/relay && pnpm test && pnpm typecheck`
Expected: all PASS (the vitest pool applies migrations from `./migrations` automatically).

- [ ] **Step 5: Commit**

```bash
git add apps/relay/migrations/0002_agent_kind_nullable.sql apps/relay/src/index.ts apps/relay/test/register.test.ts apps/relay/test/ws.test.ts
git commit -m "feat(relay): accept caller-only registrations (nullable agent_kind)"
```

---

### Task 3: cli — optional `Config.agent_kind`, `assertCallableConfig`, listen guard, optional register param

**Files:**
- Modify: `packages/cli/src/config.ts`, `packages/cli/src/api.ts:40-42`, `packages/cli/src/listener.ts:13-20`, `packages/cli/src/index.ts:94-112`, `packages/cli/src/setup.ts:148-194` (interim type narrowing only)
- Test: `packages/cli/test/config.test.ts`, `packages/cli/test/api.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (wire change is additive).
- Produces (Tasks 4-6 rely on these exact names):
  - `Config.agent_kind?: "claude" | "codex"` (now optional)
  - `type CallableConfig = Config & { agent_kind: "claude" | "codex" }` and `function assertCallableConfig(cfg: Config): asserts cfg is CallableConfig` in `config.ts`
  - `registerHandle(relay: string, handle: string, agentKind?: "claude" | "codex", opts?: { timeoutMs?: number })` — omits `agent_kind` from the request body when undefined
  - `ListenerDeps.config: CallableConfig`

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/config.test.ts`, extend the config import (`import { loadConfig, saveConfig, relayUrl, assertCallableConfig } from "../src/config.js";`) and add inside `describe("config", ...)`:

```ts
  it("round-trips a caller-only config (no agent_kind)", () => {
    const p = getPaths(tempHome());
    const cfg = { handle: "solo", token: "t".repeat(43), relay: "https://agentcall.benree.tech" };
    saveConfig(p, cfg);
    expect(loadConfig(p)).toEqual(cfg);
    expect(loadConfig(p).agent_kind).toBeUndefined();
  });
  it("assertCallableConfig passes a full config and rejects caller-only", () => {
    const full = { handle: "k", token: "t", agent_kind: "claude" as const, relay: "https://x.y" };
    expect(() => assertCallableConfig(full)).not.toThrow();
    expect(() => assertCallableConfig({ handle: "k", token: "t", relay: "https://x.y" }))
      .toThrow(/caller-only.*agentcall setup/);
  });
```

In `packages/cli/test/api.test.ts`, add a body-capturing server helper after the existing `serve` function, and a test inside `describe("api client", ...)`:

```ts
function serveCapturing(status: number, body: unknown, captured: unknown[]): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d) => (raw += d));
      req.on("end", () => {
        captured.push(JSON.parse(raw));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}
```

```ts
  it("registers caller-only: omits agent_kind from the request body entirely", async () => {
    const captured: unknown[] = [];
    const relay = await serveCapturing(200, { token: "tok", address: "solo@agentcall.benree.tech" }, captured);
    expect(await registerHandle(relay, "solo")).toEqual({ token: "tok", address: "solo@agentcall.benree.tech" });
    expect(captured).toEqual([{ handle: "solo" }]);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && pnpm test`
Expected: FAIL — `assertCallableConfig` doesn't exist (import error in config.test.ts); the api test fails to compile/type (`registerHandle` requires a third argument). The caller-only round-trip test also fails typecheck (`agent_kind` required in `Config`).

- [ ] **Step 3: Write minimal implementation**

`packages/cli/src/config.ts` — make `agent_kind` optional and add the guard:

```ts
export interface Config {
  handle: string;
  token: string;
  // Absent = caller-only: this install can call others but is not callable.
  agent_kind?: "claude" | "codex";
  relay: string;
}

export type CallableConfig = Config & { agent_kind: "claude" | "codex" };

// Guards commands that spawn the local agent: a caller-only install has no
// agent_kind and cannot answer calls.
export function assertCallableConfig(cfg: Config): asserts cfg is CallableConfig {
  if (!cfg.agent_kind) {
    throw new Error("This install is caller-only — re-run `agentcall setup` to make your agent callable.");
  }
}
```

`packages/cli/src/api.ts` — make the parameter optional (body construction is already correct: `JSON.stringify` drops an undefined `agent_kind` key):

```ts
export async function registerHandle(
  relay: string, handle: string, agentKind?: "claude" | "codex", opts: { timeoutMs?: number } = {},
): Promise<{ token: string; address: string }> {
```

`packages/cli/src/listener.ts` — require a callable config at the type level. Change the import and `ListenerDeps`:

```ts
import type { CallableConfig } from "./config.js";
```

```ts
export interface ListenerDeps {
  relay: string;
  config: CallableConfig;
  paths: Paths;
  run?: typeof runAgent;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
}
```

`packages/cli/src/index.ts` — guard the `listen` command before `startListener` (add `assertCallableConfig` to the config import):

```ts
  .action(() => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    assertCallableConfig(cfg);
    console.log(`agentcall listener starting for ${cfg.handle} -> ${relayUrl(cfg)}`);
    const l = startListener({ relay: relayUrl(cfg), config: cfg, paths });
```

(The rest of the action body is unchanged.)

`packages/cli/src/setup.ts` — the optional `Config.agent_kind` breaks typecheck at four call sites (`warnIfOutsideLaunchdPath`, `toolchainReadDirs`, `srtSettings`, `resolveExtraPathDirs` all require a defined kind). Behavior must not change in this task — no caller-only config can exist yet — so narrow the types without touching logic. Task 4 replaces all of this in its restructure.

Change the `agentKind` assignment (line 148-149) so its type stays `"claude" | "codex"`:

```ts
  const agentKind =
    (canReuse && existingCfg ? existingCfg.agent_kind : undefined) ??
    (await detectAgentKind(opts, hasBinFn, ask));
```

After the `if (canReuse && existingCfg) { ... } else { ... }` branch, define a narrowed kind and use it in place of `cfg.agent_kind` in the srt-seeding block (lines 186, 190) and the launchd block (line 194):

```ts
  // cfg.agent_kind is always set at this point (no caller-only configs exist
  // yet); this local narrows the optional field for the calls below.
  const kind = cfg.agent_kind ?? agentKind;
```

```ts
    extraReadDirs = toolchainReadDirs(kind);
```

```ts
  writeFileSync(paths.srtFile, JSON.stringify(srtSettings(paths, kind, extraReadDirs), null, 2) + "\n");
```

```ts
    const extraPathDirs = resolveExtraPathDirs([kind, "npx"], resolveBinFn);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm test && pnpm typecheck`
Expected: all PASS, including every pre-existing setup test (the narrowing is behavior-neutral).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/config.ts packages/cli/src/api.ts packages/cli/src/listener.ts packages/cli/src/index.ts packages/cli/src/setup.ts packages/cli/test/config.test.ts packages/cli/test/api.test.ts
git commit -m "feat(cli): represent caller-only configs (optional agent_kind) and guard listen"
```

---

### Task 4: cli — caller-only setup path via `--caller-only`

**Files:**
- Modify: `packages/cli/src/setup.ts` (`SetupOpts`, `runSetup`, new `decideCallable`), `packages/cli/src/index.ts:16-31`
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: `registerHandle(relay, handle, agentKind?)`, optional `Config.agent_kind` (Task 3).
- Produces: `SetupOpts.callerOnly?: boolean`; `runSetup` gates agent detection, PATH warnings, srt.json, publicDir, and launchd on the callable decision; `decideCallable(opts): Promise<boolean>` (expanded in Task 5 to `decideCallable(opts, hasBin, ask, reusedCfg)` — Task 5/6 rewrite it, nothing else consumes it).

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/setup.test.ts`, first make `fakeRelay` capture request bodies. Replace the existing `fakeRelay` function with:

```ts
const registerBodies: unknown[] = [];
function fakeRelay(): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const parsed = JSON.parse(body);
        registerBodies.push(parsed);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "tok-123", address: `${parsed.handle}@agentcall.benree.tech` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });
}
```

Then add a new describe block:

```ts
describe("caller-only setup", () => {
  it("--caller-only registers without agent_kind and skips srt/publicDir/launchd", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      registerBodies.length = 0;
      let launchdCalled = false;
      await runSetup({
        handle: "solo",
        callerOnly: true,
        relay,
        snippet: false,
        hasBin: () => false, // no agent installed at all
        installLaunchAgentFn: () => { launchdCalled = true; },
      });
      expect(registerBodies).toEqual([{ handle: "solo" }]);
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg).toEqual({ handle: "solo", token: "tok-123", relay });
      expect(existsSync(p.srtFile)).toBe(false);
      expect(existsSync(p.publicDir)).toBe(false);
      expect(launchdCalled).toBe(false);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("prints a caller-only summary with an upgrade hint instead of 'share your address'", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "solo2", callerOnly: true, relay, snippet: false, hasBin: () => false });
      const summary = logs.join("\n");
      expect(summary).toContain("caller-only");
      expect(summary).toContain("agentcall setup");
      expect(summary).not.toContain("Share your address");
    } finally {
      spy.mockRestore();
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("re-running --caller-only setup reuses the config, asks nothing, stays caller-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "solo3", callerOnly: true, relay, snippet: false, hasBin: () => false });
      const p = getPaths(home);
      const firstCfg = JSON.parse(readFileSync(p.configFile, "utf8"));

      const badRelay = await fakeRelay409();
      const asked: string[] = [];
      await runSetup({
        callerOnly: true,
        relay: badRelay,
        snippet: false,
        hasBin: () => false,
        io: { ask: async (q) => { asked.push(q); return ""; } },
      });
      expect(asked).toEqual([]);
      expect(JSON.parse(readFileSync(p.configFile, "utf8"))).toEqual(firstCfg);
      expect(existsSync(p.srtFile)).toBe(false);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && pnpm test`
Expected: FAIL — `SetupOpts` has no `callerOnly` (TS error), and `runSetup` would run agent detection (`hasBin: () => false` → "Neither `claude` nor `codex` was found" throw).

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/setup.ts`:

Add to `SetupOpts`:

```ts
  callerOnly?: boolean;
```

Add above `runSetup` (Task 5 expands this — keep the single-arg shape for now):

```ts
// Whether this install should answer calls (run the listener). Task-5 of the
// caller-only plan expands this decision with agent detection and a prompt.
function decideCallable(opts: SetupOpts): boolean {
  return !opts.callerOnly;
}
```

Restructure `runSetup` — full replacement body (this is the shape Tasks 5-6 build on):

```ts
export async function runSetup(opts: SetupOpts): Promise<void> {
  const paths: Paths = getPaths();
  const hasBinFn = opts.hasBin ?? ((name) => (opts.resolveBin ?? defaultResolveBin)(name) !== null);
  const resolveBinFn = opts.resolveBin ?? defaultResolveBin;
  const ask = opts.io?.ask ?? ttyAsk;

  // Idempotency: a re-run against an already-registered handle used to
  // always POST /v1/register, which the relay correctly 409s (the handle is
  // taken — by this same install) — aborting setup even though a valid
  // token already sits in config.json. If a usable config already exists
  // for the handle we'd otherwise register, skip registration entirely and
  // just re-do the local steps below, which are all idempotent anyway.
  let existingCfg: Config | undefined;
  try {
    existingCfg = loadConfig(paths);
  } catch {
    existingCfg = undefined;
  }
  const reusedCfg =
    existingCfg !== undefined && (!opts.handle || opts.handle === existingCfg.handle) ? existingCfg : undefined;

  const callable = decideCallable(opts);

  // On reuse the saved agent_kind is what actually gets spawned (see
  // listener.ts), so skip detection entirely — it may prompt ("Which should
  // agentcall use?") and its answer would be ignored anyway.
  let agentKind: "claude" | "codex" | undefined;
  if (callable) {
    agentKind = reusedCfg?.agent_kind ?? (await detectAgentKind(opts, hasBinFn, ask));
    warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
    warnIfOutsideLaunchdPath("npx", resolveBinFn);
  }

  let cfg: Config;
  let address: string;
  if (reusedCfg) {
    cfg = reusedCfg;
    address = addressFromConfig(cfg);
    console.log(`Reusing existing registration for ${cfg.handle}`);
  } else {
    const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
    if (!handle) throw new Error("A handle is required.");

    const relay = (opts.relay ?? relayUrl()).replace(/\/+$/, "");

    console.log(`Registering ${handle} with ${relay} ...`);
    const { token, address: registeredAddress } = await registerHandle(relay, handle, agentKind);
    cfg = agentKind ? { handle, token, agent_kind: agentKind, relay } : { handle, token, relay };
    address = registeredAddress;
    saveConfig(paths, cfg);
  }

  // Everything below the config is listener-side machinery; a caller-only
  // install (no agent_kind) needs none of it.
  if (cfg.agent_kind) {
    // Seed srt.json with the current toolchain's read dirs (see srt.ts's
    // toolchainReadDirs) so the sandboxed agent can execute node/npx/itself
    // from first call, not just after runAgent's first real spawn rewrites
    // it. If resolution throws (an odd PATH during setup), fall back to the
    // base allowlist rather than failing setup outright — runAgent rewrites
    // srt.json before every real spawn anyway, so this only affects the
    // file's content between `setup` and the first real call.
    let extraReadDirs: string[] = [];
    try {
      extraReadDirs = toolchainReadDirs(cfg.agent_kind);
    } catch {
      /* fall back to srtSettings(paths, cfg.agent_kind) below */
    }
    writeFileSync(paths.srtFile, JSON.stringify(srtSettings(paths, cfg.agent_kind, extraReadDirs), null, 2) + "\n");
    mkdirSync(paths.publicDir, { recursive: true });

    if (!opts.skipLaunchd) {
      const extraPathDirs = resolveExtraPathDirs([cfg.agent_kind, "npx"], resolveBinFn);
      (opts.installLaunchAgentFn ?? installLaunchAgent)(paths, undefined, extraPathDirs);
    }
  }

  if (opts.snippet !== false) {
    appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
    appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
  }

  if (cfg.agent_kind) {
    console.log(
      `\nagentcall is set up.\n` +
        `  Handle:  ${cfg.handle}\n` +
        `  Agent:   ${cfg.agent_kind}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n\n` +
        `Share your address so others can call your agent:\n` +
        `  agentcall call ${address} "hello"\n`,
    );
  } else {
    console.log(
      `\nagentcall is set up (caller-only).\n` +
        `  Handle:  ${cfg.handle}\n` +
        `  Relay:   ${cfg.relay}\n` +
        `  Address: ${address}\n\n` +
        `You can call other agents:\n` +
        `  agentcall call ken@agentcall.benree.tech "hello"\n\n` +
        `To make your own agent callable later, install claude or codex and re-run \`agentcall setup\`.\n`,
    );
  }
}
```

Note: the original `agent_kind`-vs-`agentKind` reuse comment (lines 180-183 of the old file) is superseded by `reusedCfg?.agent_kind ?? ...` above; the `canReuse` variable is renamed to the `reusedCfg` value. This also removes any temporary narrowing added in Task 4's sibling call sites during Task 3.

In `packages/cli/src/index.ts`, wire the flag on the `setup` command:

```ts
  .option("--caller-only", "register a handle to call others without making your own agent callable")
```

and pass it through in the action:

```ts
    await runSetup({
      handle: o.handle,
      agent: o.agent as "claude" | "codex" | undefined,
      relay: o.relay,
      snippet: o.snippet,
      skipLaunchd: o.skipLaunchd,
      callerOnly: o.callerOnly,
    });
```

(with `callerOnly?: boolean` added to the action's options type).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm test && pnpm typecheck`
Expected: all PASS, including every pre-existing setup test (full-mode flows are unchanged: `agent: "claude"` short-circuits detection, reuse of a full config asks nothing).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/src/index.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): add --caller-only setup that skips listener machinery"
```

---

### Task 5: cli — interactive callable prompt + no-agent fallback

**Files:**
- Modify: `packages/cli/src/setup.ts` (`decideCallable`, its call site)
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: Task 4's `runSetup` structure and `SetupOpts.callerOnly`.
- Produces: `decideCallable(opts: SetupOpts, hasBin: (name: string) => boolean, ask: (q: string) => Promise<string>, reusedCfg: Config | undefined): Promise<boolean>` — final signature; Task 6 relies on the `reusedCfg` parameter.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/setup.test.ts`:

**Replace** the existing test `"throws a friendly error when neither agent is found"` with:

```ts
  it("falls back to caller-only with a notice when neither agent is found", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    try {
      const relay = await fakeRelay();
      let launchdCalled = false;
      await runSetup({
        handle: "ken3",
        relay,
        snippet: false,
        hasBin: () => false,
        installLaunchAgentFn: () => { launchdCalled = true; },
      });
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg.agent_kind).toBeUndefined();
      expect(launchdCalled).toBe(false);
      expect(logs.some((l) => l.includes("caller-only"))).toBe(true);
    } finally {
      spy.mockRestore();
      delete process.env.AGENTCALL_HOME;
    }
  });
```

**Update** the existing test `"detects the agent kind via injectable hasBin when --agent is omitted"` — it now hits the callable prompt, so give it an `io` seam answering yes:

```ts
      await runSetup({
        handle: "ken2",
        relay,
        snippet: false,
        skipLaunchd: true,
        hasBin: (name) => name === "codex",
        io: { ask: async () => "y" },
      });
```

(assertion unchanged: `cfg.agent_kind` is `"codex"`).

**Add** to the `describe("caller-only setup", ...)` block:

```ts
  it("asks 'Make your agent callable' and answering n yields caller-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      const asked: string[] = [];
      let launchdCalled = false;
      await runSetup({
        handle: "asker",
        relay,
        snippet: false,
        hasBin: () => true, // agents ARE installed; user still opts out
        io: { ask: async (q) => { asked.push(q); return "n"; } },
        installLaunchAgentFn: () => { launchdCalled = true; },
      });
      expect(asked.some((q) => q.includes("callable"))).toBe(true);
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg.agent_kind).toBeUndefined();
      expect(existsSync(p.srtFile)).toBe(false);
      expect(launchdCalled).toBe(false);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("an empty answer defaults to callable", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({
        handle: "defaulter",
        relay,
        snippet: false,
        skipLaunchd: true,
        hasBin: (name) => name === "claude",
        io: { ask: async () => "" },
      });
      const p = getPaths(home);
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg.agent_kind).toBe("claude");
      expect(existsSync(p.srtFile)).toBe(true);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && pnpm test`
Expected: FAIL — no-agent fallback still throws; the two prompt tests find no "callable" question (setup never asks) and `cfg.agent_kind` is set.

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/setup.ts`, replace `decideCallable` with the final version:

```ts
// Whether this install should answer calls (run the listener) or stay
// caller-only. Precedence: explicit --caller-only > a reused config that is
// already callable > explicit --agent > no agent binary on PATH (fall back
// to caller-only instead of failing setup) > --yes > ask.
async function decideCallable(
  opts: SetupOpts,
  hasBin: (name: string) => boolean,
  ask: (q: string) => Promise<string>,
  reusedCfg: Config | undefined,
): Promise<boolean> {
  if (opts.callerOnly) return false;
  if (reusedCfg?.agent_kind) return true;
  if (opts.agent) return true;
  if (!hasBin("claude") && !hasBin("codex")) {
    console.log(
      "No claude or codex found on PATH — setting up as caller-only.\n" +
        "Install one and re-run `agentcall setup` to make your agent callable.",
    );
    return false;
  }
  if (opts.yes) return true;
  const answer = (await ask("Make your agent callable by others? [Y/n]: ")).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}
```

Update the call site in `runSetup`:

```ts
  const callable = await decideCallable(opts, hasBinFn, ask, reusedCfg);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm test && pnpm typecheck`
Expected: all PASS. Pre-existing tests stay green: `agent: "claude"` returns callable before the prompt; full-config reuse returns callable before the prompt (the "asks no questions at all" regression test still holds).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): ask 'make your agent callable?' and fall back to caller-only without an agent"
```

---

### Task 6: cli — upgrade path on reuse + downgrade guard

**Files:**
- Modify: `packages/cli/src/setup.ts` (`runSetup` reuse branch, early guard)
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: Task 5's `decideCallable(opts, hasBin, ask, reusedCfg)` and Task 4's `runSetup` structure.
- Produces: final `runSetup` behavior — nothing downstream consumes new names.

- [ ] **Step 1: Write the failing tests**

Add to the `describe("caller-only setup", ...)` block in `packages/cli/test/setup.test.ts`:

```ts
  it("re-running setup upgrades a caller-only config to callable, keeping handle and token", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "upg", callerOnly: true, relay, snippet: false, hasBin: () => false });
      const p = getPaths(home);
      expect(JSON.parse(readFileSync(p.configFile, "utf8")).agent_kind).toBeUndefined();

      // The upgrade run points at a relay that 409s every register call —
      // it must reuse the existing handle/token, not re-register.
      const badRelay = await fakeRelay409();
      let launchdCalled = false;
      await runSetup({
        relay: badRelay,
        snippet: false,
        hasBin: (name) => name === "claude",
        io: { ask: async () => "y" },
        installLaunchAgentFn: () => { launchdCalled = true; },
      });
      const cfg = JSON.parse(readFileSync(p.configFile, "utf8"));
      expect(cfg.handle).toBe("upg");
      expect(cfg.token).toBe("tok-123");
      expect(cfg.agent_kind).toBe("claude");
      expect(existsSync(p.srtFile)).toBe(true);
      expect(existsSync(p.publicDir)).toBe(true);
      expect(launchdCalled).toBe(true);
    } finally {
      delete process.env.AGENTCALL_HOME;
    }
  });

  it("--caller-only against an already-callable config makes no changes and points at uninstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentcall-setup-"));
    process.env.AGENTCALL_HOME = home;
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    try {
      const relay = await fakeRelay();
      await runSetup({ handle: "full", agent: "claude", relay, snippet: false, skipLaunchd: true });
      const p = getPaths(home);
      const before = readFileSync(p.configFile, "utf8");

      await runSetup({ callerOnly: true, relay, snippet: false, hasBin: () => true });

      expect(readFileSync(p.configFile, "utf8")).toBe(before);
      expect(errors.some((l) => l.includes("uninstall"))).toBe(true);
    } finally {
      spy.mockRestore();
      delete process.env.AGENTCALL_HOME;
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && pnpm test`
Expected: FAIL — the upgrade run reuses the config but never writes `agent_kind` (stays undefined, no srt/launchd); the downgrade run currently just reuses the config silently with no `uninstall` message (`console.error` never called).

- [ ] **Step 3: Write minimal implementation**

In `packages/cli/src/setup.ts`, inside `runSetup`:

Immediately after `reusedCfg` is computed, add the downgrade guard:

```ts
  // Downgrade (callable -> caller-only) is out of scope for setup: make no
  // changes and point at uninstall, which removes the background listener.
  if (opts.callerOnly && reusedCfg?.agent_kind) {
    console.error(
      "This install is already callable. To stop answering calls, run `agentcall uninstall` " +
        "(config is kept; re-run `agentcall setup` to come back).",
    );
    return;
  }
```

In the reuse branch, add the upgrade before `address` is computed:

```ts
  if (reusedCfg) {
    cfg = reusedCfg;
    if (callable && !cfg.agent_kind && agentKind) {
      // Upgrade caller-only -> callable: keep handle/token, add the agent
      // locally. The relay's stored agent_kind stays NULL, which is fine —
      // the relay never reads that column after registration.
      cfg = { ...cfg, agent_kind: agentKind };
      saveConfig(paths, cfg);
    }
    address = addressFromConfig(cfg);
    console.log(`Reusing existing registration for ${cfg.handle}`);
  } else {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm test && pnpm typecheck`
Expected: all PASS (the srt/publicDir/launchd block already keys off `cfg.agent_kind`, so the upgraded config flows through it unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): upgrade caller-only installs on re-setup; guard --caller-only downgrades"
```

---

### Task 7: full verification + rollout notes

**Files:**
- Modify: none expected (fix regressions if any surface)

**Interfaces:**
- Consumes: everything above.
- Produces: a green monorepo.

- [ ] **Step 1: Run the full suite from the repo root**

Run: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all three PASS across `packages/shared`, `apps/relay`, `packages/cli`. Fix any failure before proceeding (and commit the fix with an explanatory message).

- [ ] **Step 2: Report rollout order (do not execute deploys)**

Deployment is the user's call, in this order:
1. `cd apps/relay && pnpm wrangler d1 migrations apply agentcall --remote` — applies `0002_agent_kind_nullable.sql` to production D1.
2. `cd apps/relay && pnpm wrangler deploy` — the new Worker accepts registrations with and without `agent_kind`.
3. Publish `@benree/agentcall` (CLI) — only after 1-2, because the old relay 400s a caller-only registration.

Surface these three steps in the final summary; do not run them.
