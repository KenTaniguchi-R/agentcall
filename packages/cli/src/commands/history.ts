import { loadLocalHistory, renderLocalHistory } from "../history.js";
import type { Installation } from "../config.js";
import { sanitizeTerminalOutput, stringifyTerminalSafeJson } from "@benree/agentcall-shared";
import { fail } from "../errors.js";

type InstallationFor = () => Installation | undefined;

export function register(program: { command(name: string): any }, installationFor: InstallationFor): void {
  program
    .command("history")
    .description("show call activity stored locally on this machine")
    .option("--limit <count>", "maximum newest calls to show (1-100)", "20")
    .option("--flagged", "show only calls with objective local abuse signals")
    .option("--json", "print machine-readable local history")
    .action((o: { limit: string; flagged?: boolean; json?: boolean }) => {
      const limit = Number(o.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        fail("History limit must be an integer from 1 to 100.");
        return;
      }
      const ctx = installationFor();
      if (!ctx) return;
      const history = loadLocalHistory(ctx.paths, limit, { flaggedOnly: o.flagged });
      if (history.malformed > 0) {
        console.error(`Skipped ${history.malformed} malformed local history record${history.malformed === 1 ? "" : "s"}.`);
      }
      if (history.truncatedFiles.length > 0) {
        console.error(
          `History scan was limited to the newest 4 MiB of: ${history.truncatedFiles.join(", ")}. ` +
            "Tool counts may be partial.",
        );
      }
      const entries = history.entries;
      console.log(o.json
        ? stringifyTerminalSafeJson(entries)
        : sanitizeTerminalOutput(renderLocalHistory(entries)));
    });
}
