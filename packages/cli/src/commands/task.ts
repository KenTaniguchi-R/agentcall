import type { Command } from "commander";
import { getPaths } from "../paths.js";
import { loadInstallation } from "../config.js";
import { scaffoldTask } from "../tasks.js";
import { fail } from "../errors.js";

export function register(program: Command): void {
  const task = program.command("task").description("manage the tasks your agent offers");
  task
    .command("new")
    .description("scaffold a new task (does not publish it)")
    .argument("<id>", "task id: lowercase kebab-case, becomes the directory name")
    .action((id: string) => {
      let ctx;
      try {
        ctx = loadInstallation(getPaths());
      } catch (e) {
        fail(e);
        return;
      }
      try {
        const file = scaffoldTask(ctx.paths, id);
        console.log(`Created ${file}\nEdit it, then:`);
        console.log("  agentcall card                      # check it validates");
        console.log("  agentcall offer " + id + "    # offer to everyone, or:");
        console.log("  agentcall allow <handle> " + id);
      } catch (e) {
        fail(e);
      }
    });
}
