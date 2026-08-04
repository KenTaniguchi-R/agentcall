import { runDoctor } from "../doctor.js";
import { getMachinePaths } from "../paths.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("doctor")
    .description("verify this install can answer calls: binary, auth, agent spawn, tool telemetry, listener, relay self-call")
    .action(async () => {
      process.exitCode = await runDoctor({ machine: getMachinePaths() });
    });
}
