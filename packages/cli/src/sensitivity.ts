// The sensitivity half of #372: what a source is, independent of who is asking.
// The clearance half — who may receive what — lives in policy.ts.
//
// This replaces three overlapping mechanisms (the capability envelope,
// guard.ts's denylist, and AGENTCALL_ALLOWED_ROOT) with one question asked of
// every source: how sensitive is it. Everything not named is `secret`, so the
// failure mode of an unconfigured or half-configured line is a refusal to
// answer rather than a leak — which is what makes a generous default safe.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { canonical, expandHome, isInside } from "./path-canon.js";
import type { LinePaths } from "./paths.js";

// Two states, not a lattice. `shared` may reach any caller the line answers at
// all; `secret` never leaves this machine.
//
// This replaced `public < internal < secret` on 2026-08-07. The middle level had
// no producer — nothing in the CLI ever labelled a source `public` — while the
// ordering it implied caused a real bug: the seed labelled $HOME `internal`
// while the default clearance was `public`, so the "open" default opened
// nothing. A three-level order was also encoding two different questions at once
// (how sensitive is this, and whose is it), which is the shape
// docs/superpowers/specs/2026-08-07-open-default-design.md records as
// known-insufficient. Who may call is now a separate yes/no in clearance.ts.
export const SENSITIVITIES = ["shared", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

// Unlabelled means secret. This constant exists so the default is stated once
// and cannot drift between the classifiers below.
export const DEFAULT_SENSITIVITY: Sensitivity = "secret";

const SensitivitySchema = z.enum(SENSITIVITIES);

export const SensitivityMapSchema = z.object({
  sources: z.array(z.object({
    path: z.string().min(1),
    sensitivity: SensitivitySchema,
  })).default([]),
  skills: z.record(z.string(), SensitivitySchema).default({}),
}).strict();

export type SensitivityMap = z.infer<typeof SensitivityMapSchema>;

/** A fresh install: no sources named, so everything classifies `secret`. */
export const DEFAULT_SENSITIVITY_MAP: SensitivityMap = { sources: [], skills: {} };

// Missing file -> safe default (fresh install). Malformed file -> THROW.
//
// Same contract as loadUserPolicy, for the mirrored reason: there, a silent
// fallback would grant `ask` to a caller the owner blocked. Here the default is
// the restrictive end, so a fallback fails closed — but it would still mean the
// owner's map silently stopped applying, and a boundary that can disappear
// through a typo is not a boundary.
export function loadSensitivityMap(p: LinePaths): SensitivityMap {
  let raw: string;
  try {
    raw = readFileSync(p.sensitivityFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SENSITIVITY_MAP;
    throw new Error(`sensitivity map is unreadable: ${String(error)}`, { cause: error });
  }
  try {
    return SensitivityMapSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`sensitivity map is invalid: ${String(error)}`, { cause: error });
  }
}

/** Most restrictive of the inputs. No inputs is `shared` — an untouched run starts clean. */
export function combine(...values: Sensitivity[]): Sensitivity {
  return values.includes("secret") ? "secret" : "shared";
}

/**
 * May this content leave the machine?
 *
 * A function of the CONTENT alone. It used to take the caller's clearance too,
 * but with one grantable level there is nothing left to compare: a caller who
 * is not allowed never reaches a source at all, because `resolveAdmission`
 * refuses a blocked caller before any source is consulted (listener.ts). Passing
 * a single-valued parameter through a security boundary reads as a check that
 * is not happening, so it is gone.
 */
export function permits(content: Sensitivity): boolean {
  return content !== "secret";
}

export interface ClassifyOpts {
  home: string;
  cwd: string;
  realpath: (p: string) => string;
}

// Longest matching prefix wins, ties broken toward the more restrictive rule.
//
// Deliberately NOT first-match-wins, which is what the #373 spike harness used:
// under first-match, listing a broad `internal` root before a narrow `secret`
// carve-out silently shadows the carve-out. Ordering must never be able to
// widen access, because that failure is invisible in review.
export function classifyPath(
  map: SensitivityMap,
  target: string,
  opts: ClassifyOpts,
): Sensitivity {
  const canon = (p: string) => canonical(expandHome(p, opts.home), opts.cwd, opts.home, opts.realpath);
  const path = canon(target);

  let bestLength = -1;
  let best: Sensitivity = DEFAULT_SENSITIVITY;
  for (const source of map.sources) {
    const root = canon(source.path);
    if (!isInside(path, root)) continue;
    if (root.length > bestLength) {
      bestLength = root.length;
      best = source.sensitivity;
    } else if (root.length === bestLength) {
      best = combine(best, source.sensitivity);
    }
  }
  return best;
}

// Home-relative paths that are `secret` no matter what the owner's map says.
// These are guard.ts's DENIED_DIRS and DENIED_FILES, carried over verbatim.
//
// They exist as sensitivity rules rather than as a second, parallel denylist
// because "unlabelled is secret" alone does not cover them: an owner who labels
// `~` internal would otherwise classify ~/.ssh/id_rsa as internal. Expressed as
// rules, longest-prefix-wins protects them automatically, and the
// most-restrictive tie-break makes the floor non-overridable from the map.
const FLOOR_DIRS = [
  ".ssh", ".gnupg", ".aws", ".config/gcloud", "Library/Keychains",
  ".agentcall",             // holds config.json and the relay token
  ".claude",                // executable configuration; cf. CVE-2025-59536
  ".codex",                 // auth.json, plus a config.toml that routinely holds API keys
  "Library/LaunchAgents",   // how the listener itself gets launched
  ".config/systemd/user",   // Linux user units can replace the listener command
];

const FLOOR_FILES = [
  ".netrc", ".npmrc", ".docker/config.json", ".claude.json",
  // Shell startup files: sourced on every new shell, so writing one is a
  // persistence mechanism as durable as a LaunchAgent.
  ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile",
];

// Carved back OUT of the floor above, by longest-prefix-wins.
//
// ~/.claude is `secret` for an INTEGRITY reason — "executable configuration; cf.
// CVE-2025-59536" — which is about settings.json and hooks being *written*. A
// skill's SKILL.md is inert markdown, and reading it is not that threat.
//
// The carve-out is safe because of a measured asymmetry: everything a skill
// *does* passes through this guard as ordinary tool calls — its references/ come
// in as `Read` with full paths, and its Read/Grep/Glob/LS are checked like any
// other. Only the SKILL.md body reaches the model with no tool call of its own.
// So the exposure from enabling skills is bounded to that skill's own prose.
// An MCP server has no such bound, which is why it gets no carve-out.
// Measured in docs/research/2026-08-06-skill-and-mcp-guard-reachability.md.
const FLOOR_CARVEOUTS: readonly { path: string; sensitivity: Sensitivity }[] = [
  { path: ".claude/skills", sensitivity: "shared" },
];

export function builtinSecretSources(home: string): SensitivityMap["sources"] {
  return [...FLOOR_DIRS, ...FLOOR_FILES].map((p) => ({
    path: join(home, p),
    sensitivity: "secret" as const,
  }));
}

/**
 * Merge the non-overridable floor into an owner's map.
 *
 * Idempotent: the floor entries are identical on every application, and
 * duplicate rules of equal length combine toward the more restrictive value, so
 * applying it twice cannot change a verdict.
 */
export function withFloor(map: SensitivityMap, home: string): SensitivityMap {
  return {
    ...map,
    sources: [
      ...map.sources,
      ...builtinSecretSources(home),
      ...FLOOR_CARVEOUTS.map((c) => ({ path: join(home, c.path), sensitivity: c.sensitivity })),
    ],
  };
}

/**
 * Skills default OPEN, where every other source defaults `secret`.
 *
 * This is the one deliberate exception to "unlabelled is secret", and it rests
 * on the measurement recorded at FLOOR_CARVEOUTS: a skill cannot reach anything
 * this guard does not already see, so the exposure is bounded to the skill's own
 * SKILL.md body. An owner can still mark a skill `secret` to withhold it.
 *
 * Do NOT invent the same default for MCP servers. A server's I/O is opaque to
 * the guard, so there is no equivalent bound — which is why they are granted by
 * enumeration in the allowlist (runner.ts) rather than labelled here.
 */
export const DEFAULT_SKILL_SENSITIVITY: Sensitivity = "shared";

export function classifySkill(map: SensitivityMap, skill: string): Sensitivity {
  return Object.hasOwn(map.skills, skill) ? map.skills[skill]! : DEFAULT_SKILL_SENSITIVITY;
}

/**
 * The directory to spawn the answering agent in, derived from the map.
 *
 * #372 deleted line `workdir` (config.json) and task `workdir` (SKILL.md). Both
 * were a second source of truth: the map already names the directory the owner
 * cares about — `defaultSensitivityMap` seeds the git repository `setup` ran in
 * — and a `workdir` that disagreed with it pointed the agent somewhere the
 * guard would then refuse to let it read.
 *
 * Selection, in order:
 *
 *   1. Sources the caller is CLEARED for. `permits` already refuses `secret`
 *      unconditionally, so the `withFloor` entries (~/.ssh, ~/.agentcall, …)
 *      drop out here without a second exclusion list, and a `public` caller is
 *      never spawned inside `internal` content it could only be refused on.
 *   2. The richest of those — `internal` over `public` — because a cwd the
 *      caller cannot be told about is worth less than one they can.
 *   3. Shortest path, then lexicographic. Purely a tie-break, and it exists so
 *      that reordering sensitivity.json cannot silently move the cwd.
 *
 * A source that no longer exists on disk is skipped rather than fatal: the map
 * is read per call, and one stale entry must not take the line offline. That
 * trades a loud failure for a quiet fallback, so `doctor` reports it instead —
 * see checkSensitivityWorkdir.
 */
export function workdirFor(
  map: SensitivityMap, fallbackDir: string, home?: string,
): string {
  return readableSources(map, home)[0] ?? fallbackDir;
}

/**
 * The labelled directories this caller may be told about, richest first.
 *
 * Shares its filter and ordering with `workdirFor` on purpose: the prompt tells
 * the agent what it may read, and the cwd is the first of exactly that list. If
 * the two could diverge, the agent would be oriented at a directory the prompt
 * never named, or told about one the guard would refuse.
 *
 * Safe to put in a prompt: every entry is at or below the caller's clearance by
 * construction, so echoing one into a reply is already permitted. A source the
 * caller is NOT cleared for never appears, which is why this cannot become a
 * path-disclosure channel for `secret` content.
 */
export function readableSources(
  map: SensitivityMap, home: string = homedir(),
): string[] {
  const floorRoots = builtinSecretSources(home).map((s) => s.path);
  return map.sources
    .filter((s) => permits(s.sensitivity))
    .map((s) => ({ ...s, path: expandHome(s.path, home) }))
    // Nothing inside the floor is a place to work or a path to advertise, even
    // where a carve-out makes it readable. FLOOR_CARVEOUTS puts
    // ~/.claude/skills back in reach of classifyPath, and without this filter
    // that entry would also become a workdir candidate — `workdirFor` takes the
    // shortest readable path, so a fresh line would spawn the agent inside the
    // skills directory instead of the owner's home. A skill is invoked by NAME,
    // so its directory never needs to be advertised for it to be usable.
    .filter((s) => !floorRoots.some((root) => isInside(s.path, root)))
    // Absolute only. The schema accepts any string, and `classifyPath`
    // canonicalises a relative one against the CALL's cwd — but there is no
    // call cwd yet when this runs, so a bare `statSync("code/api")` would
    // resolve against whatever directory the listener service happens to have
    // been launched in. That would make the spawn directory depend on how the
    // daemon was started, which is not a property anyone can reason about.
    // resolveLineWorkdir rejected the same shape before #372 deleted it.
    .filter((s) => isAbsolute(s.path))
    // Directories only: a file is a legitimate label — classifyPath handles
    // them — but it cannot be a cwd, and naming one as somewhere to "read
    // files under" would mislead the agent about what it can enumerate.
    .filter((s) => { try { return statSync(s.path).isDirectory(); } catch { return false; } })
    .sort((a, b) =>
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path))
    .map((s) => s.path);
}

