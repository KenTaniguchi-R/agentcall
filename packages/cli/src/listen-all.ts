import { readyLines } from "./lines.js";
import { loadLineConfig } from "./lines.js";
import { startListener, type ListenerDeps } from "./listener.js";
import type { MachinePaths } from "./paths.js";
import { assertCallableLine, relayUrl } from "./config.js";

interface ListenAllDeps {
  start?: (deps: ListenerDeps) => { stop(): void | Promise<void> };
  log?: (line: string) => void;
}

// One process, N sockets. The relay enforces one listener socket per handle
// (apps/relay/src/do.ts:56) but knows nothing about processes, so N addresses
// need N sockets — not N supervised services.
export function startAllListeners(
  m: MachinePaths, deps: ListenAllDeps = {},
): { stop(): Promise<void>; started: string[] } {
  const start = deps.start ?? startListener;
  const log = deps.log ?? console.log;
  const handles: { stop(): void | Promise<void> }[] = [];
  const started: string[] = [];
  let attempted = 0;

  for (const line of readyLines(m)) {
    if (!line.config.agent_kind) continue; // caller-only: nothing to answer with
    attempted++;
    try {
      handles.push(
        start({
          relay: relayUrl(line.config),
          paths: line.paths,
          loadConfig: () => {
            // Re-read (not the `line.config` this loop already has) because
            // this thunk also runs on every reconnect, not just here at
            // startup — see listener.ts. assertCallableLine, not a cast: the
            // startup check above only covers the FIRST read; if agent_kind
            // gets edited out of config.json while this process is already
            // running, a cast would let `undefined` through silently and
            // buildSpawnSpec would take the codex branch for a claude line.
            // Asserting makes that fail loudly instead — and thanks to the
            // per-line isolation below (and listener.ts's own reconnect
            // isolation), that throw stays contained to this one line.
            const cfg = loadLineConfig(line.paths);
            assertCallableLine(cfg);
            return cfg;
          },
        }),
      );
      started.push(line.name);
      log(`listening as ${line.config.handle} (line ${line.name})`);
    } catch (e) {
      // startListener throws synchronously at startup on a bad workdir or
      // unreadable config — deliberately (see listener.ts: a typo'd workdir
      // should fail loud once, not fail every inbound call individually).
      // That contract predates lines; with N lines now sharing ONE process,
      // an uncaught throw here would take every other line down with it and
      // leak whatever sockets this loop had already pushed into `handles`,
      // with no reachable `stop()` for them. console.error, not a new log
      // path: same reasoning as listener.ts's reconnect isolation — the
      // plist already routes stderr to listenerLog, and it's visible under a
      // foreground `agentcall listen` too. Keep starting the rest.
      console.error(`agentcall: line "${line.name}" failed to start, skipping: ${String(e)}`);
    }
  }

  if (started.length === 0 && attempted > 0) {
    // Every callable line failed to start. Nothing is listening, but nothing
    // threw either — this process would otherwise sit there looking healthy
    // (launchd sees it running, `agentcall status` might even show the
    // handle as configured) while silently answering no calls at all. A
    // supervised process that's visibly down (crash-loops, gets restarted,
    // shows up in `launchctl list` as failing) is more legible than one
    // that's quietly serving nothing — so this throws, deliberately, to make
    // `agentcall listen` exit non-zero. `handles` is guaranteed empty on this
    // path (started.length === 0 means the loop above never pushed a
    // success), but stop them anyway rather than assume that invariant holds
    // forever.
    handles.forEach((h) => h.stop());
    throw new Error(`agentcall: every callable line (${attempted}) failed to start — see the errors above.`);
  }
  if (started.length === 0) log("no callable lines — nothing to listen on.");
  return {
    stop: async () => { await Promise.all(handles.map((h) => h.stop())); },
    started,
  };
}
