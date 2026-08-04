import { Command, CommanderError } from "commander";
import { getMachinePaths } from "./paths.js";
// No rotateToken here: `rotate` goes through commands/rotate.ts's rotateLine,
// which owns the per-line config write and calls the api helper itself.
import { ApiError,
  expelRosterMember, issueRosterJoinKey, listRosterJoinKeys, revokeRosterJoinKey, deleteRoster,
  } from "./api.js";
import { resolveLine } from "./lineContext.js";
import type { LineContext } from "./lineContext.js";
import { register as registerCall } from "./commands/call.js";
import { rotateLine } from "./commands/rotate.js";
import { runRecoveryIssue, runRecoveryRedeem } from "./commands/recovery.js";
import { register as registerLineCore } from "./commands/line-core.js";
import { register as registerLineAdmin } from "./commands/line-admin.js";
import { register as registerRosterCore } from "./commands/roster-core.js";
import { register as registerRosterAdmin } from "./commands/roster-admin.js";
import { register as registerAudit } from "./commands/audit.js";
import { register as registerUninstall } from "./commands/uninstall.js";
import { register as registerContacts } from "./commands/contacts.js";
import { register as registerSetup } from "./commands/setup.js";
import { register as registerRecovery } from "./commands/recovery-register.js";
import { register as registerInvite } from "./commands/invite.js";
import { register as registerStatus } from "./commands/status.js";
import { register as registerKeys } from "./commands/keys.js";
import { register as registerPeer } from "./commands/peer.js";
import { register as registerDoctor } from "./commands/doctor.js";
import { register as registerHistory } from "./commands/history.js";
import { register as registerPolicy } from "./commands/policy.js";
import { register as registerListen } from "./commands/listen.js";
import { register as registerTask } from "./commands/task.js";
import { register as registerGrants } from "./commands/grants.js";
import { registerCard, registerLint } from "./commands/card.js";
import { register as registerSearch } from "./commands/search.js";

export function createProgram(): Command {
const program = new Command();
program.name("agentcall").description("Call other people's coding agents").version("0.4.0");

registerSetup(program);

// Invite actions are isolated so the command tree remains declarative here.
registerInvite(program, lineFor);
registerAudit(program, lineFor);
registerCall(program);


registerStatus(program);
registerPeer(program);

registerKeys(program);
registerDoctor(program);
registerHistory(program, lineFor);

registerLint(program);
registerPolicy(program);
registerCard(program);

registerContacts(program);

// Rosters are LINE-scoped, not machine-scoped. A roster is membership held by
// a handle on a relay, and a line is exactly "a handle on a relay" — the
// bundle cache even validates (relay, caller, roster_id) on every read (see
// rosters.ts's readCached). Storing memberships per machine would let a line
// in one tenant read a bundle fetched by a line in another, which is the one
// thing that validation exists to prevent. Hence `--line` on every command
// here, and rostersFile/rosterCacheFile living under LinePaths.
const roster = program.command("roster").description("join and manage discovery rosters for `agentcall search`");

// Resolves the line a roster/search command acts as, or reports and exits.
// Returns undefined on failure, having already set process.exitCode.
function lineFor(line: string | undefined): LineContext | undefined {
  try {
    return resolveLine(getMachinePaths(), { line });
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    process.exitCode = 1;
    return undefined;
  }
}

registerRosterCore(roster, lineFor);

registerRosterAdmin(roster, lineFor);

registerSearch(program, lineFor);

registerTask(program);
registerGrants(program);

const line = program.command("line").description("manage the addresses (lines) this machine answers on and calls from");

registerLineCore(line);
registerLineAdmin(line);

registerListen(program);

program
  .command("rotate")
  .description("replace a line's relay token (use if it may have leaked)")
  .option("--line <name>", "line to rotate (defaults to the primary line)")
  .action(async (o: { line?: string }) => {
    let ctx: LineContext;
    try {
      ctx = resolveLine(getMachinePaths(), { line: o.line });
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
      return;
    }
    try {
      // The multi-line listener (Task 8) re-reads each line's config.json on
      // every reconnect, so a running listener — foreground or under launchd —
      // picks up the new token on its own; no restart needed here. This is
      // what replaced main's explicit installListenerService() restart: the
      // restart existed only because the old single listener read its token
      // once at startup.
      await rotateLine(ctx);
    } catch (e) {
      console.error(e instanceof ApiError ? e.message : String(e));
      process.exitCode = 1;
    }
  });

registerRecovery(program);

registerUninstall(program);

return program;
}

// Commander actions predate this test seam and communicate failure through
// process.exitCode. Isolate that process-global state here so two in-process
// invocations cannot leak a failure into one another (or into Vitest itself).
export interface CliOutput {
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
