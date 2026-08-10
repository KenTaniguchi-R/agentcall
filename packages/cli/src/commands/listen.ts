import type { Command } from "commander";
import { assertCallable, loadConfig, loadInstallation, relayUrl } from "../config.js";
import { getPaths } from "../paths.js";
import { startListener } from "../listener.js";
import { fail } from "../errors.js";

export function register(program: Command): void {
  program.command("listen")
    .description("run the foreground listener (the platform service runs this after setup)")
    .action(() => {
      try {
        const installation = loadInstallation(getPaths());
        assertCallable(installation.config);
        const listener = startListener({
          relay: relayUrl(installation.config),
          paths: installation.paths,
          loadConfig: () => {
            const config = loadConfig(installation.paths);
            assertCallable(config);
            return config;
          },
        });
        console.log(`listening as ${installation.config.handle}`);
        let stopping = false;
        const stop = async () => {
          if (stopping) return;
          stopping = true;
          await listener.stop();
          process.exit(0);
        };
        process.once("SIGTERM", () => { void stop(); });
        process.once("SIGINT", () => { void stop(); });
        setInterval(() => {}, 1 << 30);
      } catch (error) {
        fail(error);
      }
    });
}
