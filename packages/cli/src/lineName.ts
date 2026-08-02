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
// rule name) — silent and very hard to diagnose. "public" is reserved for
// the symmetric reason (~/AgentCall/<line>/public colliding with a line
// literally named "public"). Do not remove these without re-checking that
// the guard's path denial no longer applies.
const RESERVED_LINE_NAMES = new Set(["tasks", "public"]);

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