/**
 * The map `setup` writes for a new line. OPEN by default as of 2026-08-07.
 *
 * Labels `$HOME` `internal`. The non-overridable floor above — ~/.ssh, ~/.aws,
 * ~/.gnupg, keychains, ~/.agentcall, ~/.codex, the shell rc files — is what
 * makes that safe to say, and it is subtracted by longest-prefix-wins rather
 * than by a second list that could drift.
 *
 * This replaced a walk-up that labelled only the git repository `setup` ran
 * inside, and named nothing at all outside one. That default was sound and
 * unusable: on a fresh install a caller could not reach the owner's skills,
 * notes, or any directory but that one repo, so the honest answer to most real
 * questions was "I can't share that". Being useless is a failure mode too.
 *
 * `cwd` is now unused and kept only so callers need not change. The seed no
 * longer depends on where `setup` ran, which also removes the monorepo and
 * dotfiles-repo traps the walk-up carried.
 *
 * **What this gives up is real and is written down**: the seed is
 * credential-safe, not confidential. See
 * docs/superpowers/specs/2026-08-07-open-default-design.md before treating it
 * as a confidentiality boundary.
 */
export function defaultSensitivityMap(_cwd: string, home?: string): SensitivityMap {
  if (home === undefined) return DEFAULT_SENSITIVITY_MAP;
  return { ...DEFAULT_SENSITIVITY_MAP, sources: [{ path: resolve(home), sensitivity: "shared" }] };
}
