import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { lineTaskDirs } from "./lineTaskDirs.js";
import { getMachinePaths, type LinePaths } from "./paths.js";

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

// Written to stderr on every exit-2 path. Claude blocks on exit 2 regardless
// of stderr; codex blocks on exit 2 ONLY when stderr carries a reason, and
// treats an empty one as a failed hook — which runs the tool. So the text
// below is what keeps the fail-closed paths closed on both runtimes. Same
// contract as DENY_REASON: no path, no rule name.
export const FAIL_CLOSED_REASON =
  "The answering agent's policy guard could not evaluate this action.";

// `enforce` blocks; `observe` records and always allows.
//
// The codex spawn runs in `observe`. The guard is not codex's read boundary —
// codex reaches the filesystem through `Bash` (`sed -n '1,200p' file`), which
// this module deliberately records rather than blocks, so enforcing here would
// buy no protection. It would, however, deny every codex tool `decide()` cannot
// classify (`apply_patch` and friends) and break the runtime. Codex's own
// kernel-enforced `deny_read` is the boundary there.
export type GuardMode = "enforce" | "observe";

// Home-relative directories. Everything beneath them is denied.
const DENIED_DIRS = [
  ".ssh", ".gnupg", ".aws", ".config/gcloud", "Library/Keychains",
  ".agentcall",   // holds config.json and the relay token
  ".claude",      // executable configuration; cf. CVE-2025-59536
  ".codex",       // auth.json, plus a config.toml that routinely holds API keys
  "Library/LaunchAgents",  // how the listener itself gets launched
  // Legacy flat layout. As of Task 12, nothing in this codebase reads or
  // writes this path anymore — card.ts, index.ts, and lint.ts all moved to
  // the per-line AgentCall/<line>/tasks layout, and setup.ts no longer
  // creates it. It stays denied because it may still exist on disk, holding
  // real SKILL.md files from an install made before Task 12: a stale entry
  // over-denies (fails safe), while removing it would leave genuine content
  // from a previous install unprotected. The per-line entries below cover
  // AgentCall/<line>/tasks; this covers the pre-multi-line AgentCall/tasks
  // that may still be sitting there regardless. This is also the reason
  // "tasks" and "public" are reserved line names — see RESERVED_LINE_NAMES in
  // lineName.ts for the other half of this.
  "AgentCall/tasks",
  // AgentCall/<line>/tasks, one directory per line, has no single
  // home-relative entry that can name them all — see runGuard, which
  // enumerates every line's tasksDir and passes it in as an extra denied
  // root, alongside this legacy path.
];

// Home-relative single files.
const DENIED_FILES = [
  ".netrc", ".npmrc", ".docker/config.json", ".claude.json",
  // Shell startup files: sourced on every new shell, so writing one is a
  // persistence mechanism as durable as a LaunchAgent.
  ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile",
];

// This module compiles to <package root>/dist/guard.js, one directory below
// the installed package root — true both for a global npm install and for a
// dev checkout run from the monorepo. Computed once at module scope:
// import.meta.url is fixed for the process lifetime, so this is a constant,
// not I/O, and decide() stays a pure function of its arguments even though
// this value flows in as a default. Overridable via the `guardRoot` param so
// tests can assert against a synthetic root instead of the machine's real one.
const DEFAULT_PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

// package.json pins os: ["darwin"], and the default macOS filesystem is
// case-INsensitive — ~/.SSH opens ~/.ssh. Folding can over-deny on a
// case-sensitive volume, which is the safe direction for a floor.
const fold = (p: string) => p.toLowerCase();

