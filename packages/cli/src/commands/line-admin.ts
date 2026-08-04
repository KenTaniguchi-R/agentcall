import type { Command } from "commander";
import { getMachinePaths } from "../paths.js";
import { removeLine, setPrimary } from "./line.js";

export function register(line: Command): void {
  line
    .command("remove")
    .description("remove a line (archives calls.log; the handle can never be reused, see README)")
    .argument("<name>", "line to remove")
    .option("--yes", "confirm removal — required, since the handle can never be reclaimed")
    .option("--purge", "delete outright instead of archiving calls.log")
    .action((name: string, o: { yes?: boolean; purge?: boolean }) => {
      try {
        removeLine(getMachinePaths(), name, { confirm: o.yes, purge: o.purge });
        console.log(`Removed line "${name}".`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
      }
    });

  line
    .command("primary")
    .description("set which line places an outbound call when several could answer it")
    .argument("<name>", "line to make primary")
    .action((name: string) => {
      try {
        setPrimary(getMachinePaths(), name);
        console.log(`Primary line is now "${name}".`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
      }
    });
}
