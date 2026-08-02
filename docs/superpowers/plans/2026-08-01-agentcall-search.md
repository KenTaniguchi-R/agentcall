# `agentcall search` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a caller find *who* to ask — `agentcall search "<question>"` ranks `(colleague, task)` pairs from an opt-in org roster, matching entirely on the caller's own machine.

**Architecture:** A roster is a named set of handles on the relay, joined with a shared secret. The relay serves each member a per-caller filtered bundle of everyone's publishable tasks. The CLI caches that bundle and ranks it locally with a lexical scorer, so the query text never leaves the machine. Ranking output is `(handle, task-id)` pairs plus the exact `agentcall call` command to run next.

**Tech Stack:** TypeScript, ESM, zod 4, Hono + Cloudflare Workers + D1 (relay), commander (CLI), vitest + `@cloudflare/vitest-pool-workers`.

**Spec:** [`docs/superpowers/specs/2026-08-01-agentcall-search-design.md`](../specs/2026-08-01-agentcall-search-design.md) — read it before Task 1. **Issue:** [#24](https://github.com/KenTaniguchi-R/agentcall/issues/24).

## Global Constraints

- **Protocol types live in `packages/shared`.** Any shape both sides agree on goes in the zod schema there first, then relay and CLI import it. Never redeclare a frame or payload shape locally.
- **TDD.** Write the failing test, run it, watch it fail for the right reason, then implement. Every task below is ordered that way.
- **Verification order is `pnpm -r build && pnpm -r typecheck && pnpm -r test`, from the repo root, build first.** `packages/cli` typechecks against `packages/shared`'s built `dist`, so building last checks the *previous* run's types.
- **Stage files explicitly** — `git add <file> <file>`. Never `git add -A` or `git add .`.
- **`typecheck` covers `src` and `test`.** New test files are type-checked; a test that doesn't compile is a failure.
- **No live network and no live `claude`/`codex` spawn in tests.** CLI tests mock `ws`/`fs`; relay tests drive routes through `SELF.fetch`.
- **A relay rate-limit binding must exist in THREE places**, not two: `apps/relay/wrangler.jsonc` (`ratelimits`), the `Env` type in `apps/relay/src/index.ts`, and **`apps/relay/vitest.config.ts`**, which mirrors the bindings by hand for miniflare because the test tooling drops `wrangler.jsonc`'s `ratelimits` field entirely. Miss the third and `c.env.<BINDING>` is `undefined` at test time — every request through it 500s, and nothing fails at compile time. This bit Task 3, which added a binding two places and stayed green because its own route used a different one; the gap only surfaced in Task 4 when that binding got its first consumer.
- **`RELAY_HOST` in `apps/relay/src/index.ts` is deliberately not exported** — workerd rejects non-handler named exports from the entry module. Do not export it.
- Exact constant values, copied from the spec: `MAX_ROSTER_MEMBERS = 200`, `MAX_BUNDLE_TASKS_PER_CARD = 10`, `MAX_BUNDLE_BYTES = 4_500_000`, `MAX_KEYWORD_LENGTH = 40`, `MAX_TASK_KEYWORDS = 20`, `MAX_TASK_ID_LENGTH = 64`, cache TTL 15 minutes, default search limit 5, field weights `keywords: 3, name: 2, description: 1`, `MIN_SCORE = 2`.
- **A result must clear `MIN_SCORE = 2` to be shown.** A curated hit clears it alone (keyword 3, task name 2); two corroborating description terms clear it; a lone incidental word in prose does not. Pin it with a test asserting **both** directions — a description-only match returns nothing, a single keyword match still routes — otherwise a later edit can raise the threshold arbitrarily without failing anything.
- **Test fixtures for the over-firing tests must be able to match.** A roster fixture sharing no tokens with the queries proves nothing; it re-tests the zero-overlap case and would pass under a much looser matcher. At least one fixture card must contain ordinary coding vocabulary incidentally, so a false match is genuinely possible.
- **Bounds are named constants that the schemas themselves consume, never bare literals.** `MAX_KEYWORD_LENGTH` / `MAX_TASK_KEYWORDS` live in `packages/shared/src/card.ts`; `MAX_TASK_ID_LENGTH` lives in `packages/shared/src/protocol.ts` beside `TASK_ID_RE`, pinned to it by test. This exists so the bundle-size guard and the schema read one source — a literal in either place recreates the drift the guard is there to catch.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/shared/src/card.ts` | *Modify* — `keywords` on `CardTask`; new `visibleTasks()` helper | 1, 5 |
| `packages/cli/src/tasks.ts` | *Modify* — `keywords` in SKILL.md frontmatter → `Task` | 1 |
| `packages/cli/src/card.ts` | *Modify* — publish `keywords` in `buildCardUpload` | 1 |
| `packages/shared/src/roster.ts` | *Create* — roster ids, bundle/create/join schemas, bounds constants | 2 |
| `apps/relay/migrations/0004_rosters.sql` | *Create* — `rosters`, `roster_members` | 3 |
| `apps/relay/src/roster.ts` | *Create* — `mountRoster()`: create, join, bundle | 3, 4, 6 |
| `apps/relay/wrangler.jsonc` | *Modify* — `ROSTER_RL` binding | 3 |
| `apps/relay/src/index.ts` | *Modify* — `Env.ROSTER_RL`, `mountRoster(app)`, use `visibleTasks()` | 3, 5 |
| `packages/cli/src/search.ts` | *Create* — `tokenize`, `rank`, `sanitize`, `renderResults` (pure, no I/O) | 7, 10 |
| `packages/cli/src/paths.ts` | *Modify* — `rostersFile`, `rosterCacheFile` | 8 |
| `packages/cli/src/rosters.ts` | *Create* — membership records (throws on corruption) + bundle cache (rebuilds) | 8 |
| `packages/cli/src/api.ts` | *Modify* — `createRoster`, `joinRoster`, `fetchRosterBundle` | 9 |
| `packages/cli/src/index.ts` | *Modify* — `roster` command group, `search` command | 9, 10 |
| `README.md`, `CHANGELOG.md` | *Modify* — document the feature | 11 |

Rationale for the two-file split in `packages/cli/src/rosters.ts`: membership records and the fetched bundle have **opposite corruption policies** (throw vs rebuild), which is the single most important behavioral fact in that module — keeping them in one file makes the contrast visible at the point where someone might get it wrong.

---

### Task 1: `keywords` end-to-end

Nothing searches yet. This makes the field exist, be authorable in `SKILL.md`, and actually reach the relay. Splitting it would ship a dead field.

**Files:**
- Modify: `packages/shared/src/card.ts:10-15`
- Modify: `packages/cli/src/tasks.ts:42-48` (`SkillFrontmatter`), `:51-59` (`Task`), `:107-115` (`loadTasks` push), `:124-136` (`SKILL_TEMPLATE`)
- Modify: `packages/cli/src/card.ts:44`
- Test: `packages/shared/test/card.test.ts` (create), `packages/cli/test/tasks.test.ts` (extend), `packages/cli/test/card.test.ts` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `CardTask` now has `keywords: string[]`; `Task` (CLI) now has `keywords: string[]`.

- [ ] **Step 1: Write the failing shared test**

Create `packages/shared/test/card.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CardTask, CardUpload } from "../src/card.js";

const TASK = { id: "ask", name: "Ask", description: "Answer questions.", examples: [] };

