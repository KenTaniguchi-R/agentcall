import type { Command } from "commander";
import { getMachinePaths } from "../paths.js";
import { resolveLine } from "../line-context.js";
import { scaffoldTask } from "../tasks.js";

export function register(program: Command): void {
  const task = program.command("task").description("manage the tasks your agent offers");
  task
    .command("new")
    .description("scaffold a new task (does not publish it)")
    .argument("<id>", "task id: lowercase kebab-case, becomes the directory name")
    .option("--line <name>", "line to use (defaults to the primary line)")
    .action((id: string, o: { line?: string }) => {
      let ctx;
      try {
        ctx = resolveLine(getMachinePaths(), { line: o.line });
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      try {
        const file = scaffoldTask(ctx.paths, id);
        console.log(`Created ${file}\nEdit it, then:`);
        console.log("  agentcall card                      # check it validates");
        console.log("  agentcall offer " + id + "    # offer to everyone, or:");
        console.log("  agentcall allow <handle> " + id);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
      }
    });
}
