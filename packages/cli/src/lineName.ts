// Line-name validation, split out from lines.ts so it can be imported
// without pulling in zod. lines.ts imports zod at module scope (for
// LineConfigSchema), and guard-entry.ts — which needs LINE_NAME_RE to
// validate AGENTCALL_LINE — is a standalone process entry deliberately kept
// to a minimal import graph: it runs once per tool call, and its own header
// comment explains the cost of routing through a heavier graph. lines.ts
// imports and re-exports these from here, so this stays the one definition —
// nothing duplicates it.
export const LINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

// A line's authored content lives at ~/AgentCall/<line>/ (see getLinePaths in
// paths.ts). The guard denies the legacy path ~/AgentCall/tasks wholesale, so
// a line named "tasks" would put its own share directory
// (~/AgentCall/tasks/public) *inside* a denied root: `line add tasks` would
// succeed, and every answered call on that line would then fail at its first
// tool use with the generic denial (which deliberately reveals no path or
// rule name) — silent and very hard to diagnose. See guard.ts's DENIED_DIRS
// entry for the other half of this. "public" is reserved for the symmetric
// reason (~/AgentCall/<line>/public colliding with a line literally named
// "public"). Do not remove these without re-checking that the guard's path
// denial no longer applies.
//
// "doctor-probe" is reserved for an unrelated reason: it is
// verify.ts's GUARD_PROBE_LINE, the synthetic line name every verification
// spawn in that file runs under (checkAgentSpawn, and the two checkGuard
// probes). None of those probes write into a real line's directory — they
// each redirect AGENTCALL_HOME to a throwaway temp dir first — but the name
// still carries special meaning to that code, and a real line by this name
// would make a future regression of any of those redirects (see verify.ts's
// history on checkAgentSpawn) silently pollute — or worse, get mistaken for
// — the owner's own line, instead of showing up as an obviously-orphaned,
// harmless directory. Reserving it here is the one place that owns "this
// name is never a real line" — `listLines`/`doctor` deliberately still
// enumerate a stray directory by this name rather than filtering it out, so
// that if a redirect ever does regress, the orphan stays visible instead of
// disappearing.
const RESERVED_LINE_NAMES = new Set(["tasks", "public", "doctor-probe"]);

export function assertValidLineName(name: string): void {
  if (!LINE_NAME_RE.test(name)) {
    throw new Error(
      `"${name}" isn't a valid line name: lowercase letters, digits and hyphens, ` +
        `1-32 characters, starting with a letter or digit.`,
    );
  }
  if (RESERVED_LINE_NAMES.has(name)) {
    throw new Error(`"${name}" is a reserved line name and can't be used.`);
  }
}