describe("CardTask.keywords", () => {
  it("defaults to [] for a card stored before the field existed", () => {
    // This is the back-compat mechanism: .default([]) supplies the missing
    // field. (Zod's unknown-key stripping is a different property — it is what
    // let `tier` be removed — and is NOT what makes additions safe.)
    expect(CardTask.parse(TASK).keywords).toEqual([]);
  });

  it("round-trips supplied keywords", () => {
    expect(CardTask.parse({ ...TASK, keywords: ["auth", "migration"] }).keywords)
      .toEqual(["auth", "migration"]);
  });

  it("rejects a keyword longer than 40 characters", () => {
    expect(CardTask.safeParse({ ...TASK, keywords: ["a".repeat(41)] }).success).toBe(false);
  });

  it("rejects an empty-string keyword", () => {
    expect(CardTask.safeParse({ ...TASK, keywords: [""] }).success).toBe(false);
  });

  it("rejects a 21st keyword", () => {
    const many = Array.from({ length: 21 }, (_, i) => `k${i}`);
    expect(CardTask.safeParse({ ...TASK, keywords: many }).success).toBe(false);
  });

  it("keeps parsing a whole CardUpload stored before the field existed", () => {
    const upload = CardUpload.parse({
      description: "d", agent_kind: "claude", tasks: [TASK], default_offer: ["ask"],
    });
    expect(upload.tasks[0]!.keywords).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/shared && pnpm vitest run test/card.test.ts`
Expected: FAIL — `keywords` is `undefined`, and the over-length/empty/21st cases parse successfully because no such field exists.

- [ ] **Step 3: Add the field**

In `packages/shared/src/card.ts`, inside `CardTask`, after `examples`:

```ts
  // Bounded per-string like every neighbouring field. Unbounded keyword
  // strings amplify: 20 per task x 50 tasks x 200 roster members, re-sent on
  // every bundle refresh. These are the highest-weighted field in
  // `agentcall search`, so they are the callee's precision lever.
  keywords: z.array(z.string().min(1).max(40)).max(20).default([]),
```

- [ ] **Step 4: Confirm the shared test passes**

Run: `cd packages/shared && pnpm vitest run test/card.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing CLI frontmatter test**

Append to `packages/cli/test/tasks.test.ts` (match the file's existing fixture helper for writing a `SKILL.md` under a temp `tasksDir` — reuse it rather than inventing a second one):

```ts
describe("keywords frontmatter", () => {
  it("loads keywords from SKILL.md", () => {
    const p = writeTask("adr", [
      "---",
      "description: Why past architecture decisions were made.",
      "keywords: [auth, migration, adr]",
      "---",
      "body",
    ].join("\n"));
    const task = loadTasks(p).find((t) => t.id === "adr")!;
    expect(task.keywords).toEqual(["auth", "migration", "adr"]);
  });

  it("defaults keywords to [] when the frontmatter omits them", () => {
    const p = writeTask("plain", ["---", "description: A task.", "---", "body"].join("\n"));
    expect(loadTasks(p).find((t) => t.id === "plain")!.keywords).toEqual([]);
  });

  it("skips a task whose keywords exceed the cap, without killing others", () => {
    const p = writeTask("bad", [
      "---", "description: A task.",
      `keywords: [${Array.from({ length: 21 }, (_, i) => `k${i}`).join(", ")}]`,
      "---", "body",
    ].join("\n"));
    const ids = loadTasks(p, () => {}).map((t) => t.id);
    expect(ids).toContain("ask");     // built-in survives
    expect(ids).not.toContain("bad"); // one broken manifest never takes the rest offline
  });
});
```

If `packages/cli/test/tasks.test.ts` has no `writeTask` helper, add one at the top of the file:

```ts
function writeTask(id: string, skillMd: string): Paths {
  const home = mkdtempSync(join(tmpdir(), "agentcall-tasks-"));
  const p = getPaths(home);
  mkdirSync(join(p.tasksDir, id), { recursive: true });
  writeFileSync(join(p.tasksDir, id, "SKILL.md"), skillMd);
  return p;
}
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/tasks.test.ts`
Expected: FAIL — `task.keywords` is `undefined`; the cap test fails because `bad` loads fine.

- [ ] **Step 7: Thread `keywords` through `tasks.ts`**

In `SkillFrontmatter`, after `examples`:

```ts
  // Mirrors CardTask.keywords in packages/shared exactly. The two must not
  // drift: this is the authoring side of the field the search ranker weights
  // highest.
  keywords: z.array(z.string().min(1).max(40)).max(20).default([]),
```

In `interface Task`, after `examples: string[];`:

```ts
  keywords: string[];
```

In `ASK_TASK`, after `examples: [],`:

```ts
  keywords: [],
```

In the `tasks.push({...})` call in `loadTasks`, after `examples: fm.examples,`:

```ts
      keywords: fm.keywords,
```

In `SKILL_TEMPLATE`, after the `# examples:` block:

```
# keywords:              # search terms; weighted highest by \`agentcall search\`
#   - auth
#   - migration
```

- [ ] **Step 8: Confirm the frontmatter tests pass**

Run: `cd packages/cli && pnpm vitest run test/tasks.test.ts`
Expected: PASS.

- [ ] **Step 9: Write the failing publish test**

Append to `packages/cli/test/card.test.ts`:

```ts
it("publishes task keywords to the relay", () => {
  const upload = buildCardUpload(
    { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r.test" },
    { description: "d", default_offer: ["adr"], callers: {} },
    [{ id: "adr", name: "ADR", description: "Why.", examples: [],
       keywords: ["auth", "migration"], envelope: { caps: ["read"] }, skill: "" }],
  );
  expect(upload.tasks[0]!.keywords).toEqual(["auth", "migration"]);
});
```

- [ ] **Step 10: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/card.test.ts`
Expected: FAIL — `keywords` is `undefined`, because `buildCardUpload` destructures only `{id, name, description, examples}`.

- [ ] **Step 11: Publish the field**

In `packages/cli/src/card.ts:44`, change the map:

```ts
      .map(({ id, name, description, examples, keywords }) => ({ id, name, description, examples, keywords })),
```

Update the comment above `buildCardUpload` (`card.ts:14-18`) so it stays true — it currently enumerates the advertisement fields:

```ts
// The upload contains only advertisement fields (id/name/description/
// examples/keywords) — never envelopes or SKILL.md content.
```

- [ ] **Step 12: Full verification**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test` (from the repo root)
Expected: all PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/shared/src/card.ts packages/shared/test/card.test.ts \
        packages/cli/src/tasks.ts packages/cli/src/card.ts \
        packages/cli/test/tasks.test.ts packages/cli/test/card.test.ts
git commit -m "feat(card): add keywords to tasks, authorable in SKILL.md

The search ranker weights keywords highest. Threaded end-to-end in one
change: adding the shared schema field alone would ship a field that
buildCardUpload silently drops."
```

---

### Task 2: Roster schemas and bounds

**Files:**
- Create: `packages/shared/src/roster.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/test/roster.test.ts`

**Interfaces:**
- Consumes: `CardTask` from Task 1.
- Produces: `ROSTER_ID_RE`, `MAX_ROSTER_MEMBERS`, `MAX_BUNDLE_TASKS_PER_CARD`, `MAX_BUNDLE_BYTES`, `CreateRosterResponse`, `JoinRosterRequest`, `BundleTask`, `BundleEntry`, `RosterBundle`, and the types `RosterBundleType` / `BundleEntryType`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/test/roster.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CardTask } from "../src/card.js";
import {
  BundleEntry, MAX_BUNDLE_BYTES, MAX_BUNDLE_TASKS_PER_CARD, MAX_ROSTER_MEMBERS,
  ROSTER_ID_RE, RosterBundle,
} from "../src/roster.js";

const ENTRY = {
  handle: "tanaka", agent_kind: "claude", updated_at: 1, truncated: false,
  tasks: [{ id: "adr", name: "ADR", description: "Why.", keywords: ["auth"] }],
};

describe("roster ids", () => {
  it("accepts a generated-shape id", () => {
    expect(ROSTER_ID_RE.test("aBc-123_xyzQRS0987")).toBe(true);
  });
  it("rejects a too-short id, a path traversal, and a slash", () => {
    for (const bad of ["short", "../etc/passwd", "a/b", ""]) {
      expect(ROSTER_ID_RE.test(bad)).toBe(false);
    }
  });
});

describe("RosterBundle", () => {
  it("round-trips", () => {
    const b = RosterBundle.parse({ roster_id: "a".repeat(22), entries: [ENTRY], skipped: 0 });
    expect(b.entries[0]!.tasks[0]!.keywords).toEqual(["auth"]);
  });
  it("rejects an entry with more than MAX_BUNDLE_TASKS_PER_CARD tasks", () => {
    const tasks = Array.from({ length: MAX_BUNDLE_TASKS_PER_CARD + 1 }, (_, i) => ({
      id: `t${i}`, name: "N", description: "D", keywords: [],
    }));
    expect(RosterBundle.safeParse({
      roster_id: "a".repeat(22), entries: [{ ...ENTRY, tasks }], skipped: 0,
    }).success).toBe(false);
  });
  it("rejects more than MAX_ROSTER_MEMBERS entries", () => {
    const entries = Array.from({ length: MAX_ROSTER_MEMBERS + 1 }, (_, i) => ({
      ...ENTRY, handle: `h${i}`,
    }));
    expect(RosterBundle.safeParse({ roster_id: "a".repeat(22), entries, skipped: 0 }).success).toBe(false);
  });
  it("carries no `examples` field — they are deliberately not indexed", () => {
    const parsed = BundleEntry.parse(ENTRY);
    expect("examples" in parsed.tasks[0]!).toBe(false);
  });
});

describe("the bounds are arithmetic, not hope", () => {
  // This is the guard the spec calls for: raising MAX_CARD_TASKS or any card
  // field cap later must fail HERE rather than blow the response budget in
  // production. MAX_BUNDLE_BYTES is a design ceiling asserted by test, not a
  // runtime check that truncates a response.
  it("worst-case bundle stays under MAX_BUNDLE_BYTES", () => {
    const shape = CardTask.shape;
    const maxName = shape.name.maxLength ?? 0;
    const maxDescription = shape.description.maxLength ?? 0;
    // Every term traces to one named constant or a live schema read. Do NOT
    // hardcode: zod 4 does not expose .maxLength on a ZodArray (it returns
    // undefined — only .element.maxLength works), so the array caps are shared
    // via constants that the SCHEMAS themselves consume. That is what makes the
    // guard track the schema instead of restating it.
    const worstTask =
      MAX_TASK_ID_LENGTH + maxName + maxDescription + MAX_TASK_KEYWORDS * MAX_KEYWORD_LENGTH;
    const worst = MAX_ROSTER_MEMBERS * MAX_BUNDLE_TASKS_PER_CARD * worstTask;
    expect(worst).toBeLessThanOrEqual(MAX_BUNDLE_BYTES);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/shared && pnpm vitest run test/roster.test.ts`
Expected: FAIL — `Cannot find module '../src/roster.js'`.

- [ ] **Step 3: Write the module**

Create `packages/shared/src/roster.ts`:

```ts
import { z } from "zod";
import { HANDLE_RE, TASK_ID_RE } from "./protocol.js";

// A roster id is relay-generated and opaque. Deliberately NOT a memorable
// name: on a shared multi-tenant relay a global name like "acme" would be
// first-come-first-served squattable and would imply an affiliation that
// nothing verified. Display names are local-only, in the CLI's rosters.json.
//
// The id is unguessable but is NOT a secret — it travels in URL paths and
// will land in relay logs. The join secret is a separate value, which is why
// sharing an id does not grant the ability to join.
export const ROSTER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export const MAX_ROSTER_MEMBERS = 200;
export const MAX_BUNDLE_TASKS_PER_CARD = 10;
// Design ceiling asserted by test (see test/roster.test.ts), NOT a runtime
// truncation. The caps that bind at runtime are MAX_ROSTER_MEMBERS (at join)
// and MAX_BUNDLE_TASKS_PER_CARD (at projection).
export const MAX_BUNDLE_BYTES = 4_500_000;

export const CreateRosterResponse = z.object({
  roster_id: z.string().regex(ROSTER_ID_RE),
  secret: z.string().min(1),
});

export const JoinRosterRequest = z.object({
  secret: z.string().min(1).max(200),
});

// The search projection of a card task. `examples` are deliberately absent:
// at up to 5KB per task they are the largest thing a bundle would carry, and
// they are display detail available from `agentcall card <address>` once you
// know who to look up. If recall proves weak, the answer is `keywords` — a
// field the callee controls at 40 bytes a term — not re-shipping prose.
export const BundleTask = z.object({
  id: z.string().regex(TASK_ID_RE),
  name: z.string().max(100),
  description: z.string().max(1000),
  keywords: z.array(z.string().max(MAX_KEYWORD_LENGTH)).max(MAX_TASK_KEYWORDS).default([]),
});

export const BundleEntry = z.object({
  handle: z.string().regex(HANDLE_RE),
  agent_kind: z.enum(["claude", "codex"]),
  tasks: z.array(BundleTask).max(MAX_BUNDLE_TASKS_PER_CARD),
  updated_at: z.number(),
  // True when the member had more tasks than MAX_BUNDLE_TASKS_PER_CARD. The
  // bundle never truncates silently: search surfaces this to the user.
  truncated: z.boolean().default(false),
});

export const RosterBundle = z.object({
  roster_id: z.string().regex(ROSTER_ID_RE),
  entries: z.array(BundleEntry).max(MAX_ROSTER_MEMBERS),
  // Count of member cards that failed to parse and were skipped. One bad
  // legacy card must never 500 the bundle for the other 199 members.
  skipped: z.number().int().nonnegative().default(0),
});

export type BundleTaskType = z.infer<typeof BundleTask>;
export type BundleEntryType = z.infer<typeof BundleEntry>;
export type RosterBundleType = z.infer<typeof RosterBundle>;
```

- [ ] **Step 4: Export it**

Add to `packages/shared/src/index.ts`, alongside the existing re-exports:

```ts
export * from "./roster.js";
```

- [ ] **Step 5: Confirm the test passes**

Run: `cd packages/shared && pnpm vitest run test/roster.test.ts`
Expected: PASS. If the arithmetic guard fails, the fix is to lower `MAX_ROSTER_MEMBERS` or `MAX_BUNDLE_TASKS_PER_CARD` — **not** to raise `MAX_BUNDLE_BYTES`, which would defeat the point of the guard.

- [ ] **Step 6: Verify and commit**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/shared/src/roster.ts packages/shared/src/index.ts packages/shared/test/roster.test.ts
git commit -m "feat(shared): roster id, bundle schema, and bounds constants

MAX_BUNDLE_BYTES is a design ceiling asserted by test rather than a runtime
truncation: raising a card field cap later fails the arithmetic guard instead
of blowing the response budget in production."
```

---

### Task 3: Migration and `POST /v1/roster`

**Files:**
- Create: `apps/relay/migrations/0004_rosters.sql`, `apps/relay/src/roster.ts`
- Modify: `apps/relay/wrangler.jsonc` (`ratelimits` array), `apps/relay/src/index.ts` (`Env`, `mountRoster`), **`apps/relay/vitest.config.ts`** (see below)
- Test: `apps/relay/test/roster-create.test.ts`

**Interfaces:**
- Consumes: `CreateRosterResponse`, `ROSTER_ID_RE` (Task 2); `generateToken`, `sha256Hex`, `verifyHandleToken` from `apps/relay/src/auth.ts`.
- Produces: `mountRoster(app: Hono<{ Bindings: Env }>): void`; `Env.ROSTER_RL`; the `rosters` and `roster_members` tables.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/roster-create.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ROSTER_ID_RE } from "@benree/agentcall-shared";
import { registerHandle, wsAuth } from "./helpers.js";

async function createRoster(handle: string, token: string) {
  return SELF.fetch("https://relay.test/v1/roster", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
  });
}

describe("POST /v1/roster", () => {
  it("returns an opaque id and a secret to an authenticated handle", async () => {
    const token = await registerHandle("rc1");
    const res = await createRoster("rc1", token);
    expect(res.status).toBe(200);
    const body = await res.json<{ roster_id: string; secret: string }>();
    expect(ROSTER_ID_RE.test(body.roster_id)).toBe(true);
    expect(body.secret.length).toBeGreaterThan(20);
  });

  it("401s without credentials", async () => {
    expect((await SELF.fetch("https://relay.test/v1/roster", { method: "POST" })).status).toBe(401);
  });

  it("401s on a bad token", async () => {
    await registerHandle("rc2");
    expect((await createRoster("rc2", "wrong-token")).status).toBe(401);
  });

  it("gives each roster a distinct id", async () => {
    const token = await registerHandle("rc3");
    const a = await (await createRoster("rc3", token)).json<{ roster_id: string }>();
    const b = await (await createRoster("rc3", token)).json<{ roster_id: string }>();
    expect(a.roster_id).not.toBe(b.roster_id);
  });

  it("does not derive the id from the creating handle", async () => {
    const token = await registerHandle("rc4");
    const { roster_id } = await (await createRoster("rc4", token)).json<{ roster_id: string }>();
    expect(roster_id).not.toContain("rc4");
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/relay && pnpm vitest run test/roster-create.test.ts`
Expected: FAIL — 404, the route does not exist.

- [ ] **Step 3: Write the migration**

Create `apps/relay/migrations/0004_rosters.sql`:

```sql
-- A roster is a named set of handles that can discover each other via
-- `agentcall search`. There is deliberately no owner column: see the design
-- spec's "The honest tradeoff" — a single owner_handle creates a dead-owner
-- failure mode, because `uninstall --purge` destroys local credentials while
-- handle release is deliberately unimplemented.
CREATE TABLE rosters (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE roster_members (
  roster_id TEXT NOT NULL,
  handle TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (roster_id, handle)
);

-- Supports "which rosters does this handle belong to", which membership
-- checks and any future cleanup need; the PK only indexes the other direction.
CREATE INDEX roster_members_by_handle ON roster_members(handle);
```

- [ ] **Step 4: Add the rate-limit binding**

In `apps/relay/wrangler.jsonc`, append to the `ratelimits` array:

```jsonc
    ,
    // Roster join verifies a shared secret, so it is a credential-checking
    // endpoint and must not share READ_RL's 60/min read allowance. Keyed by
    // source IP *and* roster id at the call site.
    { "name": "ROSTER_RL", "namespace_id": "1004", "simple": { "limit": 10, "period": 60 } }
```

In `apps/relay/src/index.ts`, add to the `Env` type:

```ts
  // Roster join + bundle. Join verifies a shared secret; bundle returns up to
  // MAX_ROSTER_MEMBERS records at once. Neither belongs under READ_RL.
  ROSTER_RL: RateLimit;
```

- [ ] **Step 5: Write the create route**

Create `apps/relay/src/roster.ts`:

```ts
import type { Context, Hono } from "hono";
// Type-only, so the index -> roster -> index cycle is erased at compile time
// and never exists at runtime. Do not turn this into a value import — the
// same rule a2a.ts follows.
import type { Env } from "./index.js";
import { generateToken, sha256Hex, verifyHandleToken } from "./auth.js";

// 16 random bytes, base64url — 22 chars, inside ROSTER_ID_RE's 16..64 window.
// Unguessable but not secret: it travels in URL paths and will be logged.
function generateRosterId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

// Returns the verified handle, or null. Every roster route calls this first:
// possession of a handle token is the floor, not the gate — registration is
// open, so membership is what actually authorizes.
async function auth(c: Context<{ Bindings: Env }>): Promise<string | null> {
  const handle = c.req.header("X-AgentCall-Handle") ?? "";
  const token = (c.req.header("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return (await verifyHandleToken(c.env.DB, handle, token)) ? handle : null;
}

export function mountRoster(app: Hono<{ Bindings: Env }>): void {
  app.post("/v1/roster", async (c) => {
    const handle = await auth(c);
    if (!handle) return c.json({ error: "unauthorized" }, 401);
    // Reuses REGISTER_RL with a distinct key prefix, the same technique
    // /v1/token/rotate uses: creating rosters should cost what registering
    // handles costs, so it cannot be used to cheaply fill D1 with rows.
    if (!(await c.env.REGISTER_RL.limit({ key: `roster:${handle}` })).success) {
      return c.json({ error: "rate limited" }, 429);
    }
    const roster_id = generateRosterId();
    const secret = generateToken();
    await c.env.DB.prepare("INSERT INTO rosters (id, secret_hash, created_at) VALUES (?, ?, ?)")
      .bind(roster_id, await sha256Hex(secret), Date.now()).run();
    // The creator is a member like anyone else — there is no owner role.
    await c.env.DB.prepare("INSERT INTO roster_members (roster_id, handle, joined_at) VALUES (?, ?, ?)")
      .bind(roster_id, handle, Date.now()).run();
    // The secret is returned exactly once and never stored in plaintext.
    return c.json({ roster_id, secret });
  });
}
```

In `apps/relay/src/index.ts`, next to `mountA2A(app)`:

```ts
import { mountRoster } from "./roster.js";
// ...
mountRoster(app);
```

- [ ] **Step 6: Confirm the test passes**

Run: `cd apps/relay && pnpm vitest run test/roster-create.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Confirm nothing else broke**

Run: `cd apps/relay && pnpm test`
Expected: PASS. (`apps/relay/test/register.test.ts` has a documented wall-clock flake on the 6th-request 429 — if only that test fails, re-run it before investigating.)

- [ ] **Step 8: Commit**

```bash
git add apps/relay/migrations/0004_rosters.sql apps/relay/src/roster.ts \
        apps/relay/src/index.ts apps/relay/wrangler.jsonc apps/relay/test/roster-create.test.ts
git commit -m "feat(relay): roster tables and POST /v1/roster

Roster ids are relay-generated and opaque rather than memorable names:
on a shared multi-tenant relay, a global name like \"acme\" would be
squattable and would imply an affiliation nothing verified."
```

---

### Task 4: `POST /v1/roster/:id/join`

**Files:**
- Modify: `apps/relay/src/roster.ts`
- Test: `apps/relay/test/roster-join.test.ts`

**Interfaces:**
- Consumes: `mountRoster`, `generateRosterId` (Task 3); `JoinRosterRequest`, `MAX_ROSTER_MEMBERS`, `ROSTER_ID_RE` (Task 2); `constantTimeEqual`, `sha256Hex` from `auth.ts`.
- Produces: membership rows that Task 6's bundle route reads.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/roster-join.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

async function newRoster(handle: string) {
  const token = await registerHandle(handle);
  const res = await SELF.fetch("https://relay.test/v1/roster", {
    method: "POST",
    headers: { "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
  });
  return { token, ...(await res.json<{ roster_id: string; secret: string }>()) };
}

async function join(id: string, handle: string, token: string, secret: string) {
  return SELF.fetch(`https://relay.test/v1/roster/${id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
    body: JSON.stringify({ secret }),
  });
}

describe("POST /v1/roster/:id/join", () => {
  it("admits a handle with the correct secret", async () => {
    const r = await newRoster("rj1");
    const token = await registerHandle("rj1b");
    expect((await join(r.roster_id, "rj1b", token, r.secret)).status).toBe(200);
  });

  it("401s without credentials", async () => {
    const r = await newRoster("rj2");
    const res = await SELF.fetch(`https://relay.test/v1/roster/${r.roster_id}/join`, {
      method: "POST", body: JSON.stringify({ secret: r.secret }),
    });
    expect(res.status).toBe(401);
  });

  // THE load-bearing test: an unknown roster and a wrong secret must be
  // indistinguishable, or roster ids are enumerable by probing. Asserted as
  // equality of status AND body, not as two separate 404 checks.
  it("makes a wrong secret byte-identical to an unknown roster", async () => {
    const r = await newRoster("rj3");
    const token = await registerHandle("rj3b");
    const wrong = await join(r.roster_id, "rj3b", token, "not-the-secret");
    const missing = await join("A".repeat(22), "rj3b", token, "not-the-secret");
    expect(wrong.status).toBe(missing.status);
    expect(await wrong.text()).toBe(await missing.text());
    expect(wrong.status).toBe(404);
  });

  it("400s on a malformed roster id rather than querying for it", async () => {
    const token = await registerHandle("rj4");
    // NOT "../etc/passwd": URL dot-segment removal collapses "roster/../etc"
    // to "etc" before a Request object exists, so that input never reaches
    // this route at all — it would silently assert against Hono's no-route
    // 404 and look like security coverage while testing nothing.
    expect((await join("short!", "rj4", token, "x")).status).toBe(400);
  });

  it("400s on a percent-encoded traversal id, the form that actually reaches the route", async () => {
    // %2E%2E%2Fetc survives URL parsing as a single path segment, and Hono
    // decodes path params — so the handler really does see "../etc", which
    // ROSTER_ID_RE rejects (its character class has no "." or "/").
    const token = await registerHandle("rj4b");
    const res = await join("%2E%2E%2Fetc", "rj4b", token, "x");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid roster id" });
  });

  it("is idempotent: rejoining does not duplicate membership", async () => {
    const r = await newRoster("rj5");
    const token = await registerHandle("rj5b");
    expect((await join(r.roster_id, "rj5b", token, r.secret)).status).toBe(200);
    expect((await join(r.roster_id, "rj5b", token, r.secret)).status).toBe(200);
  });

  it("409s when the roster is full, since the caller already proved the secret", async () => {
    // Seeding MAX_ROSTER_MEMBERS handles through the API would blow the
    // register rate limit, so insert membership rows directly.
    const r = await newRoster("rj6");
    const db = (await import("cloudflare:test")).env.DB;
    const stmt = db.prepare("INSERT OR IGNORE INTO roster_members (roster_id, handle, joined_at) VALUES (?, ?, ?)");
    await db.batch(Array.from({ length: 200 }, (_, i) => stmt.bind(r.roster_id, `filler${i}`, 1)));
    const token = await registerHandle("rj6b");
    expect((await join(r.roster_id, "rj6b", token, r.secret)).status).toBe(409);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/relay && pnpm vitest run test/roster-join.test.ts`
Expected: FAIL — 404 from Hono's own no-route handler, so the indistinguishability test's *body* comparison fails even though both are 404.

- [ ] **Step 3: Implement join**

Add to `apps/relay/src/roster.ts`. First extend the imports:

```ts
import { constantTimeEqual, generateToken, sha256Hex, verifyHandleToken } from "./auth.js";
import { JoinRosterRequest, MAX_ROSTER_MEMBERS, ROSTER_ID_RE } from "@benree/agentcall-shared";
```

Then, inside `mountRoster`:

```ts
  // One shared body for "unknown roster" and "wrong secret". They MUST be
  // byte-identical: a distinct response for either one turns roster ids into
  // an enumerable namespace. Declared once so the two call sites cannot drift.
  const NOT_FOUND = { error: "not found" } as const;

  app.post("/v1/roster/:id/join", async (c) => {
    const handle = await auth(c);
    if (!handle) return c.json({ error: "unauthorized" }, 401);

    const id = c.req.param("id");
    // Shape-check before touching D1: a malformed id can never match a row,
    // and rejecting it here keeps junk out of the query path.
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `join:${ip}:${id}` })).success) {
      return c.json({ error: "rate limited" }, 429);
    }

    const body = JoinRosterRequest.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json(NOT_FOUND, 404);

    const row = await c.env.DB.prepare("SELECT secret_hash FROM rosters WHERE id = ?")
      .bind(id).first<{ secret_hash: string }>();
    // Hash the supplied secret even when the roster is missing, so the two
    // paths cost the same. Never log the secret or its digest.
    const supplied = await sha256Hex(body.data.secret);
    if (!row || !constantTimeEqual(row.secret_hash, supplied)) return c.json(NOT_FOUND, 404);

    // Past this point the caller has proved the secret, so revealing that the
    // roster exists and is full costs nothing.
    const already = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
    ).bind(id, handle).first();
    if (!already) {
      const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM roster_members WHERE roster_id = ?")
        .bind(id).first<{ n: number }>();
      if ((count?.n ?? 0) >= MAX_ROSTER_MEMBERS) return c.json({ error: "roster full" }, 409);
      await c.env.DB.prepare("INSERT INTO roster_members (roster_id, handle, joined_at) VALUES (?, ?, ?)")
        .bind(id, handle, Date.now()).run();
    }
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Confirm the test passes**

Run: `cd apps/relay && pnpm vitest run test/roster-join.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/relay/src/roster.ts apps/relay/test/roster-join.test.ts
git commit -m "feat(relay): POST /v1/roster/:id/join

Unknown roster and wrong secret return byte-identical 404s, asserted as
equality rather than as two separate status checks — the property is
indistinguishability, without which roster ids are enumerable by probing.
Join gets its own limiter: verifying a shared secret does not belong under
READ_RL's read allowance."
```

---

### Task 5: Extract `visibleTasks()` (refactor, no behavior change)

The bundle and `GET /v1/card/:handle` must apply identical visibility rules. Extracting first means Task 6 cannot re-implement — and cannot drop the prototype-key guard.

**Files:**
- Modify: `packages/shared/src/card.ts` (add helper), `apps/relay/src/index.ts:140-153`
- Test: `packages/shared/test/card.test.ts` (extend)

**Interfaces:**
- Consumes: `CardUpload` (Task 1).
- Produces: `visibleTasks(upload: CardUploadType, viewer: string): CardTaskType[]`.

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/card.test.ts`:

```ts
import { visibleTasks } from "../src/card.js";

const UPLOAD = CardUpload.parse({
  description: "d", agent_kind: "claude",
  tasks: [
    { id: "ask", name: "Ask", description: "Answer questions.", examples: [] },
    { id: "adr", name: "ADR", description: "Why.", examples: [] },
    { id: "payroll", name: "Payroll", description: "Secret.", examples: [] },
  ],
  default_offer: ["ask"],
  grants: { mia: ["adr"] },
});

describe("visibleTasks", () => {
  it("gives an anonymous viewer only default_offer", () => {
    expect(visibleTasks(UPLOAD, "").map((t) => t.id)).toEqual(["ask"]);
  });
  it("unions default_offer with the viewer's own grants", () => {
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr"]);
  });
  it("never leaks a task granted to someone else", () => {
    expect(visibleTasks(UPLOAD, "bob").map((t) => t.id)).toEqual(["ask"]);
  });
  it("returns tasks in card order, not grant order", () => {
    expect(visibleTasks(UPLOAD, "mia").map((t) => t.id)).toEqual(["ask", "adr"]);
  });
  // Regression: `grants` is a zod record inheriting Object.prototype, and
  // HANDLE_RE accepts "constructor". A bare grants[viewer] lookup returns the
  // Object constructor, which is not iterable and 500s the caller.
  it("does not hand back Object.prototype members for a viewer named constructor", () => {
    expect(visibleTasks(UPLOAD, "constructor").map((t) => t.id)).toEqual(["ask"]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/shared && pnpm vitest run test/card.test.ts`
Expected: FAIL — `visibleTasks is not a function`.

- [ ] **Step 3: Add the helper**

Append to `packages/shared/src/card.ts`:

```ts
// The single visibility rule: a viewer sees default_offer plus their own
// grants, never the full ACL. Lives here rather than in the relay route
// because two endpoints now apply it — GET /v1/card/:handle and the roster
// bundle — and they must not drift.
//
// Own-property check, not a bare lookup: `grants` is a zod z.record object
// that inherits Object.prototype, and HANDLE_RE accepts "constructor" — so
// `grants[viewer]` would hand back the Object constructor (not iterable,
// 500s the endpoint) for a viewer with that handle, against every callee.
export function visibleTasks(upload: CardUploadType, viewer: string): CardTaskType[] {
  const granted = viewer && Object.hasOwn(upload.grants, viewer) ? upload.grants[viewer]! : [];
  const visible = new Set([...upload.default_offer, ...granted]);
  return upload.tasks.filter((t) => visible.has(t.id));
}
```

- [ ] **Step 4: Confirm the shared test passes**

Run: `cd packages/shared && pnpm vitest run test/card.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in the relay route**

In `apps/relay/src/index.ts`, replace lines 140-153 (from `const upload = CardUpload.parse(...)` to the `return c.json({...})`), keeping the surrounding auth logic untouched:

```ts
  const upload = CardUpload.parse(JSON.parse(row.card_json));
  return c.json({
    handle,
    description: upload.description,
    agent_kind: upload.agent_kind,
    tasks: visibleTasks(upload, viewer),
    updated_at: row.updated_at,
  });
```

Add `visibleTasks` to the existing `@benree/agentcall-shared` import at the top of the file. Delete the now-relocated `Object.hasOwn` comment block from the route — the explanation moved with the code.

- [ ] **Step 6: Confirm the relay behaves identically**

Run: `pnpm -r build && cd apps/relay && pnpm test`
Expected: PASS with **no changes to `apps/relay/test/card.test.ts`**. This is a pure refactor; if any card test needed editing, the extraction changed behavior and must be revisited.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/card.ts packages/shared/test/card.test.ts apps/relay/src/index.ts
git commit -m "refactor(shared): extract visibleTasks() from the card route

Two endpoints will now apply the same visibility rule. Extracting before
adding the second one means the roster bundle cannot re-implement it, and
cannot lose the Object.hasOwn guard against a viewer named \"constructor\"."
```

---

### Task 6: `GET /v1/roster/:id/bundle`

**Files:**
- Modify: `apps/relay/src/roster.ts`
- Test: `apps/relay/test/roster-bundle.test.ts`

**Interfaces:**
- Consumes: `visibleTasks` (Task 5); `MAX_BUNDLE_TASKS_PER_CARD`, `RosterBundle` (Task 2); membership rows (Task 4).
- Produces: a `RosterBundle`-shaped response that `fetchRosterBundle` (Task 9) parses.

- [ ] **Step 1: Write the failing test**

Create `apps/relay/test/roster-bundle.test.ts`:

```ts
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { registerHandle, wsAuth } from "./helpers.js";

const card = (tasks: unknown[], defaultOffer: string[], grants: Record<string, string[]> = {}) => ({
  description: "d", agent_kind: "claude", tasks, default_offer: defaultOffer, grants,
});
const task = (id: string, keywords: string[] = []) =>
  ({ id, name: id.toUpperCase(), description: `About ${id}.`, examples: [], keywords });

async function setup(prefix: string) {
  const ownerToken = await registerHandle(`${prefix}own`);
  const created = await (await SELF.fetch("https://relay.test/v1/roster", {
    method: "POST", headers: { "cf-connecting-ip": `test-${prefix}`, ...wsAuth(`${prefix}own`, ownerToken) },
  })).json<{ roster_id: string; secret: string }>();
  return { ownerToken, ...created };
}

async function joinAs(id: string, handle: string, secret: string) {
  const token = await registerHandle(handle);
  await SELF.fetch(`https://relay.test/v1/roster/${id}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token) },
    body: JSON.stringify({ secret }),
  });
  return token;
}

async function putCard(handle: string, token: string, body: unknown) {
  return SELF.fetch("https://relay.test/v1/card", {
    method: "PUT",
    headers: { "content-type": "application/json", ...wsAuth(handle, token) },
    body: JSON.stringify(body),
  });
}

const getBundle = (id: string, handle: string, token: string, extra: Record<string, string> = {}) =>
  SELF.fetch(`https://relay.test/v1/roster/${id}/bundle`, {
    headers: { "cf-connecting-ip": `test-${handle}`, ...wsAuth(handle, token), ...extra },
  });

describe("GET /v1/roster/:id/bundle", () => {
  it("returns members' publicly offered tasks to a member", async () => {
    const r = await setup("b1");
    const tanaka = await joinAs(r.roster_id, "b1tanaka", r.secret);
    await putCard("b1tanaka", tanaka, card([task("adr", ["auth"])], ["adr"]));
    const body = await (await getBundle(r.roster_id, "b1own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).toEqual(["b1tanaka"]);
    expect(body.entries[0].tasks[0].keywords).toEqual(["auth"]);
  });

  it("shows a privately granted task only to its grantee", async () => {
    const r = await setup("b2");
    const tanaka = await joinAs(r.roster_id, "b2tanaka", r.secret);
    const mia = await joinAs(r.roster_id, "b2mia", r.secret);
    await putCard("b2tanaka", tanaka, card([task("ask"), task("payroll")], ["ask"], { b2mia: ["payroll"] }));
    const forMia = await (await getBundle(r.roster_id, "b2mia", mia)).json<any>();
    const forOwner = await (await getBundle(r.roster_id, "b2own", r.ownerToken)).json<any>();
    const ids = (b: any, h: string) => b.entries.find((e: any) => e.handle === h).tasks.map((t: any) => t.id);
    expect(ids(forMia, "b2tanaka").sort()).toEqual(["ask", "payroll"]);
    expect(ids(forOwner, "b2tanaka")).toEqual(["ask"]);
  });

  // The claim the first design draft got wrong: an entry carrying a handle
  // still discloses membership even with zero tasks. Omission is what makes
  // a member invisible. This endpoint is a search index, not a directory.
  it("omits a member with no visible tasks entirely", async () => {
    const r = await setup("b3");
    const quiet = await joinAs(r.roster_id, "b3quiet", r.secret);
    await putCard("b3quiet", quiet, card([task("payroll")], [], { someone_else: ["payroll"] }));
    const body = await (await getBundle(r.roster_id, "b3own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).not.toContain("b3quiet");
  });

  it("omits a member who has published no card at all", async () => {
    const r = await setup("b4");
    await joinAs(r.roster_id, "b4nocard", r.secret);
    const body = await (await getBundle(r.roster_id, "b4own", r.ownerToken)).json<any>();
    expect(body.entries.map((e: any) => e.handle)).not.toContain("b4nocard");
  });

  it("makes a non-member byte-identical to an unknown roster", async () => {
    const r = await setup("b5");
    const outsider = await registerHandle("b5out");
    const denied = await getBundle(r.roster_id, "b5out", outsider);
    const missing = await getBundle("A".repeat(22), "b5out", outsider);
    expect(denied.status).toBe(missing.status);
    expect(await denied.text()).toBe(await missing.text());
    expect(denied.status).toBe(404);
  });

  it("401s without credentials", async () => {
    const r = await setup("b6");
    expect((await SELF.fetch(`https://relay.test/v1/roster/${r.roster_id}/bundle`)).status).toBe(401);
  });

  it("caps tasks per member and flags the entry as truncated", async () => {
    const r = await setup("b7");
    const many = await joinAs(r.roster_id, "b7many", r.secret);
    const ids = Array.from({ length: 15 }, (_, i) => `t${i}`);
    await putCard("b7many", many, card(ids.map((id) => task(id)), ids));
    const body = await (await getBundle(r.roster_id, "b7own", r.ownerToken)).json<any>();
    const entry = body.entries.find((e: any) => e.handle === "b7many");
    expect(entry.tasks).toHaveLength(10);
    expect(entry.truncated).toBe(true);
  });

  it("skips a malformed stored card without 500ing the whole bundle", async () => {
    const r = await setup("b8");
    const good = await joinAs(r.roster_id, "b8good", r.secret);
    await joinAs(r.roster_id, "b8bad", r.secret);
    await putCard("b8good", good, card([task("adr")], ["adr"]));
    const db = (await import("cloudflare:test")).env.DB;
    await db.prepare("INSERT INTO cards (handle, card_json, updated_at) VALUES (?, ?, ?)")
      .bind("b8bad", "{not json", Date.now()).run();
    const res = await getBundle(r.roster_id, "b8own", r.ownerToken);
    expect(res.status).toBe(200);
    const body = await res.json<any>();
    expect(body.entries.map((e: any) => e.handle)).toEqual(["b8good"]);
    expect(body.skipped).toBe(1);
  });

  it("304s an unchanged bundle and forbids shared caching", async () => {
    const r = await setup("b9");
    const t = await joinAs(r.roster_id, "b9t", r.secret);
    await putCard("b9t", t, card([task("adr")], ["adr"]));
    const first = await getBundle(r.roster_id, "b9own", r.ownerToken);
    expect(first.headers.get("Cache-Control")).toContain("private");
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    const second = await getBundle(r.roster_id, "b9own", r.ownerToken, { "If-None-Match": etag });
    expect(second.status).toBe(304);
  });

  it("gives two different callers different ETags", async () => {
    const r = await setup("b10");
    const t = await joinAs(r.roster_id, "b10t", r.secret);
    const mia = await joinAs(r.roster_id, "b10mia", r.secret);
    await putCard("b10t", t, card([task("ask")], ["ask"]));
    const a = await getBundle(r.roster_id, "b10own", r.ownerToken);
    const b = await getBundle(r.roster_id, "b10mia", mia);
    expect(a.headers.get("ETag")).not.toBe(b.headers.get("ETag"));
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/relay && pnpm vitest run test/roster-bundle.test.ts`
Expected: FAIL — no such route.

- [ ] **Step 3: Implement the bundle route**

Extend the shared import in `apps/relay/src/roster.ts`:

```ts
import {
  CardUpload, JoinRosterRequest, MAX_BUNDLE_TASKS_PER_CARD, MAX_ROSTER_MEMBERS,
  ROSTER_ID_RE, visibleTasks,
} from "@benree/agentcall-shared";
```

Add inside `mountRoster`:

```ts
  app.get("/v1/roster/:id/bundle", async (c) => {
    const viewer = await auth(c);
    if (!viewer) return c.json({ error: "unauthorized" }, 401);

    const id = c.req.param("id");
    if (!ROSTER_ID_RE.test(id)) return c.json({ error: "invalid roster id" }, 400);

    const ip = c.req.header("cf-connecting-ip") ?? "unknown";
    if (!(await c.env.ROSTER_RL.limit({ key: `bundle:${ip}:${id}` })).success) {
      return c.json({ error: "rate limited" }, 429);
    }

    // Membership is the real authorization. Possession of a handle token is
    // not a gate: registration is open. Checked BEFORE anything reveals that
    // the roster exists, and a non-member gets the same NOT_FOUND an unknown
    // roster gets.
    const member = await c.env.DB.prepare(
      "SELECT 1 FROM roster_members WHERE roster_id = ? AND handle = ?",
    ).bind(id, viewer).first();
    if (!member) return c.json(NOT_FOUND, 404);

    // One bounded join, never N queries. Bounded by MAX_ROSTER_MEMBERS,
    // which join enforces.
    const { results } = await c.env.DB.prepare(
      "SELECT c.handle, c.card_json, c.updated_at FROM roster_members m " +
        "JOIN cards c ON c.handle = m.handle WHERE m.roster_id = ? ORDER BY c.handle",
    ).bind(id).all<{ handle: string; card_json: string; updated_at: number }>();

    const entries = [];
    let skipped = 0;
    let newest = 0;
    for (const row of results ?? []) {
      let upload;
      try {
        upload = CardUpload.parse(JSON.parse(row.card_json));
      } catch {
        // One bad legacy card must not 500 the bundle for everyone else.
        skipped++;
        continue;
      }
      const visible = visibleTasks(upload, viewer);
      // Zero visible tasks means omitted entirely, not an empty entry: an
      // entry carrying a handle would disclose membership. This endpoint is
      // a search index, not an org directory.
      if (visible.length === 0) continue;
      entries.push({
        handle: row.handle,
        agent_kind: upload.agent_kind,
        // `examples` are deliberately dropped — see BundleTask in
        // packages/shared/src/roster.ts.
        tasks: visible.slice(0, MAX_BUNDLE_TASKS_PER_CARD).map((t) => ({
          id: t.id, name: t.name, description: t.description, keywords: t.keywords,
        })),
        updated_at: row.updated_at,
        truncated: visible.length > MAX_BUNDLE_TASKS_PER_CARD,
      });
      if (row.updated_at > newest) newest = row.updated_at;
    }

    // Varies by caller (grants differ), so the ETag must include the viewer
    // and the response must never enter a shared cache.
    const etag = `"${id}-${viewer}-${newest}-${entries.length}-${skipped}"`;
    if (c.req.header("If-None-Match") === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-store" } });
    }
    return c.json({ roster_id: id, entries, skipped }, 200, {
      ETag: etag,
      "Cache-Control": "private, no-store",
    });
  });
```

`NOT_FOUND` is already declared in `mountRoster` from Task 4 — reuse it, do not redeclare.

- [ ] **Step 4: Confirm the test passes**

Run: `cd apps/relay && pnpm vitest run test/roster-bundle.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Verify and commit**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add apps/relay/src/roster.ts apps/relay/test/roster-bundle.test.ts
git commit -m "feat(relay): GET /v1/roster/:id/bundle, per-caller filtered

Membership is checked before anything reveals the roster exists, and a
non-member response is byte-identical to an unknown roster: possession of a
handle token is not a gate, because registration is open.

Members with zero visible tasks are omitted rather than returned empty — an
entry carrying a handle discloses membership regardless of its task list."
```

---

### Task 7: The ranker

Pure functions, no I/O, no clock. This is where the false-positive discipline lives.

**Files:**
- Create: `packages/cli/src/search.ts`
- Test: `packages/cli/test/search.test.ts`

**Interfaces:**
- Consumes: nothing (deliberately — the ranker never touches the network or disk).
- Produces:
  - `tokenize(text: string): string[]`
  - `SearchEntry = { roster: string; handle: string; address: string; task: string; name: string; description: string; keywords: string[] }`
  - `Match = { term: string; fields: SearchField[] }` where `SearchField = "keywords" | "name" | "description"`
  - `SearchResult = SearchEntry & { score: number; matched: Match[] }`
  - `rank(query: string, entries: SearchEntry[], limit?: number): SearchResult[]`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/search.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rank, tokenize, type SearchEntry } from "../src/search.js";

const entry = (over: Partial<SearchEntry>): SearchEntry => ({
  roster: "acme", handle: "tanaka", address: "tanaka@relay.test", task: "adr",
  name: "ADR history", description: "Why past decisions were made.", keywords: [], ...over,
});

describe("tokenize", () => {
  it("splits hyphens, so a hyphenated task id matches its parts", () => {
    expect(tokenize("architecture-history")).toEqual(["architecture", "history"]);
  });
  it("lowercases and drops punctuation", () => {
    // "why", "did", and "we" are all stopwords; "auth" is the only term
    // carrying topical signal, and it survives lowercased. Do not pick an
    // example word that is itself on the stopword list.
    expect(tokenize("Why DID we AUTH?!")).toEqual(["auth"]);
  });
  it("NFKC-normalizes full-width input", () => {
    expect(tokenize("ＡＵＴＨ")).toEqual(["auth"]);
  });
  it("returns nothing for a query that is only stopwords", () => {
    expect(tokenize("the and of for")).toEqual([]);
  });
});

describe("rank", () => {
  it("finds a colleague by a keyword", () => {
    const results = rank("auth migration", [entry({ keywords: ["auth", "migration"] })]);
    expect(results).toHaveLength(1);
    expect(results[0]!.handle).toBe("tanaka");
  });

  // Proves matching runs against the cache CONTENTS, not a hardcoded list.
  // A wholly invented colleague with a nonsense term must route.
  it("routes a fictitious colleague with an invented term", () => {
    const results = rank("zzzcustomtoolkit please", [
      entry({ handle: "nobody", address: "nobody@relay.test", task: "invented",
              name: "Invented", description: "d", keywords: ["zzzcustomtoolkit"] }),
    ]);
    expect(results[0]!.handle).toBe("nobody");
  });

  it("weights keywords above name above description", () => {
    const results = rank("payroll", [
      entry({ handle: "c", task: "in-description", description: "Handles payroll.", name: "N" }),
      entry({ handle: "a", task: "in-keywords", keywords: ["payroll"], name: "N", description: "D" }),
      entry({ handle: "b", task: "in-name", name: "Payroll", description: "D" }),
    ]);
    expect(results.map((r) => r.task)).toEqual(["in-keywords", "in-name", "in-description"]);
  });

  it("scores presence, not count — repetition cannot buy rank", () => {
    const spammy = entry({ handle: "spam", task: "spam", description: "payroll ".repeat(50), name: "N" });
    const honest = entry({ handle: "honest", task: "honest", keywords: ["payroll"], name: "N", description: "D" });
    expect(rank("payroll", [spammy, honest])[0]!.handle).toBe("honest");
  });

  it("accumulates a term across fields", () => {
    const both = rank("payroll", [entry({ keywords: ["payroll"], name: "Payroll", description: "D" })])[0]!;
    expect(both.score).toBe(5);                                   // keywords 3 + name 2
    expect(both.matched[0]!.fields).toEqual(["keywords", "name"]);
  });

  it("breaks ties by handle then task id, deterministically", () => {
    const results = rank("payroll", [
      entry({ handle: "zoe", task: "b", keywords: ["payroll"] }),
      entry({ handle: "amy", task: "b", keywords: ["payroll"] }),
      entry({ handle: "amy", task: "a", keywords: ["payroll"] }),
    ]);
    expect(results.map((r) => `${r.handle}/${r.task}`)).toEqual(["amy/a", "amy/b", "zoe/b"]);
  });

  it("honors the limit, defaulting to 5", () => {
    const many = Array.from({ length: 9 }, (_, i) => entry({ handle: `h${i}`, keywords: ["payroll"] }));
    expect(rank("payroll", many)).toHaveLength(5);
    expect(rank("payroll", many, 2)).toHaveLength(2);
  });

  it("returns nothing rather than a fallback list when nothing matches", () => {
    expect(rank("quantum tunnelling", [entry({ keywords: ["payroll"] })])).toEqual([]);
  });

  it("returns nothing for an all-stopword query", () => {
    expect(rank("the and of", [entry({ keywords: ["payroll"] })])).toEqual([]);
  });

  // The discipline that decides whether this tool survives contact with
  // users. Every one of these is ordinary coding vocabulary that must NOT
  // suggest a colleague. Adapted from Composio's bare-verb test.
  it.each([
    "deploy the worker to production",
    "fix the failing test",
    "write an email validation regex",
    "the issue is on line 42",
    "post the results to the console",
    "connect to the local postgres database",
  ])("stays silent on bare coding vocabulary: %s", (query) => {
    const roster = [
      entry({ handle: "tanaka", task: "adr", keywords: ["adr"], name: "ADR history",
              description: "Why past architecture decisions were made." }),
      entry({ handle: "mia", task: "payroll", keywords: ["payroll", "salary"], name: "Payroll",
              description: "Answers payroll questions." }),
    ];
    expect(rank(query, roster)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/search.test.ts`
Expected: FAIL — `Cannot find module '../src/search.js'`.

- [ ] **Step 3: Write the ranker**

Create `packages/cli/src/search.ts`:

```ts
// A deliberately small, deterministic lexical ranker. It runs entirely on the
// caller's machine — the query text never reaches the relay — and its output
// is consumed by an LLM, which does the final semantic pick. That division is
// why this does not need embeddings: the expensive judgment already has a
// model attached, so this only has to be a good, honest prefilter.

export type SearchField = "keywords" | "name" | "description";

// Weighted highest first. `examples` are absent because the roster bundle
// does not carry them (see BundleTask in packages/shared/src/roster.ts).
const WEIGHTS: Record<SearchField, number> = { keywords: 3, name: 2, description: 1 };
const FIELDS: SearchField[] = ["keywords", "name", "description"];

// Small and closed on purpose. Every entry is a word that carries no topical
// signal in a question; adding domain words here would silently suppress real
// matches, so this list should stay boring.
const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "but", "by", "can", "did", "do",
  "does", "for", "from", "get", "has", "have", "how", "i", "if", "in", "is", "it", "its", "me",
  "my", "of", "on", "or", "our", "should", "so", "than", "that", "the", "their", "them", "then",
  "there", "these", "they", "this", "to", "up", "us", "was", "we", "were", "what", "when",
  "where", "which", "who", "why", "will", "with", "would", "you", "your",
]);

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

export interface SearchEntry {
  roster: string;
  handle: string;
  address: string;
  task: string;
  name: string;
  description: string;
  keywords: string[];
  // True when this member had more tasks than the bundle indexes. Carried so
  // the renderer can say so — the bundle never truncates silently.
  truncated?: boolean;
}

export interface Match {
  term: string;
  fields: SearchField[];
}

export interface SearchResult extends SearchEntry {
  score: number;
  matched: Match[];
}

export const DEFAULT_SEARCH_LIMIT = 5;

// A result must clear this to be shown. With weights keywords:3, name:2,
// description:1, a curated hit qualifies on its own (a keyword, or the task
// name), and two corroborating description terms qualify — but a SINGLE
// incidental word in prose does not.
//
// This is not arbitrary. Without it, a colleague whose CI task description
// merely mentioned "deploy" and "test" was routed for the queries "deploy the
// worker to production" and "fix the failing test", neither of which they can
// help with. One low-weight term in prose is not evidence, and a tool that
// answers those questions gets muted — at which point it finds nobody.
export const MIN_SCORE = 2;

// Plain codepoint comparison rather than localeCompare: tie-break order must
// be identical on every machine, and localeCompare is locale-dependent.
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function rank(query: string, entries: SearchEntry[], limit = DEFAULT_SEARCH_LIMIT): SearchResult[] {
  // Deduped, so repeating a word in the question cannot skew the ranking.
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const scored: SearchResult[] = [];
  for (const e of entries) {
    const tokens: Record<SearchField, Set<string>> = {
      keywords: new Set(e.keywords.flatMap(tokenize)),
      name: new Set(tokenize(e.name)),
      description: new Set(tokenize(e.description)),
    };
    let score = 0;
    const matched: Match[] = [];
    for (const term of terms) {
      // Presence per field, never count: a card cannot climb by repeating a
      // term. Accumulating the same term across fields IS intended — a word
      // in both the keywords and the description is corroborating evidence.
      const fields = FIELDS.filter((f) => tokens[f].has(term));
      if (fields.length === 0) continue;
      for (const f of fields) score += WEIGHTS[f];
      matched.push({ term, fields });
    }
    if (score >= MIN_SCORE) scored.push({ ...e, score, matched });
  }

  scored.sort(
    (a, b) => b.score - a.score || cmp(a.handle, b.handle) || cmp(a.task, b.task),
  );
  return scored.slice(0, limit);
}
```

- [ ] **Step 4: Confirm the test passes**

Run: `cd packages/cli && pnpm vitest run test/search.test.ts`
Expected: PASS. If an over-firing case fails, **do not add the offending word to `STOPWORDS` reflexively** — first check whether the fixture card genuinely should match. Stopwords suppress matches globally.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/search.ts packages/cli/test/search.test.ts
git commit -m "feat(cli): lexical ranker for agentcall search

Pure, deterministic, no I/O: the query never leaves the machine. Scores
presence per field rather than count, so repetition cannot buy rank, and
ties break by handle then task id so output is assertable.

Over-firing tests come first: a tool that suggests a colleague on \"deploy
the worker\" gets muted within days."
```

---

### Task 8: Membership records and the bundle cache

**Files:**
- Modify: `packages/cli/src/paths.ts`
- Create: `packages/cli/src/rosters.ts`
- Test: `packages/cli/test/rosters.test.ts`

**Interfaces:**
- Consumes: `RosterBundleType`, `BundleEntryType` (Task 2); `Paths`.
- Produces:
  - `Membership = { name: string; relay: string; roster_id: string }`
  - `loadMemberships(p): Membership[]` — **throws** on corruption
  - `saveMembership(p, m): void`, `forgetMembership(p, name): void`
  - `CachedBundle = { relay: string; caller: string; roster_id: string; etag?: string; fetched_at: number; entries: BundleEntryType[]; skipped: number }`
  - `loadCache(p): Record<string, CachedBundle>` — **rebuilds** on corruption
  - `readCached(p, name, identity): CachedBundle | null` — identity-validating read
  - `writeCached(p, name, bundle): void` — atomic
  - `CACHE_TTL_MS`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/rosters.test.ts`:

```ts
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getPaths } from "../src/paths.js";
import {
  CACHE_TTL_MS, forgetMembership, loadCache, loadMemberships, readCached,
  saveMembership, writeCached,
} from "../src/rosters.js";

const paths = () => getPaths(mkdtempSync(join(tmpdir(), "agentcall-roster-")));
const IDENTITY = { relay: "https://r.test", caller: "ken" };
const BUNDLE = {
  relay: "https://r.test", caller: "ken", roster_id: "a".repeat(22),
  fetched_at: 1_000, entries: [], skipped: 0,
};

describe("memberships (user data)", () => {
  it("round-trips", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(loadMemberships(p)).toEqual([{ name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) }]);
  });

  it("is empty before anything is saved", () => {
    expect(loadMemberships(paths())).toEqual([]);
  });

  // The join secret is discarded after join, so this file is the ONLY way
  // back to a roster you still belong to. Silently resetting it would lock
  // the user out permanently — same reasoning as loadContacts.
  it("throws on corruption instead of resetting", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    writeFileSync(p.rostersFile, "{not json");
    expect(() => loadMemberships(p)).toThrow(/rosters\.json/);
  });

  it("forgets a local record", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    forgetMembership(p, "acme");
    expect(loadMemberships(p)).toEqual([]);
  });

  it("writes 0600 — memberships are personal data", () => {
    const p = paths();
    saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
    expect(statSync(p.rostersFile).mode & 0o777).toBe(0o600);
  });
});

describe("bundle cache (derived data)", () => {
  it("round-trips and writes 0600", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", IDENTITY)!.roster_id).toBe("a".repeat(22));
    expect(statSync(p.rosterCacheFile).mode & 0o777).toBe(0o600);
  });

  it("rebuilds on corruption rather than throwing", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    writeFileSync(p.rosterCacheFile, "{not json");
    expect(loadCache(p)).toEqual({});
  });

  // Without this, switching relays or handles could serve one identity the
  // tasks another identity was privately granted.
  it("refuses to serve a bundle fetched by a different caller", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", { relay: "https://r.test", caller: "someone-else" })).toBeNull();
  });

  it("refuses to serve a bundle fetched from a different relay", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    expect(readCached(p, "acme", { relay: "https://other.test", caller: "ken" })).toBeNull();
  });

  it("does not leave the previous cache corrupt if a write is interrupted", () => {
    const p = paths();
    writeCached(p, "acme", BUNDLE);
    // A temp file left behind by a killed process must not be mistaken for
    // the cache: the real file is only ever replaced by an atomic rename.
    writeFileSync(`${p.rosterCacheFile}.tmp`, "{not json");
    expect(readCached(p, "acme", IDENTITY)).not.toBeNull();
  });

  it("exposes a 15 minute TTL", () => {
    expect(CACHE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/rosters.test.ts`
Expected: FAIL — `Cannot find module '../src/rosters.js'`.

- [ ] **Step 3: Add the paths**

In `packages/cli/src/paths.ts`, add to the `Paths` interface:

```ts
  rostersFile: string; rosterCacheFile: string;
```

and to the returned object:

```ts
    rostersFile: join(dir, "rosters.json"),
    rosterCacheFile: join(dir, "roster-cache.json"),
```

- [ ] **Step 4: Write the module**

Create `packages/cli/src/rosters.ts`:

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { BundleEntry, ROSTER_ID_RE } from "@benree/agentcall-shared";
import type { Paths } from "./paths.js";

// Two stores with DELIBERATELY OPPOSITE corruption policies, kept in one file
// so the contrast is visible where someone might get it wrong:
//
//   rosters.json      user data  -> THROWS. The join secret is discarded at
//                                   join time, so this is the only surviving
//                                   route back into a roster you belong to.
//                                   Resetting it locks the user out for good.
//   roster-cache.json derived    -> REBUILDS. Losing it costs one refetch.

export const CACHE_TTL_MS = 15 * 60 * 1000;

const Membership = z.object({
  name: z.string().min(1),
  relay: z.string().min(1),
  roster_id: z.string().regex(ROSTER_ID_RE),
});
// .loose() so unknown top-level keys survive a load+save round-trip under an
// older CLI, matching contacts.json.
const MembershipsFile = z.object({ rosters: z.array(Membership).default([]) }).loose();
export type Membership = z.infer<typeof Membership>;

const CachedBundle = z.object({
  relay: z.string(),
  caller: z.string(),
  roster_id: z.string(),
  etag: z.string().optional(),
  fetched_at: z.number(),
  entries: z.array(BundleEntry),
  skipped: z.number().default(0),
});
const CacheFile = z.object({ version: z.literal(1), rosters: z.record(z.string(), CachedBundle) });
export type CachedBundle = z.infer<typeof CachedBundle>;

// Temp-then-rename: a killed process can leave a partial .tmp behind, but the
// real file is only ever replaced atomically, so a reader never sees a
// half-written cache.
function writeAtomic(file: string, dir: string, data: unknown): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export function loadMemberships(p: Paths): Membership[] {
  if (!existsSync(p.rostersFile)) return [];
  try {
    return MembershipsFile.parse(JSON.parse(readFileSync(p.rostersFile, "utf8"))).rosters;
  } catch (e) {
    throw new Error(
      `Corrupt rosters.json at ${p.rostersFile}: ${e instanceof Error ? e.message : String(e)}. ` +
        `This file holds the roster ids you joined; the join secrets are not recoverable, so it is not reset automatically.`,
    );
  }
}

export function saveMembership(p: Paths, m: Membership): void {
  const rosters = loadMemberships(p).filter((r) => r.name.toLowerCase() !== m.name.toLowerCase());
  rosters.push(m);
  writeAtomic(p.rostersFile, p.dir, { rosters });
}

export function forgetMembership(p: Paths, name: string): void {
  const rosters = loadMemberships(p);
  const next = rosters.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
  if (next.length === rosters.length) {
    throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
  }
  writeAtomic(p.rostersFile, p.dir, { rosters: next });
}

export function loadCache(p: Paths): Record<string, CachedBundle> {
  if (!existsSync(p.rosterCacheFile)) return {};
  try {
    return CacheFile.parse(JSON.parse(readFileSync(p.rosterCacheFile, "utf8"))).rosters;
  } catch {
    // Derived data: a corrupt cache costs a refetch, not user data.
    return {};
  }
}

// Identity-validating read. A cached bundle is only ever served back to the
// exact (relay, caller) that fetched it, because it contains tasks granted
// privately to that caller. Any mismatch is a miss, never a downgrade.
export function readCached(
  p: Paths, name: string, identity: { relay: string; caller: string },
): CachedBundle | null {
  const hit = loadCache(p)[name];
  if (!hit) return null;
  if (hit.relay !== identity.relay || hit.caller !== identity.caller) return null;
  return hit;
}

export function writeCached(p: Paths, name: string, bundle: CachedBundle): void {
  writeAtomic(p.rosterCacheFile, p.dir, { version: 1, rosters: { ...loadCache(p), [name]: bundle } });
}
```

- [ ] **Step 5: Confirm the test passes**

Run: `cd packages/cli && pnpm vitest run test/rosters.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Verify and commit**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/cli/src/paths.ts packages/cli/src/rosters.ts packages/cli/test/rosters.test.ts
git commit -m "feat(cli): roster membership records and bundle cache

Two stores with opposite corruption policies. rosters.json throws like
contacts.json: the join secret is discarded at join time, so it is the only
surviving route back into a roster. roster-cache.json rebuilds, because
losing derived bundles costs one refetch.

Cached bundles are only served back to the exact (relay, caller) that
fetched them — they contain privately granted tasks."
```

---

### Task 9: Relay client and `agentcall roster` commands

**Files:**
- Modify: `packages/cli/src/api.ts`, `packages/cli/src/index.ts`
- Test: `packages/cli/test/api.test.ts` (extend)

**Interfaces:**
- Consumes: `CreateRosterResponse`, `RosterBundle`, `RosterBundleType` (Task 2); `Membership`, `saveMembership`, `loadMemberships`, `forgetMembership` (Task 8). Note `packages/cli/src/api.ts` already declares `relayFetch`, `RELAY_TIMEOUT_MS`, and `ApiError` — reuse them, do not redeclare.
- Produces:
  - `createRoster(relay, auth, opts?): Promise<{roster_id: string; secret: string}>`
  - `joinRoster(relay, auth, rosterId, secret, opts?): Promise<void>`
  - `fetchRosterBundle(relay, auth, rosterId, etag?, opts?): Promise<{bundle: RosterBundleType; etag?: string} | "not-modified">`
  - CLI commands `roster create|join|list|forget`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/api.test.ts`, following that file's existing `fetch`-stubbing pattern:

```ts
describe("roster api", () => {
  it("creates a roster and returns the secret once", async () => {
    stubFetch({ status: 200, json: { roster_id: "a".repeat(22), secret: "s3cret-value-long" } });
    const r = await createRoster("https://r.test", { handle: "ken", token: "t" });
    expect(r.roster_id).toBe("a".repeat(22));
  });

  it("maps a 404 join to a message that does not distinguish the two causes", async () => {
    stubFetch({ status: 404, json: { error: "not found" } });
    await expect(joinRoster("https://r.test", { handle: "ken", token: "t" }, "a".repeat(22), "wrong"))
      .rejects.toThrow(/no such roster, or the secret is wrong/i);
  });

  it("maps a 409 join to a roster-full message", async () => {
    stubFetch({ status: 409, json: { error: "roster full" } });
    await expect(joinRoster("https://r.test", { handle: "ken", token: "t" }, "a".repeat(22), "s"))
      .rejects.toThrow(/full/i);
  });

  it("returns the parsed bundle and its ETag", async () => {
    stubFetch({
      status: 200, headers: { ETag: '"etag-1"' },
      json: { roster_id: "a".repeat(22), entries: [], skipped: 0 },
    });
    const out = await fetchRosterBundle("https://r.test", { handle: "ken", token: "t" }, "a".repeat(22));
    expect(out).not.toBe("not-modified");
    expect((out as { etag?: string }).etag).toBe('"etag-1"');
  });

  it("reports not-modified on a 304 instead of parsing an empty body", async () => {
    stubFetch({ status: 304 });
    const out = await fetchRosterBundle("https://r.test", { handle: "ken", token: "t" }, "a".repeat(22), '"etag-1"');
    expect(out).toBe("not-modified");
  });
});
```

If `packages/cli/test/api.test.ts` has no `stubFetch` helper, add one matching how the existing tests already replace `globalThis.fetch`, returning `{ status, headers, json }`.

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/api.test.ts`
Expected: FAIL — the three functions are not exported.

- [ ] **Step 3: Add the client functions**

Append to `packages/cli/src/api.ts` (extend the shared import to include `CreateRosterResponse`, `RosterBundle`, and the type `RosterBundleType`):

```ts
export async function createRoster(
  relay: string, auth: { handle: string; token: string }, opts: { timeoutMs?: number } = {},
): Promise<{ roster_id: string; secret: string }> {
  const res = await relayFetch(
    relay, "/v1/roster",
    { method: "POST", headers: { Authorization: `Bearer ${auth.token}`, "X-AgentCall-Handle": auth.handle } },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many rosters created — try again in a minute.", "network");
  if (!res.ok) throw new ApiError(`Roster creation failed (${res.status}).`, "network");
  return CreateRosterResponse.parse(await res.json());
}

export async function joinRoster(
  relay: string, auth: { handle: string; token: string }, rosterId: string, secret: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const res = await relayFetch(
    relay, `/v1/roster/${rosterId}/join`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${auth.token}`,
        "X-AgentCall-Handle": auth.handle,
      },
      body: JSON.stringify({ secret }),
    },
    opts.timeoutMs ?? RELAY_TIMEOUT_MS,
  );
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many join attempts — try again in a minute.", "network");
  // The relay deliberately cannot tell these apart, and neither can this
  // message: distinguishing them would make roster ids enumerable.
  if (res.status === 404) {
    throw new ApiError("No such roster, or the secret is wrong.", "unknown_handle");
  }
  if (res.status === 409) throw new ApiError("That roster is full.", "invalid");
  if (!res.ok) throw new ApiError(`Joining the roster failed (${res.status}).`, "network");
}

// Returns "not-modified" rather than a bundle when the relay 304s, so the
// caller keeps its cached entries instead of parsing an empty body.
export async function fetchRosterBundle(
  relay: string, auth: { handle: string; token: string }, rosterId: string, etag?: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ bundle: RosterBundleType; etag?: string } | "not-modified"> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.token}`,
    "X-AgentCall-Handle": auth.handle,
  };
  if (etag) headers["If-None-Match"] = etag;
  const res = await relayFetch(relay, `/v1/roster/${rosterId}/bundle`, { headers }, opts.timeoutMs ?? RELAY_TIMEOUT_MS);
  if (res.status === 304) return "not-modified";
  if (res.status === 401) throw new ApiError("Your credentials were rejected. Re-run `agentcall setup`.", "invalid");
  if (res.status === 429) throw new ApiError("Too many roster refreshes — try again in a minute.", "network");
  if (res.status === 404) {
    throw new ApiError("That roster is gone, or you are no longer a member.", "unknown_handle");
  }
  if (!res.ok) throw new ApiError(`Roster refresh failed (${res.status}).`, "network");
  return { bundle: RosterBundle.parse(await res.json()), etag: res.headers.get("ETag") ?? undefined };
}
```

- [ ] **Step 4: Confirm the api test passes**

Run: `cd packages/cli && pnpm vitest run test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `roster` command group**

In `packages/cli/src/index.ts`, after the `contacts` group:

```ts
const roster = program.command("roster").description("join and manage discovery rosters for `agentcall search`");

roster
  .command("create")
  .description("create a roster and print its id and join secret")
  .option("--as <name>", "local name to record it under", "roster")
  .action(async (o: { as: string }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    const { roster_id, secret } = await createRoster(relayUrl(cfg), { handle: cfg.handle, token: cfg.token });
    saveMembership(paths, { name: o.as, relay: relayUrl(cfg), roster_id });
    console.log(`Roster created and saved locally as "${o.as}".\n`);
    console.log(`  id:     ${roster_id}`);
    console.log(`  secret: ${secret}\n`);
    // Printed once and never stored: the relay keeps only a SHA-256 digest.
    console.log("The secret is shown once and is not recoverable. Share both with colleagues:");
    console.log(`  agentcall roster join ${roster_id} --secret ${secret} --as ${o.as}`);
  });

roster
  .command("join")
  .description("join a roster so `agentcall search` can see its members")
  .argument("<roster-id>", "roster id shared by whoever created it")
  .requiredOption("--secret <secret>", "the roster's join secret")
  .option("--as <name>", "local name for this roster", "roster")
  .action(async (rosterId: string, o: { secret: string; as: string }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    await joinRoster(relayUrl(cfg), { handle: cfg.handle, token: cfg.token }, rosterId, o.secret);
    // The secret is spent here and never written to disk: from now on the
    // handle token plus the relay-side membership row is what authorizes.
    saveMembership(paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
    console.log(`Joined. Saved locally as "${o.as}".`);
    console.log(`Try: agentcall search "<what you need to know>"`);
  });

roster
  .command("list")
  .description("list rosters this install has joined")
  .action(() => {
    const rosters = loadMemberships(getPaths());
    if (rosters.length === 0) {
      console.log("No rosters joined. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>");
      return;
    }
    for (const r of rosters) console.log(`${r.name}\t${r.roster_id}\t${r.relay}`);
  });

roster
  .command("forget")
  .description("drop the local record of a roster (does NOT remove your membership on the relay)")
  .argument("<name>", "local roster name")
  .action((name: string) => {
    forgetMembership(getPaths(), name);
    console.log(`Forgot "${name}" locally. Your membership on the relay is unchanged — there is no leave operation.`);
  });
```

**Extend the existing `./api.js` import** at the top of `index.ts` rather than adding a second import statement from the same module — add `createRoster` and `joinRoster` to it. Then add one new line:

```ts
import { forgetMembership, loadMemberships, saveMembership } from "./rosters.js";
```

`fetchRosterBundle` is *not* imported here: `searchRefresh.ts` (Task 10) imports it directly, which is what keeps every network call for search in one module.

- [ ] **Step 6: Verify and commit**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/cli/src/api.ts packages/cli/src/index.ts packages/cli/test/api.test.ts
git commit -m "feat(cli): roster create/join/list/forget

The join secret is spent at join time and never written to disk. \`forget\`
is explicitly local-only and says so: there is no leave operation, which is
the tradeoff the design accepted."
```

---

### Task 10: `agentcall search`

**Files:**
- Modify: `packages/cli/src/search.ts` (add `sanitize`, `renderResults`, `toEntries`), `packages/cli/src/index.ts`
- Test: `packages/cli/test/search.test.ts` (extend), `packages/cli/test/search-refresh.test.ts` (create)

**Interfaces:**
- Consumes: `rank`, `SearchResult` (Task 7); `readCached`, `writeCached`, `loadMemberships`, `CACHE_TTL_MS` (Task 8); `fetchRosterBundle` (Task 9).
- Produces:
  - `sanitize(text: string, max?: number): string`
  - `toEntries(roster: string, host: string, entries: BundleEntryType[]): SearchEntry[]`
  - `renderResults(results: SearchResult[], rosters: {name: string; ageSeconds: number; stale: boolean}[]): string`
  - `refreshRoster(...)` in `index.ts`, or inline in the action — see step 5.

- [ ] **Step 1: Write the failing render test**

Append to `packages/cli/test/search.test.ts`:

```ts
import { renderResults, sanitize, toEntries } from "../src/search.js";

describe("sanitize", () => {
  // Callee-authored text reaching a caller's terminal is escape-injection
  // surface — the same reason MAX_DETAIL_LENGTH exists in the protocol.
  it("strips ANSI escapes and other control characters", () => {
    expect(sanitize("[2Jwiped")).toBe("[2Jwiped");
  });
  it("truncates past the limit", () => {
    expect(sanitize("x".repeat(300), 10)).toHaveLength(10);
  });
  it("leaves ordinary text alone", () => {
    expect(sanitize("Why we picked OAuth — the ADR.")).toBe("Why we picked OAuth — the ADR.");
  });
});

describe("toEntries", () => {
  it("builds handle@host addresses and flattens tasks", () => {
    const entries = toEntries("acme", "relay.test", [
      { handle: "tanaka", agent_kind: "claude", updated_at: 1, truncated: false,
        tasks: [{ id: "adr", name: "ADR", description: "Why.", keywords: ["auth"] },
                { id: "ask", name: "Ask", description: "Q.", keywords: [] }] },
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.address).toBe("tanaka@relay.test");
    expect(entries[0]!.roster).toBe("acme");
  });
});

describe("renderResults", () => {
  const results = rank("auth migration", [
    { roster: "acme", handle: "tanaka", address: "tanaka@relay.test", task: "adr",
      name: "ADR history", description: "Why decisions were made.", keywords: ["auth", "migration"] },
  ]);

  it("prints a runnable command with --task before the message", () => {
    // Matches the canonical ordering `agentcall card` already prints.
    expect(renderResults(results, [{ name: "acme", ageSeconds: 5, stale: false }]))
      .toContain('agentcall call tanaka@relay.test --task adr "<message>"');
  });

  it("shows which terms matched and where, so the agent can judge", () => {
    expect(renderResults(results, [{ name: "acme", ageSeconds: 5, stale: false }]))
      .toMatch(/matched:.*auth.*keywords/);
  });

  it("says nothing matched rather than listing a fallback", () => {
    const out = renderResults([], [{ name: "acme", ageSeconds: 5, stale: false }]);
    expect(out).toMatch(/no match/i);
    expect(out).not.toContain("agentcall call");
  });

  it("names a stale roster and its age", () => {
    expect(renderResults(results, [{ name: "acme", ageSeconds: 7200, stale: true }]))
      .toMatch(/acme.*stale/i);
  });

  it("says when a member's tasks were not fully indexed", () => {
    const truncated = rank("payroll", [
      { roster: "acme", handle: "mia", address: "mia@relay.test", task: "payroll",
        name: "Payroll", description: "d", keywords: ["payroll"], truncated: true },
    ]);
    expect(renderResults(truncated, [{ name: "acme", ageSeconds: 1, stale: false }]))
      .toContain("agentcall card mia@relay.test");
  });

  it("emits no escape sequences even when a card contains them", () => {
    // The payload goes in `description` and `task` because those are what the
    // human renderer actually prints. `name` is deliberately NOT rendered --
    // the output shows the task id, which is what `--task` needs -- so name
    // earns its place by being scored, not displayed. The --json path does
    // emit `name`, and sanitizes it there.
    const evil = rank("payroll", [
      { roster: "acme", handle: "x", address: "x@relay.test",
        task: "\u001b[31mpayroll-report", name: "Payroll",
        description: "\u001b[2Jwiped", keywords: ["payroll"] },
    ]);
    const output = renderResults(evil, [{ name: "acme", ageSeconds: 1, stale: false }]);
    const lines = output.split("\n");
    // No control character WITHIN any line: ESC, CR, BEL and friends. Do NOT
    // assert /\p{Cc}/u against the whole string -- that category includes
    // U+000A, so it matches the renderer's own structural newlines and the
    // assertion could never pass on correct multi-line output.
    for (const line of lines) expect(line).not.toMatch(/\p{Cc}/u);
    // And no EXTRA lines. sanitize() strips control characters from field
    // content, so a callee cannot smuggle a newline in to forge a result line
    // or paint over real output. Splitting on "\n" alone would hide exactly
    // that, which is why the line count is asserted too.
    // Compute this from the fixture rather than guessing; it is the assertion
    // that makes an injected newline detectable.
    expect(lines).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/search.test.ts`
Expected: FAIL — `sanitize`, `toEntries`, `renderResults` are not exported.

- [ ] **Step 3: Implement render**

Append to `packages/cli/src/search.ts`:

```ts
import type { BundleEntryType } from "@benree/agentcall-shared";

// Callee-authored text lands on a caller's terminal, which is
// escape-injection surface — ESC/CSI sequences can clear the screen, retitle
// the window, or paint fake output over a real error. Same reasoning as
// MAX_DETAIL_LENGTH in packages/shared/src/protocol.ts.
//
// Applied at RENDER time, not at parse time, so the cache stays faithful to
// what the relay actually served and matching runs on the real text.
export function sanitize(text: string, max = 200): string {
  const stripped = text.replace(/[\p{Cc}\p{Cf}]/gu, "");
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

export function toEntries(roster: string, host: string, entries: BundleEntryType[]): SearchEntry[] {
  return entries.flatMap((e) =>
    e.tasks.map((t) => ({
      roster,
      handle: e.handle,
      address: `${e.handle}@${host}`,
      task: t.id,
      name: t.name,
      description: t.description,
      keywords: t.keywords,
      truncated: e.truncated,
    })),
  );
}

export interface RosterStatus {
  name: string;
  ageSeconds: number;
  stale: boolean;
}

export function renderResults(results: SearchResult[], rosters: RosterStatus[]): string {
  const lines: string[] = [];
  for (const r of rosters) {
    if (r.stale) {
      lines.push(`warning: roster "${r.name}" is ${Math.round(r.ageSeconds / 60)}m stale (relay unreachable)`);
    }
  }
  if (results.length === 0) {
    // No fallback list, ever. A tool that guesses when it does not know gets
    // muted, and a muted tool finds nobody.
    lines.push(`no match in ${rosters.map((r) => `"${r.name}"`).join(", ") || "any roster"}`);
    return lines.join("\n");
  }
  for (const r of results) {
    lines.push(`${r.address}  ${sanitize(r.task, 64)}`);
    lines.push(`  ${sanitize(r.description, 200)}`);
    lines.push(
      `  matched: ${r.matched.map((m) => `${sanitize(m.term, 40)} (${m.fields.join(", ")})`).join(" · ")}`,
    );
    lines.push(`  agentcall call ${r.address} --task ${sanitize(r.task, 64)} "<message>"`);
    // No silent truncation: if the bundle dropped tasks for this member, say
    // so and point at the command that shows the full card.
    if (r.truncated) {
      lines.push(`  (more tasks not indexed — see: agentcall card ${r.address})`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
```

- [ ] **Step 4: Confirm the render tests pass**

Run: `cd packages/cli && pnpm vitest run test/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing refresh-policy test**

Create `packages/cli/test/search-refresh.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getPaths } from "../src/paths.js";
import { saveMembership, writeCached } from "../src/rosters.js";
import { ApiError } from "../src/api.js";
import { refreshRoster } from "../src/searchRefresh.js";

const setup = () => {
  const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-refresh-")));
  saveMembership(p, { name: "acme", relay: "https://r.test", roster_id: "a".repeat(22) });
  return p;
};
const AUTH = { handle: "ken", token: "t" };
const IDENTITY = { relay: "https://r.test", caller: "ken" };
const cached = (fetchedAt: number) => ({
  relay: "https://r.test", caller: "ken", roster_id: "a".repeat(22),
  etag: '"e1"', fetched_at: fetchedAt, entries: [], skipped: 0,
});

describe("refreshRoster", () => {
  it("does not touch the network when the cache is fresh", async () => {
    const p = setup();
    writeCached(p, "acme", cached(Date.now()));
    const fetcher = vi.fn();
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.stale).toBe(false);
  });

  it("refreshes a stale cache", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockResolvedValue({
      bundle: { roster_id: "a".repeat(22), entries: [], skipped: 0 }, etag: '"e2"',
    });
    await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps cached entries on a 304", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockResolvedValue("not-modified");
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(out.stale).toBe(false);
    expect(out.entries).toEqual([]);
  });

  // Fail OPEN: search decides what to PRINT, not whether code runs. Failing
  // closed here protects nothing — the relay still gates the actual call —
  // while silently deleting the feature.
  it("serves a stale cache with a warning when the relay is unreachable", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockRejectedValue(new ApiError("down", "network"));
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() });
    expect(out.stale).toBe(true);
    expect(out.entries).toEqual([]);
  });

  // The ONE place fail-closed is right: the relay is reporting that your
  // ACCESS changed. Serving stale results would advertise people you can no
  // longer reach.
  it("refuses to serve results on a 404", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn().mockRejectedValue(new ApiError("gone", "unknown_handle"));
    await expect(refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() }))
      .rejects.toThrow(/no longer a member|gone/i);
  });

  it("errors on a cold cache with no network", async () => {
    const p = setup();
    const fetcher = vi.fn().mockRejectedValue(new ApiError("down", "network"));
    await expect(refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now() }))
      .rejects.toThrow(/never been fetched|agentcall roster join/i);
  });

  it("never refreshes when offline is set", async () => {
    const p = setup();
    writeCached(p, "acme", cached(0));
    const fetcher = vi.fn();
    const out = await refreshRoster(p, "acme", "a".repeat(22), IDENTITY, AUTH, { fetcher, now: Date.now(), offline: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(out.stale).toBe(true);
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd packages/cli && pnpm vitest run test/search-refresh.test.ts`
Expected: FAIL — `Cannot find module '../src/searchRefresh.js'`.

- [ ] **Step 7: Implement the refresh policy**

Create `packages/cli/src/searchRefresh.ts`:

```ts
import type { BundleEntryType } from "@benree/agentcall-shared";
import { ApiError, fetchRosterBundle } from "./api.js";
import { CACHE_TTL_MS, readCached, writeCached } from "./rosters.js";
import type { Paths } from "./paths.js";

export interface RefreshOptions {
  fetcher?: typeof fetchRosterBundle;
  now?: number;
  offline?: boolean;
}

export interface RefreshResult {
  entries: BundleEntryType[];
  ageSeconds: number;
  stale: boolean;
}

// The failure policy is deliberately fail-OPEN, the opposite of the
// PreToolUse guard's stance, with exactly one exception. The guard decides
// whether code runs; this decides what gets printed. Failing closed on a
// network blip protects nothing — the relay still enforces membership on the
// actual call, and the callee's policy still enforces disclosure — while
// silently deleting the feature. The exception is a 404: there the relay is
// telling us the caller's ACCESS changed, and serving stale results would
// advertise people they can no longer reach.
export async function refreshRoster(
  p: Paths,
  name: string,
  rosterId: string,
  identity: { relay: string; caller: string },
  auth: { handle: string; token: string },
  opts: RefreshOptions = {},
): Promise<RefreshResult> {
  const now = opts.now ?? Date.now();
  const fetcher = opts.fetcher ?? fetchRosterBundle;
  const hit = readCached(p, name, identity);
  const ageMs = hit ? now - hit.fetched_at : Infinity;

  if (hit && !opts.offline && ageMs < CACHE_TTL_MS) {
    return { entries: hit.entries, ageSeconds: Math.floor(ageMs / 1000), stale: false };
  }
  if (opts.offline) {
    if (!hit) {
      throw new Error(`Roster "${name}" has never been fetched and --offline was set. Drop --offline, or run \`agentcall roster join\`.`);
    }
    return { entries: hit.entries, ageSeconds: Math.floor(ageMs / 1000), stale: true };
  }

  try {
    const out = await fetcher(identity.relay, auth, rosterId, hit?.etag);
    if (out === "not-modified") {
      // Nothing changed; re-stamp so the TTL restarts without a refetch.
      writeCached(p, name, { ...hit!, fetched_at: now });
      return { entries: hit!.entries, ageSeconds: 0, stale: false };
    }
    writeCached(p, name, {
      relay: identity.relay, caller: identity.caller, roster_id: rosterId,
      etag: out.etag, fetched_at: now, entries: out.bundle.entries, skipped: out.bundle.skipped,
    });
    return { entries: out.bundle.entries, ageSeconds: 0, stale: false };
  } catch (e) {
    // The relay says the roster is gone or membership ended: fail closed.
    if (e instanceof ApiError && e.code === "unknown_handle") throw e;
    if (!hit) {
      throw new Error(
        `Roster "${name}" has never been fetched and the relay is unreachable (${e instanceof Error ? e.message : String(e)}). ` +
          `Retry when online, or run \`agentcall roster join\`.`,
      );
    }
    return { entries: hit.entries, ageSeconds: Math.floor(ageMs / 1000), stale: true };
  }
}
```

- [ ] **Step 8: Confirm the refresh tests pass**

Run: `cd packages/cli && pnpm vitest run test/search-refresh.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 9: Wire up the command**

In `packages/cli/src/index.ts`:

```ts
program
  .command("search")
  .description("find which colleague's agent can answer something")
  .argument("<question...>", "what you need to know")
  .option("--roster <name>", "search only this roster (default: all joined rosters)")
  .option("--limit <n>", "maximum results", (v) => Number.parseInt(v, 10), DEFAULT_SEARCH_LIMIT)
  .option("--json", "machine-readable output for your own agent")
  .option("--offline", "never refresh; use whatever is cached")
  .action(async (questionParts: string[], o: { roster?: string; limit: number; json?: boolean; offline?: boolean }) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    const relay = relayUrl(cfg);
    const identity = { relay, caller: cfg.handle };
    const memberships = loadMemberships(paths)
      .filter((m) => m.relay === relay)
      .filter((m) => !o.roster || m.name.toLowerCase() === o.roster.toLowerCase());

    if (memberships.length === 0) {
      console.error(
        o.roster
          ? `No roster named "${o.roster}" on ${relay} — run \`agentcall roster list\`.`
          : `No rosters joined on ${relay}. Ask a colleague for a roster id and secret, then:\n  agentcall roster join <id> --secret <secret> --as <name>`,
      );
      process.exitCode = 1;
      return;
    }

    const host = new URL(relay).host;
    const entries: SearchEntry[] = [];
    const statuses: RosterStatus[] = [];
    for (const m of memberships) {
      try {
        // Each roster degrades on its own: one unreachable roster must not
        // take down a search across the others.
        const out = await refreshRoster(paths, m.name, m.roster_id, identity, { handle: cfg.handle, token: cfg.token }, { offline: o.offline });
        entries.push(...toEntries(m.name, host, out.entries));
        statuses.push({ name: m.name, ageSeconds: out.ageSeconds, stale: out.stale });
      } catch (e) {
        console.error(`${m.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    const results = rank(questionParts.join(" "), entries, o.limit);
    if (o.json) {
      console.log(JSON.stringify({
        query: questionParts.join(" "),
        rosters: statuses.map((s) => ({ name: s.name, cache_age_seconds: s.ageSeconds, stale: s.stale })),
        results: results.map((r) => ({
          roster: r.roster, address: r.address, handle: r.handle, task: r.task,
          name: sanitize(r.name, 100), description: sanitize(r.description, 1000),
          score: r.score, matched: r.matched,
        })),
      }));
      return;
    }
    console.log(renderResults(results, statuses));
  });
```

Extend the imports at the top of `index.ts`:

```ts
import { DEFAULT_SEARCH_LIMIT, rank, renderResults, sanitize, toEntries, type RosterStatus, type SearchEntry } from "./search.js";
import { refreshRoster } from "./searchRefresh.js";
```

- [ ] **Step 10: Verify and commit**

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
git add packages/cli/src/search.ts packages/cli/src/searchRefresh.ts packages/cli/src/index.ts \
        packages/cli/test/search.test.ts packages/cli/test/search-refresh.test.ts
git commit -m "feat(cli): agentcall search

Ranks (colleague, task) pairs from cached roster bundles. The query never
leaves the machine. Output carries the matched terms and fields so the
calling agent can judge, plus the exact call command to run next.

Fails open on a network blip and closed on a 404: search decides what to
print, but a 404 means access changed, and stale results would advertise
people the caller can no longer reach."
```

---

### Task 11: Documentation and the scope guard

**Files:**
- Modify: `README.md`, `CHANGELOG.md`
- Test: `packages/cli/test/search-scope.test.ts` (create)

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the scope guard test**

Create `packages/cli/test/search-scope.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

// A scope guard, in the spirit of the exact-hook-set test the Composio
// research doc calls out. The design deliberately shipped explicit search
// ONLY: proactive routing (a UserPromptSubmit hook that suggests a colleague
// as you type) needs its own false-positive discipline and its own spec.
//
// If you are here because this test failed, that is the point: adding
// proactive routing must be a deliberate decision that edits this assertion,
// not a side effect of another change.
describe("search scope", () => {
  it("registers no SessionStart or UserPromptSubmit behavior", () => {
    for (const f of ["../src/search.ts", "../src/searchRefresh.ts", "../src/rosters.ts"]) {
      const src = read(f);
      expect(src).not.toContain("SessionStart");
      expect(src).not.toContain("UserPromptSubmit");
    }
  });

  it("keeps the ranker free of network and filesystem access", () => {
    const src = read("../src/search.ts");
    // The privacy claim — the query never leaves the machine — is only as
    // good as this. Keep I/O in searchRefresh.ts and api.ts.
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toContain("node:fs");
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/cli && pnpm vitest run test/search-scope.test.ts`
Expected: PASS immediately. This test guards a property the previous tasks already have; it fails only if someone later violates it.

- [ ] **Step 3: Document in README.md**

Add after the existing "Usage" block:

````markdown
## Finding who to ask

`agentcall call` assumes you already know the address. In a company you often
don't — that's what rosters and `agentcall search` are for.

A **roster** is an opt-in group whose members can discover each other's
published tasks. One person creates it and shares the id and secret:

```bash
agentcall roster create --as acme
# → id and join secret, printed once

# everyone else:
agentcall roster join <roster-id> --secret <secret> --as acme
```

Then search by what you need, not by who you know:

```bash
agentcall search "why did we pick this auth migration"
# tanaka@agentcall.benree.tech  architecture-history
#   Why past architecture decisions were made — ADR context and rationale.
#   matched: auth, migration (keywords) · migration (description)
#   agentcall call tanaka@agentcall.benree.tech --task architecture-history "<message>"

agentcall search "..." --json    # for your own agent to parse
```

**Matching happens on your machine.** The relay serves a filtered index of what
each member publishes *to you*; the ranking runs locally, so your query text is
never sent anywhere. Refreshing a roster does tell the relay that you refreshed
it, so search *activity* isn't private — the query is.

Add `keywords` to a task's `SKILL.md` frontmatter to make it findable; they're
weighted highest:

```yaml
---
description: Why past architecture decisions were made.
keywords: [auth, migration, adr]
---
```

**There is no way to remove someone from a roster, and no way to rotate its
secret.** If the secret leaks, abandon the roster and create a new one.
`agentcall roster forget` only drops your *local* record — your membership on
the relay stays. Membership lifecycle is deliberate follow-up work.

Results are hints, not permission: a task can appear in search and still be
refused when you call it, because the callee's policy is what actually decides.
````

- [ ] **Step 4: Document in CHANGELOG.md**

Add under the current unreleased heading (match the file's existing format):

```markdown
### Added

- `agentcall search "<question>"` — find which colleague's agent can answer
  something, ranked over an opt-in roster. Matching runs locally; the query
  text is never sent to the relay.
- `agentcall roster create|join|list|forget` — opt-in discovery groups, joined
  with a shared secret.
- `keywords` in a task's `SKILL.md` frontmatter, published on the agent card
  and weighted highest by search.
- Relay: `POST /v1/roster`, `POST /v1/roster/:id/join`,
  `GET /v1/roster/:id/bundle` (per-caller filtered), plus the `rosters` and
  `roster_members` tables.

### Known limitations

- No way to expel a roster member or rotate a roster secret. A leaked join
  secret means abandoning the roster.
```

- [ ] **Step 5: Full verification**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all PASS. (`apps/relay/test/register.test.ts` has a documented wall-clock flake — re-run before investigating if only that fails.)

- [ ] **Step 6: Commit**

```bash
git add README.md CHANGELOG.md packages/cli/test/search-scope.test.ts
git commit -m "docs: document rosters and agentcall search

Includes a scope guard test: search registers no SessionStart or
UserPromptSubmit behavior, and the ranker touches neither network nor
filesystem. Proactive routing must be a deliberate decision that edits that
assertion, not a side effect."
```

---

## Post-implementation

- [ ] Run the full gate one more time from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
- [ ] Apply migration `0004_rosters.sql` to the deployed D1 before the relay change goes live — the bundle route 500s against a database without those tables.
- [ ] Close [#24](https://github.com/KenTaniguchi-R/agentcall/issues/24) referencing the spec, and open the follow-up issue for **roster membership lifecycle** (expel, secret rotation, teardown) so the accepted tradeoff is tracked rather than forgotten.
