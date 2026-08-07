import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lineTaskDirs } from "./line-task-dirs.js";
import { canonical, expandHome, fold, isAncestorOf, isInside } from "./path-canon.js";
import { getMachinePaths, type LinePaths } from "./paths.js";
import { deniedBasename, deniedRoots, isReadable, type Scope } from "./scope.js";

export type GuardInput = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
};

// `rule` and `detail` are audit-only. They name the matched rule and the
// resolved path, and MUST NOT reach permissionDecisionReason — the caller-facing
// reason is DENY_REASON, a fixed string with no per-denial content. See the
// reason contract in the design spec.
type GuardVerdict =
  | { allow: true; flag?: { rule: string; detail: string } }
  | { allow: false; rule: string; detail: string };

// Caller-facing. One sentence, no path, no rule name. Under test.
export const DENY_REASON =
  "This action is not permitted by the answering agent's policy.";

// Written to stderr on every exit-2 path. Claude blocks on exit 2 regardless
// of stderr; codex blocks on exit 2 ONLY when stderr carries a reason, and
// treats an empty one as a failed hook — which runs the tool. So the text
// below is what keeps the fail-closed paths closed on both runtimes. Same
// contract as DENY_REASON: no path, no rule name.
export const FAIL_CLOSED_REASON =
  "The answering agent's policy guard could not evaluate this action.";

// The home-relative paths that used to live here as DENIED_DIRS/DENIED_FILES
// now live in sensitivity.ts as the non-overridable `secret` floor
// (builtinSecretSources/withFloor). They are the same paths; expressing them as
// sensitivity rules rather than a second parallel denylist is what lets
// longest-prefix-wins protect them even when an owner labels a parent
// directory. AgentCall/<line>/tasks still has no fixed home-relative form and
// is passed in per call — see runGuard's extraSecretRoots.

// This module compiles to <package root>/dist/guard.js, one directory below
// the installed package root — true both for a global npm install and for a
// dev checkout run from the monorepo. Computed once at module scope:
// import.meta.url is fixed for the process lifetime, so this is a constant,
// not I/O, and decide() stays a pure function of its arguments even though
// this value flows in as a default. Overridable via the `guardRoot` param so
// tests can assert against a synthetic root instead of the machine's real one.
const DEFAULT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Every tool the envelope can grant (see CLAUDE_TOOLS in runner.ts). A tool
// absent from all four groups is DENIED, not allowed: an unclassified tool has
// an argument shape this function cannot inspect. `LS` was missed exactly that
// way in an earlier draft and fell through to allow.
const EXACT_TARGET: Record<string, string> = {
  Read: "file_path", Write: "file_path", Edit: "file_path", NotebookEdit: "notebook_path",
};
// Tools whose `path` argument names a root that is then searched or listed.
// `Glob` joins them below: its root is implicit, but it is checked the same way.
const SCANNING_ROOT = new Set(["Grep", "LS"]);
// Tools with no filesystem argument at all. WebFetch is checked separately
// below, not included here: its `url` can itself be a filesystem path via a
// `file://` scheme, so it gets its own scheme check rather than a blanket allow.
const NO_PATH_SURFACE = new Set(["WebSearch"]);
// A glob selector is a path in disguise, and the root check never sees it:
// Grep narrows its root with `glob`, Glob carries its whole path in `pattern`.
// Both can name a denied basename under an otherwise permitted root, and both
// can climb out of that root entirely. LS has no selector.
const SELECTOR_KEY: Record<string, string> = { Grep: "glob", Glob: "pattern" };

