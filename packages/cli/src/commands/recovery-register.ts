import { existsSync } from "node:fs";
import { ApiError } from "../api.js";
import { assertValidLineName, loadLineConfig } from "../lines.js";
import { getLinePaths, getMachinePaths } from "../paths.js";
import { resolveLine } from "../lineContext.js";
import { runRecoveryIssue, runRecoveryRedeem } from "./recovery.js";

export function register(program: { command(name: string): any }): void {
  const recovery = program.command("recovery").description("manage the out-of-band identity recovery proof");
  recovery.command("issue").description("issue or replace a recovery proof while the line token still works")
    .option("--line <name>", "line to protect (defaults to the primary line)")
    .action(async (o: { line?: string }) => {
      try { await runRecoveryIssue(resolveLine(getMachinePaths(), { line: o.line })); }
      catch (e) { console.error(e instanceof ApiError ? e.message : String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });
  recovery.command("redeem").description("recover one line using an out-of-band proof")
    .requiredOption("--line <name>", "local line name to recover")
    .option("--org <org>", "organization (required when local config is missing)")
    .option("--handle <handle>", "handle (required when local config is missing)")
    .option("--relay <url>", "relay URL (required when local config is missing)")
    .option("--generation <number>", "generation recorded with the current proof")
    .option("--resume", "resume the exact pending recovery after a lost response")
    .action(async (o: { line: string; org?: string; handle?: string; relay?: string; generation?: string; resume?: boolean }) => {
      try {
        assertValidLineName(o.line);
        const paths = getLinePaths(getMachinePaths(), o.line);
        const config = existsSync(paths.configFile) ? loadLineConfig(paths) : undefined;
        let generation: number | undefined;
        if (o.generation !== undefined) {
          generation = Number(o.generation);
          if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("--generation must be a positive integer.");
        }
        await runRecoveryRedeem({ name: o.line, paths, config, org: o.org, handle: o.handle, relay: o.relay, generation, resume: o.resume });
      } catch (e) { console.error(e instanceof ApiError ? e.message : String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
    });
}