// Denied roots are canonicalized alongside the targets they get compared with.
// A denied root can itself be a symlink — ~/.aws onto an encrypted volume — and
// a canonical target is never "inside" a lexical alias, so comparing the two
// silently allows the read. Both forms are kept: the Bash branch matches this
// list as text, where the literal ~/.aws is the form that appears in a command.
// `extraRoots` are already absolute (the guard's own package root, not
// home-relative) and are canonicalized the same way as the home-relative
// table, for the same symlink reason.
function deniedPaths(home: string, realpath: (p: string) => string, extraRoots: string[]): string[] {
  const lexical = [...DENIED_DIRS, ...DENIED_FILES].map((d) => resolve(home, d));
  const roots = [...lexical, ...extraRoots];
  return [...new Set([...roots, ...roots.map((d) => canonical(d, home, home, realpath))])];
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
  userHome: string,
  realpath: (p: string) => string,
  guardRoot: string = DEFAULT_PACKAGE_ROOT,
  // Two orthogonal restrictions, and both apply. `allowedRoot` confines a task
  // to one workdir (an allow-list); `extraDeniedRoots` adds paths that are
  // denied wherever they sit (a deny-list). allowedRoot keeps position 5
  // because its callers pass it positionally in quantity; extraDeniedRoots is
  // 6th. Do not swap them — allowedRoot is a string and extraDeniedRoots is
  // spread, so passing one where the other is expected silently explodes a
  // path into single-character denied roots rather than failing loudly.
  allowedRoot?: string,
  extraDeniedRoots: string[] = [],
): GuardVerdict {
  const { tool_name: tool, tool_input: args, cwd } = input;
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { allow: false, rule: "unparseable-input", detail: tool };
  }
  // userHome, never a redirectable state root: AGENTCALL_HOME can move the
  // latter, which would have the guard diligently protecting a temp directory
  // while the real ~/.ssh stood open.
  const denied = deniedPaths(userHome, realpath, [guardRoot, ...extraDeniedRoots]);
  const canon = (p: string) => canonical(p, cwd, userHome, realpath);
  const allowed = allowedRoot === undefined ? undefined : canon(allowedRoot);
  const outsideAllowed = (target: string) => allowed !== undefined && !isInside(target, allowed);
  const reached = (t: string, withAncestors: boolean) =>
    denied.find((d) => isInside(t, d) || (withAncestors && isAncestorOf(t, d)));

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
    if (basenameDenied(target)) return { allow: false, rule: "denied-basename", detail: target };
    const hit = reached(target, false);
    if (hit) return { allow: false, rule: "inside-denied-path", detail: target };
    return outsideAllowed(target)
      ? { allow: false, rule: "outside-allowed-root", detail: target }
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
    if (basenameDenied(root)) return { allow: false, rule: "denied-basename", detail: root };
    if (reached(root, true)) return { allow: false, rule: "root-reaches-denied-path", detail: root };
    if (outsideAllowed(root)) return { allow: false, rule: "outside-allowed-root", detail: root };

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
    if (basenameDenied(selector)) return { allow: false, rule: "denied-basename-pattern", detail: selector };
    const prefix = globLiteralPrefix(selector);
    if (prefix === "") return { allow: true };
    const selectorRoot = canon(isAbsolute(expandHome(prefix, userHome)) ? prefix : join(rawRoot, prefix));
    const hit = reached(selectorRoot, true);
    if (hit) return { allow: false, rule: "root-reaches-denied-path", detail: selectorRoot };
    return outsideAllowed(selectorRoot)
      ? { allow: false, rule: "outside-allowed-root", detail: selectorRoot }
      : { allow: true };
  }

  // Unclassified tool. Deny — an argument shape this function has never seen
  // cannot be inspected, and allowing it is how LS became a hole.
  return { allow: false, rule: "unclassified-tool", detail: tool };
}

export interface GuardDeps {
  line: LinePaths;
  callId: string;
  now: () => string;
  realpath: (p: string) => string;
  appendLine: (file: string, line: string) => void;
  allowedRoot?: string;
}

export type GuardOutput = { exitCode: number; stdout: string; stderr: string };

const ALLOW: GuardOutput = { exitCode: 0, stdout: "", stderr: "" };
const FAIL_CLOSED: GuardOutput = { exitCode: 2, stdout: "", stderr: FAIL_CLOSED_REASON };

// calls.log stays sparse and owner-facing; tools.log carries every call so the
// audit-trail claim is true. A denial appears in both.
export function runGuard(raw: string, deps: GuardDeps, mode: GuardMode = "enforce"): GuardOutput {
  // In observe mode the guard is telemetry, not a boundary, so a failure to
  // decide must not cost availability — there is nothing to fail closed *to*.
  const onFailure = mode === "observe" ? ALLOW : FAIL_CLOSED;

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
    // Task frontmatter sets the envelope's caps verbatim, so it is as
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
    const verdict = decide(input, userHome, deps.realpath, undefined, deps.allowedRoot, taskRoots);
    const ts = deps.now();
    const write = (file: string, obj: Record<string, unknown>) =>
      deps.appendLine(file, JSON.stringify({ ts, ...obj }));

    // PreToolUse fires on what the model ATTEMPTED. In enforce mode this
    // function's own verdict is the outcome, so `allowed` is a fact. In
    // observe mode it is not: the tool proceeds regardless of the verdict, and
    // may still be stopped downstream by codex's sandbox. Recording `allowed`
    // there would assert an outcome this hook never sees.
    write(deps.line.toolsLog, mode === "observe"
      ? { type: "tool_call", call_id: deps.callId, tool: input.tool_name, mode }
      : { type: "tool_call", call_id: deps.callId, tool: input.tool_name, allowed: verdict.allow });

    const noteworthy = verdict.allow ? verdict.flag : verdict;
    if (noteworthy) {
      write(deps.line.callsLog, {
        // Three distinct names, because they are three distinct claims:
        // denied = we stopped it; flagged = we let it through and noticed;
        // attempt_flagged = we only ever watched.
        type: mode === "observe" ? "tool_attempt_flagged" : verdict.allow ? "tool_flagged" : "tool_denied",
        call_id: deps.callId, tool: input.tool_name,
        rule: noteworthy.rule, detail: noteworthy.detail,
      });
    }

    if (mode === "observe" || verdict.allow) return ALLOW;
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
