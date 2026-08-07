// What an answering agent may read. Who gets answered lives in access.ts.
//
// **Inverted 2026-08-07 (#412).** This replaced a label model — every source
// carried `shared`/`secret`, unlabelled meant secret — with two facts:
//
//   1. a ROOT the agent may read under ($HOME by default), and
//   2. a DENYLIST of paths that are never readable, whatever the roots say.
//
// The label model needed four different mechanisms to say "this is secret" (the
// map, a non-overridable floor, a carve-out through the floor, and a basename
// denylist in guard.ts) plus an inverted default for skills, and it still
// required `setup` to write a seed file whose whole content said "you may read
// your own home directory" — a file that existed to undo a default.
//
// **What this gives up is real and is not hidden.** The failure mode of a
// half-configured line is now a leak rather than a refusal: a new source type
// is readable the day it ships, a directory acquired next week is in scope
// without anyone deciding so, and the denylist can never be complete. See
// docs/superpowers/specs/2026-08-07-invert-the-default-design.md, which records
// the conditions under which this is the wrong call.
//
// The root is what makes it defensible at all — /etc, /var, other users' homes
// and mounted volumes stay out without appearing on any list. Without a root
// this is not a simplification, it is `/`.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonical, expandHome, fold, isInside } from "./path-canon.js";
import type { LinePaths } from "./paths.js";

export const ScopeSchema = z.object({
  /** Directories the agent may read under. Anything outside every root is refused. */
  roots: z.array(z.string().min(1)).default([]),
  /** Extra paths the owner never wants answered from. Added to the built-in denylist. */
  denied: z.array(z.string().min(1)).default([]),
}).strict();

export type Scope = z.infer<typeof ScopeSchema>;

/** No roots means nothing is readable. This is the misconfiguration path, not "allow all". */
export const DEFAULT_SCOPE: Scope = { roots: [], denied: [] };

// Home-relative paths that are denied no matter what the owner's roots say.
// Adding `~` or even `~/.ssh` as a root does not make these readable — that is
// what makes this a floor rather than a starting point.
//
// Location, not format, is what generalizes: ~/.aws/credentials is denied
// regardless of what shape AWS chooses for a key, and a credential store for a
// service nobody has heard of is denied the moment its directory is named.
// See #410/#411, closed by decision, for the evidence and the known gaps.
const DENIED_DIRS = [
  ".ssh", ".gnupg", ".aws", ".config/gcloud", "Library/Keychains",
  ".agentcall",             // holds config.json and the relay token
  ".claude",                // executable configuration; cf. CVE-2025-59536
  ".codex",                 // auth.json, plus a config.toml that routinely holds API keys
  "Library/LaunchAgents",   // how the listener itself gets launched
  ".config/systemd/user",   // Linux user units can replace the listener command
];

const DENIED_FILES = [
  ".netrc", ".npmrc", ".docker/config.json", ".claude.json",
  // Shell startup files: sourced on every new shell, so writing one is a
  // persistence mechanism as durable as a LaunchAgent.
  ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile",
];

// Narrower than a DENIED_DIRS entry, so longest-prefix wins and these stay
// readable. ~/.claude is denied for an INTEGRITY reason — settings and hooks
// being *written* — which does not apply to a skill's markdown being *read*.
//
// Without this a skill's `references/*.md` are refused and any skill that uses
// them breaks. The SKILL.md body is unaffected either way: it reaches the model
// with no tool call at all, so no rule here ever sees it (measured, see
// docs/research/2026-08-06-skill-and-mcp-guard-reachability.md).
const ALLOWED_EXCEPTIONS = [".claude/skills"];

// Denied by NAME anywhere under a root — the one entry shape a prefix rule
// cannot express. `.env.example` and friends are deliberately excluded: they
// are not secrets, and denying them is a false positive that teaches owners to
// widen the roots.
const DENIED_BASENAMES: RegExp[] = [
  /^\.env$/,
  /^\.env\.(?!example$|sample$|template$)/,
  /^id_rsa$/, /^id_ed25519$/, /^id_ecdsa$/,
  /\.pem$/, /\.p12$/, /\.pfx$/,
];

