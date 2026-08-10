import { runDoctor } from "../doctor.js";
import { getPaths } from "../paths.js";

export function register(program: { command(name: string): any }): void {
  program
    .command("doctor")
    .description("verify this install can answer calls: binary, auth, agent spawn, listener, relay self-call")
    .action(async () => {
      process.exitCode = await runDoctor({ paths: getPaths() });
    });
}
