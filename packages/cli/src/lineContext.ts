import type { LineConfig } from "./config.js";
import { listLines, readyLines } from "./lines.js";
import type { LinePaths, MachinePaths } from "./paths.js";
import { resolvePrimary } from "./person.js";

export interface LineContext {
  machine: MachinePaths;
  name: string;
  paths: LinePaths;
  config: LineConfig;
}

export interface LineSelector {
  line?: string;
}

// Resolved ONCE per command and threaded through. Resolving twice — say, once
// for policy and once for credentials — is how a command ends up publishing
// one line's task menu under another line's handle.
export function resolveLine(m: MachinePaths, opts: LineSelector = {}): LineContext {
  const all = listLines(m);
  const requested = opts.line ?? process.env.AGENTCALL_LINE;

  if (requested !== undefined && requested !== "") {
    const found = all.find((l) => l.name === requested);
    if (!found) {
      const names = all.map((l) => l.name);
      throw new Error(
        `No line named "${requested}".` +
          (names.length > 0 ? ` This machine has: ${names.join(", ")}.` : " This machine has none."),
      );
    }
    if (!found.ok || !found.config) throw new Error(found.error ?? `Line "${requested}" is unusable.`);
    return { machine: m, name: found.name, paths: found.paths, config: found.config };
  }

  const ready = readyLines(m);
  const primary = resolvePrimary(m, ready.map((l) => l.name));
  const found = ready.find((l) => l.name === primary)!;
  return { machine: m, name: found.name, paths: found.paths, config: found.config };
}
