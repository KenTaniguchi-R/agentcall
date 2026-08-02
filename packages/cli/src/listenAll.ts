import { readyLines } from "./lines.js";
import { loadLineConfig } from "./lines.js";
import { startListener, type ListenerDeps } from "./listener.js";
import type { MachinePaths } from "./paths.js";
import { relayUrl } from "./config.js";
import type { CallableLineConfig } from "./config.js";

export interface ListenAllDeps {
  start?: (deps: ListenerDeps) => { stop(): void };
  log?: (line: string) => void;
}

// One process, N sockets. The relay enforces one listener socket per handle
// (apps/relay/src/do.ts:56) but knows nothing about processes, so N addresses
// need N sockets — not N supervised services.
export function startAllListeners(
  m: MachinePaths, deps: ListenAllDeps = {},
): { stop(): void; started: string[] } {
  const start = deps.start ?? startListener;
  const log = deps.log ?? console.log;
  const handles: { stop(): void }[] = [];
  const started: string[] = [];

  for (const line of readyLines(m)) {
    if (!line.config.agent_kind) continue; // caller-only: nothing to answer with
    handles.push(
      start({
        relay: relayUrl(line.config),
        paths: line.paths,
        loadConfig: () => loadLineConfig(line.paths) as CallableLineConfig,
      }),
    );
    started.push(line.name);
    log(`listening as ${line.config.handle} (line ${line.name})`);
  }
  if (started.length === 0) log("no callable lines — nothing to listen on.");
  return { stop: () => handles.forEach((h) => h.stop()), started };
}
