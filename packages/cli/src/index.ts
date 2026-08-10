import { Command, CommanderError } from "commander";
import { getPaths } from "./paths.js";
import { loadInstallation, type Installation } from "./config.js";
import { register as registerCall } from "./commands/call.js";
import { register as registerRotate } from "./commands/rotate.js";
import { register as registerAudit } from "./commands/audit.js";
import { register as registerUninstall } from "./commands/uninstall.js";
import { register as registerContacts } from "./commands/contacts.js";
import { register as registerSetup } from "./commands/setup.js";
import { register as registerRecovery } from "./commands/recovery-register.js";
import { register as registerInvite } from "./commands/invite.js";
import { register as registerInspect } from "./commands/inspect.js";
import { register as registerAdmin } from "./commands/admin.js";
import { register as registerPeer } from "./commands/peer.js";
import { register as registerDoctor } from "./commands/doctor.js";
import { register as registerHistory } from "./commands/history.js";
import { register as registerListen } from "./commands/listen.js";
import { register as registerTask } from "./commands/task.js";
import { register as registerGrants } from "./commands/grants.js";
import { register as registerJobs } from "./commands/jobs.js";
export function createProgram(): Command {
const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.4.0");
registerSetup(program);
registerInvite(program, installationFor);
registerAudit(program, installationFor);
registerCall(program);
registerJobs(program);
registerInspect(program);
registerPeer(program);
registerAdmin(program);
registerDoctor(program);
registerHistory(program, installationFor);
registerContacts(program);
function installationFor(): Installation | undefined {
  try {
    return loadInstallation(getPaths());
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
    return undefined;
  }
}
registerTask(program);
registerGrants(program);
registerListen(program);
registerRotate(program);
registerRecovery(program);
registerUninstall(program);
return program;
}
interface CliOutput {
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
}
export async function runCli(argv: string[], output: CliOutput = {}): Promise<number> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const program = createProgram();
    program.configureOutput(output);
    program.exitOverride();
    try {
      await program.parseAsync(argv, { from: "user" });
      return process.exitCode ?? 0;
    } catch (e) {
      if (e instanceof CommanderError) return e.exitCode;
      console.error(String(e));
      return 1;
    }
  } finally {
    process.exitCode = previousExitCode;
  }
}
