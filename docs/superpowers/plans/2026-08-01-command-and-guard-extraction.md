# Command and Guard Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every CLI command action out of `packages/cli/src/index.ts` into testable functions, and extract the repeated security preamble in `apps/relay/src/roster.ts` into guards, so that #48's four new endpoints and five new commands land in a structure that can hold them.

**Architecture:** Two independent halves. On the relay, `roster.ts` becomes a `roster/` directory where `guards.ts` owns the enumeration and constant-time invariants that every route inherits instead of retyping. On the CLI, each command becomes a plain exported function taking a `Deps` object (`{ paths, io }`), and `index.ts` shrinks to commander wiring plus one `run()` error wrapper. No behavior changes.

**Tech Stack:** TypeScript, ESM, pnpm workspace. Hono + `@cloudflare/vitest-pool-workers` on the relay; commander + vitest on the CLI.

## Global Constraints

- **This is Phase 1 of `docs/superpowers/specs/2026-08-01-roster-lifecycle-design.md`.** Read that spec's "Phase 1 — Prerequisite refactor" section before starting.
- **No behavior changes,** with exactly one carved-out exception below. Every user-visible string, exit code, and side effect stays byte-identical. If a change seems like an improvement, it belongs in a different commit.
- **The one accepted exception: error-message formatting converges on the bare message.** Today about half the 26 commands catch their own errors and print `e.message`; the rest have no `catch` and fall through to `runCli`'s outer handler at `index.ts:492`, which prints `String(e)` — rendering an `Error` as `"Error: <message>"`. Routing every command through `run()` makes all of them print the bare `<message>`, so the previously-unwrapped commands lose an `"Error: "` prefix. **This is accepted as intentional cleanup** (decided 2026-08-01): the prefix is noise on a message already written for a human, and the bare form is already the majority behavior, so this makes the CLI consistent rather than inconsistent. Do not special-case any command to preserve the prefix, and do not change `run()` to print `String(e)` — that would break the larger group instead. Call it out in the PR description and CHANGELOG.
- **Protocol types live in `packages/shared`.** This plan adds none, but do not introduce local frame shapes.
- **Stage files explicitly** — `git add <file> <file>`, never `git add -A` or `git add .`.
- **Before calling any task done:** `pnpm -r build && pnpm -r typecheck && pnpm -r test` must pass from the repo root, **in that order**. `packages/cli` typechecks against `packages/shared`'s built `dist`, so building last checks the previous run's types.
- **`typecheck` covers `src` and `test`.** New test files are type-checked; a signature change that leaves a stale call site in `test/` must fail the build, not surface at runtime.
- **Coordinate before starting the CLI half.** A parallel session is implementing #23 on branch `docs/23-multi-turn-calls` and its spec says it consumes `commands/call.ts` from this work. Use one worktree per session (`CONTRIBUTING.md`); this plan's author lost an uncommitted file to a shared-worktree collision already.

## Rebase note — read before Task 2

**This plan was written against `index.ts` as it stood before PR #63 landed. It has been rebased; the differences below are binding.**

**#49 is CLOSED.** PR #63 (`test/49-command-actions`) closed it by a different and better route than this plan proposed: it extracted `runCli(argv, { writeOut, writeErr })` and `createProgram()` as an in-process seam, added `cli-entry.ts` as the bin shim, and added `packages/cli/test/cli-actions.test.ts` — 199 lines driving commands *through* the Commander seam, asserting argv parsing, stream routing, exit status, relay requests against a local http server, and durable state. No task here closes #49. Do not write that in a commit message.

**What that changes for the better.** This plan's original weakness was stated in its own Task 2 rationale: extracting untested code is unverified by construction, with no net to catch a behavior change. `cli-actions.test.ts` **is** that net, and it tests something this plan's per-command tests structurally cannot — that `index.ts` still *wires* each command correctly. A broken `.action(run(...))` would pass every unit test in Tasks 2–7 and fail `cli-actions.test.ts`.

**So the CLI tasks gain one mandatory step each:** after extracting, run

```bash
cd packages/cli && pnpm vitest run test/cli-actions.test.ts
```

and it must pass unchanged. If a command you extracted is covered there and the file needs editing to accommodate your change, you have changed behavior — stop and report it rather than amending the test. (`setup` and `listen` are deliberately excluded from that file; Task 7 must not add them.)

**Line references shift by exactly +1** throughout `index.ts`, because `createProgram()` opens at line 21 and the program body below it is otherwise unchanged. Where a task says `index.ts:244-314`, read `245-315`. Current landmarks: `createProgram()` :21, `contacts` :194, `roster` :245, `search` :318, `task` :408, `allow` :427, `listen` :441, `uninstall` :488, `runCli` :509.

**`run()` goes inside `createProgram()`**, above the first `.command()`, not at module scope. Its contract is already compatible with the new seam: `run()` sets `process.exitCode = 1` on a thrown error, and `runCli` returns `process.exitCode ?? 0` after restoring the previous value. Do not make command functions return exit codes — `runCli` owns that translation and already isolates the process-global.

