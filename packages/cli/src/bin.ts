import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import type { AgentKind } from "@benree/agentcall-shared";

// Roots whose contents don't survive the session that created them. A dir
// under any of these must never be treated as the preferred resolution of a
// PATH search: terminal wrappers (e.g. cmux) plant per-session bin shims in
// $TMPDIR that shadow the real agent binary, then vanish — or worse, linger
// and exec a wrapper for a dead session. /var/folders and /tmp are listed
// alongside os.tmpdir() (and in /private-prefixed form, their macOS
// realpath) because the per-user temp tree differs per machine.
const EPHEMERAL_ROOTS = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];

export function isEphemeralDir(dir: string): boolean {
  const normalized = resolve(dir);
  return EPHEMERAL_ROOTS.some((root) => normalized === root || normalized.startsWith(root + "/"));
}

// First candidate whose dir survives the current session; falls back to the
// first match (better a warning-producing shim than claiming the binary
// doesn't exist at all) and null when there are no candidates.
export function preferDurableBin(candidates: string[]): string | null {
  return candidates.find((c) => !isEphemeralDir(dirname(c))) ?? candidates[0] ?? null;
}

// which()-style PATH search, resolving every match's real (symlink-
// followed) absolute path, then preferring a durable install (see
// preferDurableBin/EPHEMERAL_ROOTS above) over an ephemeral per-session
// shim that happens to sit earlier on PATH — e.g. a cmux session's
// $TMPDIR/cmux-cli-shims/<uuid>/claude, which fails with exit 127 once the
// session that created it is gone. Returns null rather than throwing so
// callers that only want a best-effort answer can skip a missing binary.
function resolveOnPath(name: string, pathEnv: string): string | null {
  const matches: string[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (!existsSync(candidate)) continue;
    try {
      matches.push(realpathSync(candidate));
    } catch {
      continue;
    }
  }
  return preferDurableBin(matches);
}

// Resolves the absolute, symlink-followed path to the claude/codex binary
// via a PATH search, throwing a clear error if it can't be found. The runner
// spawns this resolved path rather than a bare "claude"/"codex" so the
// listener's environment (launchd's fixed PATH, no shell rc) can't come up
// empty-handed where an interactive shell would have succeeded. `env` is
// overridable for tests; production callers should leave it as process.env.
export function resolveAgentBin(agentKind: AgentKind, env: NodeJS.ProcessEnv = process.env): string {
  const resolved = resolveOnPath(agentKind, env.PATH ?? "");
  if (!resolved) {
    throw new Error(
      `Could not find \`${agentKind}\` on PATH. Install it, or make sure it's discoverable via PATH before running agentcall.`,
    );
  }
  return resolved;
}