// Everything before the first magic character, trimmed back to a directory.
// Glob carries its path inside `pattern`, so "/Users/o/.ssh/*" must be checked
// even when `path` is absent entirely.
function globLiteralPrefix(pattern: string): string {
  const magic = pattern.search(/[*?[{]/);
  const head = magic === -1 ? pattern : pattern.slice(0, magic);
  const cut = head.lastIndexOf(sep);
  return cut === -1 ? "" : head.slice(0, cut) || sep;
}

// A context object rather than positional arguments. The previous signature
// carried a warning that swapping parameters 5 and 6 "silently explodes a path
// into single-character denied roots rather than failing loudly" — a hazard
// that only existed because two differently-shaped restrictions sat adjacent in
// a positional list. Naming them removes the hazard instead of documenting it.
export interface DecideContext {
  /** userHome, never a redirectable state root: AGENTCALL_HOME can move the
   *  latter, which would have the guard diligently protecting a temp directory
   *  while the real ~/.ssh stood open. */
  userHome: string;
  realpath: (p: string) => string;
  /** What this line may read: roots plus the denylist. */
  scope: Scope;
  guardRoot?: string;
  /** Paths that are `secret` for this run regardless of the map — the guard's
   *  own package root and every line's tasks directory. */
  extraSecretRoots?: string[];
}

export function decide(input: GuardInput, ctx: DecideContext): GuardVerdict {
  const { userHome, realpath } = ctx;
  const { tool_name: tool, tool_input: args, cwd } = input;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { allow: false, rule: "unparseable-input", detail: tool };
  }
  const canon = (p: string) => canonical(p, cwd, userHome, realpath);
  const scope: Scope = {
    ...ctx.scope,
    denied: [
      ...ctx.scope.denied,
      ctx.guardRoot ?? DEFAULT_PACKAGE_ROOT,
      ...(ctx.extraSecretRoots ?? []),
    ],
  };

  // Readable = inside a root and not denied. Both on the canonical path, so a
  // symlink cannot be used to leave a root or enter the denylist.
  const unreachable = (target: string) =>
    !isReadable(scope, target, { home: userHome, cwd, realpath });

  const denied = deniedRoots(scope, userHome, realpath);

  // A scan reads every file beneath its root in ONE tool call, so the hook
  // never sees the individual files. A root that merely contains something
  // unreachable must therefore be refused outright.
  const scanReachesSecret = (root: string) =>
    denied.find((d) => isInside(root, d) || isAncestorOf(root, d));
  const targetInsideSecret = (target: string) => denied.find((d) => isInside(target, d));

  if (tool === "Bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const hit = denied.find((d) =>
      fold(command).includes(fold(d)) || fold(command).includes(fold(d.replace(userHome, "~"))));
    // Record and allow: string matching is too weak to be a boundary and too
    // eager to be harmless. See the spec's Bash section — and note this means
    // an `exec`-granted task has NO read floor.
    return hit ? { allow: true, flag: { rule: "bash-references-denied-path", detail: hit } } : { allow: true };
  }

  if (NO_PATH_SURFACE.has(tool)) return { allow: true };

  // Skills are dispatched by NAME, and under #412 there is no per-name label to
  // check: a skill's own files sit under a root (or under the ~/.claude/skills
  // exception) and its reads — references/, Read, Grep — arrive here as ordinary
  // tool calls checked like any other. Withholding one now means denying its
  // directory, not labelling its name.
  //
  // Kept as its own named branch rather than an entry in NO_PATH_SURFACE so the
  // reason is visible. `--allowedTools` does not gate Skill at all (measured
  // 2026-08-06), so this deliberate allow is what makes it reachable; the
  // unclassified-tool deny below is what held it closed before.
  if (tool === "Skill") return { allow: true };

  // WebFetch's `url` is safe to allow unread only if Claude Code itself
  // rejects a non-http(s) scheme before this hook fires — an unstated
  // external assumption a floor should not rest on. `file://…` would read
  // the local filesystem through a tool this function otherwise never checks.
  if (tool === "WebFetch") {
    const url = args.url;
    const ok = typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"));
    return ok ? { allow: true } : { allow: false, rule: "unparseable-url", detail: tool };
  }

  const key = EXACT_TARGET[tool];
  if (key !== undefined) {
    const raw = args[key];
    // Fail closed: a path-shaped tool with no usable path is not understood.
    if (typeof raw !== "string" || raw === "") return { allow: false, rule: "unparseable-target", detail: String(raw) };
    const target = canon(raw);
    if (deniedBasename(target)) return { allow: false, rule: "denied-basename", detail: target };
    const hit = targetInsideSecret(target);
    // Distinct from `above-clearance` on purpose, and both are audit-only. This
    // one means "inside a source you labelled above this caller's clearance";
    // the other means "classified above it", which is usually the unlabelled
    // default. Debugging a map is far easier when those two read differently.
    if (hit) return { allow: false, rule: "inside-unreachable-source", detail: target };
    return unreachable(target)
      ? { allow: false, rule: "source-is-secret", detail: target }
      : { allow: true };
  }

  if (SCANNING_ROOT.has(tool) || tool === "Glob") {
    // Fail closed: a `path` that is present but not a string must not
    // silently fall back to cwd. The branches on either side of this one
    // already fail closed on an unparseable shape; this closes the gap
    // between them.
    if ("path" in args && typeof args.path !== "string") {
      return { allow: false, rule: "unparseable-root", detail: tool };
    }
    const rawRoot = typeof args.path === "string" && args.path !== "" ? args.path : cwd;
    const root = canon(rawRoot);
    if (deniedBasename(root)) return { allow: false, rule: "denied-basename", detail: root };
    if (scanReachesSecret(root)) return { allow: false, rule: "root-reaches-denied-path", detail: root };
    if (unreachable(root)) return { allow: false, rule: "source-is-secret", detail: root };

    const selectorKey = SELECTOR_KEY[tool];
    const selector = selectorKey === undefined ? undefined : args[selectorKey];
    if (selector === undefined) {
      // LS has no selector, and for Grep an absent one only means "the whole
      // root", which the check above already cleared. Glob is different: its
      // `pattern` IS the path — there is no root check to fall back on — so
      // an absent pattern is unparseable, not "search everything".
      if (tool === "Glob") return { allow: false, rule: "unparseable-selector", detail: tool };
      return { allow: true };
    }
    // Fail closed on a shape this function cannot read, as with an exact target.
    if (typeof selector !== "string") return { allow: false, rule: "unparseable-selector", detail: tool };
    // A selector that climbs out of its root defeats a root-only check.
    if (selector.split("/").includes("..")) return { allow: false, rule: "escaping-pattern", detail: selector };
    // "**/.env" and "**/*.pem" enumerate denied basenames under a permitted root.
    if (deniedBasename(selector)) return { allow: false, rule: "denied-basename-pattern", detail: selector };
    const prefix = globLiteralPrefix(selector);
    if (prefix === "") return { allow: true };
    const selectorRoot = canon(isAbsolute(expandHome(prefix, userHome)) ? prefix : join(rawRoot, prefix));
    const hit = scanReachesSecret(selectorRoot);
    if (hit) return { allow: false, rule: "root-reaches-denied-path", detail: selectorRoot };
    return unreachable(selectorRoot)
      ? { allow: false, rule: "source-is-secret", detail: selectorRoot }
      : { allow: true };
  }

  // Unclassified tool. Deny — an argument shape this function has never seen
  // cannot be inspected, and allowing it is how LS became a hole.
  return { allow: false, rule: "unclassified-tool", detail: tool };
}

