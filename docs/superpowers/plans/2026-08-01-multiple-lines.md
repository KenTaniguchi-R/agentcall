# Multiple Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one machine host several agentcall addresses — one *line* per agent — each with its own handle, policy, tasks, and socket, all served by a single supervised listener process.

**Architecture:** Split the single flat `Config`/`Paths` into person-scoped state (`~/.agentcall/person.json`, contacts) and line-scoped state (`~/.agentcall/lines/<name>/`). One `agentcall listen` process opens N authenticated WebSockets, one per line, each with its own `SerialQueue`. Outbound calls pick a line by matching the destination's relay. No migration — there are no users.

**Tech Stack:** TypeScript ESM, pnpm workspace, vitest, zod (`packages/shared`), commander (CLI), `ws`, macOS launchd.

**Spec:** [`docs/superpowers/specs/2026-08-01-multiple-lines-design.md`](../specs/2026-08-01-multiple-lines-design.md)

## Global Constraints

- **TDD.** Every task writes the failing test first, runs it to see it fail, then implements. No exceptions.
- **Build before typecheck.** `pnpm -r build && pnpm -r typecheck && pnpm -r test` from the repo root, in that order. `packages/cli` typechecks against `packages/shared`'s built `dist`.
- **Every commit is green.** `pnpm -r build && pnpm -r typecheck && pnpm -r test` must pass before every commit in every task — no exceptions, no "the next task fixes it". This is why the migration is **additive**: new types land *alongside* the old ones (`paths.ts` exports `Paths`/`getPaths` *and* `MachinePaths`/`getMachinePaths`; `config.ts` exports `Config` *and* `LineConfig`), each consumer moves over in its own task, and the legacy exports are deleted in Task 12 once nothing imports them. If a task's change would break an existing caller, that task updates the caller.
- **Baseline is 504 tests** (73 shared / 67 relay / 364 cli). A task that ends with fewer passing than it started has broken something.
- **Protocol types live in `packages/shared`.** Never redeclare a frame shape in `apps/relay` or `packages/cli`.
- **Stage files explicitly** — `git add <file> <file>`. Never `git add -A` or `git add .`.
- **No live agent spawn in tests.** `packages/cli/test/runner.test.ts`'s fake binary is the seam.
- **`typecheck` covers `src` and `test`** via `tsconfig.test.json`. A changed signature must not leave stale call sites in `test/`.
- **No relay changes.** This feature is entirely client-side. If you find yourself editing `apps/relay`, stop — you have gone off-plan.
- **Line name regex:** `/^[a-z0-9][a-z0-9-]{0,31}$/`, compared case-insensitively against existing names.
- **Handle regex** is `HANDLE_RE` from `@benree/agentcall-shared` — do not duplicate it.
- File modes: directories `0o700`, files `0o600`, matching `config.ts:70-75`.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `packages/cli/src/person.ts` | `Person` record: load, atomic save, primary-line recovery |
| `packages/cli/src/lines.ts` | `LineConfig` load/save, line enumeration, name validation, orphan detection |
| `packages/cli/src/lineContext.ts` | `resolveLine` — the single place `--line` precedence is applied |
| `packages/cli/src/outbound.ts` | Picks which line places an outgoing call, by relay match |
| `packages/cli/src/commands/line.ts` | `line add/list/remove/primary` |
| `packages/cli/test/person.test.ts`, `lines.test.ts`, `lineContext.test.ts`, `outbound.test.ts`, `line-cmd.test.ts` | Their tests |

**Modified:**

| File | Change |
|---|---|
| `packages/shared/src/protocol.ts` | Export `AgentKind` type + `AGENT_KINDS` const |
| `packages/cli/src/paths.ts` | Add `MachinePaths` + `LinePaths` alongside `Paths` (deleted in Task 12) |
| `packages/cli/src/config.ts` | Add `LineConfig` + `resolveLineWorkdir` alongside `Config` (deleted in Task 12) |
| `packages/cli/src/launchd.ts` | Plist path and `HOME` derive from `userHome` |
| `packages/cli/src/guard.ts` | `decide()` gets `userHome`; per-line task dirs as extra denied roots |
| `packages/cli/src/guard-entry.ts` | Resolve `LinePaths` from `AGENTCALL_LINE`, fail closed if absent |
| `packages/cli/src/runner.ts` | Inject `AGENTCALL_LINE` into both spawn specs |
| `packages/cli/src/listener.ts` | Re-read config on reconnect |
| `packages/cli/src/setup.ts` | Person + first line |
| `packages/cli/src/doctor.ts` | Per-line reporting |
| `packages/cli/src/index.ts` | Wire everything; `line` command group; `--as`/`--line` |
| `packages/cli/src/card.ts`, `policy.ts`, `tasks.ts`, `contacts.ts`, `verify.ts` | `Paths` → `LinePaths`/`MachinePaths` |
| `README.md`, `CHANGELOG.md` | Document lines |

---

## Task 1: `AgentKind` moves to `packages/shared`

Seven sites declare `"claude" | "codex"` inline. Consolidate before anything else touches them, so later tasks import one name.

