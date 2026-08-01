# Task-Menu Owner UX (Phase 1.5) Implementation Plan

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

**Goal:** Make task menus easy to author and manage: one-file frontmatter SKILL.md tasks, `agentcall card` self-view with lint, flat policy verbs that auto-publish, and a `task new` scaffold.

**Architecture:** All changes live in `packages/cli` — no relay or shared-protocol change anywhere in this phase. The `task.json` parse layer in `tasks.ts` is replaced by YAML-frontmatter parsing (everything downstream — `Task`, `Envelope`, policy, spawning, cards — is untouched). A `publishCard` helper centralizes push + local snapshot; a `buildCardReport` function produces the owner's lint view; a `verbs.ts` module holds pure policy mutations that commander wires up.

**Tech Stack:** TypeScript ESM, zod v4, `yaml` (eemeli/yaml, new dependency), commander, vitest.

Spec: `docs/superpowers/specs/2026-07-16-task-menu-ux-design.md`. Base branch state: `task-menu-phase1` at commit `c27a142` (Phase 1 complete).

## Global Constraints

- All work happens in the worktree `/Users/ryuseitaniguchi/coding/agentcall/.claude/worktrees/task-menu-phase1` on branch `task-menu-phase1`.
- TDD: write the failing test first, run it, observe the failure. No live `claude`/`codex` spawn in tests.
- Stage files explicitly (`git add <file> <file>`), never `git add -A` or `git add .`.
- Done means `pnpm -r test && pnpm -r typecheck && pnpm -r build` pass at the worktree root.
- **The directory name IS the task id** — the frontmatter has no `id` field; the dir name is validated against `TASK_ID_RE` (from `@benree/agentcall-shared`).
- Frontmatter fields (flat, not nested under `envelope`): `name?` (defaults to id), `description` (REQUIRED, the only required field), `examples[]`, `tier` (`T1`|`T2`, default `T1`), `tools[]` (default `["read"]`), `write_paths[]` (default `[]`, regex `/^public(?:\/[a-z0-9][a-z0-9\/_-]*)?$/`), `network[]` (default `[]`, existing DOMAIN_RE), `timeout_s?` (int, 1..300).
- `task.json` support is DELETED — no migration path (format never shipped).
- Warn-and-skip resilience semantics of `loadTasks` are unchanged: one broken SKILL.md never takes other tasks offline; the listener's warn-to-log behavior stays identical.
- Card snapshot file: `~/.agentcall/card.pushed.json` (`Paths.cardSnapshotFile`), written on every successful push (setup, `card push`, every verb).
- Verbs are flat top-level commands: `allow`, `revoke`, `block`, `unblock`, `offer`, `unoffer` (spec open question 1 resolved: flat).
- `agentcall card` (no args) exits 1 if any `✗` problem exists; staleness/never-pushed notices (`!`) alone exit 0. No relay fetch for staleness (spec open question 2 resolved: local snapshot only).
- `allow`/`offer` on a task id with no manifest on disk: hard error naming `agentcall task new <id>`. `revoke`/`unoffer`/`block`/`unblock` are idempotent, never error on missing targets.
- `ask` is reserved: not scaffoldable, not shadowable (existing behavior).

---

### Task 1: Frontmatter SKILL.md format (replaces task.json)