// Missing file -> the fresh-install default. Malformed file -> THROW.
//
// A silent fallback would mean the owner's scope stopped applying without
// anyone being told, and under this model that widens rather than narrows.
export function loadScope(p: LinePaths): Scope {
  let raw: string;
  try {
    raw = readFileSync(p.scopeFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SCOPE;
    throw new Error(`scope is unreadable: ${String(error)}`, { cause: error });
  }
  try {
    return ScopeSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`scope is invalid: ${String(error)}`, { cause: error });
  }
}

/** The scope `setup` writes for a new line: the owner's home, and nothing else declared. */
export function defaultScope(home?: string): Scope {
  return home === undefined ? DEFAULT_SCOPE : { roots: [resolve(home)], denied: [] };
}

export interface ScopeOpts {
  home: string;
  cwd: string;
  realpath: (p: string) => string;
}

/**
 * May the agent read this path?
 *
 * Inside a root AND not denied. Both checks run on the CANONICAL path, which is
 * the whole reason a symlink cannot be used to escape: a link out of a root
 * resolves to a path that is outside every root, and a link into ~/.ssh
 * resolves to a denied one. Checking the root lexically would turn this model
 * into an escape hatch worse than anything the label model allowed.
 */
export function isReadable(scope: Scope, target: string, opts: ScopeOpts): boolean {
  const canon = (p: string) => canonical(expandHome(p, opts.home), opts.cwd, opts.home, opts.realpath);
  const path = canon(target);

  if (DENIED_BASENAMES.some((re) => re.test(fold(basename(path))))) return false;

  const inside = (roots: readonly string[]) =>
    roots.map((r) => canon(r)).filter((r) => isInside(path, r));

  // Longest match wins, so a narrower ALLOWED_EXCEPTIONS entry beats the
  // DENIED_DIRS entry it sits inside.
  const denied = inside([
    ...DENIED_DIRS.map((d) => join(opts.home, d)),
    ...DENIED_FILES.map((f) => join(opts.home, f)),
    ...scope.denied,
  ]);
  const excepted = inside(ALLOWED_EXCEPTIONS.map((e) => join(opts.home, e)));
  const longestDenied = Math.max(-1, ...denied.map((d) => d.length));
  const longestExcepted = Math.max(-1, ...excepted.map((e) => e.length));
  if (longestDenied > longestExcepted) return false;

  return inside(scope.roots).length > 0;
}

/**
 * The roots this caller may be told about, shortest first.
 *
 * Safe to put in a prompt: a root is a directory the owner declared readable,
 * so naming one discloses nothing the agent could not already read from.
 * Non-existent roots are skipped rather than fatal — one stale entry must not
 * take a line offline.
 */
export function readableRoots(scope: Scope, home: string = homedir()): string[] {
  return scope.roots
    .map((p) => expandHome(p, home))
    .filter((p) => isAbsolute(p))
    .filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Where to spawn the agent: the first readable root, or the caller's fallback. */
export function workdirFor(scope: Scope, fallbackDir: string, home?: string): string {
  return readableRoots(scope, home)[0] ?? fallbackDir;
}

/**
 * Every denied path, canonicalized, for the checks that cannot ask about one
 * target file.
 *
 * A scan (`Grep`, `Glob`, `LS`) reads everything beneath its root in ONE tool
 * call, so the hook never sees the individual files and a root that merely
 * *contains* something denied has to be refused outright. The Bash branch
 * matches this list as text, which is why both the literal `~/.aws` form and
 * the resolved form are returned — a command carries the former, a path
 * comparison needs the latter.
 */
export function deniedRoots(
  scope: Scope, home: string, realpath: (p: string) => string,
): string[] {
  const lexical = [
    ...DENIED_DIRS.map((d) => join(home, d)),
    ...DENIED_FILES.map((f) => join(home, f)),
    ...scope.denied.map((d) => expandHome(d, home)),
  ].map((p) => resolve(p));
  return [...new Set([...lexical, ...lexical.map((d) => canonical(d, home, home, realpath))])];
}

/** Denied by name, for selectors that are patterns rather than real paths. */
export function deniedBasename(p: string): boolean {
  return DENIED_BASENAMES.some((re) => re.test(fold(basename(p))));
}
