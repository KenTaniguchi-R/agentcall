#!/usr/bin/env node
// PreToolUse hook for the #373 spike. Records every filesystem path an
// answering agent reaches for, then ALWAYS allows the call.
//
// Allowing is deliberate. The spike measures where an unconstrained agent
// actually goes; a hook that denied `secret` paths would change the very
// behaviour under test, and the run would report the confinement we imposed
// rather than the wandering we wanted to observe.
//
// Occupies the same seam as guard-entry.ts, which is what makes the result
// transferable to the real implementation.
import { appendFileSync, readFileSync } from "node:fs";

const out = process.env.SPIKE_PATH_LOG;
if (!out) process.exit(0);

let input = "";
try {
  input = readFileSync(0, "utf8");
} catch {
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(input);
} catch {
  process.exit(0);
}

const ti = payload.tool_input ?? {};
// Read/Write take `file_path`; Grep/Glob/LS take `path`; Glob can also carry
// its root inside `pattern`, which is the same blind spot guard.ts documents.
const candidates = [ti.file_path, ti.path, ti.pattern, ti.notebook_path].filter(
  (v) => typeof v === "string" && v.length > 0,
);

for (const path of candidates) {
  appendFileSync(out, JSON.stringify({ tool: payload.tool_name ?? "unknown", path }) + "\n");
}

process.exit(0);