**The remaining justification for Tasks 2–7 is structural, and narrower than the plan first claimed.** `index.ts` is 527 lines with 24 `process.exitCode = 1` assignments still inside command actions. #48 adds five more commands. The seam test covers wiring; it does not make business logic unit-testable, and it does not shrink the file. That is the case for continuing — not #49.

---

## File Structure

**Relay — created:**

| file | responsibility |
|---|---|
| `apps/relay/src/roster/index.ts` | `mountRoster` — the route table and nothing else |
| `apps/relay/src/roster/guards.ts` | auth, id shape, rate limit, membership, secret comparison, and the one canonical `NOT_FOUND` response |
| `apps/relay/src/roster/bundle.ts` | the per-caller search projection handler |

**Relay — deleted:** `apps/relay/src/roster.ts` (its contents move into the three files above).

**CLI — created:** `packages/cli/src/commands/{roster,search,contacts,call,card,policy,account}.ts`

**CLI — modified:** `packages/cli/src/index.ts` (527 lines → ~150; the floor is higher than the original plan's ~120 because `createProgram`/`runCli`/`CliOutput` stay).

Command-to-file mapping, covering all 26 commands:

| file | commands |
|---|---|
| `roster.ts` | `roster create`, `roster join`, `roster list`, `roster forget` |
| `search.ts` | `search` |
| `contacts.ts` | `contacts add`, `contacts list`, `contacts remove` |
| `call.ts` | `call`, `status` |
| `card.ts` | `card`, `task new` |
| `policy.ts` | `allow`, `revoke`, `block`, `unblock`, `offer`, `unoffer` |
| `account.ts` | `setup`, `doctor`, `listen`, `rotate`, `uninstall` |

---

### Task 1: Relay guards and the `roster/` split

**Files:**
- Create: `apps/relay/src/roster/guards.ts`
- Create: `apps/relay/src/roster/index.ts`
- Create: `apps/relay/src/roster/bundle.ts`
- Delete: `apps/relay/src/roster.ts`
- Modify: `apps/relay/src/index.ts` (import path only)
- Test: `apps/relay/test/roster-guards.test.ts`

**Interfaces:**
- Consumes: `verifyHandleToken`, `constantTimeEqual`, `sha256Hex`, `generateToken` from `../auth.js`; `Env` from `../index.js` (**type-only import** — the `index → roster → index` cycle must stay erased at compile time, the rule `a2a.ts` follows).
- Produces:
  - `notFound(): Response` — the single canonical 404
  - `secretMatches(supplied: string, hash: string | null): Promise<boolean>`
  - `requireRoster(c, op: string): Promise<{ handle: string; id: string } | Response>`
  - `requireMember(c, id: string, handle: string): Promise<Response | null>`
  - `mountRoster(app: Hono<{ Bindings: Env }>): void` — unchanged signature

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/roster-guards.test.ts`. This is the test that makes `guards.ts` load-bearing: it asserts the enumeration invariant on the **whole response**, not just the body, because `Cache-Control` and `ETag` are already varied deliberately on this route (`roster.ts:156-165`) and a 404 that leaked them differentially would defeat the shared body.

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

async function snapshot(res: Response) {
  return {
    status: res.status,
    body: await res.text(),
    // Only headers a client can observe and that could differ per path.
    etag: res.headers.get("ETag"),
    cacheControl: res.headers.get("Cache-Control"),
    contentType: res.headers.get("content-type"),
  };
}

describe("roster guards: the enumeration invariant", () => {
  it("returns an identical response for an unknown roster and a non-member", async () => {
    const owner = await registerHandle("rg1");
    const outsider = await registerHandle("rg2");

    const created = await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST",
      headers: { "cf-connecting-ip": "test-rg1", ...wsAuth("rg1", owner) },
    });
    const { roster_id } = await created.json<{ roster_id: string }>();

    // Real roster, but the viewer is not a member.
    const nonMember = await SELF.fetch(`https://relay.test/v1/roster/${roster_id}/bundle`, {
      headers: { "cf-connecting-ip": "test-rg2", ...wsAuth("rg2", outsider) },
    });
    // Well-formed but nonexistent roster id (22 chars, inside ROSTER_ID_RE).
    const unknown = await SELF.fetch("https://relay.test/v1/roster/AAAAAAAAAAAAAAAAAAAAAA/bundle", {
      headers: { "cf-connecting-ip": "test-rg2", ...wsAuth("rg2", outsider) },
    });

    expect(await snapshot(nonMember)).toEqual(await snapshot(unknown));
    expect(nonMember.status).toBe(404);
  });

  it("returns an identical response for a wrong secret and an unknown roster on join", async () => {
    const owner = await registerHandle("rg3");
    const joiner = await registerHandle("rg4");

    const created = await SELF.fetch("https://relay.test/v1/roster", {
      method: "POST",
      headers: { "cf-connecting-ip": "test-rg3", ...wsAuth("rg3", owner) },
    });
    const { roster_id } = await created.json<{ roster_id: string }>();

    const wrongSecret = await SELF.fetch(`https://relay.test/v1/roster/${roster_id}/join`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "test-rg4", ...wsAuth("rg4", joiner) },
      body: JSON.stringify({ secret: "not-the-secret" }),
    });
    const unknownRoster = await SELF.fetch("https://relay.test/v1/roster/BBBBBBBBBBBBBBBBBBBBBB/join", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "test-rg4", ...wsAuth("rg4", joiner) },
      body: JSON.stringify({ secret: "not-the-secret" }),
    });

    expect(await snapshot(wrongSecret)).toEqual(await snapshot(unknownRoster));
    expect(wrongSecret.status).toBe(404);
  });

  it("rejects a malformed roster id before any lookup, with 400 not 404", async () => {
    const token = await registerHandle("rg5");
    const res = await SELF.fetch("https://relay.test/v1/roster/short/bundle", {
      headers: { "cf-connecting-ip": "test-rg5", ...wsAuth("rg5", token) },
    });
    expect(res.status).toBe(400);
  });

  it("401s before revealing anything about the roster", async () => {
    const res = await SELF.fetch("https://relay.test/v1/roster/AAAAAAAAAAAAAAAAAAAAAA/bundle");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/relay && pnpm vitest run test/roster-guards.test.ts
```

Expected: FAIL. The `snapshot` equality assertions are the ones that matter — today each 404 is constructed at its own call site, so any drift shows up here. If they happen to pass before the refactor, that is fine: they then serve as the regression net proving the extraction preserved the property.

- [ ] **Step 3: Create `apps/relay/src/roster/guards.ts`**

```ts
import type { Context } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "../index.js";
import { constantTimeEqual, sha256Hex, verifyHandleToken } from "../auth.js";
import { ROSTER_ID_RE } from "@benree/agentcall-shared";

// ONE body and ONE header set for every "you may not see this" outcome:
// unknown roster, wrong secret, and non-member are indistinguishable. A
// distinct response for any of them turns roster ids into an enumerable
// namespace. Constructed fresh per call because a Response body can only be
// read once, but always from these same values.
export function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

// Hashes the supplied value even when there is no stored hash, so a missing
// roster and a wrong secret cost the same. Never log either argument.
export async function secretMatches(supplied: string, hash: string | null): Promise<boolean> {
  const digest = await sha256Hex(supplied);
  if (!hash) return false;
  return constantTimeEqual(hash, digest);
}

// Every roster route starts here. Possession of a handle token is the floor,
// not the gate — registration is open, so membership or a secret is what
// actually authorizes. Order matters: auth, then id shape, then rate limit,
// and only then anything that touches roster rows. Rate limiting before any
// existence-dependent query is what keeps a 429 from distinguishing a real
// roster id from a fabricated one.
export async function requireRoster(
  c: Context<{ Bindings: Env }>,
  op: string,
): Promise<{ handle: string; id: string } | Response> {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!(await verifyHandleToken(c.env.DB, handle, token))) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const id = c.req.param("id");
  // Shape-check before touching D1: a malformed id can never match a row.
  if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  if (!(await c.env.ROSTER_RL.limit({ key: `${op}:${ip}:${id}` })).success) {
    return c.json({ error: "rate limited" }, 429);
  }

  return { handle, id };
}

// Membership is the real authorization for reads. Checked BEFORE anything
// reveals that the roster exists, and a non-member gets exactly what an
// unknown roster gets.
export async function requireMember(
  c: Context<{ Bindings: Env }>,
  id: string,
  handle: string,
): Promise<Response | null> {
  const member = await c.env.DB.prepare(
    "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
  ).bind(id, handle).first();
  return member ? null : notFound();
}
```

- [ ] **Step 4: Create `apps/relay/src/roster/bundle.ts`**

Move the body of the `GET /v1/roster/:id/bundle` handler from `roster.ts:97-166` verbatim into an exported `handleBundle(c)`, with exactly three substitutions:

1. Delete the inline auth block, the `ROSTER_ID_RE` check, and the rate-limit block — `requireRoster(c, "bundle")` now supplies all three.
2. Replace the inline membership query with `requireMember`.
3. Replace `return c.json(NOT_FOUND, 404)` with `return notFound()`.

```ts
import type { Context } from "hono";
import type { Env } from "../index.js";
import { CardUpload, MAX_BUNDLE_TASKS_PER_CARD, visibleTasks } from "@benree/agentcall-shared";
import { requireMember } from "./guards.js";

export async function handleBundle(
  c: Context<{ Bindings: Env }>,
  id: string,
  viewer: string,
): Promise<Response> {
  const denied = await requireMember(c, id, viewer);
  if (denied) return denied;

  // ... the remainder of roster.ts:118-165 moves here unchanged: the single
  // bounded join, the per-entry CardUpload.parse with `skipped` counting, the
  // visibleTasks projection, the ETag construction, and the 304 branch.
}
```

Keep every existing comment. They record why the bundle omits zero-task entries, why `examples` are dropped, and why the ETag includes the viewer — none of which is re-derivable from the code.

- [ ] **Step 5: Create `apps/relay/src/roster/index.ts`**

```ts
import type { Hono } from "hono";
import type { Env } from "../index.js";
import { generateToken, sha256Hex } from "../auth.js";
import { JoinRosterRequest, MAX_ROSTER_MEMBERS } from "@benree/agentcall-shared";
import { notFound, requireRoster, secretMatches } from "./guards.js";
import { handleBundle } from "./bundle.js";

// 16 random bytes, base64url — 22 chars, inside ROSTER_ID_RE's 16..64 window.
// Unguessable but not secret: it travels in URL paths and will be logged.
function generateRosterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function mountRoster(app: Hono<{ Bindings: Env }>): void {
  // POST /v1/roster does NOT go through requireRoster: there is no :id yet,
  // and it is rate-limited on REGISTER_RL rather than ROSTER_RL so creating
  // a roster costs what registering a handle costs.
  app.post("/v1/roster", async (c) => { /* roster.ts:29-47 verbatim */ });

  app.post("/v1/roster/:id/join", async (c) => {
    const gate = await requireRoster(c, "join");
    if (gate instanceof Response) return gate;
    const { handle, id } = gate;
    // ... roster.ts:68-94 verbatim, with c.json(NOT_FOUND, 404) -> notFound()
    // and the inline sha256/constantTimeEqual pair -> secretMatches().
  });

  app.get("/v1/roster/:id/bundle", async (c) => {
    const gate = await requireRoster(c, "bundle");
    if (gate instanceof Response) return gate;
    return handleBundle(c, gate.id, gate.handle);
  });
}
```

- [ ] **Step 6: Delete the old file and repoint the import**

```bash
git rm apps/relay/src/roster.ts
```

In `apps/relay/src/index.ts`, change the import from `./roster.js` to `./roster/index.js`.

- [ ] **Step 7: Run the full relay suite**

```bash
cd apps/relay && pnpm test
```

Expected: PASS, including the pre-existing `roster-create`, `roster-join`, and `roster-bundle` suites. Those three are the safety net for this task — if any fails, the extraction changed behavior.

Note: `test/register.test.ts` has a known wall-clock flake (a 5-in-60s burst test). If only that fails, re-run before investigating.

- [ ] **Step 8: Verify and commit**

```bash
cd /Users/ryuseitaniguchi/coding/agentcall
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add apps/relay/src/roster/guards.ts apps/relay/src/roster/index.ts apps/relay/src/roster/bundle.ts apps/relay/src/index.ts apps/relay/test/roster-guards.test.ts
git rm --cached apps/relay/src/roster.ts 2>/dev/null; git add -u apps/relay/src
git commit -m "refactor(relay): extract roster guards, split roster.ts into roster/

The enumeration invariant (unknown roster, wrong secret, and non-member are
byte-identical) and the equal-cost secret comparison were derived inline at
each call site. #48 adds four more roster routes, each of which would have
had to re-derive both. They now live in guards.ts and every route inherits
them.

roster-guards.test.ts asserts the invariant on the whole response including
headers, not just the body — Cache-Control and ETag are varied deliberately
on this route, so a body-only assertion would pass while they leaked."
```

---

### Task 2: CLI `run()` wrapper and `commands/roster.ts`

**Files:**
- Create: `packages/cli/src/commands/roster.ts`
- Modify: `packages/cli/src/index.ts:244-314` (the roster command block)
- Test: `packages/cli/test/commands-roster.test.ts`

**Interfaces:**
- Consumes: `getPaths` from `../paths.js`, `loadConfig`/`relayUrl` from `../config.js`, `createRoster`/`joinRoster` from `../api.js`, `loadMemberships`/`saveMembership`/`forgetMembership` from `../rosters.js`.
- Produces — relied on by Tasks 3-7 and by #48:
  ```ts
  export type Io = {
    log(s: string): void;
    error(s: string): void;
    ask(q: string): Promise<string>;
  };
  export type Deps = { paths: Paths; io: Io };
  export function realDeps(): Deps;
  export async function rosterCreate(d: Deps, o: { as: string }): Promise<void>;
  export async function rosterJoin(d: Deps, rosterId: string, o: { secret: string; as: string }): Promise<void>;
  export function rosterList(d: Deps): void;
  export function rosterForget(d: Deps, name: string): void;
  ```

**Why `io` is injected rather than calling `console` directly:** vitest runs files in parallel, so a process-wide `console.log` spy is shared mutable state between suites. An injected sink is per-test and asserts exactly.

**Why commands throw instead of setting `process.exitCode`:** exit-code handling is process concern, not command logic. Centralizing it in `run()` is what lets a test call `rosterForget` and assert on a thrown error rather than on a global.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/commands-roster.test.ts`:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { rosterForget, rosterList, type Deps, type Io } from "../src/commands/roster.js";
import { saveMembership } from "../src/rosters.js";
import type { Paths } from "../src/paths.js";

function fakeIo(): Io & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines, errors,
    log: (s) => lines.push(s),
    error: (s) => errors.push(s),
    ask: async () => "",
  };
}