**Files:**
- Modify: `packages/cli/package.json` (add `"yaml": "^2.5.0"` to dependencies)
- Modify: `packages/cli/src/tasks.ts`
- Modify: `packages/cli/test/tasks.test.ts` (rewrite loader fixtures)
- Modify: `packages/cli/test/listener.test.ts` (only the `seedTask` helper + its two call sites' manifest args)

**Interfaces:**
- Consumes: `TASK_ID_RE` from `@benree/agentcall-shared`; `YAML.parse` from `yaml`.
- Produces (later tasks rely on): `splitFrontmatter(text: string): { meta: string; body: string } | null`; `SkillFrontmatter` (zod object, exported); `loadTasks(p: Paths, warn?: (msg: string) => void): Task[]` (signature unchanged); `Task`/`Envelope`/`CAPS`/`FULL_ACCESS_ENVELOPE`/`ASK_TASK` unchanged. `TaskManifest`/`TaskManifestType` are deleted.

- [ ] **Step 1: Add the dependency**

In `packages/cli/package.json` dependencies, add `"yaml": "^2.5.0"` (alongside zod/ws/commander), then run `pnpm install` from the worktree root.

- [ ] **Step 2: Rewrite the loader tests to frontmatter fixtures**

Replace the `writeTask` helper and the `TaskManifest`/`loadTasks` describe blocks in `packages/cli/test/tasks.test.ts` with the following (keep the `paths` and `FULL_ACCESS_ENVELOPE` describes unchanged; update the import line to `import { ASK_TASK, FULL_ACCESS_ENVELOPE, loadTasks, SkillFrontmatter, splitFrontmatter } from "../src/tasks.js";`):

```ts
function writeSkill(home: string, id: string, skillMd: string) {
  const dir = join(home, "AgentCall", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);
}

describe("splitFrontmatter", () => {
  it("splits meta and body", () => {
    const r = splitFrontmatter("---\ndescription: d\n---\n# Body\ntext\n");
    expect(r).toEqual({ meta: "description: d", body: "# Body\ntext\n" });
  });
  it("returns null without a leading fence", () => {
    expect(splitFrontmatter("# Just markdown\n")).toBeNull();
  });
  it("returns null without a closing fence", () => {
    expect(splitFrontmatter("---\ndescription: d\n")).toBeNull();
  });
});

describe("SkillFrontmatter", () => {
  it("applies defaults (read-only, no writes, no network, T1)", () => {
    const m = SkillFrontmatter.parse({ description: "Introduce the owner." });
    expect(m).toMatchObject({ tier: "T1", tools: ["read"], write_paths: [], network: [], examples: [] });
    expect(m.name).toBeUndefined();
  });
  it("requires description", () => {
    expect(SkillFrontmatter.safeParse({ name: "X" }).success).toBe(false);
  });
  it("rejects write_paths outside public and timeouts above 300", () => {
    expect(SkillFrontmatter.safeParse({ description: "d", write_paths: ["inbox"] }).success).toBe(false);
    expect(SkillFrontmatter.safeParse({ description: "d", timeout_s: 999 }).success).toBe(false);
  });
});

describe("loadTasks", () => {
  it("always includes the built-in ask task, even with no tasks dir", () => {
    const tasks = loadTasks(getPaths(tempHome()), () => {});
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
  });
  it("loads a frontmatter SKILL.md; dir name is the id; name defaults to id", () => {
    const home = tempHome();
    writeSkill(home, "schedule-meeting", [
      "---",
      "description: Book a time.",
      "tools: [read, fetch]",
      "network: [calendar.google.com]",
      "timeout_s: 120",
      "---",
      "# Check the calendar first",
      "",
    ].join("\n"));
    const tasks = loadTasks(getPaths(home), () => {});
    const t = tasks.find((x) => x.id === "schedule-meeting")!;
    expect(t.name).toBe("schedule-meeting");
    expect(t.envelope).toEqual({ caps: ["read", "fetch"], write_paths: [], network: ["calendar.google.com"] });
    expect(t.skill).toContain("Check the calendar");
    expect(t.timeout_s).toBe(120);
  });
  it("uses an explicit name when given", () => {
    const home = tempHome();
    writeSkill(home, "intro", "---\nname: Owner introduction\ndescription: d\n---\nbody\n");
    expect(loadTasks(getPaths(home), () => {}).find((t) => t.id === "intro")!.name).toBe("Owner introduction");
  });
  it("skips missing SKILL.md, missing frontmatter, bad YAML, and schema violations — each with a warning", () => {
    const home = tempHome();
    mkdirSync(join(home, "AgentCall", "tasks", "empty-dir"), { recursive: true });
    writeSkill(home, "no-fm", "# bare markdown, no frontmatter\n");
    writeSkill(home, "bad-yaml", "---\ndescription: [unclosed\n---\nbody\n");
    writeSkill(home, "bad-schema", "---\nname: X\n---\nbody\n"); // missing description
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(warnings).toHaveLength(4);
    expect(warnings.some((w) => w.includes("no-fm"))).toBe(true);
  });
  it("skips a dir whose name is not a valid task id, and a task shadowing ask", () => {
    const home = tempHome();
    writeSkill(home, "Bad_Name", "---\ndescription: d\n---\n");
    writeSkill(home, "ask", "---\ndescription: override\n---\n");
    const warnings: string[] = [];
    const tasks = loadTasks(getPaths(home), (m) => warnings.push(m));
    expect(tasks.map((t) => t.id)).toEqual(["ask"]);
    expect(tasks[0]!.name).toBe(ASK_TASK.name);
    expect(warnings).toHaveLength(2);
  });
});
```

Delete the old `writeTask` helper, the `TaskManifest` describe, and the old `loadTasks` describe (including the dir-name-must-match-id test — that invariant no longer exists).

- [ ] **Step 3: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- tasks`
Expected: FAIL — `splitFrontmatter`/`SkillFrontmatter` not exported; loader still looks for task.json.

- [ ] **Step 4: Rewrite the parse layer in tasks.ts**

In `packages/cli/src/tasks.ts`: add `import { parse as parseYaml } from "yaml";` and replace everything from the `TaskManifest` declaration through the end of `loadTasks` with:

```ts
// A SKILL.md is YAML frontmatter between --- fences, then the skill body.
// Returns null when the file has no leading fence or no closing fence.
export function splitFrontmatter(text: string): { meta: string; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  return { meta: m[1]!, body: m[2] ?? "" };
}

// Frontmatter schema. The task id is NOT here — the directory name is the
// id, so there is no dual source to drift. `description` is the only
// required field: a card entry without one is useless to callers. `name`
// defaults to the id at load time.
export const SkillFrontmatter = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().min(1).max(1000),
  examples: z.array(z.string().max(500)).max(10).default([]),
  tier: z.enum(["T1", "T2"]).default("T1"),
  tools: z.array(z.enum(CAPS)).default(["read"]),
  write_paths: z.array(z.string().regex(WRITE_PATH_RE)).default([]),
  network: z.array(z.string().regex(DOMAIN_RE)).default([]),
  timeout_s: z.number().int().positive().max(300).optional(),
});
export type SkillFrontmatterType = z.infer<typeof SkillFrontmatter>;

