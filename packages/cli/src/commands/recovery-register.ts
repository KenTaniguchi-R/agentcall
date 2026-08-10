import { existsSync } from "node:fs";
import { loadConfig, loadInstallation } from "../config.js";
import { getPaths } from "../paths.js";
import { runRecoveryIssue, runRecoveryRedeem } from "./recovery.js";
import { fail } from "../errors.js";

export function register(program: { command(name: string): any }): void {
  const recovery = program.command("recovery").description("manage the out-of-band identity recovery proof");
  recovery.command("issue").description("issue or replace a recovery proof while the token still works")
    .action(async () => {
      try { await runRecoveryIssue(loadInstallation(getPaths())); }
      catch (error) { fail(error); }
    });
  recovery.command("redeem").description("recover this installation using an out-of-band proof")
    .option("--org <org>", "organization (required when local config is missing)")
    .option("--handle <handle>", "handle (required when local config is missing)")
    .option("--relay <url>", "relay URL (required when local config is missing)")
    .option("--generation <number>", "generation recorded with the current proof")
    .option("--resume", "resume the exact pending recovery after a lost response")
    .action(async (options: { org?: string; handle?: string; relay?: string; generation?: string; resume?: boolean }) => {
      try {
        const paths = getPaths();
        const config = existsSync(paths.configFile) ? loadConfig(paths) : undefined;
        const generation = options.generation === undefined ? undefined : Number(options.generation);
        if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 1)) {
          throw new Error("--generation must be a positive integer.");
        }
        await runRecoveryRedeem({ paths, config, org: options.org, handle: options.handle, relay: options.relay, generation, resume: options.resume });
      } catch (error) { fail(error); }
    });
}
