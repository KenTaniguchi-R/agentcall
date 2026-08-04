import { existsSync, readdirSync } from "node:fs";
import { LINE_NAME_RE } from "./line-name.js";
import { getLinePaths, type MachinePaths } from "./paths.js";

// Every line's tasksDir, derived from the directory NAME alone — no
// config.json read, no zod validation. decide() only needs a list of paths
// to deny; it never needs anything from a line's config. Same enumeration as
// lines.ts's listLines (same directory filter, same never-throws contract —
// a half-made or corrupt line still contributes its tasksDir, since this
// function never touches config.json in the first place and so can never
// fail on account of it), without listLines' cost: it readFileSync's and
// zod-parses every line's config.json to build a LineSummary this caller
// would immediately discard everything but the path from.
//
// Deliberately does not live in lines.ts: lines.ts imports zod at module
// scope, and this is on the guard's hot path, called once per tool call from
// runGuard. See guard-entry.ts's own header comment for why that entry point
// stays a minimal, standalone import graph.
export function lineTaskDirs(m: MachinePaths): string[] {
  if (!existsSync(m.linesDir)) return [];
  return readdirSync(m.linesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && LINE_NAME_RE.test(e.name))
    .map((e) => getLinePaths(m, e.name).tasksDir);
}
