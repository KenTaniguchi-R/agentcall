// The sensitivity half of #372: what a source is, independent of who is asking.
// The clearance half — who may receive what — lives in policy.ts.
//
// This replaces three overlapping mechanisms (the capability envelope,
// guard.ts's denylist, and AGENTCALL_ALLOWED_ROOT) with one question asked of
// every source: how sensitive is it. Everything not named is `secret`, so the
// failure mode of an unconfigured or half-configured line is a refusal to
// answer rather than a leak — which is what makes a generous default safe.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { canonical, expandHome, isInside } from "./path-canon.js";
import type { LinePaths } from "./paths.js";

export const SENSITIVITIES = ["public", "internal", "secret"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

// Ordering is the whole lattice: higher is more restrictive.
const RANK: Record<Sensitivity, number> = { public: 0, internal: 1, secret: 2 };

// Unlabelled means secret. This constant exists so the default is stated once
// and cannot drift between the classifiers below.
export const DEFAULT_SENSITIVITY: Sensitivity = "secret";

const SensitivitySchema = z.enum(SENSITIVITIES);

export const SensitivityMapSchema = z.object({
  sources: z.array(z.object({
    path: z.string().min(1),
    sensitivity: SensitivitySchema,
  })).default([]),
  mcp: z.record(z.string(), SensitivitySchema).default({}),
  skills: z.record(z.string(), SensitivitySchema).default({}),
}).strict();

export type SensitivityMap = z.infer<typeof SensitivityMapSchema>;

/** A fresh install: no sources named, so everything classifies `secret`. */
export const DEFAULT_SENSITIVITY_MAP: SensitivityMap = { sources: [], mcp: {}, skills: {} };

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

/** Most restrictive of the inputs. No inputs is `public` — an untouched run starts clean. */
export function combine(...values: Sensitivity[]): Sensitivity {
  return values.reduce<Sensitivity>(
    (acc, v) => (RANK[v] > RANK[acc] ? v : acc),
    "public",
  );
}

// `secret` is deliberately not grantable. It means "never leaves this machine",
// so treating it as a holdable clearance would turn the top of the lattice into
// a bypass that any policy edit could hand out.
export function permits(clearance: Sensitivity, content: Sensitivity): boolean {
  if (content === "secret") return false;
  return RANK[content] <= RANK[clearance];
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

// z.record output inherits Object.prototype, so a bare `record[name]` resolves
// to the Object constructor for any map that does not define that key — which
// reads as a real declaration. Same trap policy.ts:161-171 documents for
// `policy.callers`; both lookups go through an own-property check.
function lookup(record: Record<string, Sensitivity>, name: string): Sensitivity {
  return Object.hasOwn(record, name) ? record[name]! : DEFAULT_SENSITIVITY;
}

export function classifyMcp(map: SensitivityMap, server: string): Sensitivity {
  return lookup(map.mcp, server);
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
  return { ...map, sources: [...map.sources, ...builtinSecretSources(home)] };
}

export function classifySkill(map: SensitivityMap, skill: string): Sensitivity {
  return lookup(map.skills, skill);
}

/**
 * The map `setup` writes for a new line.
 *
 * Labels the git repository setup ran inside, walking up from cwd so running it
 * deep in a monorepo still names the root. If there is no repository, names
 * NOTHING — an empty map means every source is `secret`, the line answers "I
 * can't share that", and `doctor` tells the owner to label something. A wrong
 * guess here would be a silent leak, which is the one failure this model exists
 * to make impossible.
 *
 * $HOME is never labelled even when it contains a .git: that is a dotfiles
 * repository, not a project, and labelling it would hand a caller the whole
 * home tree minus the floor.
 */
export function defaultSensitivityMap(cwd: string, home?: string): SensitivityMap {
  const stop = home === undefined ? undefined : resolve(home);
  let dir = resolve(cwd);
  for (;;) {
    if (dir !== stop && existsSync(join(dir, ".git"))) {
      return { ...DEFAULT_SENSITIVITY_MAP, sources: [{ path: dir, sensitivity: "internal" }] };
    }
    const parent = dirname(dir);
    if (parent === dir) return DEFAULT_SENSITIVITY_MAP;
    dir = parent;
  }
}
