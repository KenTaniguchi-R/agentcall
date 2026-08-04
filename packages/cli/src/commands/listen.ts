import type { Command } from "commander";
import { assertCallableLine, relayUrl } from "../config.js";
import { getMachinePaths } from "../paths.js";
import { loadLineConfig } from "../lines.js";
import { resolveLine, type LineContext } from "../line-context.js";
import { startAllListeners } from "../listen-all.js";
import { startListener } from "../listener.js";

export function register(program: Command): void {
  program
    .command("listen")
    .description("run the foreground listener (the platform service runs this after setup)")
    .option("--line <name>", "run only this line instead of every callable line")
    .action((o: { line?: string }) => {
      const machine = getMachinePaths();
      let listener: { stop(): Promise<void> };
      if (o.line) {
        // Single-line foreground run: mirrors startAllListeners' own per-line
        // wiring (listenAll.ts) instead of duplicating it — same loadConfig
        // re-read on every reconnect, so a rotated token or edited workdir
        // still takes effect without a restart.
        let ctx: LineContext;
        try {
          ctx = resolveLine(machine, { line: o.line });
          assertCallableLine(ctx.config);
        } catch (e) {
          console.error(String(e instanceof Error ? e.message : e));
          process.exitCode = 1;
          return;
        }
        listener = startListener({
          relay: relayUrl(ctx.config),
          paths: ctx.paths,
          loadConfig: () => {
            const cfg = loadLineConfig(ctx.paths);
            assertCallableLine(cfg);
            return cfg;
          },
        });
        console.log(`listening as ${ctx.config.handle} (line ${ctx.name})`);
      } else {
        // One process, every callable line: startAllListeners enumerates
        // ~/.agentcall/lines itself and opens one socket per callable line.
        listener = startAllListeners(machine);
      }
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await listener.stop();
        process.exit(0);
      };
      process.once("SIGTERM", () => { void stop(); });
      process.once("SIGINT", () => { void stop(); });
      // Keep the process alive without a busy loop; setInterval's max delay.
      setInterval(() => {}, 1 << 30);
    });
}
