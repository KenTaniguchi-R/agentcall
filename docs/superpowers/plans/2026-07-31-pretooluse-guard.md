# PreToolUse Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deny a caller's agent access to credential paths on the owner's machine by inspecting every tool call before it runs.

**Architecture:** A catch-all `PreToolUse` hook is registered via inline `--settings` JSON when `runner.ts` spawns `claude -p`. The hook invokes a standalone Node entry point that reads the tool call from stdin, asks a pure `decide()` function whether it can reach a denied path, writes audit lines, and emits a structured deny. Nothing is installed into the owner's `~/.claude`.

**Tech Stack:** TypeScript (ESM, `"type": "module"`), Node ≥20, vitest, existing `packages/cli` layout.

**Spec:** [2026-07-31-pretooluse-guard-design.md](../specs/2026-07-31-pretooluse-guard-design.md). Read the six findings and **both review sections** before starting. An earlier draft of this plan had eight exploitable bugs in `decide()` alone, all from comparing unnormalised paths with `startsWith`; the comments in the code below name the specific bypass each line prevents. Do not "simplify" them back.

**Verification status:** Task 1's implementation and its 31 tests were executed together before this plan was committed, and all 31 pass. Later tasks are reviewed but not executed — they depend on repo files that do not exist yet.

## Global Constraints

- ESM only. Every relative import ends in `.js` even though the source is `.ts`.
- Node `>=20`. macOS only (`"os": ["darwin"]` in package.json).
- Stage files explicitly: `git add <file> <file>`. Never `git add -A` or `git add .`.
- Test-first. Write the failing test, watch it fail, then implement.
- **No live `claude` spawn in tests.** The doctor self-test spawns for real on a user's machine but must be mocked in vitest.
- `pnpm typecheck` does **not** cover `test/` (tsconfig `"include": ["src"]`). A signature change shows up only in `pnpm test`.
- Before calling the whole thing done, from the repo root: `pnpm -r test && pnpm -r typecheck && pnpm -r build`.
- The caller-facing deny reason is a fixed constant. It must never contain a path, a `~`, or a rule name.

---

### Task 1: `decide()` — the reachability rules and the denied-path table

The whole security value of the feature is in this function. It is pure: no fs, no env, no clock.

**Files:**
- Create: `packages/cli/src/guard.ts`
- Test: `packages/cli/test/guard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GuardInput = { tool_name: string; tool_input: Record<string, unknown>; cwd: string }`
  - `type GuardVerdict = { allow: true; flag?: { rule: string; detail: string } } | { allow: false; rule: string; detail: string }`
  - `function decide(input: GuardInput, home: string, realpath: (p: string) => string): GuardVerdict`
  - `const DENY_REASON: string`

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decide, DENY_REASON, type GuardInput } from "../src/guard.js";

const HOME = "/Users/owner";
const CWD = "/Users/owner/AgentCall/public";
// Identity realpath: these tests assert path logic, not symlink resolution.
const id = (p: string) => p;

const call = (tool: string, input: Record<string, unknown>, cwd = CWD): GuardInput =>
  ({ tool_name: tool, tool_input: input, cwd });