export interface Task {
  id: string;
  name: string;
  description: string;
  examples: string[];
  tier: "T1" | "T2";
  envelope: Envelope;
  timeout_s?: number;
  skill: string; // SKILL.md body (after the frontmatter), embedded into the spawn prompt
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

// Reads ~/AgentCall/tasks/<id>/SKILL.md (YAML frontmatter + body). Invalid
// or duplicate entries are skipped with a warning rather than failing the
// whole listener: one broken manifest must not take every other task
// offline.
export function loadTasks(p: Paths, warn: (msg: string) => void = console.error): Task[] {
  const tasks: Task[] = [ASK_TASK];
  if (!existsSync(p.tasksDir)) return tasks;
  for (const entry of readdirSync(p.tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    if (!TASK_ID_RE.test(id)) {
      warn(`agentcall: task "${id}": directory name is not a valid task id (lowercase kebab-case), skipped`);
      continue;
    }
    if (tasks.some((t) => t.id === id)) {
      warn(`agentcall: task "${id}": duplicate or reserved id, skipped`);
      continue;
    }
    const skillFile = join(p.tasksDir, id, "SKILL.md");
    if (!existsSync(skillFile)) {
      warn(`agentcall: task "${id}": missing SKILL.md, skipped`);
      continue;
    }
    let fm: SkillFrontmatterType;
    let body: string;
    try {
      const split = splitFrontmatter(readFileSync(skillFile, "utf8"));
      if (!split) {
        warn(`agentcall: task "${id}": SKILL.md has no YAML frontmatter (--- fences), skipped`);
        continue;
      }
      fm = SkillFrontmatter.parse(parseYaml(split.meta));
      body = split.body;
    } catch (e) {
      warn(`agentcall: task "${id}": invalid SKILL.md frontmatter, skipped (${String(e).slice(0, 200)})`);
      continue;
    }
    tasks.push({
      id,
      name: fm.name ?? id,
      description: fm.description,
      examples: fm.examples,
      tier: fm.tier,
      envelope: { caps: fm.tools, write_paths: fm.write_paths, network: fm.network },
      timeout_s: fm.timeout_s,
      skill: body,
    });
  }
  return tasks;
}
```

Note: `parseYaml(split.meta)` returning non-object (e.g. a YAML scalar) fails `SkillFrontmatter.parse` inside the same try — covered by the bad-schema warn path. The file-read is inside the try, closing Phase 1's TOCTOU carry-forward.

- [ ] **Step 5: Update the listener test seed helper**

In `packages/cli/test/listener.test.ts`, replace the `seedTask` helper with:

```ts
function seedTask(paths: ReturnType<typeof getPaths>, id: string, frontmatter: string[], body = "do it\n") {
  const dir = join(paths.tasksDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), ["---", ...frontmatter, "---", body].join("\n"));
}
```

and update its two call sites:

```ts
seedTask(paths, "schedule-meeting", ["description: d"]);
```

```ts
seedTask(paths, "schedule-meeting", [
  "description: d",
  "tools: [read, fetch]",
  "network: [calendar.google.com]",
  "timeout_s: 60",
], "check the calendar\n");
```

- [ ] **Step 6: Run the full cli suite to verify green**

Run (from `packages/cli`): `pnpm test && pnpm typecheck`
Expected: PASS. If anything else still references `TaskManifest`, the typecheck names it — fix by deleting the stale reference (grep confirms only tasks.ts/tests used it).

- [ ] **Step 7: Commit**

```bash
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src/tasks.ts packages/cli/test/tasks.test.ts packages/cli/test/listener.test.ts
git commit -m "feat(cli)!: replace task.json with YAML-frontmatter SKILL.md

One file per task; the directory name is the id. No migration path —
the task.json format never shipped outside this branch."
```

---

### Task 2: Card snapshot + publishCard

**Files:**
- Modify: `packages/cli/src/paths.ts`
- Modify: `packages/cli/src/card.ts`
- Modify: `packages/cli/src/setup.ts:200-211` (the card-push try block)
- Modify: `packages/cli/src/index.ts` (card push branch)
- Test: `packages/cli/test/card.test.ts` (append), `packages/cli/test/setup.test.ts` (extend one assertion)

**Interfaces:**
- Consumes: `buildCardUpload` (card.ts), `pushCard` (api.ts), `loadPolicy`, `loadTasks`, `relayUrl`.
- Produces: `Paths.cardSnapshotFile` = `<home>/.agentcall/card.pushed.json`; `publishCard(cfg: Config, p: Paths, push: typeof pushCard = pushCard): Promise<CardUploadType>` — builds the upload, pushes, writes the snapshot, returns the upload; throws if the push throws (snapshot NOT written on failure).

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/card.test.ts`:

```ts
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPaths } from "../src/paths.js";
import { publishCard } from "../src/card.js";

describe("publishCard", () => {
  function tempPaths() {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pub-")));
    mkdirSync(p.dir, { recursive: true });
    return p;
  }

  it("exposes the snapshot path on Paths", () => {
    expect(getPaths("/tmp/fakehome").cardSnapshotFile).toBe("/tmp/fakehome/.agentcall/card.pushed.json");
  });

  it("pushes the built upload and writes the snapshot", async () => {
    const p = tempPaths();
    let pushed: unknown;
    const upload = await publishCard(cfg, p, async (_relay, _auth, u) => { pushed = u; });
    expect(pushed).toEqual(upload);
    expect(upload.default_offer).toEqual(["ask"]); // DEFAULT_POLICY, no tasks dir
    const snap = JSON.parse(readFileSync(p.cardSnapshotFile, "utf8"));
    expect(snap).toEqual(upload);
  });

  it("does not write the snapshot when the push fails", async () => {
    const p = tempPaths();
    await expect(publishCard(cfg, p, async () => { throw new Error("relay down"); })).rejects.toThrow("relay down");
    expect(() => readFileSync(p.cardSnapshotFile, "utf8")).toThrow();
  });
});
```

(`cfg` is the existing fixture at the top of card.test.ts.)

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- card`
Expected: FAIL — `cardSnapshotFile` undefined; `publishCard` not exported.

- [ ] **Step 3: Implement**

In `packages/cli/src/paths.ts`, add `cardSnapshotFile: string;` to the interface and `cardSnapshotFile: join(dir, "card.pushed.json"),` to the returned object.

In `packages/cli/src/card.ts`, add imports and the function:

```ts
import { writeFileSync } from "node:fs";
import { pushCard } from "./api.js";
import { relayUrl } from "./config.js";
import { loadPolicy } from "./policy.js";
import { loadTasks } from "./tasks.js";
import type { Paths } from "./paths.js";
```

```ts
// Single path for every card publish (setup, `card push`, policy verbs):
// build from local policy+tasks, push, then record what was pushed so
// `agentcall card` can detect staleness without any relay round-trip.
// The snapshot is written only after a successful push — a failed push
// must keep the old snapshot so staleness detection stays truthful.
export async function publishCard(cfg: Config, p: Paths, push: typeof pushCard = pushCard): Promise<CardUploadType> {
  const upload = buildCardUpload(cfg, loadPolicy(p), loadTasks(p));
  await push(relayUrl(cfg), { handle: cfg.handle, token: cfg.token }, upload);
  writeFileSync(p.cardSnapshotFile, JSON.stringify(upload, null, 2) + "\n");
  return upload;
}
```

In `packages/cli/src/setup.ts`, replace the card-push try block body with `await publishCard(cfg, paths);` (same try/catch and warning text; drop the now-unused `pushCard`/`buildCardUpload`/`loadPolicy`/`loadTasks` imports, import `publishCard` from `./card.js`).

In `packages/cli/src/index.ts` card command's push branch, replace the `pushCard(...)` call with `await publishCard(cfg, paths);` (adjust imports: drop `pushCard`/`buildCardUpload`/`loadPolicy`/`loadTasks` if now unused, add `publishCard`).

- [ ] **Step 4: Extend the setup assertion**

In `packages/cli/test/setup.test.ts`, in the "seeds policy.json + tasks dir and publishes the card" test, add after the existing card-PUT assertion:

```ts
expect(existsSync(p.cardSnapshotFile)).toBe(true);
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test && pnpm typecheck`
Expected: PASS (the 409-relay reuse test still passes: publishCard throws there, setup's catch downgrades, snapshot absent — nothing asserts otherwise on that path).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/paths.ts packages/cli/src/card.ts packages/cli/src/setup.ts packages/cli/src/index.ts packages/cli/test/card.test.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): centralize card publishing with a local pushed-card snapshot"
```

---

### Task 3: Policy verbs (allow/revoke/block/unblock/offer/unoffer)

**Files:**
- Modify: `packages/cli/src/policy.ts` (add `savePolicy`)
- Create: `packages/cli/src/verbs.ts`
- Modify: `packages/cli/src/index.ts` (six commands)
- Test: `packages/cli/test/verbs.test.ts` (new file), `packages/cli/test/policy.test.ts` (append savePolicy round-trip)

**Interfaces:**
- Consumes: `Policy`, `loadPolicy`, `DEFAULT_POLICY`, `offeredFor` (policy.ts); `Task` (tasks.ts); `HANDLE_RE`, `TASK_ID_RE` (shared); `publishCard` (Task 2).
- Produces: `savePolicy(p: Paths, policy: Policy): void`; `type Verb = "allow" | "revoke" | "block" | "unblock" | "offer" | "unoffer"`; `execVerb(policy: Policy, tasks: Task[], verb: Verb, a: string, b?: string): { policy: Policy; lines: string[] }` — pure (returns a new Policy, never mutates the input), throws `Error` with a user-facing message on validation failure.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/verbs.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execVerb } from "../src/verbs.js";
import { DEFAULT_POLICY, type Policy } from "../src/policy.js";
import { ASK_TASK, type Task } from "../src/tasks.js";

