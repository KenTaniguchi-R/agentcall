// Line-name validation, split out from lines.ts so it can be imported
// without pulling in zod. lines.ts imports zod at module scope (for
// LineConfigSchema), and guard-entry.ts — which needs LINE_NAME_RE to
// validate AGENTCALL_LINE — is a standalone process entry deliberately kept
// to a minimal import graph: it runs once per tool call, and its own header
// comment explains the cost of routing through a heavier graph. lines.ts
// imports and re-exports these from here, so this stays the one definition —
// nothing duplicates it.
export const LINE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function assertValidLineName(name: string): void {
  if (!LINE_NAME_RE.test(name)) {
    throw new Error(
      `"${name}" isn't a valid line name: lowercase letters, digits and hyphens, ` +
        `1-32 characters, starting with a letter or digit.`,
    );
  }
}
