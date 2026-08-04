import { rmSync } from "node:fs";
import { getMachinePaths } from "../paths.js";
import { uninstallListenerService } from "../listener-service.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("uninstall")
    .description("remove the background listener")
    .option("--purge", "also delete ~/.agentcall (config, token, logs)")
    .action((o: { purge?: boolean }) => {
      const machine = getMachinePaths();
      uninstallListenerService(machine);
      if (o.purge) rmSync(machine.dir, { recursive: true, force: true });
      console.log("agentcall listener removed." + (o.purge ? " Config purged." : ""));
    });
}
