import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Paths } from "./paths.js";

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