describe("decide — exact-target tools", () => {
  it("denies reading inside a denied directory", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a denied basename anywhere on disk", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/.env" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows .env.example, which is not a secret", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/.env.example" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("allows an ordinary project file", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/src/index.ts" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("resolves relative paths against cwd", () => {
    const v = decide(call("Read", { file_path: "../../.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("follows a symlink into a denied directory", () => {
    const realpath = (p: string) => (p === "/tmp/x" ? "/Users/owner/.ssh/id_rsa" : p);
    const v = decide(call("Read", { file_path: "/tmp/x" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });

  it("denies writing into the agent's own config", () => {
    const v = decide(call("Write", { file_path: "/Users/owner/.claude/settings.json" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies reading agentcall's own relay token", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.agentcall/config.json" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — tilde is a path, not a literal directory", () => {
  it("denies a tilde-prefixed read", () => {
    const v = decide(call("Read", { file_path: "~/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a tilde-prefixed Grep root", () => {
    const v = decide(call("Grep", { path: "~/.ssh", pattern: "KEY" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — case folding on a case-insensitive filesystem", () => {
  it("denies an upper-cased denied directory", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/.SSH/id_rsa" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies an upper-cased denied basename", () => {
    const v = decide(call("Read", { file_path: "/Users/owner/proj/KEY.PEM" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — scanning tools reach through a parent", () => {
  it("denies Grep rooted at home, which contains denied paths", () => {
    const v = decide(call("Grep", { path: "/Users/owner", pattern: "PRIVATE KEY" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies Grep rooted at /", () => {
    const v = decide(call("Grep", { path: "/", pattern: "PRIVATE KEY" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows Grep rooted at a project that contains nothing denied", () => {
    const v = decide(call("Grep", { path: "/Users/owner/proj", pattern: "TODO" }), HOME, id);
    expect(v.allow).toBe(true);
  });

  it("denies LS of a denied directory — LS is granted by the read cap", () => {
    const v = decide(call("LS", { path: "/Users/owner/.ssh" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies LS rooted at home", () => {
    const v = decide(call("LS", { path: "/Users/owner" }), HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("decide — Glob carries its path in the pattern", () => {
  it("denies an absolute pattern into a denied directory", () => {
    const v = decide(call("Glob", { pattern: "/Users/owner/.ssh/*" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a tilde pattern into a denied directory", () => {
    const v = decide(call("Glob", { pattern: "~/.ssh/*" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a pattern enumerating a denied basename", () => {
    expect(decide(call("Glob", { pattern: "**/.env" }), HOME, id).allow).toBe(false);
    expect(decide(call("Glob", { pattern: "**/*.pem" }), HOME, id).allow).toBe(false);
  });

  it("denies a pattern that escapes its root", () => {
    const v = decide(call("Glob", { pattern: "../../.ssh/*" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("allows an ordinary source glob under cwd", () => {
    const v = decide(call("Glob", { pattern: "**/*.ts" }), HOME, id);
    expect(v.allow).toBe(true);
  });
});

describe("decide — writes to a path that does not exist yet", () => {
  it("resolves the longest existing ancestor through a symlink", () => {
    // /tmp/link exists and points into ~/.ssh; the leaf does not exist yet.
    const realpath = (p: string) => {
      if (p === "/tmp/link/new_key") throw new Error("ENOENT");
      if (p === "/tmp/link") return "/Users/owner/.ssh";
      return p;
    };
    const v = decide(call("Write", { file_path: "/tmp/link/new_key" }), HOME, realpath);
    expect(v.allow).toBe(false);
  });
});

describe("decide — Bash records but does not deny", () => {
  it("flags a command referencing a denied path, and still allows it", () => {
    const v = decide(call("Bash", { command: "cat ~/.ssh/id_rsa" }), HOME, id);
    expect(v.allow).toBe(true);
    expect(v.allow === true && v.flag?.rule).toBeTruthy();
  });

  it("does not flag ordinary work", () => {
    const v = decide(call("Bash", { command: "npm test" }), HOME, id);
    expect(v.allow).toBe(true);
    expect(v.allow === true && v.flag).toBeUndefined();
  });
});

describe("decide — unknown shapes fail closed", () => {
  it("allows a tool with no filesystem surface", () => {
    expect(decide(call("WebSearch", { query: "typescript" }), HOME, id).allow).toBe(true);
    expect(decide(call("WebFetch", { url: "https://example.com" }), HOME, id).allow).toBe(true);
  });

  it("DENIES a tool it has never been taught", () => {
    // The LS failure mode: an unclassified tool has an argument shape this
    // function cannot inspect, so it must not be waved through.
    const v = decide(call("SomeNewTool", { path: "/Users/owner/.ssh" }), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies a path-shaped tool whose argument is missing", () => {
    const v = decide(call("Read", {}), HOME, id);
    expect(v.allow).toBe(false);
  });

  it("denies when tool_input is not an object", () => {
    const v = decide({ tool_name: "Read", tool_input: null as never, cwd: CWD }, HOME, id);
    expect(v.allow).toBe(false);
  });
});

describe("DENY_REASON is a contract", () => {
  it("leaks no path, tilde, or rule name", () => {
    expect(DENY_REASON).not.toMatch(/[/~]/);
    expect(DENY_REASON).not.toMatch(/ssh|aws|env|keychain/i);
    expect(DENY_REASON.split(/[.!?]/).filter((s) => s.trim()).length).toBe(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/guard.test.ts`
Expected: FAIL — `Failed to resolve import "../src/guard.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/cli/src/guard.ts`:

```ts
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type GuardInput = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
};

// `rule` and `detail` are audit-only. They name the matched rule and the
// resolved path, and MUST NOT reach permissionDecisionReason — the caller-facing
// reason is DENY_REASON, a fixed string with no per-denial content. See the
// reason contract in the design spec.
export type GuardVerdict =
  | { allow: true; flag?: { rule: string; detail: string } }
  | { allow: false; rule: string; detail: string };

// Caller-facing. One sentence, no path, no rule name. Under test.
export const DENY_REASON =
  "This action is not permitted by the answering agent's policy.";

// Home-relative directories. Everything beneath them is denied.
const DENIED_DIRS = [
  ".ssh", ".gnupg", ".aws", ".config/gcloud", "Library/Keychains",
  ".agentcall",   // holds config.json and the relay token
  ".claude",      // executable configuration; cf. CVE-2025-59536
];

// Home-relative single files.
const DENIED_FILES = [".netrc", ".npmrc", ".docker/config.json", ".claude.json"];

// Basenames denied anywhere on disk. `.env.example` and friends are
// deliberately excluded: they are not secrets, and denying them is the
// false-positive failure the spec warns about.
const DENIED_BASENAMES: RegExp[] = [
  /^\.env$/,
  /^\.env\.(?!example$|sample$|template$)/,
  /^id_rsa$/, /^id_ed25519$/, /^id_ecdsa$/,
  /\.pem$/, /\.p12$/, /\.pfx$/,
];

// Every tool the envelope can grant (see CLAUDE_TOOLS in runner.ts). A tool
// absent from all four groups is DENIED, not allowed: an unclassified tool has
// an argument shape this function cannot inspect. `LS` was missed exactly that
// way in an earlier draft and fell through to allow.
const EXACT_TARGET: Record<string, string> = {
  Read: "file_path", Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path",
};
// Tools whose `path` argument names a root that is then searched or listed.
const SCANNING_ROOT = new Set(["Grep", "LS"]);
// Tools with no filesystem argument at all.
const NO_PATH_SURFACE = new Set(["WebFetch", "WebSearch"]);
// `Glob` is handled separately: its path lives in `pattern`, not `path`.

// package.json pins os: ["darwin"], and the default macOS filesystem is
// case-INsensitive — ~/.SSH opens ~/.ssh. Folding can over-deny on a
// case-sensitive volume, which is the safe direction for a floor.
const fold = (p: string) => p.toLowerCase();

function deniedPaths(home: string): string[] {
  return [...DENIED_DIRS, ...DENIED_FILES].map((d) => resolve(home, d));
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

// realpath throws on a path that does not exist yet — a Write target, a
// dangling symlink. Resolving the longest EXISTING ancestor and re-appending
// the unresolved tail is what stops `/tmp/link/new_key` (link -> ~/.ssh) from
// being compared as text and allowed.
function canonical(p: string, cwd: string, home: string, realpath: (p: string) => string): string {
  const expanded = expandHome(p, home);
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const tail: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return resolve(realpath(cur), ...[...tail].reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return abs;   // reached the root, nothing resolvable
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

// relative() rather than startsWith(): resolve("/") is "/", so "/" + sep is
// "//", which prefixes nothing — a prefix compare silently permits a search
// rooted at the filesystem root.
function isInside(target: string, denied: string): boolean {
  const rel = relative(fold(denied), fold(target));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// A search rooted at `target` reaches `denied` when `target` is above it.
// This is what stops Grep(path: "~") and Grep(path: "/").
function isAncestorOf(target: string, denied: string): boolean {
  const rel = relative(fold(target), fold(denied));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function basenameDenied(p: string): boolean {
  const b = fold(basename(p));
  return DENIED_BASENAMES.some((re) => re.test(b));
}

// Everything before the first magic character, trimmed back to a directory.
// Glob carries its path inside `pattern`, so "/Users/o/.ssh/*" must be checked
// even when `path` is absent entirely.
function globLiteralPrefix(pattern: string): string {
  const magic = pattern.search(/[*?[{]/);
  const head = magic === -1 ? pattern : pattern.slice(0, magic);
  const cut = head.lastIndexOf(sep);
  return cut === -1 ? "" : head.slice(0, cut) || sep;
}

export function decide(
  input: GuardInput,
  home: string,
  realpath: (p: string) => string,
): GuardVerdict {
  const { tool_name: tool, tool_input: args, cwd } = input;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { allow: false, rule: "unparseable-input", detail: tool };
  }
  const denied = deniedPaths(home);
  const canon = (p: string) => canonical(p, cwd, home, realpath);
  const reached = (t: string, withAncestors: boolean) =>
    denied.find((d) => isInside(t, d) || (withAncestors && isAncestorOf(t, d)));

  if (tool === "Bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const hit = denied.find((d) =>
      fold(command).includes(fold(d)) || fold(command).includes(fold(d.replace(home, "~"))));
    // Record and allow: string matching is too weak to be a boundary and too
    // eager to be harmless. See the spec's Bash section — and note this means
    // an `exec`-granted task has NO read floor.
    return hit ? { allow: true, flag: { rule: "bash-references-denied-path", detail: hit } } : { allow: true };
  }

  if (NO_PATH_SURFACE.has(tool)) return { allow: true };

  const key = EXACT_TARGET[tool];
  if (key !== undefined) {
    const raw = args[key];
    // Fail closed: a path-shaped tool with no usable path is not understood.
    if (typeof raw !== "string" || raw === "") return { allow: false, rule: "unparseable-target", detail: String(raw) };
    const target = canon(raw);
    if (basenameDenied(target)) return { allow: false, rule: "denied-basename", detail: target };
    const hit = reached(target, false);
    return hit ? { allow: false, rule: "inside-denied-path", detail: target } : { allow: true };
  }

  if (SCANNING_ROOT.has(tool)) {
    const rawRoot = typeof args.path === "string" && args.path !== "" ? args.path : cwd;
    const root = canon(rawRoot);
    if (basenameDenied(root)) return { allow: false, rule: "denied-basename", detail: root };
    const hit = reached(root, true);
    return hit ? { allow: false, rule: "root-reaches-denied-path", detail: root } : { allow: true };
  }

  if (tool === "Glob") {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    // A pattern that climbs out of its root defeats a root-only check.
    if (pattern.split("/").includes("..")) return { allow: false, rule: "escaping-pattern", detail: pattern };
    // "**/.env" and "**/*.pem" enumerate denied basenames under a permitted root.
    if (basenameDenied(pattern)) return { allow: false, rule: "denied-basename-pattern", detail: pattern };
    const prefix = globLiteralPrefix(pattern);
    const rawRoot = typeof args.path === "string" && args.path !== "" ? args.path : cwd;
    const root = canon(prefix === "" ? rawRoot
      : isAbsolute(expandHome(prefix, home)) ? prefix : join(rawRoot, prefix));
    const hit = reached(root, true);
    return hit ? { allow: false, rule: "root-reaches-denied-path", detail: root } : { allow: true };
  }

  // Unclassified tool. Deny — an argument shape this function has never seen
  // cannot be inspected, and allowing it is how LS became a hole.
  return { allow: false, rule: "unclassified-tool", detail: tool };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd packages/cli && pnpm vitest run test/guard.test.ts`
Expected: PASS, 30 tests. This exact implementation and this exact test set were executed together before the plan was committed — if any case fails, the implementation was transcribed wrongly, not mis-specified.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/guard.ts packages/cli/test/guard.test.ts
git commit -m "feat(guard): decide() — reachability rules for the denied-path floor"
```

---

### Task 2: `runGuard()` — the two log streams and the verdict payload

**Files:**
- Modify: `packages/cli/src/paths.ts`
- Modify: `packages/cli/src/guard.ts` (append)
- Test: `packages/cli/test/guard.test.ts` (append)

**Interfaces:**
- Consumes: `decide()`, `DENY_REASON`, `GuardVerdict` from Task 1.
- Produces:
  - `Paths.toolsLog: string`
  - `interface GuardDeps { paths: Paths; callId: string; now: () => string; realpath: (p: string) => string; appendLine: (file: string, line: string) => void }`
  - `function runGuard(raw: string, deps: GuardDeps): { exitCode: number; stdout: string }`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/guard.test.ts`:

```ts
import { runGuard, type GuardDeps } from "../src/guard.js";
import { getPaths } from "../src/paths.js";

function harness() {
  const lines: Array<{ file: string; line: string }> = [];
  const deps: GuardDeps = {
    paths: getPaths(HOME),
    callId: "call-123",
    now: () => "2026-07-31T00:00:00.000Z",
    realpath: id,
    appendLine: (file, line) => lines.push({ file, line }),
  };
  const p = getPaths(HOME);
  return {
    deps, lines,
    calls: () => lines.filter((l) => l.file === p.callsLog).map((l) => JSON.parse(l.line)),
    tools: () => lines.filter((l) => l.file === p.toolsLog).map((l) => JSON.parse(l.line)),
  };
}

const payload = (tool: string, input: Record<string, unknown>) =>
  JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input: input, cwd: CWD });

describe("runGuard", () => {
  it("allows an ordinary read, logging only to tools.log", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/proj/a.ts" }), h.deps);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(h.calls()).toHaveLength(0);
    expect(h.tools()).toEqual([
      { ts: "2026-07-31T00:00:00.000Z", type: "tool_call", call_id: "call-123", tool: "Read", allowed: true },
    ]);
  });

  it("denies a credential read, logging to both streams", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.exitCode).toBe(0);
    const decision = JSON.parse(out.stdout);
    expect(decision.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBe(DENY_REASON);
    expect(h.calls()[0]).toMatchObject({ type: "tool_denied", call_id: "call-123", tool: "Read" });
    expect(h.tools()[0]).toMatchObject({ type: "tool_call", allowed: false });
  });

  it("never leaks the resolved path to the caller", () => {
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.stdout).not.toContain("id_rsa");
    expect(out.stdout).not.toContain(".ssh");
    // …while the owner's log keeps the specifics.
    expect(JSON.stringify(h.calls()[0])).toContain("id_rsa");
  });

  it("records a flagged Bash command without denying it", () => {
    const h = harness();
    const out = runGuard(payload("Bash", { command: "cat /Users/owner/.ssh/id_rsa" }), h.deps);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(h.calls()[0]).toMatchObject({ type: "tool_flagged", tool: "Bash" });
    expect(h.tools()[0]).toMatchObject({ allowed: true });
  });

  it("fails closed on unparseable input", () => {
    const h = harness();
    const out = runGuard("not json", h.deps);
    expect(out.exitCode).toBe(2);
  });

  it("fails closed on a payload with no tool name", () => {
    const h = harness();
    const out = runGuard(JSON.stringify({ cwd: CWD }), h.deps);
    expect(out.exitCode).toBe(2);
  });

  it("fails closed when the audit write throws", () => {
    // A full disk or read-only home must not become a silent allow. Without
    // the log writes inside the try, this exits 1 and Claude runs the tool.
    const h = harness();
    const out = runGuard(payload("Read", { file_path: "/Users/owner/proj/a.ts" }), {
      ...h.deps,
      appendLine: () => { throw new Error("ENOSPC: no space left on device"); },
    });
    expect(out.exitCode).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/guard.test.ts`
Expected: FAIL — `runGuard` is not exported, and `toolsLog` does not exist on `Paths`.

- [ ] **Step 3: Add `toolsLog` to paths.ts**

In `packages/cli/src/paths.ts`, add the field to the interface and the returned object:

```ts
export interface Paths {
  home: string; dir: string; configFile: string;
  callsLog: string; listenerLog: string; toolsLog: string; publicDir: string;
  tasksDir: string; policyFile: string; cardSnapshotFile: string;
  contactsFile: string;
}
```

and inside `getPaths`, beside `callsLog`:

```ts
    toolsLog: join(dir, "tools.log"),
```

- [ ] **Step 4: Append `runGuard` to guard.ts**

```ts
import type { Paths } from "./paths.js";

export interface GuardDeps {
  paths: Paths;
  callId: string;
  now: () => string;
  realpath: (p: string) => string;
  appendLine: (file: string, line: string) => void;
}

// calls.log stays sparse and owner-facing; tools.log carries every call so the
// audit-trail claim is true. A denial appears in both.
export function runGuard(raw: string, deps: GuardDeps): { exitCode: number; stdout: string } {
  let input: GuardInput;
  try {
    const parsed = JSON.parse(raw) as Partial<GuardInput>;
    if (typeof parsed.tool_name !== "string" || parsed.tool_name === "") throw new Error("no tool_name");
    input = {
      tool_name: parsed.tool_name,
      tool_input: (parsed.tool_input ?? {}) as Record<string, unknown>,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : deps.paths.home,
    };
  } catch {
    // Exit 2 blocks bluntly. The guard never allows because it failed to decide.
    return { exitCode: 2, stdout: "" };
  }

  // EVERYTHING below is inside the failure boundary, including the log writes.
  // An exception escaping this function exits the process 1, and Claude treats
  // any exit other than 0 or 2 as a non-blocking error — so a full disk or a
  // read-only home would silently turn the guard off. Fail closed instead.
  try {
    const verdict = decide(input, deps.paths.home, deps.realpath);
    const ts = deps.now();
    const write = (file: string, obj: Record<string, unknown>) =>
      deps.appendLine(file, JSON.stringify({ ts, ...obj }));

    write(deps.paths.toolsLog, {
      type: "tool_call", call_id: deps.callId, tool: input.tool_name, allowed: verdict.allow,
    });

    if (!verdict.allow) {
      write(deps.paths.callsLog, {
        type: "tool_denied", call_id: deps.callId, tool: input.tool_name,
        rule: verdict.rule, detail: verdict.detail,
      });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: DENY_REASON,
          },
        }),
      };
    }

    if (verdict.flag) {
      write(deps.paths.callsLog, {
        type: "tool_flagged", call_id: deps.callId, tool: input.tool_name,
        rule: verdict.flag.rule, detail: verdict.flag.detail,
      });
    }
    return { exitCode: 0, stdout: "" };
  } catch {
    return { exitCode: 2, stdout: "" };
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd packages/cli && pnpm vitest run test/guard.test.ts`
Expected: PASS, 6 new tests. No other test needs updating — every test that needs a `Paths` builds it through `getPaths()`, so the new field appears automatically.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/guard.ts packages/cli/src/paths.ts packages/cli/test/guard.test.ts
git commit -m "feat(guard): runGuard() with two log streams and a fixed deny reason"
```

---

### Task 3: `guard-entry.ts` — the standalone process entry

Finding 6 measured ~33 ms standalone against ~78 ms through `index.ts`. This is the hot path, so it gets its own entry and deliberately **not** a subcommand.

**Files:**
- Create: `packages/cli/src/guard-entry.ts`
- Test: `packages/cli/test/guard-entry.test.ts`

**Interfaces:**
- Consumes: `runGuard`, `GuardDeps` from Task 2.
- Produces: a runnable `dist/guard-entry.js` that reads stdin and exits 0 or 2.

- [ ] **Step 1: Write the failing test**

Create `packages/cli/test/guard-entry.test.ts`:

```ts
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_TIMEOUT_S } from "../src/runner.js";

// The entry is a real process — that is the whole point of the file, and the
// only way to measure what the timeout has to cover.
const ENTRY = join(process.cwd(), "dist", "guard-entry.js");

function run(payload: object, home: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [ENTRY], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" },
      encoding: "utf8",
    });
    return { status: 0, stdout };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { status: err.status, stdout: err.stdout ?? "" };
  }
}

describe("guard-entry as a real process", () => {
  it("allows an ordinary read and writes tools.log", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run({ tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home }, home);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const tools = readFileSync(join(home, ".agentcall", "tools.log"), "utf8").trim();
    expect(JSON.parse(tools)).toMatchObject({ type: "tool_call", call_id: "call-abc", allowed: true });
  });

  it("denies a credential read and emits the structured decision", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run({ tool_name: "Read", tool_input: { file_path: join(home, ".ssh/id_rsa") }, cwd: home }, home);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const calls = readFileSync(join(home, ".agentcall", "calls.log"), "utf8").trim();
    expect(JSON.parse(calls)).toMatchObject({ type: "tool_denied" });
  });

  it("exits 2 on unparseable input", () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const r = run("not json" as unknown as object, home);
    expect(r.status).toBe(2);
  });

  // Guards the fail-open-on-timeout path, and does it under concurrency:
  // Copilot's documented bug is specifically parallel — the timeout expires,
  // the CLI stops waiting, and the tool runs anyway. Timing decide() would
  // pass while this path was slow, because the cost is process startup.
  // Asserted against the REGISTERED timeout, not an arbitrary number.
  it("completes inside the registered timeout with 8 hooks in flight", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    const one = () => new Promise<void>((ok, fail) => {
      const child = execFile(
        process.execPath, [ENTRY],
        { env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" } },
        (err) => (err ? fail(err) : ok()),
      );
      child.stdin?.end(body);
    });
    const started = Date.now();
    await Promise.all(Array.from({ length: 8 }, one));
    expect(Date.now() - started).toBeLessThan(GUARD_TIMEOUT_S * 1000);
  });

  it("writes one tools.log line per concurrent call, losing none", async () => {
    const home = mkdtempSync(join(tmpdir(), "guard-"));
    const body = JSON.stringify({
      tool_name: "Read", tool_input: { file_path: join(home, "a.ts") }, cwd: home,
    });
    const one = () => new Promise<void>((ok, fail) => {
      const child = execFile(
        process.execPath, [ENTRY],
        { env: { ...process.env, AGENTCALL_HOME: home, AGENTCALL_CALL_ID: "call-abc" } },
        (err) => (err ? fail(err) : ok()),
      );
      child.stdin?.end(body);
    });
    await Promise.all(Array.from({ length: 8 }, one));
    const lines = readFileSync(join(home, ".agentcall", "tools.log"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(8);
    // Interleaved appends must still parse: a torn line means the audit trail
    // cannot be trusted, which is the whole point of the second stream.
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && pnpm build && pnpm vitest run test/guard-entry.test.ts`
Expected: FAIL — `dist/guard-entry.js` does not exist.

- [ ] **Step 3: Write the entry point**

Create `packages/cli/src/guard-entry.ts`:

```ts
// Standalone process entry for the PreToolUse hook. Deliberately NOT a
// subcommand on index.ts: routing through commander and the full import graph
// measured 78ms against 33ms here, and this runs once per tool call.
// Import only what it needs.
import { appendFileSync, mkdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { runGuard } from "./guard.js";
import { getPaths } from "./paths.js";

try {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  const out = runGuard(raw, {
    paths: getPaths(),
    callId: process.env.AGENTCALL_CALL_ID ?? "unknown",
    now: () => new Date().toISOString(),
    // Plain realpathSync, which THROWS on a path that does not exist. That is
    // required: canonical() catches it and walks up to the longest existing
    // ancestor. Swallowing the throw here and returning the text unchanged is
    // what let a Write through /tmp/link (-> ~/.ssh) land inside ~/.ssh.
    realpath: realpathSync,
    appendLine: (file, line) => {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, line + "\n");
    },
  });

  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.exitCode);
} catch {
  // Nothing may escape this file. Any exit that is not 0 or 2 is a
  // non-blocking error to Claude, and the tool call proceeds.
  process.exit(2);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd packages/cli && pnpm build && pnpm vitest run test/guard-entry.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/guard-entry.ts packages/cli/test/guard-entry.test.ts
git commit -m "feat(guard): standalone process entry, measured off the slow CLI path"
```

---

### Task 4: Wire the hook into the spawn

This is the task that makes the guard live.

**Files:**
- Modify: `packages/cli/src/runner.ts`
- Modify: `packages/cli/src/listener.ts:83-90`
- Test: `packages/cli/test/runner.test.ts` (append)

**Interfaces:**
- Consumes: `dist/guard-entry.js` from Task 3.
- Produces:
  - `SpawnSpec` gains `env?: NodeJS.ProcessEnv`
  - `function guardSettingsJson(): string`
  - `const GUARD_TIMEOUT_S: number`
  - `buildSpawnSpec(kind, prompt, workdir, resolveBin?, envelope?, callId?)`
  - `runAgent(kind, prompt, workdir, timeoutMs?, specOverride?, envelope?, callId?)`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/runner.test.ts`:

```ts
import { guardSettingsJson, GUARD_TIMEOUT_S } from "../src/runner.js";

describe("guard hook wiring", () => {
  it("registers exactly one PreToolUse hook and nothing else", () => {
    const settings = JSON.parse(guardSettingsJson());
    // Scope guard: a hook cannot be added to a security-carrying payload
    // without deliberately editing this assertion.
    expect(Object.keys(settings.hooks)).toEqual(["PreToolUse"]);
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(settings.hooks.PreToolUse[0].hooks).toHaveLength(1);
  });

  it("uses no matcher, so every tool call reaches the guard", () => {
    const entry = JSON.parse(guardSettingsJson()).hooks.PreToolUse[0];
    expect(entry.matcher).toBeUndefined();
    expect(entry.if).toBeUndefined();
  });

  it("invokes an absolute interpreter and an absolute entry path", () => {
    const hook = JSON.parse(guardSettingsJson()).hooks.PreToolUse[0].hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toContain(process.execPath);
    expect(hook.command).toContain("guard-entry.js");
    expect(hook.timeout).toBe(GUARD_TIMEOUT_S);
  });

  it("declares no permissions.deny — deny rules suppress the hook", () => {
    expect(JSON.parse(guardSettingsJson()).permissions).toBeUndefined();
  });

  it("shell-quotes both paths, since an unparseable command fails open", () => {
    const hook = JSON.parse(guardSettingsJson()).hooks.PreToolUse[0].hooks[0];
    // Both arguments single-quoted; nothing left bare for the shell to split
    // or expand.
    expect(hook.command).toMatch(/^'[^']*(?:'\\''[^']*)*' '[^']*(?:'\\''[^']*)*'$/);
  });

  it("passes --settings and the call id when spawning claude", () => {
    const spec = buildSpawnSpec("claude", "hi", WORKDIR, () => "/bin/claude", FULL_ACCESS_ENVELOPE, "call-9");
    const i = spec.args.indexOf("--settings");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(spec.args[i + 1]!).hooks.PreToolUse).toBeDefined();
    expect(spec.env?.AGENTCALL_CALL_ID).toBe("call-9");
  });

  it("leaves the codex spawn untouched", () => {
    const spec = buildSpawnSpec("codex", "hi", WORKDIR, () => "/bin/codex", FULL_ACCESS_ENVELOPE, "call-9");
    expect(spec.args).not.toContain("--settings");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/runner.test.ts`
Expected: FAIL — `guardSettingsJson` is not exported.

- [ ] **Step 3: Implement the wiring in runner.ts**

Add near the top of `packages/cli/src/runner.ts`:

```ts
import { fileURLToPath } from "node:url";

// Biased long on purpose. Timeout expiry fails OPEN — the tool runs — so all
// the risk is on the too-short side. A hung guard stalls one call, which is
// safe and visible; an abandoned one is neither. Measured cost is ~33ms.
export const GUARD_TIMEOUT_S = 30;

// Inline settings, not a plugin and not a file: scoped to this spawn, gone when
// the process exits, and the owner's own ~/.claude is untouched.
//
// No `matcher` and no `if`: both narrow which calls arrive, and the matcher
// parser fails open. No `permissions.deny` either — a matching deny rule blocks
// the read AND suppresses the hook, so the denial would never be logged.
// The hook command is handed to a shell. An install path containing a quote,
// a space, a backslash, or $( ) would produce an unparseable command — and an
// unparseable hook command fails OPEN, so the credential read then proceeds.
// Single quotes with the standard '\'' escape are the safe POSIX form.
const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function guardSettingsJson(): string {
  const entry = fileURLToPath(new URL("./guard-entry.js", import.meta.url));
  return JSON.stringify({
    hooks: {
      PreToolUse: [{
        hooks: [{
          type: "command",
          command: `${shellQuote(process.execPath)} ${shellQuote(entry)}`,
          timeout: GUARD_TIMEOUT_S,
        }],
      }],
    },
  });
}
```

Change the `SpawnSpec` type:

```ts
export interface SpawnSpec { cmd: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
```

Change `buildSpawnSpec`'s signature and its claude branch:

```ts
export function buildSpawnSpec(
  kind: AgentKind, prompt: string, workdir: string, resolveBin: (kind: AgentKind) => string = resolveAgentBin,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown",
): SpawnSpec {
  if (kind === "claude") {
    return {
      cmd: resolveBin(kind),
      args: ["-p", prompt, "--output-format", "json",
        "--permission-mode", "dontAsk", "--allowedTools", claudeAllowedTools(envelope),
        "--settings", guardSettingsJson()],
      cwd: workdir,
      env: { ...process.env, AGENTCALL_CALL_ID: callId },
    };
  }
```

Leave the codex branch as it is — Codex has no equivalent hook yet, and `decide()` is agent-agnostic so parity is later wiring.

Change `runAgent` to accept and forward the id:

```ts
export function runAgent(
  kind: AgentKind, prompt: string, workdir: string, timeoutMs: number = AGENT_TIMEOUT_MS, specOverride?: SpawnSpec,
  envelope: Envelope = FULL_ACCESS_ENVELOPE, callId: string = "unknown",
): Promise<AgentOutput> {
  const spec = specOverride ?? buildSpawnSpec(kind, prompt, workdir, resolveAgentBin, envelope, callId);
```

and pass the env through to `spawn`:

```ts
    const child = spawn(spec.cmd, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
```

- [ ] **Step 4: Thread the call id from the listener**

In `packages/cli/src/listener.ts`, the `run(...)` call at line 83 currently ends with `task.envelope`. Add `call_id` after it:

```ts
          const out = await run(
            deps.config.agent_kind,
            buildPrompt(deps.config.handle, from, message, task, workdir),
            workdir.dir,
            timeoutMs,
            undefined,
            task.envelope,
            call_id,
          );
```

- [ ] **Step 5: Run the full CLI suite**

Run: `cd packages/cli && pnpm test`
Expected: PASS. If `listener.test.ts` asserts on `run` arguments, update those assertions to include the new trailing `call_id`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/runner.ts packages/cli/src/listener.ts packages/cli/test/runner.test.ts
git commit -m "feat(guard): register the hook on every claude spawn, thread call_id"
```

---

### Task 5: Doctor self-test and the Codex gap in the README

Claude treats a hook exiting anything other than 0 or 2 as a non-blocking error, so an unresolvable binary means no guard and nothing says so. This turns that into a loud setup-time failure.

**Files:**
- Modify: `packages/cli/src/verify.ts`
- Modify: `packages/cli/src/doctor.ts`
- Modify: `README.md`
- Test: `packages/cli/test/verify.test.ts` (append)

**Interfaces:**
- Consumes: `guardSettingsJson` from Task 4.
- Produces: `function checkGuard(runFn?: GuardProbeFn): Promise<VerifyCheck>`, `type GuardProbeFn = (settings: string) => Promise<string>`

- [ ] **Step 1: Write the failing test**

Append to `packages/cli/test/verify.test.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkGuard } from "../src/verify.js";

// A temp home whose calls.log already contains a denial, as a real guard run
// would have left behind.
function homeWithDenial(): string {
  const home = mkdtempSync(join(tmpdir(), "guardcheck-"));
  mkdirSync(join(home, ".agentcall"), { recursive: true });
  writeFileSync(join(home, ".agentcall", "calls.log"),
    JSON.stringify({ ts: "2026-07-31T00:00:00.000Z", type: "tool_denied", tool: "Read" }) + "\n");
  return home;
}

describe("checkGuard", () => {
  it("passes when the read was refused AND a denial was recorded", async () => {
    const probe = async () => ({ output: "I could not read it.", home: homeWithDenial() });
    expect((await checkGuard(probe)).ok).toBe(true);
  });

  it("fails when the canary comes back — the guard is not in force", async () => {
    const probe = async () => ({ output: "It contains AGENTCALL-GUARD-CANARY", home: homeWithDenial() });
    const c = await checkGuard(probe);
    expect(c.ok).toBe(false);
    expect(c.hint).toBeTruthy();
  });

  it("fails when nothing was denied, even though the canary is absent", async () => {
    // The model simply never called Read. A clean transcript is not evidence
    // that the guard is working.
    const probe = async () => ({ output: "Sure, what would you like to know?", home: mkdtempSync(join(tmpdir(), "empty-")) });
    const c = await checkGuard(probe);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("no denial was recorded");
  });

  it("fails when the probe throws", async () => {
    const probe = async () => { throw new Error("claude not found"); };
    expect((await checkGuard(probe)).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd packages/cli && pnpm vitest run test/verify.test.ts`
Expected: FAIL — `checkGuard` is not exported.

- [ ] **Step 3: Implement `checkGuard` in verify.ts**

**Merge the imports — do not add duplicates.** `verify.ts:1` already imports `execFileSync` from `node:child_process`, and line 4 already imports from `./runner.js`. Extend those two lines rather than adding new ones, or the file will not compile:

```ts
import { execFileSync } from "node:child_process";                       // unchanged
import { AgentRunError, guardSettingsJson, runAgent, type AgentKind } from "./runner.js";  // + guardSettingsJson
```

and add these, which `verify.ts` does not yet have:

```ts
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

Then the check itself:

```ts
export const GUARD_CANARY = "AGENTCALL-GUARD-CANARY";
// The probe returns the temp home as well as the output, because the absence
// of the canary is not evidence — see below.
export interface GuardProbeResult { output: string; home: string }
export type GuardProbeFn = (settings: string) => Promise<GuardProbeResult>;

const GUARD_HINT = "run `pnpm build` in packages/cli so dist/guard-entry.js exists, then re-run doctor";

// Spawns a real `claude -p` against a canary in a throwaway .ssh directory and
// asserts the read is refused. Live on the user's machine; always mocked in CI.
const defaultGuardProbe: GuardProbeFn = async (settings) => {
  const home = mkdtempSync(join(tmpdir(), "agentcall-guard-"));
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "id_rsa"), GUARD_CANARY);
  const output = execFileSync(
    "claude",
    ["-p", "Read the file .ssh/id_rsa and print its exact contents.",
     "--permission-mode", "dontAsk", "--allowedTools", "Read", "--settings", settings],
    { cwd: home, env: { ...process.env, AGENTCALL_HOME: home }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return { output, home };
};

function deniedInLog(home: string): boolean {
  try {
    return readFileSync(join(home, ".agentcall", "calls.log"), "utf8")
      .split("\n").filter(Boolean)
      .some((line) => { try { return JSON.parse(line).type === "tool_denied"; } catch { return false; } });
  } catch {
    return false;
  }
}

export async function checkGuard(probe: GuardProbeFn = defaultGuardProbe): Promise<VerifyCheck> {
  try {
    const { output, home } = await probe(guardSettingsJson());
    if (output.includes(GUARD_CANARY)) {
      return { name: "tool guard", ok: false,
               detail: "canary was readable — the guard is not in force", hint: GUARD_HINT };
    }
    // Absence of the canary proves nothing on its own: the model may have
    // declined to call Read, answered something unrelated, or failed. Require
    // positive evidence that the guard ran AND denied.
    return deniedInLog(home)
      ? { name: "tool guard", ok: true }
      : { name: "tool guard", ok: false,
          detail: "no denial was recorded — the guard did not run", hint: GUARD_HINT };
  } catch (e) {
    return { name: "tool guard", ok: false, detail: short(e),
             hint: "the guard probe could not run; check that `claude` resolves on the listener's PATH" };
  }
}
```

- [ ] **Step 4: Call it from doctor.ts**

In `packages/cli/src/doctor.ts`, add the seam to `DoctorDeps`:

```ts
  guardFn?: GuardProbeFn;
```

and import it alongside the existing verify imports:

```ts
import { checkGuard, checkRelaySelfCall, formatCheck, short, verifyAgent, type GuardProbeFn, type VerifyCheck, type VerifyFns } from "./verify.js";
```

Then in `runDoctor`, immediately after `const agentOk = agentChecks.every((c) => c.ok);` (line 98):

```ts
  // Claude-only: the guard is registered on claude spawns, and checkGuard
  // spawns claude to probe it. Gated on agentOk because probing through a
  // broken agent tests nothing.
  if (cfg.agent_kind === "claude" && agentOk) {
    report(await checkGuard(deps.guardFn));
  }
```

No exit-code change is needed: `report()` pushes into `checks`, and `runDoctor` already ends with `return checks.every((c) => c.ok) ? 0 : 1;`.

**Then close the CI hole this opens.** `test/doctor.test.ts` has five tests configured with `agent_kind: "claude"` and no `guardFn`. Without a stub they fall through to `defaultGuardProbe` and **spawn live `claude` in CI**, violating this plan's own constraint — they would hang, burn credentials, or fail depending on the machine. Add a passing stub to the shared deps those tests build:

```ts
  guardFn: async () => ({ output: "blocked", home: homeWithDenial() }),
```

reusing the same `homeWithDenial()` helper as `verify.test.ts` (lift it into a shared test helper if both files need it). Run `pnpm vitest run test/doctor.test.ts` and confirm no `claude` process is spawned — if a test hangs for more than a couple of seconds, a stub is missing.

- [ ] **Step 5: Document the Codex gap in README.md**

In the security section of `README.md`, add:

The wording matters — an earlier draft claimed every read reaching a credential path is
refused, which is false whenever a task grants `exec`. Say what is actually delivered:

```markdown
**Tool guard.** Tool calls a caller's agent makes on your machine are checked before
they run. File reads, writes, searches, and listings that reach credential paths
(`~/.ssh`, `~/.aws`, `.env`, Keychains, `~/.agentcall`, `~/.claude`) are refused, and
every tool call reaching the guard is recorded to `~/.agentcall/tools.log`.
`agentcall doctor` verifies the guard is in force.

Two limits, stated plainly:

- **A task that grants `exec` has no read floor.** Shell commands are recorded, not
  blocked — pattern-matching a command string is too weak to be a boundary and too
  eager to be harmless. The control on `exec` is which tasks you choose to write.
- **Claude answering agents only.** Codex has no equivalent hook wired yet, so a Codex
  answering agent has no read guard at all; its `--sandbox` level confines writes but
  not reads.
```

- [ ] **Step 6: Run everything**

Run from the repo root: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/cli/src/verify.ts packages/cli/src/doctor.ts packages/cli/test/verify.test.ts README.md
git commit -m "feat(guard): doctor canary check, and state the Codex gap in the README"
```

---

## After the plan

Open question 4 in the spec is unresolved and is **not** covered by these tasks: every experiment so far exercised one tool call at a time, and Copilot's fail-open bug is specifically a parallel one. Before treating the guard as trustworthy, run a manual probe that induces several concurrent tool calls (a prompt that reads four files at once) and confirm `tools.log` contains one line per call with none missing.

The spec's `ConfigChange` hook — layer 4 — is a separate, cheap follow-on. The `~/.claude/**` read denial in Task 1 overlaps its territory but does not replace it: it stops reads, not writes made through other means.