let dir: string;
let deps: Deps & { io: ReturnType<typeof fakeIo> };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentcall-roster-"));
  const paths = { dir, rostersFile: join(dir, "rosters.json"), rosterCacheFile: join(dir, "roster-cache.json") } as Paths;
  deps = { paths, io: fakeIo() };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rosterList", () => {
  it("prints the onboarding hint when nothing is joined", () => {
    rosterList(deps);
    expect(deps.io.lines.join("\n")).toContain("No rosters joined");
  });

  it("prints one tab-separated row per membership", () => {
    saveMembership(deps.paths, { name: "acme", relay: "https://r.test", roster_id: "AAAAAAAAAAAAAAAAAAAAAA" });
    rosterList(deps);
    expect(deps.io.lines).toEqual(["acme\tAAAAAAAAAAAAAAAAAAAAAA\thttps://r.test"]);
  });
});

describe("rosterForget", () => {
  it("removes the local record and says the relay is unchanged", () => {
    saveMembership(deps.paths, { name: "acme", relay: "https://r.test", roster_id: "AAAAAAAAAAAAAAAAAAAAAA" });
    rosterForget(deps, "acme");
    expect(deps.io.lines.join("\n")).toContain("membership on the relay is unchanged");
    rosterList(deps);
    expect(deps.io.lines.join("\n")).toContain("No rosters joined");
  });

  it("throws rather than setting an exit code when the name is unknown", () => {
    // The command's contract: throw. index.ts's run() wrapper owns exit codes.
    expect(() => rosterForget(deps, "nope")).toThrow(/No roster named "nope"/);
    expect(deps.io.errors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd packages/cli && pnpm vitest run test/commands-roster.test.ts
```

Expected: FAIL — `Cannot find module '../src/commands/roster.js'`.

- [ ] **Step 3: Create `packages/cli/src/commands/roster.ts`**

Move the four action bodies from `index.ts:247-314` verbatim, with exactly three substitutions:

1. `console.log(x)` → `d.io.log(x)`
2. `console.error(...); process.exitCode = 1;` and its enclosing `try`/`catch` → **deleted entirely**; let the error propagate.
3. `getPaths()` / the local `paths` binding → `d.paths`.

```ts
import { ask } from "../tty.js";
import { getPaths, type Paths } from "../paths.js";
import { loadConfig, relayUrl } from "../config.js";
import { createRoster, joinRoster } from "../api.js";
import { forgetMembership, loadMemberships, saveMembership } from "../rosters.js";

// One injected I/O surface for every command. Injected rather than calling
// console directly because vitest runs files in parallel and a process-wide
// console spy is shared mutable state between suites.
export type Io = {
  log(s: string): void;
  error(s: string): void;
  ask(q: string): Promise<string>;
};
export type Deps = { paths: Paths; io: Io };

export function realDeps(): Deps {
  return {
    paths: getPaths(),
    io: { log: (s) => console.log(s), error: (s) => console.error(s), ask },
  };
}

export async function rosterCreate(d: Deps, o: { as: string }): Promise<void> {
  const cfg = loadConfig(d.paths);
  const { roster_id, secret } = await createRoster(relayUrl(cfg), { handle: cfg.handle, token: cfg.token });
  saveMembership(d.paths, { name: o.as, relay: relayUrl(cfg), roster_id });
  d.io.log(`Roster created and saved locally as "${o.as}".\n`);
  d.io.log(`  id:     ${roster_id}`);
  d.io.log(`  secret: ${secret}\n`);
  // Printed once and never stored: the relay keeps only a SHA-256 digest.
  d.io.log("The secret is shown once and is not recoverable. Share both with colleagues:");
  d.io.log(`  agentcall roster join ${roster_id} --secret ${secret} --as ${o.as}`);
}

export async function rosterJoin(d: Deps, rosterId: string, o: { secret: string; as: string }): Promise<void> {
  const cfg = loadConfig(d.paths);
  await joinRoster(relayUrl(cfg), { handle: cfg.handle, token: cfg.token }, rosterId, o.secret);
  // The secret is spent here and never written to disk: from now on the
  // handle token plus the relay-side membership row is what authorizes.
  saveMembership(d.paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
  d.io.log(`Joined. Saved locally as "${o.as}".`);
  d.io.log(`Try: agentcall search "<what you need to know>"`);
}

export function rosterList(d: Deps): void {
  const rosters = loadMemberships(d.paths);
  if (rosters.length === 0) {
    d.io.log("No rosters joined. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>");
    return;
  }
  for (const r of rosters) d.io.log(`${r.name}\t${r.roster_id}\t${r.relay}`);
}

export function rosterForget(d: Deps, name: string): void {
  forgetMembership(d.paths, name);
  d.io.log(`Forgot "${name}" locally. Your membership on the relay is unchanged — there is no leave operation.`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd packages/cli && pnpm vitest run test/commands-roster.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Add `run()` to `index.ts` and rewire the roster block**

Add near the top of `index.ts`, after the `program` declaration:

```ts
// The ONLY place that knows about process state. Commands throw; this
// converts a thrown error into the message-plus-exit-code convention. Before
// this existed the same six lines appeared 15 times and the exit code was
// set in 23 places.
function run<A extends unknown[]>(fn: (...a: A) => Promise<void> | void) {
  return async (...a: A) => {
    try {
      await fn(...a);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  };
}
```

Replace the four roster actions with wiring only:

```ts
roster
  .command("create")
  .description("create a roster and print its id and join secret")
  .option("--as <name>", "local name to record it under", "roster")
  .action(run((o: { as: string }) => rosterCreate(realDeps(), o)));

roster
  .command("join")
  .description("join a roster so `agentcall search` can see its members")
  .argument("<roster-id>", "roster id shared by whoever created it")
  .requiredOption("--secret <secret>", "the roster's join secret")
  .option("--as <name>", "local name for this roster", "roster")
  .action(run((rosterId: string, o: { secret: string; as: string }) => rosterJoin(realDeps(), rosterId, o)));

roster
  .command("list")
  .description("list rosters this install has joined")
  .action(run(() => rosterList(realDeps())));

roster
  .command("forget")
  .description("drop the local record of a roster (does NOT remove your membership on the relay — there is no leave operation)")
  .argument("<name>", "local roster name")
  .action(run((name: string) => rosterForget(realDeps(), name)));
```

Every `.description()` and `.option()` string stays byte-identical.

- [ ] **Step 6: Verify and commit**

```bash
cd /Users/ryuseitaniguchi/coding/agentcall
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/cli/src/commands/roster.ts packages/cli/src/index.ts packages/cli/test/commands-roster.test.ts
git commit -m "refactor(cli): extract roster commands, add run() error wrapper

First of seven command extractions. Establishes the Deps/Io convention the
rest follow: commands are plain functions that print through an injected io
and throw on failure, and index.ts holds only commander wiring plus run(),
which is now the single place that touches process.exitCode.

io is injected rather than calling console directly because vitest runs
files in parallel, so a process-wide console spy is shared state between
suites."
```

---

### Task 3: `commands/search.ts`

**Files:**
- Create: `packages/cli/src/commands/search.ts`
- Modify: `packages/cli/src/index.ts:317-405`
- Test: `packages/cli/test/commands-search.test.ts`

**Interfaces:**
- Consumes: `Deps`, `Io`, `realDeps` from `./roster.js`.
- Produces: `export async function search(d: Deps, questionParts: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean }): Promise<void>`

`search` is the largest action at ~90 lines and the one with real branching — per-roster degradation, the all-rosters-failed case, and the `--json` shape. Extract it alone.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { search } from "../src/commands/search.js";
```

Write four cases, mocking `../src/searchRefresh.js` with `vi.mock` so no network is touched:

1. **No rosters joined** → the message names `agentcall roster join`, and nothing throws.
2. **`--roster nope` with a joined roster named `acme`** → the error names `agentcall roster list`.
3. **One roster reachable, one failing** → results from the reachable one are printed and the failure does not abort. This is the "each roster degrades on its own" comment at `index.ts:348-350`, currently untested.
4. **Every roster fails** → throws rather than printing an empty result set, per `allRostersFailed` in `search.ts`. This is the distinction between "no matches" and "nothing worked", and it is the behavior most likely to be broken silently by a refactor.

Use the same `mkdtempSync` + fake `Io` harness as Task 2.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/cli && pnpm vitest run test/commands-search.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Move the action body**

Move `index.ts:324-405` into `search(d, questionParts, o)`, applying the same three substitutions from Task 2 Step 3. Keep the comments at 348-350 and 358 — they record why one unreachable roster must not fail the whole search and why total failure is not a no-results answer.

- [ ] **Step 4: Run to verify it passes**

```bash
cd packages/cli && pnpm vitest run test/commands-search.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Rewire and commit**

```ts
program
  .command("search")
  .description("find which colleague's agent can answer something")
  .argument("<question...>", "what you need to know")
  .option("--roster <name>", "search only this roster (default: all joined rosters)")
  // ... remaining options byte-identical
  .action(run((q: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean }) =>
    search(realDeps(), q, o)));
```

```bash
cd /Users/ryuseitaniguchi/coding/agentcall
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/cli/src/commands/search.ts packages/cli/src/index.ts packages/cli/test/commands-search.test.ts
git commit -m "refactor(cli): extract search command

Adds the first coverage of two behaviors that were only ever expressed in
index.ts: that one unreachable roster degrades on its own rather than
failing the search, and that every roster failing throws rather than
reporting no matches."
```

---

### Task 4: `commands/deps.ts` extraction, then `commands/contacts.ts`

**Do the `deps.ts` move FIRST, as its own commit, before touching contacts.**

Task 2 put `Deps`, `Io`, and `realDeps` in `commands/roster.ts` because it was the first command module; Task 3's fix round added `ExitOnly` there too. That was right for two files and is wrong for seven — every remaining command module would import its core types from a sibling *command*, which reads as a dependency on roster functionality that does not exist. It also makes `roster.ts` un-deletable: if the roster commands ever move or split, the shared types move with them by accident.

Move them to `packages/cli/src/commands/deps.ts`:

```ts
// The shared surface every command module depends on. Deliberately NOT in
// roster.ts: it was the first command extracted, not the owner of these
// types, and six sibling modules importing from it would imply a
// dependency on roster functionality that does not exist.
export type Io = { log(s: string): void; error(s: string): void; ask(q: string): Promise<string> };
export type Deps = { paths: Paths; io: Io };
export function realDeps(): Deps { /* moved verbatim from roster.ts */ }
export class ExitOnly extends Error { /* keep its comment verbatim */ }
```

Update the imports in `commands/roster.ts`, `commands/search.ts`, and `index.ts`. Commit that alone, verify the suite is unchanged at 637, then proceed to the contacts extraction below in a second commit.

Cost check, for the record: two command modules to migrate now, six if this waits until Task 7.

**Files:**
- Create: `packages/cli/src/commands/deps.ts`
- Modify: `packages/cli/src/commands/roster.ts`, `packages/cli/src/commands/search.ts` (imports only)
- Create: `packages/cli/src/commands/contacts.ts`
- Modify: `packages/cli/src/index.ts:193-242`
- Test: `packages/cli/test/commands-contacts.test.ts`

**Interfaces:**
- Consumes: `Deps`, `realDeps` from `./roster.js`; `addContact`, `loadContacts`, `removeContact` from `../contacts.js`.
- Produces:
  ```ts
  export function contactsAdd(d: Deps, name: string, address: string, o: { note?: string }): void;
  export function contactsList(d: Deps, o: { json?: boolean }): void;
  export function contactsRemove(d: Deps, name: string): void;
  ```

- [ ] **Step 1: Write the failing test**

Three cases, same harness as Task 2: adding then listing round-trips the contact; `--json` emits parseable JSON whose shape matches the human output's fields; removing an unknown name throws with a message naming the command to run.

- [ ] **Step 2: Run to verify it fails**

```bash
cd packages/cli && pnpm vitest run test/commands-contacts.test.ts
```

- [ ] **Step 3: Move the three action bodies**

Same three substitutions as Task 2 Step 3.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Rewire and commit**

```bash
git add packages/cli/src/commands/contacts.ts packages/cli/src/index.ts packages/cli/test/commands-contacts.test.ts
git commit -m "refactor(cli): extract contacts commands"
```

---

### Task 5: `commands/call.ts` — `call` and `status`

**Files:**
- Create: `packages/cli/src/commands/call.ts`
- Modify: `packages/cli/src/index.ts:58-121`
- Test: `packages/cli/test/commands-call.test.ts`

**Interfaces:**
- Consumes: `Deps`, `realDeps` from `./roster.js`; `callAgent`, `CallError` from `../callClient.js`; `getStatus` from `../api.js`; `resolveAddress` from `../contacts.js`.
- Produces:
  ```ts
  export async function call(d: Deps, address: string, messageParts: string[], o: { json?: boolean; /* remaining options unchanged */ }): Promise<void>;
  export async function status(d: Deps, address: string): Promise<void>;
  ```

**Coordinate before starting this task.** The #23 session's spec states it consumes `commands/call.ts`. Confirm with that session which of you creates the file, or land this task first and tell them.

- [ ] **Step 1: Write the failing test**

Mock `../src/callClient.js`. Three cases: a successful call prints the reply; a `CallError` propagates as a throw rather than setting an exit code inside the command; `--json` emits the machine shape. Assert the contact-name path resolves through `resolveAddress` by seeding a contact and calling with the short name.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Move both action bodies**

Same three substitutions. `CallError` handling that distinguishes error kinds for the user stays inside the command; only the generic `catch` that sets `process.exitCode` is removed.

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Rewire and commit**

```bash
git add packages/cli/src/commands/call.ts packages/cli/src/index.ts packages/cli/test/commands-call.test.ts
git commit -m "refactor(cli): extract call and status commands"
```

---

### Task 6: `commands/card.ts` and `commands/policy.ts`

**Files:**
- Create: `packages/cli/src/commands/card.ts` — `card`, `task new`
- Create: `packages/cli/src/commands/policy.ts` — `allow`, `revoke`, `block`, `unblock`, `offer`, `unoffer`
- Modify: `packages/cli/src/index.ts:130-191`, `:407-438`
- Test: `packages/cli/test/commands-card.test.ts`, `packages/cli/test/commands-policy.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function card(d: Deps, target?: string): Promise<void>;
  export function taskNew(d: Deps, /* existing args */): void;
  export function policyVerb(d: Deps, verb: Verb, args: string[]): void;
  ```

The six policy commands all delegate to `execVerb` in `verbs.ts`, so they collapse into one `policyVerb` function rather than six near-identical ones. That is the one place this refactor removes duplication rather than only relocating it — verify against `index.ts:426-438` that the six differ *only* by the verb they pass. If any has extra logic, keep it separate rather than forcing the collapse.

- [ ] **Step 1: Write the failing tests**

For `policy.ts`: assert each of the six verbs reaches `execVerb` with the right verb string, using `vi.mock("../src/verbs.js")`. For `card.ts`: assert the no-argument form publishes the local card and the address form fetches a remote one.

- [ ] **Step 2: Run to verify they fail**

- [ ] **Step 3: Move the bodies**

- [ ] **Step 4: Run to verify they pass**

- [ ] **Step 5: Rewire and commit**

```bash
git add packages/cli/src/commands/card.ts packages/cli/src/commands/policy.ts packages/cli/src/index.ts packages/cli/test/commands-card.test.ts packages/cli/test/commands-policy.test.ts
git commit -m "refactor(cli): extract card, task, and policy commands

The six policy verbs collapse into one policyVerb function: they differed
only by the verb passed to execVerb."
```

---

### Task 7: `commands/account.ts` and the `index.ts` cleanup

**Files:**
- Create: `packages/cli/src/commands/account.ts` — `setup`, `doctor`, `listen`, `rotate`, `uninstall`
- Modify: `packages/cli/src/index.ts` (final shape)
- Test: `packages/cli/test/commands-account.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function setup(d: Deps, o: SetupOptions): Promise<void>;
  export async function doctor(d: Deps): Promise<void>;
  export async function listen(d: Deps, o: { /* existing */ }): Promise<void>;
  export async function rotate(d: Deps): Promise<void>;
  export function uninstall(d: Deps, o: { purge?: boolean }): void;
  ```

`setup` is already thin — it delegates to `runSetup()` and only translates `{ ready: false }` into an exit code. Preserve that translation: `setup` throws when `runSetup` returns `ready: false`, so `run()` produces the same exit code. Do **not** call `process.exitCode` inside the command.

- [ ] **Step 1: Write the failing test**

Cases: `setup` throws when `runSetup` resolves `{ ready: false }` and does not throw when `{ ready: true }`; `uninstall` without `--purge` leaves the config directory in place, and with `--purge` removes it. Mock `../src/setup.js` and `../src/launchd.js`.

`uninstall --purge` deletes `~/.agentcall` with no confirmation (`index.ts:490-495`). This refactor **preserves that behavior exactly** — it is noted as a separate concern in the #48 spec and changing it here would violate the no-behavior-change constraint. Point the test at a temp directory, never a real path.

- [ ] **Step 2: Run to verify it fails**

- [ ] **Step 3: Move the five action bodies**

- [ ] **Step 4: Run to verify it passes**

- [ ] **Step 5: Confirm `index.ts` holds no logic**

```bash
wc -l packages/cli/src/index.ts                        # expect ~150, down from 527
grep -c "process.exitCode" packages/cli/src/index.ts   # expect 4
grep -c "} catch" packages/cli/src/index.ts            # expect 3
```

The expected counts account for the `runCli` seam that PR #63 added — they are **not** zero, and driving them to zero would delete that seam. The four `process.exitCode` references are: the assignment inside `run()`, and the three inside `runCli` (`previousExitCode` capture, the `undefined` reset, and the `?? 0` read plus the `finally` restore). The three `catch` blocks are: `run()`, and the two nested ones in `runCli`.

If either `grep` exceeds its expected count, an action still holds logic. Find it and move it.

Then confirm the seam still holds:

```bash
cd packages/cli && pnpm vitest run test/cli-actions.test.ts
```

Expected: PASS, with `test/cli-actions.test.ts` unmodified by this plan.

- [ ] **Step 6: Verify and commit**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/cli/src/commands/account.ts packages/cli/src/index.ts packages/cli/test/commands-account.test.ts
git commit -m "refactor(cli): extract account commands; index.ts is wiring only



index.ts goes from 500 lines holding 26 command actions to ~120 lines of
commander wiring. Every action is now a plain function with an injected io,
reachable from a test — the seam where #43, #50, and #51 all hid.

process.exitCode is set in exactly two places: run(), and the top-level
parseAsync catch. It was set in 23."
```

---

## Self-Review

**Spec coverage.** Every item in the design's "Phase 1 — Prerequisite refactor" maps to a task: the relay `roster/` split and `guards.ts` to Task 1; the CLI `commands/` extraction and `run()` wrapper to Tasks 2-7; the "TDD per command" rule to each task's Step 1. The spec's `events.ts` and `admin.ts` are **deliberately absent** — they hold Phase 3 code and belong to the second plan.

**Not covered here, by design:** Phases 2 and 3 (migration `0005`, the shared schemas, the four new routes, the five new commands, `batch()` on every mutation). Those need a second plan, written after this one lands, because their tasks reference files this plan creates.

**Type consistency.** `Deps` and `Io` are defined once in `commands/roster.ts` (Task 2) and imported by Tasks 3-7. `realDeps()` is the only constructor. Guard names — `notFound`, `secretMatches`, `requireRoster`, `requireMember` — are used identically in Task 1's Steps 3, 4, and 5.

**Known gap, stated rather than hidden.** Tasks 4, 6, and 7 describe their test cases in prose rather than full code, because the command bodies they extract have not been read line by line at planning time and inventing their assertions would produce tests that fail for the wrong reason. The implementer must open the action in `index.ts` first and write assertions against what is actually there. Tasks 1, 2, and 3 — the ones #48 directly builds on — carry complete test code.

**Ordering.** Task 1 is independent of Tasks 2-7 and can run in parallel. Task 2 must precede 3-7 because it defines `Deps`, `Io`, and `realDeps`. Tasks 3-7 are independent of each other.