**Files:**
- Modify: `packages/shared/src/protocol.ts`
- Modify: `packages/cli/src/config.ts:9`, `setup.ts:24,65,175`, `api.ts:41`
- Modify: `packages/cli/src/bin.ts:54` (`resolveAgentBin`'s parameter), `packages/cli/src/index.ts:43` (the `as` cast in the `setup` action)
- Test: `packages/shared/test/protocol.test.ts`

**Done means this returns only the `AGENT_KINDS` declaration:**

```bash
grep -rn '"claude" *| *"codex"' packages/cli/src apps/relay/src packages/shared/src
```

*(Corrected 2026-08-01 after the Task 1 review: the first draft said "five files" and
omitted `bin.ts` and `index.ts`, so the consolidation the task exists for was not
actually complete. The grep above is the real acceptance test.)*

**Interfaces:**
- Produces: `AGENT_KINDS: readonly ["claude", "codex"]`, `type AgentKind = "claude" | "codex"`, `AgentKindSchema: z.ZodEnum`

- [ ] **Step 1: Write the failing test**

In `packages/shared/test/protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AGENT_KINDS, AgentKindSchema } from "../src/protocol.js";

describe("AgentKind", () => {
  it("exposes the known agent kinds", () => {
    expect(AGENT_KINDS).toEqual(["claude", "codex"]);
  });

  it("accepts a known kind and rejects an unknown one", () => {
    expect(AgentKindSchema.parse("codex")).toBe("codex");
    expect(AgentKindSchema.safeParse("hermes").success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/shared && pnpm vitest run test/protocol.test.ts -t AgentKind`
Expected: FAIL — `AGENT_KINDS` is not exported.

- [ ] **Step 3: Implement**

In `packages/shared/src/protocol.ts`, above `RegisterRequest`:

```ts
export const AGENT_KINDS = ["claude", "codex"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];
export const AgentKindSchema = z.enum(AGENT_KINDS);
```

Then replace the three existing closed enums with it:
- `protocol.ts:128` — `agent_kind: AgentKindSchema.optional()`
- `packages/shared/src/card.ts:20` and `:31` — `agent_kind: AgentKindSchema`

In the CLI, replace each inline union with the imported type:
- `config.ts:9` → `agent_kind?: AgentKind;`
- `setup.ts:24` → `agent?: AgentKind;`
- `setup.ts:65` → `Promise<AgentKind>`
- `setup.ts:175` → `let agentKind: AgentKind | undefined;`
- `api.ts:41` → `agentKind?: AgentKind`

Add `import type { AgentKind } from "@benree/agentcall-shared";` to each. Note `runner.ts` already has its own `AgentKind` — delete that local declaration and re-export the shared one so `verify.ts`'s `import { type AgentKind } from "./runner.js"` keeps working.

- [ ] **Step 4: Verify**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/protocol.ts packages/shared/src/card.ts packages/shared/test/protocol.test.ts packages/cli/src/config.ts packages/cli/src/setup.ts packages/cli/src/api.ts packages/cli/src/runner.ts
git commit -m "refactor(shared): export AgentKind, drop five inline unions"
```

---

## Task 2: `MachinePaths` and `LinePaths`

The load-bearing split. `getPaths(home)` conflates the state root, the user's real home (plist `HOME`, `~/Library/LaunchAgents`, **the guard's security root**), and authored content. No field is named `home` afterwards — that reuse is what caused the conflation.

**Files:**
- Modify: `packages/cli/src/paths.ts` (additive — the new declarations land beside the existing `Paths`/`getPaths`, which stay until Task 12)
- Create: `packages/cli/test/paths.test.ts` — **this file does not exist.** `getPaths` has never had a dedicated test; it is only exercised indirectly through the ten test files that build `Paths` to drive other modules. Nothing to preserve or merge.

**Interfaces:**
- Produces: `MachinePaths`, `LinePaths`, `getMachinePaths(stateRoot?, userHome?)`, `getLinePaths(m, name)`

- [ ] **Step 1: Write the failing test**

Replace `packages/cli/test/paths.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { getLinePaths, getMachinePaths } from "../src/paths.js";

describe("getMachinePaths", () => {
  it("derives person-scoped paths from the state root", () => {
    const m = getMachinePaths("/state", "/state");
    expect(m.dir).toBe("/state/.agentcall");
    expect(m.personFile).toBe("/state/.agentcall/person.json");
    expect(m.contactsFile).toBe("/state/.agentcall/contacts.json");
    expect(m.linesDir).toBe("/state/.agentcall/lines");
    expect(m.removedDir).toBe("/state/.agentcall/removed");
    expect(m.listenerLog).toBe("/state/.agentcall/listener.log");
  });

  it("keeps userHome independent of the state root", () => {
    const m = getMachinePaths("/tmp/test-state", "/Users/real");
    expect(m.stateRoot).toBe("/tmp/test-state");
    expect(m.userHome).toBe("/Users/real");
    expect(m.dir).toBe("/tmp/test-state/.agentcall");
  });

  it("reads AGENTCALL_HOME for the state root only", () => {
    const prev = process.env.AGENTCALL_HOME;
    process.env.AGENTCALL_HOME = "/tmp/env-state";
    try {
      const m = getMachinePaths();
      expect(m.stateRoot).toBe("/tmp/env-state");
      expect(m.userHome).not.toBe("/tmp/env-state");
    } finally {
      if (prev === undefined) delete process.env.AGENTCALL_HOME;
      else process.env.AGENTCALL_HOME = prev;
    }
  });
});

describe("getLinePaths", () => {
  it("puts line state under linesDir and authored content under AgentCall/<name>", () => {
    const m = getMachinePaths("/state", "/state");
    const l = getLinePaths(m, "codex");
    expect(l.name).toBe("codex");
    expect(l.dir).toBe("/state/.agentcall/lines/codex");
    expect(l.configFile).toBe(join(l.dir, "config.json"));
    expect(l.policyFile).toBe(join(l.dir, "policy.json"));
    expect(l.cardSnapshotFile).toBe(join(l.dir, "card.pushed.json"));
    expect(l.callsLog).toBe(join(l.dir, "calls.log"));
    expect(l.toolsLog).toBe(join(l.dir, "tools.log"));
    expect(l.tasksDir).toBe("/state/AgentCall/codex/tasks");
    expect(l.shareDir).toBe("/state/AgentCall/codex/public");
  });

  it("carries the machine paths so a line can reach person-scoped state", () => {
    const m = getMachinePaths("/state", "/real");
    expect(getLinePaths(m, "claude").machine.userHome).toBe("/real");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/paths.test.ts`
Expected: FAIL — `getMachinePaths` is not exported.

- [ ] **Step 3: Implement**

Replace `packages/cli/src/paths.ts` entirely:

```ts
import os from "node:os";
import { join } from "node:path";

// Three concepts that used to be one string called `home`:
//   userHome  — the real account home. The plist's HOME, ~/Library/LaunchAgents,
//               and the guard's security root (the home whose .ssh/.claude/.codex
//               get denied). Redirecting this is how a test home silently stopped
//               protecting the real one.
//   stateRoot — where agentcall keeps its own state. Redirectable via
//               AGENTCALL_HOME, which is a TEST SEAM and not a user feature.
//   authored  — owner-edited task markdown, kept outside the dotfile dir so it
//               is visible in Finder. Follows stateRoot.
export interface MachinePaths {
  userHome: string;
  stateRoot: string;
  dir: string;
  personFile: string;
  contactsFile: string;
  linesDir: string;
  removedDir: string;
  listenerLog: string;
}

export interface LinePaths {
  machine: MachinePaths;
  name: string;
  dir: string;
  configFile: string;
  policyFile: string;
  cardSnapshotFile: string;
  callsLog: string;
  toolsLog: string;
  tasksDir: string;
  shareDir: string;
}

export function getMachinePaths(
  stateRoot: string = process.env.AGENTCALL_HOME ?? os.homedir(),
  userHome: string = os.homedir(),
): MachinePaths {
  const dir = join(stateRoot, ".agentcall");
  return {
    userHome,
    stateRoot,
    dir,
    personFile: join(dir, "person.json"),
    contactsFile: join(dir, "contacts.json"),
    linesDir: join(dir, "lines"),
    removedDir: join(dir, "removed"),
    // One process serves every line, so there is one listener log.
    listenerLog: join(dir, "listener.log"),
  };
}

export function getLinePaths(machine: MachinePaths, name: string): LinePaths {
  const dir = join(machine.linesDir, name);
  const authored = join(machine.stateRoot, "AgentCall", name);
  return {
    machine,
    name,
    dir,
    configFile: join(dir, "config.json"),
    policyFile: join(dir, "policy.json"),
    cardSnapshotFile: join(dir, "card.pushed.json"),
    callsLog: join(dir, "calls.log"),
    toolsLog: join(dir, "tools.log"),
    tasksDir: join(authored, "tasks"),
    shareDir: join(authored, "public"),
  };
}
```

**Additive — do not delete anything.** Keep the existing `Paths` interface and
`getPaths` export exactly as they are, and add the four new declarations above them
in the same file. Every current consumer keeps compiling untouched; each moves to
`MachinePaths`/`LinePaths` in its own later task, and Task 12 deletes `Paths` and
`getPaths` once nothing imports them. A comment on the legacy pair saying so is
welcome; removing them here is not.

- [ ] **Step 4: Run the full suite**

Run from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all pass — 504 tests plus the new `paths.test.ts` cases. Nothing else
changed, so nothing else may break.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/paths.ts packages/cli/test/paths.test.ts
git commit -m "refactor(cli): split Paths into MachinePaths and LinePaths"
```

---

## Task 3: The `Person` record

**Files:**
- Create: `packages/cli/src/person.ts`
- Test: `packages/cli/test/person.test.ts`

**Interfaces:**
- Consumes: `MachinePaths` (Task 2)
- Produces: `Person`, `loadPerson(m)`, `savePerson(m, p)`, `resolvePrimary(m, lineNames)`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMachinePaths, type MachinePaths } from "../src/paths.js";
import { loadPerson, savePerson, resolvePrimary } from "../src/person.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-person-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.dir, { recursive: true });
});

describe("savePerson / loadPerson", () => {
  it("round-trips and writes 0600", () => {
    savePerson(m, { primary_line: "claude" });
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(statSync(m.personFile).mode & 0o777).toBe(0o600);
  });

  it("rejects a corrupt person.json rather than returning a partial record", () => {
    writeFileSync(m.personFile, "{not json");
    expect(() => loadPerson(m)).toThrow(/person\.json/);
  });

  it("rejects a schema-invalid person.json", () => {
    writeFileSync(m.personFile, JSON.stringify({ primary_line: 42 }));
    expect(() => loadPerson(m)).toThrow(/person\.json/);
  });

  it("does not leave a temp file behind", () => {
    savePerson(m, { primary_line: "claude" });
    const leftovers = readFileSync(m.personFile, "utf8");
    expect(leftovers).toContain("claude");
  });
});

describe("resolvePrimary", () => {
  it("returns the recorded primary when it still exists", () => {
    savePerson(m, { primary_line: "codex" });
    expect(resolvePrimary(m, ["claude", "codex"])).toBe("codex");
  });

  it("repairs a dangling primary when exactly one line remains", () => {
    savePerson(m, { primary_line: "gone" });
    expect(resolvePrimary(m, ["claude"])).toBe("claude");
    expect(loadPerson(m).primary_line).toBe("claude");
  });

  it("refuses to guess when the primary dangles and several lines exist", () => {
    savePerson(m, { primary_line: "gone" });
    expect(() => resolvePrimary(m, ["claude", "codex"])).toThrow(/agentcall line primary/);
  });

  it("adopts the only line when person.json is missing entirely", () => {
    expect(resolvePrimary(m, ["claude"])).toBe("claude");
    expect(loadPerson(m).primary_line).toBe("claude");
  });

  it("refuses when there are no lines at all", () => {
    expect(() => resolvePrimary(m, [])).toThrow(/agentcall setup/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/person.test.ts`
Expected: FAIL — cannot resolve `../src/person.js`.

- [ ] **Step 3: Implement**

```ts
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import type { MachinePaths } from "./paths.js";

export const PersonSchema = z.object({ primary_line: z.string() });
export type Person = z.infer<typeof PersonSchema>;

export function loadPerson(m: MachinePaths): Person {
  if (!existsSync(m.personFile)) {
    throw new Error(`No agentcall install found. Run \`agentcall setup\` first.`);
  }
  try {
    return PersonSchema.parse(JSON.parse(readFileSync(m.personFile, "utf8")));
  } catch (e) {
    throw new Error(
      `Corrupt person.json at ${m.personFile}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

// Temp-file-plus-rename: person.json is read by every person-scoped command,
// so a half-written file would break the whole CLI rather than one feature.
// rename(2) within a directory is atomic, so a reader sees either the old
// file or the new one.
export function savePerson(m: MachinePaths, person: Person): void {
  mkdirSync(m.dir, { recursive: true, mode: 0o700 });
  chmodSync(m.dir, 0o700);
  const tmp = `${m.personFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(person, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, m.personFile);
}

// The primary line is what places every outgoing call, so a dangling pointer
// has to be handled rather than thrown at the user mid-call. One line is
// unambiguous and gets repaired silently; several is a decision only the
// owner can make.
export function resolvePrimary(m: MachinePaths, lineNames: string[]): string {
  if (lineNames.length === 0) {
    throw new Error("This machine has no agentcall lines. Run `agentcall setup` first.");
  }
  let recorded: string | undefined;
  if (existsSync(m.personFile)) recorded = loadPerson(m).primary_line;
  if (recorded !== undefined && lineNames.includes(recorded)) return recorded;

  if (lineNames.length === 1) {
    savePerson(m, { primary_line: lineNames[0]! });
    return lineNames[0]!;
  }
  throw new Error(
    `No usable primary line (person.json names ${recorded === undefined ? "nothing" : `"${recorded}"`}, ` +
      `which does not exist). Pick one with: agentcall line primary <${lineNames.join("|")}>`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/person.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/person.ts packages/cli/test/person.test.ts
git commit -m "feat(cli): add the Person record with atomic writes and primary recovery"
```

---

## Task 4: `lines.ts` — line config, enumeration, validation

**Files:**
- Create: `packages/cli/src/lines.ts`
- Modify: `packages/cli/src/config.ts` (rename `Config` → `LineConfig`, retarget `resolveWorkdir`)
- Test: `packages/cli/test/lines.test.ts`

**Interfaces:**
- Consumes: `MachinePaths`, `LinePaths`, `getLinePaths` (Task 2)
- Produces: `LINE_NAME_RE`, `assertValidLineName(name)`, `loadLineConfig(l)`, `saveLineConfig(l, cfg)`, `listLines(m): LineSummary[]`, `type LineSummary = { name: string; ok: boolean; config?: LineConfig; error?: string }`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { assertValidLineName, listLines, loadLineConfig, saveLineConfig } from "../src/lines.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-lines-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const cfg = { handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("assertValidLineName", () => {
  it("accepts lowercase alphanumeric and hyphens", () => {
    expect(() => assertValidLineName("codex-2")).not.toThrow();
  });

  it.each(["../escape", "Codex", "has space", "-leading", "", "a".repeat(33)])(
    "rejects %j",
    (name) => {
      expect(() => assertValidLineName(name)).toThrow(/line name/i);
    },
  );
});

describe("saveLineConfig / loadLineConfig", () => {
  it("round-trips and writes 0600 under a 0700 directory", () => {
    const l = getLinePaths(m, "claude");
    saveLineConfig(l, cfg);
    expect(loadLineConfig(l)).toEqual(cfg);
    expect(statSync(l.configFile).mode & 0o777).toBe(0o600);
    expect(statSync(l.dir).mode & 0o777).toBe(0o700);
  });
});

describe("listLines", () => {
  it("returns nothing when linesDir does not exist", () => {
    const empty = getMachinePaths(mkdtempSync(join(tmpdir(), "agentcall-none-")));
    expect(listLines(empty)).toEqual([]);
  });

  it("lists valid lines sorted by name", () => {
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    expect(listLines(m).map((l) => l.name)).toEqual(["claude", "codex"]);
    expect(listLines(m).every((l) => l.ok)).toBe(true);
  });

  it("reports a line with no config.json as an orphan rather than throwing", () => {
    mkdirSync(join(m.linesDir, "half-made"), { recursive: true });
    const [line] = listLines(m);
    expect(line!.ok).toBe(false);
    expect(line!.error).toMatch(/config\.json/);
  });

  it("reports a schema-invalid config as an orphan", () => {
    const l = getLinePaths(m, "broken");
    mkdirSync(l.dir, { recursive: true });
    writeFileSync(l.configFile, JSON.stringify({ handle: "x" }));
    expect(listLines(m)[0]!.ok).toBe(false);
  });

  it("ignores files and invalid names sitting in linesDir", () => {
    writeFileSync(join(m.linesDir, "stray.txt"), "x");
    mkdirSync(join(m.linesDir, "Bad Name"), { recursive: true });
    expect(listLines(m)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/lines.test.ts`
Expected: FAIL — cannot resolve `../src/lines.js`.

- [ ] **Step 3: Implement**

First, in `packages/cli/src/config.ts`, rename the interface and retarget the workdir helper:

```ts
export interface LineConfig {
  handle: string;
  token: string;
  relay: string;
  /** Absent = answer-incapable. The line can still call out. */
  agent_kind?: AgentKind;
  workdir?: string;
}
export type CallableLineConfig = LineConfig & { agent_kind: AgentKind };

export function assertCallableLine(cfg: LineConfig): asserts cfg is CallableLineConfig {
  if (!cfg.agent_kind) {
    throw new Error("This line is caller-only — re-run `agentcall line add` with an agent to make it callable.");
  }
}
```

**Additive again:** leave `Config`, `CallableConfig`, `assertCallableConfig`,
`loadConfig`, `saveConfig`, and the existing `resolveWorkdir` exactly as they are.
Add `LineConfig`, `CallableLineConfig`, `assertCallableLine`, and a new
`resolveLineWorkdir(cfg: LineConfig, p: LinePaths)` — same logic as `resolveWorkdir`,
but defaulting to `p.shareDir` instead of `p.publicDir`. Task 12 deletes the legacy
half once its last consumer has moved.

Then create `packages/cli/src/lines.ts`:

```ts
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentKindSchema } from "@benree/agentcall-shared";
import { getLinePaths, type LinePaths, type MachinePaths } from "./paths.js";
import type { LineConfig } from "./config.js";

// A line name becomes a directory component and part of an authored-content
// path, so this regex is the traversal defence and runs before anything
// touches disk. Deliberately narrower than HANDLE_RE: the handle is global
// and may need length, the local label does not.
export const LINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertValidLineName(name: string): void {
  if (!LINE_NAME_RE.test(name)) {
    throw new Error(
      `"${name}" isn't a valid line name: lowercase letters, digits and hyphens, ` +
        `1-32 characters, starting with a letter or digit.`,
    );
  }
}

export const LineConfigSchema = z.object({
  handle: z.string(),
  token: z.string(),
  relay: z.string(),
  agent_kind: AgentKindSchema.optional(),
  workdir: z.string().optional(),
});

export function loadLineConfig(l: LinePaths): LineConfig {
  if (!existsSync(l.configFile)) {
    throw new Error(`Line "${l.name}" has no config.json — it was never finished. Remove it with \`agentcall line remove ${l.name}\`.`);
  }
  try {
    return LineConfigSchema.parse(JSON.parse(readFileSync(l.configFile, "utf8")));
  } catch (e) {
    throw new Error(`Corrupt config.json for line "${l.name}": ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Atomic for the same reason person.json is: this file holds the only copy of
// the relay token, and a torn write is unrecoverable (the relay authenticates
// rotation with the OLD token, and handle release is not implemented — #16).
export function saveLineConfig(l: LinePaths, cfg: LineConfig): void {
  mkdirSync(l.dir, { recursive: true, mode: 0o700 });
  chmodSync(l.dir, 0o700);
  const tmp = `${l.configFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, l.configFile);
}

export interface LineSummary {
  name: string;
  ok: boolean;
  paths: LinePaths;
  config?: LineConfig;
  error?: string;
}

// Never throws: a half-made or corrupt line must be *reportable* (by doctor,
// by `line list`) rather than fatal to every command that enumerates lines.
export function listLines(m: MachinePaths): LineSummary[] {
  if (!existsSync(m.linesDir)) return [];
  const names = readdirSync(m.linesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LINE_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  return names.map((name) => {
    const paths = getLinePaths(m, name);
    try {
      return { name, ok: true, paths, config: loadLineConfig(paths) };
    } catch (e) {
      return { name, ok: false, paths, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function readyLines(m: MachinePaths): { name: string; paths: LinePaths; config: LineConfig }[] {
  return listLines(m)
    .filter((l): l is LineSummary & { config: LineConfig } => l.ok && l.config !== undefined)
    .map(({ name, paths, config }) => ({ name, paths, config }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/lines.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lines.ts packages/cli/src/config.ts packages/cli/test/lines.test.ts
git commit -m "feat(cli): add line config storage, enumeration and name validation"
```

---

## Task 5: `LineContext` and `resolveLine`

The single place `--line` precedence is applied. Without it, a command can resolve the line twice and pair one line's policy with another's token.

**Files:**
- Create: `packages/cli/src/lineContext.ts`
- Test: `packages/cli/test/lineContext.test.ts`

**Interfaces:**
- Consumes: `listLines`, `readyLines` (Task 4), `resolvePrimary` (Task 3)
- Produces: `LineContext { machine, name, paths, config }`, `resolveLine(m, opts?: { line?: string })`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { savePerson } from "../src/person.js";
import { resolveLine } from "../src/lineContext.js";

let m: MachinePaths;
const cfg = { handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-ctx-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
  delete process.env.AGENTCALL_LINE;
});
afterEach(() => { delete process.env.AGENTCALL_LINE; });

describe("resolveLine", () => {
  it("prefers an explicit --line over everything", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    savePerson(m, { primary_line: "claude" });
    process.env.AGENTCALL_LINE = "claude";
    expect(resolveLine(m, { line: "codex" }).name).toBe("codex");
  });

  it("falls back to AGENTCALL_LINE, then to the primary", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    savePerson(m, { primary_line: "claude" });
    process.env.AGENTCALL_LINE = "codex";
    expect(resolveLine(m).name).toBe("codex");
    delete process.env.AGENTCALL_LINE;
    expect(resolveLine(m).name).toBe("claude");
  });

  it("returns the config alongside the paths, from the same line", () => {
    saveLineConfig(getLinePaths(m, "codex"), { ...cfg, handle: "ken-cdx" });
    const ctx = resolveLine(m, { line: "codex" });
    expect(ctx.config.handle).toBe("ken-cdx");
    expect(ctx.paths.configFile).toContain(join("lines", "codex"));
  });

  it("names the available lines when asked for one that does not exist", () => {
    saveLineConfig(getLinePaths(m, "claude"), cfg);
    expect(() => resolveLine(m, { line: "nope" })).toThrow(/claude/);
  });

  it("refuses an orphaned line rather than returning a partial context", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    expect(() => resolveLine(m, { line: "half" })).toThrow(/config\.json/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/lineContext.test.ts`
Expected: FAIL — cannot resolve `../src/lineContext.js`.

- [ ] **Step 3: Implement**

```ts
import type { LineConfig } from "./config.js";
import { listLines, readyLines } from "./lines.js";
import type { LinePaths, MachinePaths } from "./paths.js";
import { resolvePrimary } from "./person.js";

export interface LineContext {
  machine: MachinePaths;
  name: string;
  paths: LinePaths;
  config: LineConfig;
}

export interface LineSelector {
  line?: string;
}

// Resolved ONCE per command and threaded through. Resolving twice — say, once
// for policy and once for credentials — is how a command ends up publishing
// one line's task menu under another line's handle.
export function resolveLine(m: MachinePaths, opts: LineSelector = {}): LineContext {
  const all = listLines(m);
  const requested = opts.line ?? process.env.AGENTCALL_LINE;

  if (requested !== undefined && requested !== "") {
    const found = all.find((l) => l.name === requested);
    if (!found) {
      const names = all.map((l) => l.name);
      throw new Error(
        `No line named "${requested}".` +
          (names.length > 0 ? ` This machine has: ${names.join(", ")}.` : " This machine has none."),
      );
    }
    if (!found.ok || !found.config) throw new Error(found.error ?? `Line "${requested}" is unusable.`);
    return { machine: m, name: found.name, paths: found.paths, config: found.config };
  }

  const ready = readyLines(m);
  const primary = resolvePrimary(m, ready.map((l) => l.name));
  const found = ready.find((l) => l.name === primary)!;
  return { machine: m, name: found.name, paths: found.paths, config: found.config };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/lineContext.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/lineContext.ts packages/cli/test/lineContext.test.ts
git commit -m "feat(cli): add LineContext so a command resolves its line exactly once"
```

---

## Task 6: `launchd` uses `userHome`

Small, isolated, and the reason a supervised second identity was impossible.

**Files:**
- Modify: `packages/cli/src/launchd.ts`
- Test: `packages/cli/test/launchd.test.ts`

**Interfaces:**
- Consumes: `MachinePaths` (Task 2)
- Produces: `launchAgentFile(m)`, `isLaunchAgentInstalled(m)`, `installLaunchAgent(m, execCmd?, extraPathDirs?, sleep?)`, `uninstallLaunchAgent(m, execCmd?)` — all now taking `MachinePaths`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/launchd.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { getMachinePaths } from "../src/paths.js";
import { launchAgentFile, plistContent } from "../src/launchd.js";

describe("plist uses the real home, not the state root", () => {
  it("sets HOME to userHome so the spawned agent finds its credentials", () => {
    const m = getMachinePaths("/tmp/state", "/Users/real");
    const xml = plistContent("/usr/bin/node", "/pkg/dist/index.js", m);
    expect(xml).toContain("<key>HOME</key><string>/Users/real</string>");
    expect(xml).not.toContain("<string>/tmp/state</string>");
  });

  it("writes the plist under userHome's LaunchAgents", () => {
    const m = getMachinePaths("/tmp/state", "/Users/real");
    expect(launchAgentFile(m)).toBe(
      "/Users/real/Library/LaunchAgents/tech.benree.agentcall.listener.plist",
    );
  });

  it("logs to the machine-scoped listener log", () => {
    const m = getMachinePaths("/tmp/state", "/Users/real");
    expect(plistContent("/usr/bin/node", "/pkg/dist/index.js", m))
      .toContain("<key>StandardOutPath</key><string>/tmp/state/.agentcall/listener.log</string>");
  });

  it("runs `listen` with no line argument — one process serves every line", () => {
    const m = getMachinePaths("/tmp/state", "/Users/real");
    const xml = plistContent("/usr/bin/node", "/pkg/dist/index.js", m);
    expect(xml).toContain("<string>listen</string>");
    expect(xml).not.toContain("--line");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/launchd.test.ts -t "real home"`
Expected: FAIL — `plistContent` still reads `p.home`.

- [ ] **Step 3: Implement**

In `packages/cli/src/launchd.ts`, change the type import to `MachinePaths` and swap the two `p.home` reads:

```ts
export function launchAgentFile(m: MachinePaths): string {
  // userHome, not stateRoot: launchd only loads plists from the real account's
  // LaunchAgents directory, and a redirected state root must not move it.
  return join(m.userHome, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
}
```

and inside `plistContent`, replace `<key>HOME</key><string>${p.home}</string>` with:

```ts
    <key>HOME</key><string>${m.userHome}</string>
```

with `${p.listenerLog}` becoming `${m.listenerLog}`. Rename the parameter `p` to `m` throughout the module. `LAUNCH_LABEL` stays a single constant — one process, one label.

**This changes a public signature, so update every caller in this same task** — the
green-commit constraint applies here as much as anywhere. The callers are
`index.ts` (`rotate` at the `isLaunchAgentInstalled`/`installLaunchAgent` pair, and
`uninstall`), `setup.ts` (the `installLaunchAgentFn` call), and any launchd call in
`packages/cli/test/`. Each becomes `getMachinePaths()` instead of `getPaths()` —
`getMachinePaths` already exists from Task 2 and needs no other change to those
files. `doctor.ts` only imports `LAUNCH_LABEL` and is unaffected.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/launchd.test.ts`, then the full gate
from the repo root: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/launchd.ts packages/cli/test/launchd.test.ts
git commit -m "fix(cli): plist HOME and path derive from the real home, not the state root"
```

---

## Task 7: Guard — real-home security root, per-line task denial, line propagation

Three defects, all security-relevant, all introduced or exposed by the split.

**Why this matters:** `guard.ts:302` passes `deps.paths.home` to `decide()` as the home whose `.ssh`, `.claude`, `.codex`, `.agentcall` and shell startup files are denied. Pass the state root and the guard protects a temp directory while the real home stands open. Separately, `DENIED_DIRS` contains the home-relative `AgentCall/tasks` (`guard.ts:47`) — under the new layout that path is `AgentCall/<line>/tasks`, so **the rule stops matching and task frontmatter (which sets the envelope's caps verbatim) becomes writable**. Finally, `guard-entry.ts:20` calls `getPaths()` on its own and has no idea which line it is serving, so per-line logs would silently go to the wrong place.

Note `.agentcall` is already in `DENIED_DIRS`, so denying one line's agent access to *another* line's token comes free — provided the real home is what gets passed.

**Files:**
- Modify: `packages/cli/src/guard.ts` (`GuardDeps`, `runGuard`, `decide` call site, `DENIED_DIRS`)
- Modify: `packages/cli/src/guard-entry.ts`
- Modify: `packages/cli/src/runner.ts:118,140`
- Test: `packages/cli/test/guard.test.ts`, `packages/cli/test/runner.test.ts`

**Interfaces:**
- Consumes: `LinePaths`, `MachinePaths` (Task 2), `listLines` (Task 4)
- Produces: `GuardDeps` gains `line: LinePaths`; `buildSpawnSpec(..., lineName)` injects `AGENTCALL_LINE`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { decide } from "../src/guard.js";

const realpath = (p: string) => p;

describe("guard security root", () => {
  it("denies the real home's .ssh, not the state root's", () => {
    const verdict = decide(
      { tool_name: "Read", tool_input: { file_path: "/Users/real/.ssh/id_rsa" }, cwd: "/tmp/work" },
      "/Users/real",
      realpath,
    );
    expect(verdict.allow).toBe(false);
  });

  it("denies one line's config from another line's agent (.agentcall is a denied root)", () => {
    const verdict = decide(
      { tool_name: "Read", tool_input: { file_path: "/Users/real/.agentcall/lines/codex/config.json" }, cwd: "/tmp/work" },
      "/Users/real",
      realpath,
    );
    expect(verdict.allow).toBe(false);
  });
});

describe("per-line task directories are denied", () => {
  it("denies AgentCall/<line>/tasks when passed as an extra root", () => {
    const verdict = decide(
      { tool_name: "Write", tool_input: { file_path: "/Users/real/AgentCall/codex/tasks/x/SKILL.md" }, cwd: "/tmp/work" },
      "/Users/real",
      realpath,
      "/pkg",
      [join("/Users/real", "AgentCall", "codex", "tasks")],
    );
    expect(verdict.allow).toBe(false);
  });

  it("still allows the line's own share directory", () => {
    const verdict = decide(
      { tool_name: "Write", tool_input: { file_path: "/Users/real/AgentCall/codex/public/notes.md" }, cwd: "/tmp/work" },
      "/Users/real",
      realpath,
      "/pkg",
      [join("/Users/real", "AgentCall", "codex", "tasks")],
    );
    expect(verdict.allow).toBe(true);
  });
});
```

Add to `packages/cli/test/runner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildSpawnSpec } from "../src/runner.js";

describe("AGENTCALL_LINE propagation", () => {
  it("injects the line name into a claude spawn", () => {
    const spec = buildSpawnSpec("claude", "hi", "/work", () => "/bin/claude", undefined, "call-1", "codex");
    expect(spec.env?.AGENTCALL_LINE).toBe("codex");
    expect(spec.env?.AGENTCALL_CALL_ID).toBe("call-1");
  });

  it("injects the line name into a codex spawn alongside observe mode", () => {
    const spec = buildSpawnSpec("codex", "hi", "/work", () => "/bin/codex", undefined, "call-2", "claude");
    expect(spec.env?.AGENTCALL_LINE).toBe("claude");
    expect(spec.env?.AGENTCALL_GUARD_MODE).toBe("observe");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && pnpm vitest run test/guard.test.ts test/runner.test.ts -t "line"`
Expected: FAIL — `decide` takes four parameters; `buildSpawnSpec` takes six.

- [ ] **Step 3: Implement**

In `guard.ts`, remove `"AgentCall/tasks"` from `DENIED_DIRS` (it no longer describes a real path) and add a fifth parameter to `decide`:

```ts
export function decide(
  input: GuardInput,
  userHome: string,
  realpath: (p: string) => string,
  guardRoot: string = DEFAULT_PACKAGE_ROOT,
  extraDeniedRoots: string[] = [],
): GuardVerdict {
  ...
  const denied = deniedPaths(userHome, realpath, [guardRoot, ...extraDeniedRoots]);
  const canon = (p: string) => canonical(p, cwd, userHome, realpath);
```

Rename the `home` parameter to `userHome` throughout the function body so nothing reads `home` again.

`GuardDeps` gains the line and the machine:

```ts
export interface GuardDeps {
  line: LinePaths;
  callId: string;
  now: () => string;
  realpath: (p: string) => string;
  appendLine: (file: string, line: string) => void;
}
```

In `runGuard`, replace every `deps.paths.*`:
- `deps.paths.home` (two sites, `:290` and `:302`) → `deps.line.machine.userHome`
- `deps.paths.toolsLog` → `deps.line.toolsLog`
- `deps.paths.callsLog` → `deps.line.callsLog`

and compute the extra denied roots — every line's task directory, so an agent on one line cannot rewrite another line's task frontmatter:

```ts
    // Task frontmatter sets the envelope's caps verbatim, so it is as
    // sensitive as policy.json. Under the per-line layout these live at
    // ~/AgentCall/<line>/tasks, which no fixed home-relative rule can match —
    // enumerate them instead.
    const taskRoots = listLines(deps.line.machine).map((l) => l.paths.tasksDir);
    const verdict = decide(input, deps.line.machine.userHome, deps.realpath, undefined, taskRoots);
```

In `guard-entry.ts`, resolve the line from the environment and fail closed without it:

```ts
import { getLinePaths, getMachinePaths } from "./paths.js";
import { LINE_NAME_RE } from "./lines.js";

// The guard runs as a subprocess of the answering agent and has no other way
// to learn which line's call it is policing. Without it, tool events would be
// audited against the wrong line — so an absent or malformed value fails
// closed rather than guessing.
const lineName = process.env.AGENTCALL_LINE ?? "";
if (!LINE_NAME_RE.test(lineName)) {
  process.stderr.write(FAIL_CLOSED_REASON);
  process.exit(2);
}
const machine = getMachinePaths();

  const out = runGuard(raw, {
    line: getLinePaths(machine, lineName),
    callId: process.env.AGENTCALL_CALL_ID ?? "unknown",
    ...
```

In `runner.ts`, add a `lineName` parameter to `buildSpawnSpec` (after `callId`) and thread it into both env objects:

```ts
export function buildSpawnSpec(
  kind: AgentKind, prompt: string, workdir: string, resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown", lineName: string = "",
): SpawnSpec {
```

claude branch: `env: { ...process.env, AGENTCALL_CALL_ID: callId, AGENTCALL_LINE: lineName },`
codex branch: `env: { ...process.env, AGENTCALL_CALL_ID: callId, AGENTCALL_GUARD_MODE: "observe", AGENTCALL_LINE: lineName },`

Add the same trailing parameter to `runAgent` and pass it through to `buildSpawnSpec`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/guard.test.ts test/runner.test.ts`
Expected: PASS. Existing guard tests that call `decide(input, home, realpath)` still compile — the new parameter is optional.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/guard.ts packages/cli/src/guard-entry.ts packages/cli/src/runner.ts packages/cli/test/guard.test.ts packages/cli/test/runner.test.ts
git commit -m "fix(guard): evaluate against the real home, deny per-line task dirs, require AGENTCALL_LINE"
```

---

## Task 8: Listener — many lines, one process, config reload on reconnect

**Files:**
- Modify: `packages/cli/src/listener.ts`
- Create: `packages/cli/src/listenAll.ts`
- Test: `packages/cli/test/listener.test.ts`, `packages/cli/test/listenAll.test.ts`

**Interfaces:**
- Consumes: `readyLines` (Task 4), `LinePaths` (Task 2)
- Produces: `startListener(deps)` where `deps: { relay, paths: LinePaths, loadConfig: () => CallableLineConfig, ... }`; `startAllListeners(m, deps?): { stop(): void; started: string[] }`

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/listener.test.ts` (follow the existing fake-socket harness in that file):

```ts
it("re-reads config on each reconnect so a rotated token takes effect", () => {
  let token = "old";
  const seen: string[] = [];
  const sockets = fakeSocketFactory((url, opts) => {
    seen.push(String(opts.headers.Authorization));
  });
  const l = startListener({
    relay: "https://r.example",
    paths: linePaths,
    loadConfig: () => ({ handle: "ken", token, relay: "https://r.example", agent_kind: "claude" }),
    socketFactory: sockets.factory,
    backoffMs: () => 0,
  });
  sockets.last().emit("close");          // force a reconnect
  token = "new";
  sockets.last().emit("close");
  l.stop();
  expect(seen[0]).toBe("Bearer old");
  expect(seen.at(-1)).toBe("Bearer new");
});
```

Create `packages/cli/test/listenAll.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { startAllListeners } from "../src/listenAll.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-all-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const base = { token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("startAllListeners", () => {
  it("starts one listener per callable line", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    const started: string[] = [];
    const h = startAllListeners(m, { start: (d) => { started.push(d.paths.name); return { stop() {} }; } });
    expect(started).toEqual(["claude", "codex"]);
    expect(h.started).toEqual(["claude", "codex"]);
    h.stop();
  });

  it("skips a caller-only line", () => {
    saveLineConfig(getLinePaths(m, "caller"), { handle: "ken", token: "t", relay: "https://r.example" });
    const h = startAllListeners(m, { start: () => ({ stop() {} }) });
    expect(h.started).toEqual([]);
    h.stop();
  });

  it("skips an orphaned line without throwing", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    const h = startAllListeners(m, { start: () => ({ stop() {} }) });
    expect(h.started).toEqual(["claude"]);
    h.stop();
  });

  it("stops every listener it started", () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    let stops = 0;
    startAllListeners(m, { start: () => ({ stop() { stops++; } }) }).stop();
    expect(stops).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/cli && pnpm vitest run test/listenAll.test.ts`
Expected: FAIL — cannot resolve `../src/listenAll.js`.

- [ ] **Step 3: Implement**

In `listener.ts`, change `ListenerDeps` so config is a thunk rather than a value, and move `resolveWorkdir` inside `connect()`:

```ts
export interface ListenerDeps {
  relay: string;
  paths: LinePaths;
  /** Called on every (re)connect — a rotated token takes effect without a restart. */
  loadConfig: () => CallableLineConfig;
  run?: typeof runAgent;
  maxPending?: number;
  backoffMs?: (attempt: number) => number;
}
```

Inside `connect()`, read `const config = deps.loadConfig();` first and use it for the socket headers and for `resolveLineWorkdir(config, deps.paths)` (Task 4's `LinePaths` variant). Pass `deps.paths.name` as `runAgent`'s new trailing `lineName` argument at the `run(...)` call site (`listener.ts:110-119`).

**`ListenerDeps` is a public signature — update its callers in this same task.** The
only production caller is `index.ts`'s `listen` action; point it at
`startAllListeners(getMachinePaths())` and delete its `loadConfig`/`assertCallableConfig`
preamble. `packages/cli/test/listener.test.ts` constructs `ListenerDeps` directly and
must move from `config:` to `loadConfig: () => ...` throughout — mechanical, but it is
the bulk of the diff and the green-commit constraint depends on it.

Create `packages/cli/src/listenAll.ts`:

```ts
import { readyLines } from "./lines.js";
import { loadLineConfig } from "./lines.js";
import { startListener, type ListenerDeps } from "./listener.js";
import type { MachinePaths } from "./paths.js";
import { relayUrl } from "./config.js";
import type { CallableLineConfig } from "./config.js";

export interface ListenAllDeps {
  start?: (deps: ListenerDeps) => { stop(): void };
  log?: (line: string) => void;
}

// One process, N sockets. The relay enforces one listener socket per handle
// (apps/relay/src/do.ts:56) but knows nothing about processes, so N addresses
// need N sockets — not N supervised services.
export function startAllListeners(
  m: MachinePaths, deps: ListenAllDeps = {},
): { stop(): void; started: string[] } {
  const start = deps.start ?? startListener;
  const log = deps.log ?? console.log;
  const handles: { stop(): void }[] = [];
  const started: string[] = [];

  for (const line of readyLines(m)) {
    if (!line.config.agent_kind) continue; // caller-only: nothing to answer with
    handles.push(
      start({
        relay: relayUrl(line.config),
        paths: line.paths,
        loadConfig: () => loadLineConfig(line.paths) as CallableLineConfig,
      }),
    );
    started.push(line.name);
    log(`listening as ${line.config.handle} (line ${line.name})`);
  }
  if (started.length === 0) log("no callable lines — nothing to listen on.");
  return { stop: () => handles.forEach((h) => h.stop()), started };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/listener.test.ts test/listenAll.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/listener.ts packages/cli/src/listenAll.ts packages/cli/test/listener.test.ts packages/cli/test/listenAll.test.ts
git commit -m "feat(cli): one listener process serving every line, config reloaded per reconnect"
```

---

## Task 9: Outbound line selection

**Files:**
- Create: `packages/cli/src/outbound.ts`
- Test: `packages/cli/test/outbound.test.ts`

**Interfaces:**
- Consumes: `readyLines` (Task 4), `resolvePrimary` (Task 3)
- Produces: `pickOutboundLine(m, destinationRelay, opts?: { as?: string }): LineContext`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { savePerson } from "../src/person.js";
import { pickOutboundLine } from "../src/outbound.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-out-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const A = "https://a.example";
const B = "https://b.example";

describe("pickOutboundLine", () => {
  it("uses the only line on the destination's relay", () => {
    saveLineConfig(getLinePaths(m, "work"), { handle: "ken-w", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    expect(pickOutboundLine(m, B).name).toBe("work");
  });

  it("uses the primary when several lines share the destination relay", () => {
    saveLineConfig(getLinePaths(m, "claude"), { handle: "ken", token: "t", relay: A });
    saveLineConfig(getLinePaths(m, "codex"), { handle: "ken-cdx", token: "t", relay: A });
    savePerson(m, { primary_line: "codex" });
    expect(pickOutboundLine(m, A).name).toBe("codex");
  });

  it("refuses when the primary is on another relay and several candidates tie", () => {
    saveLineConfig(getLinePaths(m, "w1"), { handle: "k1", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "w2"), { handle: "k2", token: "t", relay: B });
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    savePerson(m, { primary_line: "home" });
    expect(() => pickOutboundLine(m, B)).toThrow(/--as/);
  });

  it("names the relays this machine holds lines on when none match", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    expect(() => pickOutboundLine(m, B)).toThrow(/a\.example/);
  });

  it("honours --as, even across relays, but rejects a mismatch", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: A });
    saveLineConfig(getLinePaths(m, "work"), { handle: "ken-w", token: "t", relay: B });
    expect(pickOutboundLine(m, B, { as: "work" }).name).toBe("work");
    expect(() => pickOutboundLine(m, B, { as: "home" })).toThrow(/a\.example/);
  });

  it("matches on relay host, ignoring a trailing slash", () => {
    saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: "https://a.example/" });
    expect(pickOutboundLine(m, A).name).toBe("home");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/outbound.test.ts`
Expected: FAIL — cannot resolve `../src/outbound.js`.

- [ ] **Step 3: Implement**

```ts
import { readyLines } from "./lines.js";
import type { LineContext } from "./lineContext.js";
import type { MachinePaths } from "./paths.js";
import { resolvePrimary } from "./person.js";

function host(relay: string): string {
  try {
    return new URL(relay).host;
  } catch {
    return relay.replace(/\/+$/, "");
  }
}

// callClient dials ONE relay for both authentication and destination
// (callClient.ts:36), so "one identity outbound" can only mean one identity
// per relay. With every line on the same relay — the common case — this is
// always the primary and the user never sees it.
export function pickOutboundLine(
  m: MachinePaths, destinationRelay: string, opts: { as?: string } = {},
): LineContext {
  const lines = readyLines(m);
  const want = host(destinationRelay);

  if (opts.as !== undefined && opts.as !== "") {
    const chosen = lines.find((l) => l.name === opts.as);
    if (!chosen) {
      throw new Error(`No line named "${opts.as}". This machine has: ${lines.map((l) => l.name).join(", ") || "none"}.`);
    }
    if (host(chosen.config.relay) !== want) {
      throw new Error(
        `Line "${opts.as}" is registered on ${host(chosen.config.relay)}, but that address is on ${want}. ` +
          `A line can only call within its own relay.`,
      );
    }
    return { machine: m, ...chosen };
  }

  const candidates = lines.filter((l) => host(l.config.relay) === want);
  if (candidates.length === 0) {
    const relays = [...new Set(lines.map((l) => host(l.config.relay)))];
    throw new Error(
      `No line on ${want}. This machine has lines on: ${relays.join(", ") || "no relays"}. ` +
        `Add one with \`agentcall line add <name> --relay <url>\`.`,
    );
  }
  if (candidates.length === 1) return { machine: m, ...candidates[0]! };

  let primary: string | undefined;
  try {
    primary = resolvePrimary(m, lines.map((l) => l.name));
  } catch {
    primary = undefined;
  }
  const chosen = candidates.find((l) => l.name === primary);
  if (chosen) return { machine: m, ...chosen };

  throw new Error(
    `Several lines can call ${want} (${candidates.map((l) => l.name).join(", ")}) and the primary is not among them. ` +
      `Pick one with --as <line>.`,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/outbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/outbound.ts packages/cli/test/outbound.test.ts
git commit -m "feat(cli): pick the outbound line by matching the destination relay"
```

---

## Task 10: The `line` command group

**Files:**
- Create: `packages/cli/src/commands/line.ts`
- Test: `packages/cli/test/line-cmd.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 3–6, `registerHandle` (`api.ts:40`), `publishCard` (`card.ts:55`), `DEFAULT_POLICY` (`policy.ts`)
- Produces: `addLine(m, opts)`, `listLinesReport(m, presence?)`, `removeLine(m, name, opts)`, `setPrimary(m, name)`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { loadPerson, savePerson } from "../src/person.js";
import { addLine, removeLine, setPrimary } from "../src/commands/line.js";

let m: MachinePaths;
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-linecmd-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

const ok = async () => ({ token: "tok", address: "ken-cdx@r.example" });
const base = { handle: "ken", token: "t", relay: "https://r.example", agent_kind: "claude" as const };

describe("addLine", () => {
  it("registers, then writes config.json as the first thing on disk", async () => {
    await addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false });
    const l = getLinePaths(m, "codex");
    expect(JSON.parse(readFileSync(l.configFile, "utf8")).token).toBe("tok");
  });

  it("leaves the disk untouched when the handle is taken", async () => {
    const taken = async () => { throw new Error("Handle \"ken-cdx\" is already taken."); };
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: taken, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already taken/);
    expect(readdirSync(m.linesDir)).toEqual([]);
  });

  it("rejects an invalid line name before registering", async () => {
    let called = false;
    await expect(addLine(m, { name: "../evil", handle: "x", agent: "codex", relay: "https://r.example",
      register: async () => { called = true; return { token: "t", address: "a" }; },
      installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/line name/i);
    expect(called).toBe(false);
  });

  it("refuses a name that already exists", async () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    await expect(addLine(m, { name: "codex", handle: "other", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/already/);
  });

  it("refuses a handle another line already holds", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken-cdx" });
    await expect(addLine(m, { name: "codex", handle: "ken-cdx", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false }))
      .rejects.toThrow(/ken-cdx/);
  });

  it("warns when the handle is a predictable derivative of an existing one", async () => {
    saveLineConfig(getLinePaths(m, "claude"), { ...base, handle: "ken" });
    const warnings: string[] = [];
    await addLine(m, { name: "codex", handle: "ken-codex", agent: "codex", relay: "https://r.example",
      register: ok, installLaunchAgentFn: () => {}, publishCardFn: async () => undefined, verify: false,
      warn: (s) => warnings.push(s) });
    expect(warnings.join(" ")).toMatch(/guess/i);
  });

  it("installs no launch agent for a caller-only line", async () => {
    let installed = false;
    await addLine(m, { name: "caller", handle: "ken-c", relay: "https://r.example", callerOnly: true,
      register: ok, installLaunchAgentFn: () => { installed = true; }, publishCardFn: async () => undefined, verify: false });
    expect(installed).toBe(false);
  });
});

describe("removeLine", () => {
  it("archives the line rather than deleting it", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "codex", { confirm: true, uninstallFn: () => {} });
    expect(existsSync(getLinePaths(m, "codex").dir)).toBe(false);
    expect(readdirSync(m.removedDir)[0]).toMatch(/^codex-/);
  });

  it("deletes outright with --purge", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "codex", { confirm: true, purge: true, uninstallFn: () => {} });
    expect(existsSync(m.removedDir)).toBe(false);
  });

  it("refuses the primary while another line exists", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/line primary/);
  });

  it("refuses the only line", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "claude", { confirm: true, uninstallFn: () => {} })).toThrow(/uninstall --purge/);
  });

  it("requires confirmation, because the handle can never be reclaimed", () => {
    saveLineConfig(getLinePaths(m, "codex"), base);
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    expect(() => removeLine(m, "codex", { confirm: false, uninstallFn: () => {} })).toThrow(/--yes/);
  });

  it("removes an orphaned line directory", () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    removeLine(m, "half", { confirm: true, uninstallFn: () => {} });
    expect(existsSync(getLinePaths(m, "half").dir)).toBe(false);
  });
});

describe("setPrimary", () => {
  it("rewrites person.json and nothing else", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), base);
    savePerson(m, { primary_line: "claude" });
    const before = readFileSync(getLinePaths(m, "claude").configFile, "utf8");
    setPrimary(m, "codex");
    expect(loadPerson(m).primary_line).toBe("codex");
    expect(readFileSync(getLinePaths(m, "claude").configFile, "utf8")).toBe(before);
  });

  it("refuses a line that does not exist", () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    expect(() => setPrimary(m, "nope")).toThrow(/nope/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/line-cmd.test.ts`
Expected: FAIL — cannot resolve `../src/commands/line.js`.

- [ ] **Step 3: Implement**

```ts
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";
import { registerHandle } from "../api.js";
import { publishCard } from "../card.js";
import type { LineConfig } from "../config.js";
import { assertValidLineName, listLines, readyLines, saveLineConfig } from "../lines.js";
import { getLinePaths, type MachinePaths } from "../paths.js";
import { loadPerson, resolvePrimary, savePerson } from "../person.js";
import { DEFAULT_POLICY } from "../policy.js";
import { uninstallLaunchAgent, installLaunchAgent } from "../launchd.js";

export interface AddLineOpts {
  name: string;
  handle: string;
  relay: string;
  agent?: AgentKind;
  callerOnly?: boolean;
  verify?: boolean;
  warn?: (line: string) => void;
  // Test seams.
  register?: typeof registerHandle;
  publishCardFn?: (cfg: LineConfig, p: ReturnType<typeof getLinePaths>) => Promise<unknown>;
  installLaunchAgentFn?: typeof installLaunchAgent;
}

// A handle that is `<existing>-<something>` is guessable from an address the
// owner already handed out. The address is the sharing boundary, so a
// predictable one weakens the thing the line exists for — warn, don't refuse.
function derivativeOf(handle: string, existing: string[]): string | undefined {
  return existing.find((e) => handle.startsWith(`${e}-`));
}

export async function addLine(m: MachinePaths, opts: AddLineOpts): Promise<{ address: string }> {
  // Validate BEFORE the network call: a rejected name must not burn a handle.
  assertValidLineName(opts.name);
  const existing = listLines(m);
  if (existing.some((l) => l.name.toLowerCase() === opts.name.toLowerCase())) {
    throw new Error(`A line named "${opts.name}" already exists.`);
  }
  const heldHandles = existing.filter((l) => l.config).map((l) => l.config!.handle);
  if (heldHandles.includes(opts.handle)) {
    throw new Error(`This machine already holds the handle "${opts.handle}" on another line.`);
  }
  const near = derivativeOf(opts.handle, heldHandles);
  if (near) {
    (opts.warn ?? console.error)(
      `Warning: "${opts.handle}" is easy to guess from "${near}", which you have already shared. ` +
        `Anyone holding that address can find this one.`,
    );
  }

  const agentKind = opts.callerOnly ? undefined : opts.agent;
  const { token, address } = await (opts.register ?? registerHandle)(opts.relay, opts.handle, agentKind);

  // Registration succeeded, so the handle is spent and unreclaimable (#16).
  // config.json is therefore the very first thing written — everything below
  // is recoverable by re-running, losing the token is not.
  const paths = getLinePaths(m, opts.name);
  const cfg: LineConfig = agentKind
    ? { handle: opts.handle, token, relay: opts.relay, agent_kind: agentKind }
    : { handle: opts.handle, token, relay: opts.relay };
  saveLineConfig(paths, cfg);

  if (agentKind) {
    mkdirSync(paths.shareDir, { recursive: true });
    mkdirSync(paths.tasksDir, { recursive: true });
    if (!existsSync(paths.policyFile)) {
      writeFileSync(paths.policyFile, JSON.stringify(DEFAULT_POLICY, null, 2) + "\n", { mode: 0o600 });
    }
    try {
      await (opts.publishCardFn ?? publishCard)(cfg, paths);
    } catch (e) {
      (opts.warn ?? console.error)(
        `Warning: could not publish the card (${String(e)}). Run \`agentcall card push --line ${opts.name}\` later.`,
      );
    }
    (opts.installLaunchAgentFn ?? installLaunchAgent)(m);
  }

  // person.json is written LAST, and only for the first line, so a failed
  // first setup never leaves primary_line pointing at a broken line.
  if (!existsSync(m.personFile)) savePerson(m, { primary_line: opts.name });
  return { address };
}

export interface RemoveLineOpts {
  confirm?: boolean;
  purge?: boolean;
  uninstallFn?: typeof uninstallLaunchAgent;
  // BOTH launchd calls need a seam, not just uninstall. A half-applied seam is
  // worse than none: it reads as injected at a glance while the paired call
  // still shells out to the real `launchctl bootstrap gui/<uid>`. The first
  // draft of this plan omitted this field, and running the tests below booted
  // out a developer's live listener and re-registered it against a vitest
  // temp directory that no longer existed. The plist path is sandboxed by
  // MachinePaths; the launchd session and label are not.
  installFn?: typeof installLaunchAgent;
}

export function removeLine(m: MachinePaths, name: string, opts: RemoveLineOpts = {}): void {
  const all = listLines(m);
  const target = all.find((l) => l.name === name);
  if (!target) throw new Error(`No line named "${name}".`);

  if (all.length === 1) {
    throw new Error(
      `"${name}" is the only line on this machine — removing it would leave you unable to answer or call. ` +
        `Use \`agentcall uninstall --purge\` to remove agentcall entirely.`,
    );
  }
  let primary: string | undefined;
  try {
    primary = loadPerson(m).primary_line;
  } catch {
    primary = undefined;
  }
  if (primary === name) {
    throw new Error(`"${name}" is the primary line. Promote another first: agentcall line primary <name>`);
  }
  if (!opts.confirm) {
    throw new Error(
      `Removing "${name}" abandons the handle "${target.config?.handle ?? "?"}" permanently — handle release is ` +
        `not implemented, so nobody (including you) can ever register it again. Re-run with --yes to confirm.`,
    );
  }

  if (opts.purge) {
    rmSync(target.paths.dir, { recursive: true, force: true });
  } else {
    // Archive rather than delete: calls.log is the audit trail of what this
    // address disclosed, and removing a line should not destroy it silently.
    mkdirSync(m.removedDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    renameSync(target.paths.dir, join(m.removedDir, `${name}-${stamp}`));
  }

  // One process serves every line, so removing one means restarting it, not
  // unloading a per-line service. Reinstalling the single agent is how that
  // happens; skip it when nothing callable is left.
  if (readyLines(m).some((l) => l.config.agent_kind)) {
    (opts.uninstallFn ?? uninstallLaunchAgent)(m);
    (opts.installFn ?? installLaunchAgent)(m);
  } else {
    (opts.uninstallFn ?? uninstallLaunchAgent)(m);
  }
}

export function setPrimary(m: MachinePaths, name: string): void {
  const ready = readyLines(m);
  if (!ready.some((l) => l.name === name)) {
    throw new Error(`No usable line named "${name}". This machine has: ${ready.map((l) => l.name).join(", ") || "none"}.`);
  }
  savePerson(m, { primary_line: name });
}

export interface LineRow {
  name: string;
  address: string;
  relay: string;
  state: "online" | "offline" | "caller-only" | "broken";
  primary: boolean;
}

export function listLinesReport(
  m: MachinePaths, presence: (cfg: LineConfig) => boolean = () => false,
): LineRow[] {
  let primary: string | undefined;
  try {
    primary = resolvePrimary(m, readyLines(m).map((l) => l.name));
  } catch {
    primary = undefined;
  }
  return listLines(m).map((l) => ({
    name: l.name,
    address: l.config ? `${l.config.handle}@${new URL(l.config.relay).host}` : "—",
    relay: l.config?.relay ?? "—",
    state: !l.ok ? "broken" : !l.config!.agent_kind ? "caller-only" : presence(l.config!) ? "online" : "offline",
    primary: l.name === primary,
  }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/line-cmd.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/line.ts packages/cli/test/line-cmd.test.ts
git commit -m "feat(cli): add line add/list/remove/primary"
```

---

## Task 11: `setup` creates a person and a first line

**Files:**
- Modify: `packages/cli/src/setup.ts`
- Test: `packages/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: `addLine` (Task 10), `listLines` (Task 4)
- Produces: `runSetup(opts): Promise<{ ready: boolean }>` — unchanged signature

- [ ] **Step 1: Write the failing test**

Replace the clobber-related tests in `packages/cli/test/setup.test.ts` with:

```ts
describe("runSetup", () => {
  it("creates person.json plus one line, and marks it primary", async () => {
    await runSetup({ handle: "ken", agent: "claude", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true });
    expect(loadPerson(m).primary_line).toBe("claude");
    expect(listLines(m).map((l) => l.name)).toEqual(["claude"]);
  });

  it("names the line after the agent kind", async () => {
    await runSetup({ handle: "ken", agent: "codex", relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true });
    expect(listLines(m).map((l) => l.name)).toEqual(["codex"]);
  });

  it("creates nothing on a second run and points at line add", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    savePerson(m, { primary_line: "claude" });
    const out: string[] = [];
    const res = await runSetup({ handle: "other", agent: "codex", relay: R, yes: true, snippet: false,
      verify: false, addLineFn: fakeAddLine, skipLaunchd: true, log: (s) => out.push(s) });
    expect(listLines(m).map((l) => l.name)).toEqual(["claude"]);
    expect(out.join("\n")).toMatch(/agentcall line add/);
    expect(res.ready).toBe(true);
  });

  it("creates an agentless line under --caller-only", async () => {
    await runSetup({ handle: "ken", callerOnly: true, relay: R, yes: true, snippet: false, verify: false,
      addLineFn: fakeAddLine, skipLaunchd: true });
    expect(listLines(m)[0]!.config!.agent_kind).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/setup.test.ts`
Expected: FAIL — `runSetup` still writes a flat `config.json`.

- [ ] **Step 3: Implement**

Rewrite `runSetup`'s body. Keep `detectAgentKind`, `decideCallable`, `warnIfOutsideLaunchdPath`, `resolveExtraPathDirs`, and the verify/snippet tail unchanged; replace the config-reuse block (`setup.ts:148-206`) with:

```ts
  const machine = getMachinePaths();
  const existing = listLines(machine);

  // Setup is first-run only. Adding an address to a machine that already has
  // one is `line add` — which is also why the old clobber path (#43) is gone:
  // there is no single config.json left to overwrite.
  if (existing.length > 0) {
    log("agentcall is already set up on this machine.\n");
    for (const row of listLinesReport(machine)) {
      log(`  ${row.name.padEnd(10)} ${row.address}${row.primary ? "   primary" : ""}`);
    }
    log(`\nTo add another address:  agentcall line add <name> --handle <handle>`);
    if (opts.snippet !== false) {
      appendSnippet(join(homedir(), ".claude", "CLAUDE.md"));
      appendSnippet(join(homedir(), ".codex", "AGENTS.md"));
    }
    return { ready: true };
  }

  const callable = await decideCallable(opts, hasBinFn, ask, undefined);
  const agentKind = callable ? await detectAgentKind(opts, hasBinFn, ask) : undefined;
  if (agentKind) {
    warnIfOutsideLaunchdPath(agentKind, resolveBinFn);
    warnIfOutsideLaunchdPath("npx", resolveBinFn);
  }

  const handle = opts.handle ?? (await ask("Choose a handle (e.g. ken): ")).trim();
  if (!handle) throw new Error("A handle is required.");
  const relay = (opts.relay ?? relayUrl()).replace(/\/+$/, "");
  // The line name is local; default it to the agent kind, which is what the
  // owner will call it anyway.
  const name = agentKind ?? "caller";

  const { address } = await (opts.addLineFn ?? addLine)(machine, {
    name, handle, relay, agent: agentKind, callerOnly: !callable,
    installLaunchAgentFn: opts.skipLaunchd ? () => {} : opts.installLaunchAgentFn,
  });
```

Then reuse the existing verify + summary tail, reading from the created line's `LineContext` (`resolveLine(machine, { line: name })`) instead of `cfg`. Add `addLineFn?: typeof addLine` and `log?: (s: string) => void` to `SetupOpts` as test seams.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/setup.ts packages/cli/test/setup.test.ts
git commit -m "feat(cli): setup creates a person and a first line, delegating to addLine"
```

---

## Task 12: Line-scoped commands via `LineContext`

`card`, `task new`, the six policy verbs, and `rotate` all resolve one line and thread it.

**Files:**
- Modify: `packages/cli/src/card.ts`, `policy.ts`, `tasks.ts`, `lint.ts`, `index.ts`
- Test: `packages/cli/test/rotate.test.ts` (new), existing `card.test.ts` / `policy.test.ts` updated for `LinePaths`

**Interfaces:**
- Consumes: `resolveLine` (Task 5)
- Produces: `rotateLine(ctx, deps): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/rotate.test.ts`:

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLinePaths, getMachinePaths, type MachinePaths } from "../src/paths.js";
import { saveLineConfig } from "../src/lines.js";
import { resolveLine } from "../src/lineContext.js";
import { rotateLine } from "../src/commands/rotate.js";

let m: MachinePaths;
const base = { handle: "ken", token: "old", relay: "https://r.example", agent_kind: "claude" as const };

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), "agentcall-rot-"));
  m = getMachinePaths(root, root);
  mkdirSync(m.linesDir, { recursive: true });
});

describe("rotateLine", () => {
  it("writes the new token to that line only", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    await rotateLine(resolveLine(m, { line: "claude" }), { rotate: async () => ({ token: "new" }) });
    expect(JSON.parse(readFileSync(getLinePaths(m, "claude").configFile, "utf8")).token).toBe("new");
    expect(JSON.parse(readFileSync(getLinePaths(m, "codex").configFile, "utf8")).token).toBe("old");
  });

  it("tells the owner the listener picks it up on reconnect", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    const out: string[] = [];
    await rotateLine(resolveLine(m, { line: "claude" }),
      { rotate: async () => ({ token: "new" }), log: (s) => out.push(s) });
    expect(out.join(" ")).toMatch(/reconnect/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/rotate.test.ts`
Expected: FAIL — cannot resolve `../src/commands/rotate.js`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/commands/rotate.ts`:

```ts
import { rotateToken } from "../api.js";
import { relayUrl } from "../config.js";
import type { LineContext } from "../lineContext.js";
import { saveLineConfig } from "../lines.js";

export interface RotateDeps {
  rotate?: typeof rotateToken;
  log?: (line: string) => void;
}

export async function rotateLine(ctx: LineContext, deps: RotateDeps = {}): Promise<void> {
  const log = deps.log ?? console.log;
  const { token } = await (deps.rotate ?? rotateToken)(
    relayUrl(ctx.config), { handle: ctx.config.handle, token: ctx.config.token },
  );
  saveLineConfig(ctx.paths, { ...ctx.config, token });
  log(
    `Token rotated for line "${ctx.name}" (${ctx.config.handle}). The old token no longer works.\n` +
      `The listener re-reads config on reconnect, so it picks this up without a restart; ` +
      `other lines are unaffected.`,
  );
}
```

Retarget the shared modules — mechanical, no behaviour change:
- `card.ts`: `publishCard(cfg: LineConfig, p: LinePaths, ...)`; `buildCardUpload` takes `LineConfig`.
- `policy.ts`, `tasks.ts`, `lint.ts`: every `Paths` parameter becomes `LinePaths`; `loadTasks` reads `p.tasksDir`, unchanged otherwise.
- `contacts.ts`: every `Paths` becomes `MachinePaths` (contacts are person-scoped).

In `index.ts`, add `--line <name>` to `card`, `task new`, `allow`, `revoke`, `block`, `unblock`, `offer`, `unoffer`, `rotate`, and start each action with `const ctx = resolveLine(getMachinePaths(), { line: o.line });`. Replace `policyVerbAction`'s `loadConfig`/`!cfg.agent_kind` preamble with `resolveLine` + `assertCallableLine(ctx.config)`.

**This is the deletion point for the legacy half.** Tasks 2–11 added the new types
alongside the old ones so every commit stayed green; by the end of this task nothing
imports them, so delete: `Paths` and `getPaths` (`paths.ts`), and `Config`,
`CallableConfig`, `assertCallableConfig`, `loadConfig`, `saveConfig`, and
`resolveWorkdir` (`config.ts`). Verify with `grep -rn "getPaths\|loadConfig\|saveConfig\|assertCallableConfig" packages/cli/src packages/cli/test` — the only surviving
hits should be `loadLineConfig`/`saveLineConfig`. If a caller still needs one, that
caller was missed by an earlier task: move it now rather than keeping the legacy
export alive.

- [ ] **Step 4: Run the full suite**

Run: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/rotate.ts packages/cli/src/card.ts packages/cli/src/policy.ts packages/cli/src/tasks.ts packages/cli/src/lint.ts packages/cli/src/contacts.ts packages/cli/src/index.ts packages/cli/test/rotate.test.ts
git commit -m "feat(cli): route line-scoped commands through LineContext"
```

---

## Task 13: `doctor` across every line

**Files:**
- Modify: `packages/cli/src/doctor.ts`
- Test: `packages/cli/test/doctor.test.ts`

**Interfaces:**
- Consumes: `listLines` (Task 4), `LAUNCH_LABEL` (Task 6)
- Produces: `runDoctor(deps: { machine: MachinePaths, ... }): Promise<number>`

- [ ] **Step 1: Write the failing test**

```ts
describe("runDoctor across lines", () => {
  it("reports every line and exits non-zero if any callable line fails", async () => {
    saveLineConfig(getLinePaths(m, "claude"), base);
    saveLineConfig(getLinePaths(m, "codex"), { ...base, handle: "ken-cdx" });
    const out: string[] = [];
    const code = await runDoctor({ machine: m, log: (s) => out.push(s), isDarwin: false,
      getStatusFn: async () => ({ online: true }),
      verifyFns: failingVerifyFor("codex"), callFn: fakeCall });
    expect(out.join("\n")).toContain("line claude");
    expect(out.join("\n")).toContain("line codex");
    expect(code).toBe(1);
  });

  it("treats a caller-only line as fine, not as a failure", async () => {
    saveLineConfig(getLinePaths(m, "caller"), { handle: "ken", token: "t", relay: R });
    const code = await runDoctor({ machine: m, log: () => {}, isDarwin: false });
    expect(code).toBe(0);
  });

  it("reports an orphaned line as broken and exits non-zero", async () => {
    mkdirSync(getLinePaths(m, "half").dir, { recursive: true });
    const out: string[] = [];
    const code = await runDoctor({ machine: m, log: (s) => out.push(s), isDarwin: false });
    expect(out.join("\n")).toMatch(/half/);
    expect(code).toBe(1);
  });

  it("probes the guard once per agent kind, not once per line", async () => {
    saveLineConfig(getLinePaths(m, "a"), base);
    saveLineConfig(getLinePaths(m, "b"), { ...base, handle: "ken-b" });
    let probes = 0;
    await runDoctor({ machine: m, log: () => {}, isDarwin: false,
      getStatusFn: async () => ({ online: true }), callFn: fakeCall,
      guardFn: async () => { probes++; return { name: "guard", ok: true }; } });
    expect(probes).toBe(1);
  });

  it("checks the single launch agent once, not per line", async () => {
    saveLineConfig(getLinePaths(m, "a"), base);
    saveLineConfig(getLinePaths(m, "b"), { ...base, handle: "ken-b" });
    let listed = 0;
    await runDoctor({ machine: m, log: () => {}, isDarwin: true,
      launchctlList: () => { listed++; return LAUNCH_LABEL; },
      getStatusFn: async () => ({ online: true }), callFn: fakeCall });
    expect(listed).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/doctor.test.ts`
Expected: FAIL — `runDoctor` still takes `paths`.

- [ ] **Step 3: Implement**

Change `DoctorDeps.paths: Paths` to `machine: MachinePaths`. Structure `runDoctor` as:

1. **Machine checks, once.** The single launchd label (`launchctlList().includes(LAUNCH_LABEL)`), gated on `isDarwin`.
2. **Per line**, printing a `line <name>` header before each: config validity (an orphan is `ok: false`), workdir, relay status, `verifyAgent`. A line with no `agent_kind` prints `caller-only` and contributes no failure.
3. **Guard probe once per distinct `agent_kind`** across all lines — it probes the binary, not the line. Cache by kind.
4. **Relay self-call once per line**, gated on that line's agent and presence both being healthy.
5. Return `checks.every((c) => c.ok) ? 0 : 1`.

Keep the existing ladder semantics from the comment at `doctor.ts:26-33`: a `!` warning is not a failure.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/doctor.ts packages/cli/test/doctor.test.ts
git commit -m "feat(cli): doctor reports per line, probing the guard once per agent kind"
```

---

## Task 14: Wire the CLI, then document

**Files:**
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/snippet.ts`
- Modify: `README.md`, `CHANGELOG.md`
- Test: `packages/cli/test/index.test.ts` (if present) — otherwise covered by the module tests above

**Interfaces:**
- Consumes: every module from Tasks 3–13

- [ ] **Step 1: Write the failing test**

Add to `packages/cli/test/outbound.test.ts` an end-to-end selection assertion for the `call` path:

```ts
it("call resolves its line from the destination address, not from a fixed config", () => {
  saveLineConfig(getLinePaths(m, "home"), { handle: "ken", token: "t", relay: "https://a.example" });
  const ctx = pickOutboundLine(m, "https://a.example");
  expect(ctx.config.handle).toBe("ken");
  expect(ctx.config.token).toBe("t");
});
```

- [ ] **Step 2: Run it**

Run: `cd packages/cli && pnpm vitest run test/outbound.test.ts`
Expected: PASS (this is a wiring guard, not a new behaviour).

- [ ] **Step 3: Implement the wiring**

In `index.ts`:

- Replace every `getPaths()` with `getMachinePaths()`.
- `call` / `status`: resolve the destination with `resolveAddress(machine, address, ...)`, then `pickOutboundLine(machine, destRelay, { as: o.as })`, and use that context's handle/token. Add `--as <line>`.
- `listen`: `--line <name>` runs one line via `startListener`; with no flag, `startAllListeners(machine)`.
- New `line` command group wired to Task 10's four functions; `line list` passes a presence probe built from `getStatus`.
- `uninstall`: `uninstallLaunchAgent(machine)`; `--purge` does `rmSync(machine.dir, ...)`.
- Delete the three `!cfg.agent_kind` blocks at the old `index.ts:134,154,245` — `assertCallableLine(ctx.config)` replaces them.

In `snippet.ts`, extend the snippet text with one line so an interactive agent knows lines exist:

```
- `agentcall line list` — the addresses this machine answers on. Calls go out as
  the primary line unless you pass `--as <line>`.
```

- [ ] **Step 4: Full verification**

Run from the repo root, in this order:

```bash
pnpm -r build && pnpm -r typecheck && pnpm -r test
```

Expected: all three pass. Then a smoke test **against a local relay only**:

```bash
# Terminal 1 — a throwaway relay on localhost. Never the production relay:
# handle release is not implemented (#16), so every name registered there is
# spent forever. Do not point this at agentcall.benree.tech.
cd apps/relay && pnpm dev            # serves http://localhost:8787

# Terminal 2
export AGENTCALL_HOME=$(mktemp -d)
export AGENTCALL_RELAY=http://localhost:8787
node packages/cli/dist/index.js setup --handle smoke-a --agent claude --skip-launchd --no-verify --no-snippet
node packages/cli/dist/index.js line add codex --handle smoke-b --agent codex --skip-launchd --no-verify
node packages/cli/dist/index.js line list
node packages/cli/dist/index.js doctor
unset AGENTCALL_HOME AGENTCALL_RELAY
```

Expected: two lines listed, `claude` primary, `smoke-a@localhost:8787` and
`smoke-b@localhost:8787` as the addresses. `doctor` reports both lines; agent checks
may fail if no `claude`/`codex` binary is present, which is fine — the line
enumeration and relay registration are what this exercises.

**If `wrangler dev` will not start in this environment, stop and report it rather
than falling back to the production relay.**

- [ ] **Step 5: Document and commit**

Update `README.md` with a "Several agents, several addresses" section covering `line add`, `line list`, `line primary`, that outbound uses the primary, and that an unshared address is not a security boundary. Add a `CHANGELOG.md` entry under a new version heading.

```bash
git add packages/cli/src/index.ts packages/cli/src/snippet.ts README.md CHANGELOG.md packages/cli/test/outbound.test.ts
git commit -m "feat(cli): wire the line commands, outbound selection and multi-line listen"
```

---

## Self-Review

**Spec coverage.** Every section of the design maps to a task: the person/line split → 2–5; one process N sockets → 8; outbound per relay → 9; two names and line validation → 4, 10; soft-boundary warning → 10 (`derivativeOf`); shared contacts → 12; per-line `calls.log` → 2, 7; `LineContext` → 5; guard corrections → 7; failure modes → 3, 4, 10; CLI surface → 10–14; testing → each task. The `AgentKind` move is Task 1.

**One thing the spec did not cover**, found while reading `guard.ts` for Task 7 and handled there: `DENIED_DIRS` contains the home-relative `AgentCall/tasks` (`guard.ts:47`), which stops matching once tasks live at `AgentCall/<line>/tasks`. Since task frontmatter sets the envelope's caps verbatim, losing that rule would let an answering agent widen its own permissions. Task 7 enumerates every line's `tasksDir` through the `extraRoots` parameter `deniedPaths` already accepts. **The spec should be amended to record this.**

**Type consistency.** `MachinePaths`/`LinePaths` (Task 2) are the parameter types everywhere downstream; `LineConfig` (Task 4) replaces `Config`; `LineContext` (Task 5) is what commands receive; `assertCallableLine` replaces `assertCallableConfig` consistently in Tasks 4, 12, 14. `listLines` returns `LineSummary[]` (may be broken) and `readyLines` returns only usable lines — Tasks 8, 9, 10 and 13 use whichever matches their tolerance for a broken line, deliberately.

**Ordering.** The migration is additive: Tasks 2–11 add the new types alongside the
old ones and move consumers over one task at a time, so **every commit passes
`pnpm -r build && pnpm -r typecheck && pnpm -r test`**. Task 12 is the deletion point
for the legacy exports (`Paths`, `getPaths`, `Config`, `loadConfig`, `saveConfig`,
`assertCallableConfig`, `resolveWorkdir`); by then nothing imports them. Tasks that
change a public signature — 6 (`launchd`), 8 (`ListenerDeps`), 12 (the shared
modules) — update their callers within the same task for exactly this reason.

**Amended after the pre-flight scan** (2026-08-01): the first draft had Tasks 2–5
land as one non-compiling unit, and Task 14 smoke-testing against the production
relay. Both were changed — the first to keep every commit bisectable and green, the
second because handle release is not implemented (#16), so a smoke test against
production spends global handles permanently.