const meet: Task = {
  id: "schedule-meeting", name: "Schedule", description: "Book a time.",
  examples: [], tier: "T1", envelope: { caps: ["read"], write_paths: [], network: [] }, skill: "",
};
const TASKS = [ASK_TASK, meet];
const base: Policy = { description: "", default_offer: ["ask"], callers: {} };

describe("execVerb", () => {
  it("allow grants a task and reports the caller's effective menu", () => {
    const { policy, lines } = execVerb(base, TASKS, "allow", "ken", "schedule-meeting");
    expect(policy.callers.ken).toEqual({ offer: ["schedule-meeting"], block: false });
    expect(base.callers.ken).toBeUndefined(); // pure: input untouched
    expect(lines.join("\n")).toContain("ken can now: ask, schedule-meeting");
  });
  it("allow is idempotent", () => {
    const once = execVerb(base, TASKS, "allow", "ken", "schedule-meeting").policy;
    const twice = execVerb(once, TASKS, "allow", "ken", "schedule-meeting").policy;
    expect(twice.callers.ken!.offer).toEqual(["schedule-meeting"]);
  });
  it("allow on a task with no manifest on disk is a hard error naming the fix", () => {
    expect(() => execVerb(base, TASKS, "allow", "ken", "ghost-task"))
      .toThrow(/agentcall task new ghost-task/);
  });
  it("allow validates the handle", () => {
    expect(() => execVerb(base, TASKS, "allow", "Bad Handle", "ask")).toThrow(/handle/i);
  });
  it("revoke removes a grant and drops an empty, unblocked caller entry", () => {
    const granted = execVerb(base, TASKS, "allow", "ken", "schedule-meeting").policy;
    const { policy } = execVerb(granted, TASKS, "revoke", "ken", "schedule-meeting");
    expect(policy.callers.ken).toBeUndefined();
  });
  it("revoke of a nonexistent grant is a no-op, not an error", () => {
    expect(() => execVerb(base, TASKS, "revoke", "ken", "schedule-meeting")).not.toThrow();
  });
  it("block sets the flag and survives revoke-to-empty; unblock clears it", () => {
    const blocked = execVerb(base, TASKS, "block", "spammer").policy;
    expect(blocked.callers.spammer).toEqual({ offer: [], block: true });
    const stillBlocked = execVerb(blocked, TASKS, "revoke", "spammer", "anything").policy;
    expect(stillBlocked.callers.spammer!.block).toBe(true); // blocked entry never dropped
    const un = execVerb(stillBlocked, TASKS, "unblock", "spammer").policy;
    expect(un.callers.spammer).toBeUndefined();
  });
  it("offer/unoffer edit default_offer and report the public menu", () => {
    const { policy, lines } = execVerb(base, TASKS, "offer", "schedule-meeting");
    expect(policy.default_offer).toEqual(["ask", "schedule-meeting"]);
    expect(lines.join("\n")).toContain("Offered to anyone: ask, schedule-meeting");
    const { policy: p2 } = execVerb(policy, TASKS, "unoffer", "schedule-meeting");
    expect(p2.default_offer).toEqual(["ask"]);
  });
  it("offer on a missing task is a hard error", () => {
    expect(() => execVerb(base, TASKS, "offer", "ghost-task")).toThrow(/agentcall task new ghost-task/);
  });
  it("block reports; allow on a blocked caller still records the grant but says so", () => {
    const blocked = execVerb(base, TASKS, "block", "spammer").policy;
    const { policy, lines } = execVerb(blocked, TASKS, "allow", "spammer", "schedule-meeting");
    expect(policy.callers.spammer).toEqual({ offer: ["schedule-meeting"], block: true });
    expect(lines.join("\n")).toContain("blocked");
  });
});
```

Append to `packages/cli/test/policy.test.ts`:

```ts
import { savePolicy } from "../src/policy.js"; // merge into the existing import

