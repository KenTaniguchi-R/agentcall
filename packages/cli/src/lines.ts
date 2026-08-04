import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { AgentKindSchema, ORG_RE } from "@benree/agentcall-shared";
import { getLinePaths, type LinePaths, type MachinePaths } from "./paths.js";
import type { LineConfig } from "./config.js";
import { writeJsonAtomic } from "./json-store.js";
// A line name becomes a directory component and part of an authored-content
// path, so this regex is the traversal defence and runs before anything
// touches disk. Deliberately narrower than HANDLE_RE: the handle is global
// and may need length, the local label does not.
//
// Defined in lineName.ts, not here, and re-exported below: this module
// imports zod (for LineConfigSchema), and guard-entry.ts needs LINE_NAME_RE
// without pulling zod into its once-per-tool-call import graph. The
// re-export keeps every existing `from "./lines.js"` caller working
// unchanged.
import { assertValidLineName, LINE_NAME_RE } from "./line-name.js";
export { assertValidLineName, LINE_NAME_RE };

// `relay` is a REQUIRED non-empty string but deliberately NOT parsed as a URL
// here, unlike main's flat ConfigSchema. Requiring it is what stops a silent
// fall-through to the public default; validating its syntax at load would make
// a typo'd relay fatal to loading the line at all, and one line's typo must
// not make the line unreportable. `doctor` (relay config check) and
// `line list` validate the syntax where they can name it, which is strictly
// more diagnosable than a load-time schema error — see doctor.ts.
export const LineConfigSchema = z.object({
  org: z.string().regex(ORG_RE),
  handle: z.string().min(1),
  token: z.string().min(1),
  relay: z.string().min(1),
  agent_kind: AgentKindSchema.optional(),
  workdir: z.string().optional(),
});

export function loadLineConfig(l: LinePaths): LineConfig {
  if (!existsSync(l.configFile)) {
    throw new Error(`Line "${l.name}" has no config.json — it was never finished. Remove it with \`agentcall line remove ${l.name}\`.`);
  }
  // Validate shape before readFileSync. Besides refusing config indirection,
  // this prevents a planted FIFO/device from blocking every command that
  // enumerates lines (including doctor) before it can report the problem.
  const dir = lstatSync(l.dir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error(`Line "${l.name}" directory at ${l.dir} must be a real directory, not a symlink.`);
  }
  const file = lstatSync(l.configFile);
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error(`Line "${l.name}" config at ${l.configFile} must be a regular file, not a symlink.`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(l.configFile, "utf8"));
  } catch (e) {
    throw new Error(`Corrupt config.json for line "${l.name}" at ${l.configFile}: invalid JSON (${e instanceof Error ? e.message : String(e)}). Fix or remove this file, then re-run \`agentcall line add ${l.name} --invite <token>\`.`);
  }
  try {
    return LineConfigSchema.parse(raw);
  } catch (e) {
    const problem = e instanceof z.ZodError
      ? e.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")
      : e instanceof Error ? e.message : String(e);
    throw new Error(
      `Corrupt config.json for line "${l.name}" at ${l.configFile}: ${problem}. ` +
        `Fix or remove this file, then re-run \`agentcall line add ${l.name} --invite <token>\`.`,
      { cause: e },
    );
  }
}

// Atomic for the same reason person.json is: this file holds the only copy of
// the relay token, and a torn write is unrecoverable (the relay authenticates
// rotation with the OLD token, and handle release is not implemented — #16).
export function saveLineConfig(l: LinePaths, cfg: LineConfig): void {
  writeJsonAtomic(l.configFile, cfg);
}

export interface LineSummary {
  name: string;
  ok: boolean;
  paths: LinePaths;
  config?: LineConfig;
  error?: string;
}

// Never throws: a half-made or corrupt line must be *reportable* (by doctor,
// by `line list`) rather than fatal to every command that enumerates lines.
export function listLines(m: MachinePaths): LineSummary[] {
  if (!existsSync(m.linesDir)) return [];
  const names = readdirSync(m.linesDir, { withFileTypes: true })
    // Include validly named symlinks so they become explicit broken lines
    // through loadLineConfig instead of disappearing from doctor/list output.
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && LINE_NAME_RE.test(e.name))
    .map((e) => e.name)
    .sort();
  return names.map((name) => {
    const paths = getLinePaths(m, name);
    try {
      return { name, ok: true, paths, config: loadLineConfig(paths) };
    } catch (e) {
      return { name, ok: false, paths, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function readyLines(m: MachinePaths): { name: string; paths: LinePaths; config: LineConfig }[] {
  return listLines(m)
    .filter((l): l is LineSummary & { config: LineConfig } => l.ok && l.config !== undefined)
    .map(({ name, paths, config }) => ({ name, paths, config }));
}