export interface GuardDeps {
  line: LinePaths;
  callId: string;
  correlationId?: string;
  now: () => string;
  realpath: (p: string) => string;
  appendLine: (file: string, line: string) => void;
  /** What this line may read: roots plus the denylist. */
  scope: Scope;
}

type GuardOutput = { exitCode: number; stdout: string; stderr: string };

const ALLOW: GuardOutput = { exitCode: 0, stdout: "", stderr: "" };
const FAIL_CLOSED: GuardOutput = { exitCode: 2, stdout: "", stderr: FAIL_CLOSED_REASON };

// calls.log stays sparse and owner-facing; tools.log carries every call so the
// audit-trail claim is true. A denial appears in both.
export function runGuard(raw: string, deps: GuardDeps): GuardOutput {
  const onFailure = FAIL_CLOSED;

  let input: GuardInput;
  try {
    const parsed = JSON.parse(raw) as Partial<GuardInput>;
    if (typeof parsed.tool_name !== "string" || parsed.tool_name === "") throw new Error("no tool_name");
    input = {
      tool_name: parsed.tool_name,
      tool_input: (parsed.tool_input ?? {}) as Record<string, unknown>,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : deps.line.machine.userHome,
    };
  } catch {
    // Exit 2 blocks bluntly. The guard never allows because it failed to decide.
    return onFailure;
  }

  // EVERYTHING below is inside the failure boundary, including the log writes.
  // An exception escaping this function exits the process 1, and Claude treats
  // any exit other than 0 or 2 as a non-blocking error — so a full disk or a
  // read-only home would silently turn the guard off. Fail closed instead.
  try {
    // Task frontmatter declares which sources a task may read, so it is as
    // sensitive as policy.json. Under the per-line layout these live at
    // ~/AgentCall/<line>/tasks, which no fixed home-relative rule can match —
    // enumerate them instead. Every line's, not just this one's: one line's
    // agent must not rewrite another line's tasks either. lineTaskDirs, not
    // listLines: this runs on every tool call, and listLines readFileSync's
    // and zod-parses every line's config.json just to build a LineSummary
    // this call only ever wants the tasksDir out of.
    //
    // Enumerated from a machine rooted at userHome — NOT deps.line.machine as
    // given: deps.line.machine.linesDir sits under stateRoot, the exact
    // AGENTCALL_HOME-redirectable value defect (a) exists to keep out of
    // decide(). Passing deps.line.machine through unchanged would enumerate
    // an empty (or nonexistent) redirected state dir, silently deny nothing,
    // and leave the real machine's per-line task directories wide open —
    // defect (a) fixed for .ssh and quietly reopened for tasks.
    const userHome = deps.line.machine.userHome;
    const taskRoots = lineTaskDirs(getMachinePaths(userHome, userHome));
    const verdict = decide(input, {
      userHome,
      realpath: deps.realpath,
      scope: deps.scope,
      extraSecretRoots: taskRoots,
    });
    const ts = deps.now();
    const correlation = deps.correlationId
      ? { correlation_id: deps.correlationId }
      : {};
    const write = (file: string, obj: Record<string, unknown>) =>
      deps.appendLine(file, JSON.stringify({ ts, ...obj }));

    // PreToolUse fires on what the model ATTEMPTED. In enforce mode this
    // function's own verdict is the outcome, so `allowed` is a fact. In
    // observe mode it is not: the tool proceeds regardless of the verdict, and
    // may still be stopped downstream by codex's sandbox. Recording `allowed`
    // there would assert an outcome this hook never sees.
    write(deps.line.toolsLog,
      { type: "tool_call", call_id: deps.callId, ...correlation, tool: input.tool_name, allowed: verdict.allow });

    const noteworthy = verdict.allow ? verdict.flag : verdict;
    if (noteworthy) {
      write(deps.line.callsLog, {
        // Three distinct names, because they are three distinct claims:
        // denied = we stopped it; flagged = we let it through and noticed.
        type: verdict.allow ? "tool_flagged" : "tool_denied",
        call_id: deps.callId, ...correlation, tool: input.tool_name,
        rule: noteworthy.rule, detail: noteworthy.detail,
      });
    }

    if (verdict.allow) return ALLOW;
    return {
      exitCode: 0,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: DENY_REASON,
        },
      }),
      stderr: "",
    };
  } catch {
    return onFailure;
  }
}