describe("savePolicy", () => {
  it("round-trips through loadPolicy", () => {
    const p = getPaths(mkdtempSync(join(tmpdir(), "agentcall-pol-")));
    mkdirSync(dirname(p.policyFile), { recursive: true });
    const pol: Policy = { description: "x", default_offer: ["ask"], callers: { ken: { offer: ["a-task"], block: false } } };
    savePolicy(p, pol);
    expect(loadPolicy(p)).toEqual(pol);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- verbs && pnpm test -- policy`
Expected: FAIL — `../src/verbs.js` missing; `savePolicy` not exported.

- [ ] **Step 3: Implement savePolicy**

Append to `packages/cli/src/policy.ts` (add `mkdirSync, writeFileSync` to its `node:fs` import and `dirname` from `node:path`):

```ts
// Writes the exact shape PolicySchema parses, so hand-edits and the CLI
// verbs (verbs.ts) interoperate on the same file.
export function savePolicy(p: Paths, policy: Policy): void {
  mkdirSync(dirname(p.policyFile), { recursive: true });
  writeFileSync(p.policyFile, JSON.stringify(policy, null, 2) + "\n");
}
```

- [ ] **Step 4: Implement verbs.ts**

Create `packages/cli/src/verbs.ts`:

```ts
import { HANDLE_RE, TASK_ID_RE } from "@benree/agentcall-shared";
import { offeredFor, type Policy } from "./policy.js";
import type { Task } from "./tasks.js";

export type Verb = "allow" | "revoke" | "block" | "unblock" | "offer" | "unoffer";

// Pure policy mutations behind the flat CLI verbs. Each returns a NEW
// Policy plus the lines the CLI prints. Validation throws Error with a
// user-facing message. Grant-adding verbs (allow/offer) hard-error on a
// task id with no manifest on disk — publishing a dangling grant is never
// what the owner wants; removals are idempotent and never error.
export function execVerb(
  policy: Policy, tasks: Task[], verb: Verb, a: string, b?: string,
): { policy: Policy; lines: string[] } {
  const requireHandle = (h: string) => {
    if (!HANDLE_RE.test(h)) throw new Error(`"${h}" is not a valid handle.`);
    return h;
  };
  const requireTaskId = (id: string | undefined, forVerb: string) => {
    if (!id || !TASK_ID_RE.test(id)) throw new Error(`${forVerb} needs a valid task id.`);
    return id;
  };
  const requireTaskExists = (id: string) => {
    if (!tasks.some((t) => t.id === id)) {
      throw new Error(`No task "${id}" exists on disk. Create it first: agentcall task new ${id}`);
    }
    return id;
  };
  const clone = (): Policy => ({
    description: policy.description,
    default_offer: [...policy.default_offer],
    callers: Object.fromEntries(
      Object.entries(policy.callers).map(([k, v]) => [k, { offer: [...v.offer], block: v.block }]),
    ),
  });
  const menuLine = (next: Policy, handle: string): string => {
    const offered = offeredFor(next, handle);
    return offered === "blocked"
      ? `${handle} is blocked; grants are kept but inactive until: agentcall unblock ${handle}`
      : `${handle} can now: ${offered.join(", ")}`;
  };

  const next = clone();
  switch (verb) {
    case "allow": {
      const handle = requireHandle(a);
      const id = requireTaskExists(requireTaskId(b, "allow"));
      const entry = next.callers[handle] ?? { offer: [], block: false };
      if (!entry.offer.includes(id)) entry.offer.push(id);
      next.callers[handle] = entry;
      return { policy: next, lines: [menuLine(next, handle)] };
    }
    case "revoke": {
      const handle = requireHandle(a);
      const id = requireTaskId(b, "revoke");
      const entry = next.callers[handle];
      if (entry) {
        entry.offer = entry.offer.filter((x) => x.replace(/^\+/, "") !== id);
        if (entry.offer.length === 0 && !entry.block) delete next.callers[handle];
      }
      return { policy: next, lines: [next.callers[handle] ? menuLine(next, handle) : `${handle} has no grants.`] };
    }
    case "block": {
      const handle = requireHandle(a);
      const entry = next.callers[handle] ?? { offer: [], block: false };
      entry.block = true;
      next.callers[handle] = entry;
      return { policy: next, lines: [`${handle} is blocked.`] };
    }
    case "unblock": {
      const handle = requireHandle(a);
      const entry = next.callers[handle];
      if (entry) {
        entry.block = false;
        if (entry.offer.length === 0) delete next.callers[handle];
      }
      return { policy: next, lines: [next.callers[handle] ? menuLine(next, handle) : `${handle} is not blocked.`] };
    }
    case "offer": {
      const id = requireTaskExists(requireTaskId(a, "offer"));
      if (!next.default_offer.includes(id)) next.default_offer.push(id);
      return { policy: next, lines: [`Offered to anyone: ${next.default_offer.join(", ")}`] };
    }
    case "unoffer": {
      const id = requireTaskId(a, "unoffer");
      next.default_offer = next.default_offer.filter((x) => x.replace(/^\+/, "") !== id);
      return { policy: next, lines: [`Offered to anyone: ${next.default_offer.join(", ") || "(nothing — invite-only)"}`] };
    }
  }
}
```

- [ ] **Step 5: Wire the six commands in index.ts**

Add imports to `packages/cli/src/index.ts`: `import { execVerb, type Verb } from "./verbs.js";`, `import { savePolicy } from "./policy.js";` (merge with the existing `loadPolicy` import), and ensure `publishCard` and `loadTasks` are imported. Then add after the `card` command:

```ts
function policyVerbAction(verb: Verb) {
  return async (a: string, b?: string) => {
    const paths = getPaths();
    const cfg = loadConfig(paths);
    try {
      const { policy, lines } = execVerb(loadPolicy(paths), loadTasks(paths), verb, a, b);
      savePolicy(paths, policy);
      for (const line of lines) console.log(line);
      try {
        await publishCard(cfg, paths);
        console.log("Card updated.");
      } catch (e) {
        console.error(`Warning: policy saved locally, but the card push failed (${String(e)}). Run \`agentcall card push\` later.`);
      }
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  };
}

program.command("allow").description("grant a caller an extra task (and republish your card)")
  .argument("<handle>").argument("<task-id>").action(policyVerbAction("allow"));
program.command("revoke").description("remove a caller's task grant")
  .argument("<handle>").argument("<task-id>").action(policyVerbAction("revoke"));
program.command("block").description("refuse all calls from a handle")
  .argument("<handle>").action(policyVerbAction("block"));
program.command("unblock").description("lift a block")
  .argument("<handle>").action(policyVerbAction("unblock"));
program.command("offer").description("offer a task to any registered caller")
  .argument("<task-id>").action(policyVerbAction("offer"));
program.command("unoffer").description("stop offering a task publicly")
  .argument("<task-id>").action(policyVerbAction("unoffer"));
```

- [ ] **Step 6: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/policy.ts packages/cli/src/verbs.ts packages/cli/src/index.ts packages/cli/test/verbs.test.ts packages/cli/test/policy.test.ts
git commit -m "feat(cli): flat policy verbs (allow/revoke/block/unblock/offer/unoffer) with auto-publish"
```

---

### Task 4: Own-card lint report + `agentcall card` with no args

**Files:**
- Create: `packages/cli/src/lint.ts`
- Modify: `packages/cli/src/index.ts` (card command: optional argument)
- Test: `packages/cli/test/lint.test.ts` (new file)

**Interfaces:**
- Consumes: `loadPolicy`/`DEFAULT_POLICY` (policy.ts), `loadTasks`/`ASK_TASK` (tasks.ts), `buildCardUpload` (card.ts), `Paths.cardSnapshotFile` (Task 2), `Config`.
- Produces: `buildCardReport(cfg: Config, p: Paths): CardReport` where `CardReport = { menu: string[]; problems: string[]; notices: string[] }`. `menu` renders like the spec sample; `problems` (`✗`) → CLI exit 1; `notices` (`!`) → exit 0.

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/test/lint.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardReport } from "../src/lint.js";
import { publishCard } from "../src/card.js";
import { getPaths } from "../src/paths.js";
import type { Config } from "../src/config.js";

const cfg: Config = { handle: "ken", token: "t", agent_kind: "claude", relay: "https://r" };

function home() {
  const h = mkdtempSync(join(tmpdir(), "agentcall-lint-"));
  mkdirSync(join(h, ".agentcall"), { recursive: true });
  return h;
}
function writeSkill(h: string, id: string, skillMd: string) {
  const dir = join(h, "AgentCall", "tasks", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);
}

describe("buildCardReport", () => {
  it("renders the default menu and a never-pushed notice on a fresh install", () => {
    const p = getPaths(home());
    const r = buildCardReport(cfg, p);
    expect(r.menu.join("\n")).toContain("ask [T1]");
    expect(r.problems).toEqual([]);
    expect(r.notices.join("\n")).toContain("never been pushed");
  });

  it("surfaces skipped-manifest warnings as problems", () => {
    const h = home();
    writeSkill(h, "broken", "# no frontmatter\n");
    const r = buildCardReport(cfg, getPaths(h));
    expect(r.problems.join("\n")).toContain("broken");
  });

  it("flags policy references to tasks that do not exist", () => {
    const h = home();
    const p = getPaths(h);
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask", "gone"], callers: { mia: { offer: ["also-gone"], block: false } },
    }));
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toContain('"gone"');
    expect(r.problems.join("\n")).toContain('"also-gone"');
  });

  it("reports a malformed policy file as a problem instead of throwing", () => {
    const p = getPaths(home());
    writeFileSync(p.policyFile, "{corrupt");
    const r = buildCardReport(cfg, p);
    expect(r.problems.join("\n")).toContain("policy.json");
  });

  it("is quiet after a push and stale after a change", async () => {
    const h = home();
    const p = getPaths(h);
    await publishCard(cfg, p, async () => {});
    expect(buildCardReport(cfg, p).notices).toEqual([]);
    writeSkill(h, "intro", "---\ndescription: d\n---\nbody\n");
    writeFileSync(p.policyFile, JSON.stringify({ default_offer: ["ask", "intro"], callers: {} }));
    const r = buildCardReport(cfg, p);
    expect(r.notices.join("\n")).toContain("out of date");
  });

  it("lists per-caller grants and blocked callers in the menu", () => {
    const h = home();
    const p = getPaths(h);
    writeSkill(h, "intro", "---\ndescription: d\n---\n");
    writeFileSync(p.policyFile, JSON.stringify({
      default_offer: ["ask"],
      callers: { mia: { offer: ["intro"], block: false }, spammer: { offer: [], block: true } },
    }));
    const text = buildCardReport(cfg, p).menu.join("\n");
    expect(text).toContain("mia: intro");
    expect(text).toContain("Blocked: spammer");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- lint`
Expected: FAIL — `../src/lint.js` missing.

- [ ] **Step 3: Implement lint.ts**

Create `packages/cli/src/lint.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { buildCardUpload } from "./card.js";
import type { Config } from "./config.js";
import type { Paths } from "./paths.js";
import { DEFAULT_POLICY, loadPolicy, type Policy } from "./policy.js";
import { loadTasks } from "./tasks.js";

export interface CardReport {
  menu: string[];     // the owner's card as callers see it
  problems: string[]; // ✗ — broken manifests, dangling policy refs, unreadable policy; CLI exits 1
  notices: string[];  // ! — staleness / never-pushed; informational, exit 0
}

// The owner-facing view of `agentcall card` with no arguments: render the
// menu from the same loadPolicy/loadTasks/buildCardUpload path the push
// uses, but route every warning to the terminal instead of the listener
// log (spec: error-visibility principle).
export function buildCardReport(cfg: Config, p: Paths): CardReport {
  const problems: string[] = [];
  const notices: string[] = [];

  const tasks = loadTasks(p, (msg) => problems.push(msg.replace(/^agentcall: /, "")));

  let policy: Policy;
  try {
    policy = loadPolicy(p);
  } catch (e) {
    problems.push(`policy.json: invalid (${String(e).slice(0, 200)})`);
    return { menu: [], problems, notices };
  }

  const exists = (id: string) => tasks.some((t) => t.id === id.replace(/^\+/, ""));
  for (const id of policy.default_offer) {
    if (!exists(id)) problems.push(`policy.json: default_offer references "${id.replace(/^\+/, "")}" but no such task exists`);
  }
  for (const [caller, entry] of Object.entries(policy.callers)) {
    for (const id of entry.offer) {
      if (!exists(id)) problems.push(`policy.json: grant for ${caller} references "${id.replace(/^\+/, "")}" but no such task exists`);
    }
  }

  const upload = buildCardUpload(cfg, policy, tasks);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const menu: string[] = [`${cfg.handle} (${cfg.agent_kind})${upload.description ? ` — ${upload.description}` : ""}`];
  menu.push("  Offered to anyone:");
  for (const id of upload.default_offer) {
    const t = byId.get(id)!;
    menu.push(`    ${id} [${t.tier}] — ${t.description}`);
  }
  const grantEntries = Object.entries(upload.grants);
  if (grantEntries.length > 0) {
    menu.push("  Granted per caller:");
    for (const [caller, ids] of grantEntries) menu.push(`    ${caller}: ${ids.join(", ")}`);
  }
  const blocked = Object.entries(policy.callers).filter(([, e]) => e.block).map(([h]) => h);
  if (blocked.length > 0) menu.push(`  Blocked: ${blocked.join(", ")}`);

  if (!existsSync(p.cardSnapshotFile)) {
    notices.push("card has never been pushed — run `agentcall card push`");
  } else {
    try {
      const snapshot = JSON.parse(readFileSync(p.cardSnapshotFile, "utf8"));
      if (JSON.stringify(snapshot) !== JSON.stringify(upload)) {
        notices.push("card out of date: local menu differs from last push — run `agentcall card push`");
      }
    } catch {
      notices.push("card snapshot unreadable — run `agentcall card push` to refresh it");
    }
  }

  return { menu, problems, notices };
}
```

Note on `DEFAULT_POLICY` import: `loadPolicy` already returns it for a missing file — the import is unnecessary; omit it (keep the import list minimal: drop `DEFAULT_POLICY` if unused after writing).

- [ ] **Step 4: Wire `agentcall card` with an optional argument**

In `packages/cli/src/index.ts`, change the card command: `.argument("[target]", "handle@host to fetch, 'push' to publish, or omit to review your own card")` and prepend to the action:

```ts
.action(async (target?: string) => {
  const paths = getPaths();
  if (target === undefined) {
    const cfg = loadConfig(paths);
    if (!cfg.agent_kind) {
      console.error("This handle is caller-only (no agent configured) — no card to review.");
      process.exitCode = 1;
      return;
    }
    const { buildCardReport } = await import("./lint.js");
    const report = buildCardReport(cfg, paths);
    for (const line of report.menu) console.log(line);
    if (report.problems.length || report.notices.length) console.log("\nProblems:");
    for (const p of report.problems) console.log(`  ✗ ${p}`);
    for (const n of report.notices) console.log(`  ! ${n}`);
    if (report.problems.length > 0) process.exitCode = 1;
    return;
  }
  // ... existing push / fetch branches unchanged
```

(Use a static import of `buildCardReport` instead of the dynamic import — match the file's existing static-import style; the snippet above shows placement, not the import mechanism.)

Update the command `.description(...)` to "show your own card with problems, another agent's menu, or publish yours (push)".

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/lint.ts packages/cli/src/index.ts packages/cli/test/lint.test.ts
git commit -m "feat(cli): agentcall card with no args reviews your own card and lints it"
```

---

### Task 5: `agentcall task new <id>` scaffold

**Files:**
- Modify: `packages/cli/src/tasks.ts` (add `SKILL_TEMPLATE`, `scaffoldTask`)
- Modify: `packages/cli/src/index.ts` (task command)
- Test: `packages/cli/test/tasks.test.ts` (append)

**Interfaces:**
- Consumes: `TASK_ID_RE`, `Paths.tasksDir`, `loadTasks`.
- Produces: `SKILL_TEMPLATE: string`; `scaffoldTask(p: Paths, id: string): string` — creates `<tasksDir>/<id>/SKILL.md`, returns the created file path; throws on invalid id, reserved id (`ask`), or existing directory.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/tasks.test.ts`:

```ts
import { scaffoldTask } from "../src/tasks.js"; // merge into the existing import

describe("scaffoldTask", () => {
  it("creates a SKILL.md that loadTasks accepts as a valid task", () => {
    const home = tempHome();
    const p = getPaths(home);
    const file = scaffoldTask(p, "schedule-meeting");
    expect(file).toBe(join(p.tasksDir, "schedule-meeting", "SKILL.md"));
    const warnings: string[] = [];
    const tasks = loadTasks(p, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    const t = tasks.find((x) => x.id === "schedule-meeting")!;
    expect(t.description).toContain("TODO");
    expect(t.envelope).toEqual({ caps: ["read"], write_paths: [], network: [] });
  });
  it("refuses invalid ids, the reserved ask id, and existing directories", () => {
    const p = getPaths(tempHome());
    expect(() => scaffoldTask(p, "Bad_Id")).toThrow(/valid task id/i);
    expect(() => scaffoldTask(p, "ask")).toThrow(/reserved/i);
    scaffoldTask(p, "twice");
    expect(() => scaffoldTask(p, "twice")).toThrow(/already exists/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `packages/cli`): `pnpm test -- tasks`
Expected: FAIL — `scaffoldTask` not exported.

- [ ] **Step 3: Implement**

Append to `packages/cli/src/tasks.ts` (add `mkdirSync, writeFileSync` to the `node:fs` import):

```ts
// Scaffold for `agentcall task new`. Parses cleanly as-is: the TODO
// description shows up verbatim on the owner's card review, which is its
// own nudge to edit before offering. Commented lines document every
// optional frontmatter field with its default.
export const SKILL_TEMPLATE = `---
description: TODO — one line callers will see on your card
# name: defaults to the directory name
# tier: T1                # T1 runs immediately; T2 reserved for approval gates
# tools: [read]           # read | write | fetch | exec
# write_paths: []         # e.g. [public/inbox] — must be public or under it
# network: []             # extra allowed domains, e.g. [calendar.google.com]
# timeout_s: 300
# examples:
#   - An example message a caller might send
---
# Instructions for this task

Describe how your agent should perform it. This text is given to the
agent verbatim when a caller invokes the task.
`;

// Creates ~/AgentCall/tasks/<id>/SKILL.md from the template and returns the
// file path. Never overwrites; never touches policy — a scaffolded task is
// invisible to callers until the owner runs `agentcall offer <id>` or
// `agentcall allow <handle> <id>` (create ≠ publish).
export function scaffoldTask(p: Paths, id: string): string {
  if (!TASK_ID_RE.test(id)) {
    throw new Error(`"${id}" is not a valid task id: lowercase letters, digits, and hyphens, starting with a letter or digit.`);
  }
  if (id === ASK_TASK.id) throw new Error(`"ask" is the built-in reserved task and can't be redefined.`);
  const dir = join(p.tasksDir, id);
  if (existsSync(dir)) throw new Error(`Task "${id}" already exists at ${dir}.`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, SKILL_TEMPLATE);
  return file;
}
```

- [ ] **Step 4: Wire the CLI command**

In `packages/cli/src/index.ts` (import `scaffoldTask` from `./tasks.js`), add:

```ts
const task = program.command("task").description("manage the tasks your agent offers");
task
  .command("new")
  .description("scaffold a new task (does not publish it)")
  .argument("<id>", "task id: lowercase kebab-case, becomes the directory name")
  .action((id: string) => {
    const paths = getPaths();
    try {
      const file = scaffoldTask(paths, id);
      console.log(`Created ${file}\nEdit it, then:`);
      console.log(`  agentcall card                      # check it validates`);
      console.log(`  agentcall offer ${id}    # offer to everyone, or:`);
      console.log(`  agentcall allow <handle> ${id}`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `packages/cli`): `pnpm test && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/tasks.ts packages/cli/src/index.ts packages/cli/test/tasks.test.ts
git commit -m "feat(cli): agentcall task new scaffolds a frontmatter SKILL.md"
```

---

### Task 6: README, full gate, and manual check

**Files:**
- Modify: `README.md` (the task-menu section added in Phase 1's final fixes)

- [ ] **Step 1: Update the README section**

Rewrite the Phase 1 task-menu paragraph to reflect the 1.5 surface. Locate the section added by commit `34514c0` and replace its body with:

```markdown
Plain calls (no `--task`) run the built-in read-only `ask` task. To offer more:

    agentcall task new schedule-meeting   # scaffold ~/AgentCall/tasks/<id>/SKILL.md
    # edit the SKILL.md (YAML frontmatter: description, tools, network, ...)
    agentcall card                        # review your card + catch problems
    agentcall offer schedule-meeting      # offer to everyone, or:
    agentcall allow ken schedule-meeting  # grant to one caller
    agentcall block spammer               # refuse a caller entirely

Tasks are one markdown file each — YAML frontmatter (only `description` is
required) over the instructions your agent follows. Grants and blocks live in
`~/.agentcall/policy.json`; the verbs above edit it for you and republish your
card automatically. Callers see your menu with `agentcall card <address>`.
```

- [ ] **Step 2: Full repo gate**

Run (from the worktree root): `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all green across shared/relay/cli. Fix anything that fails.

- [ ] **Step 3: Manual smoke (no relay needed)**

With `AGENTCALL_HOME` pointed at a temp dir and a config.json seeded by hand (or on the real home if set up): `agentcall task new demo` → `agentcall card` shows the TODO description and a never-pushed notice, exit 0; break the SKILL.md frontmatter → `agentcall card` shows a `✗` and exits 1. Record the transcript in the commit message or PR body.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: task-menu owner workflow (task new / card / offer / allow / block)"
```

## Self-Review (completed at plan-writing time)

- **Spec coverage:** D frontmatter format + no-migration (Task 1), A card lint + snapshot staleness + exit codes (Tasks 2, 4), B verbs + auto-publish + degrade-to-warning (Tasks 2, 3), C scaffold + create≠publish (Task 5), error-visibility principle (warn callback capture in Task 4; verb/scaffold errors to stderr in Tasks 3, 5), README (Task 6). Non-goals respected: no relay change, no `task test`, no listener file-watching.
- **Type consistency:** `execVerb(policy, tasks, verb, a, b?)` → `{policy, lines}`; `publishCard(cfg, p, push?)` → `Promise<CardUploadType>`; `buildCardReport(cfg, p)` → `{menu, problems, notices}`; `scaffoldTask(p, id)` → `string`; `splitFrontmatter(text)` → `{meta, body} | null` — checked against every consuming task.
- **Known judgment calls encoded:** blocked entries are never auto-dropped by revoke (block survives empty offers); allow-on-blocked records the grant and says so; verbs save policy locally even when the push fails; snapshot written only on successful push.
