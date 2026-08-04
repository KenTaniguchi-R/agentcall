import { Command, CommanderError } from "commander";
import { getMachinePaths, type LinePaths } from "./paths.js";
import { relayUrl } from "./config.js";
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
import { deleteCached, forgetMembership, loadMemberships, saveMembership } from "./rosters.js";
import { ask } from "./tty.js";
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

async function adminSecret(flag?: string): Promise<string> {
  const value = flag ?? process.env.AGENTCALL_ADMIN_SECRET;
  if (value) return value;
  const prompted = (await ask("Admin secret: ")).trim();
  if (!prompted) throw new Error("An admin secret is required.");
  return prompted;
}

async function confirmRoster(name: string, consequence: string, yes?: boolean): Promise<void> {
  if (yes) return;
  const answer = (await ask(`${consequence} Type the roster name "${name}" to continue: `)).trim();
  if (answer !== name) throw new Error("Confirmation did not match; nothing was changed.");
}

function namedRoster(paths: LinePaths, name: string) {
  const membership = loadMemberships(paths).find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!membership) throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
  return membership;
}

roster
  .command("expel")
  .description("remove a member using the roster admin secret")
  .argument("<name>", "local roster name")
  .argument("<handle>", "member handle to remove")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, handle: string, o: { adminSecret?: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      await expelRosterMember(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, handle, await adminSecret(o.adminSecret));
      console.log(`Expelled ${handle}. Revoke any join key they may still know.`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

const rosterKey = roster.command("key").description("issue, list, and revoke scoped roster join keys");

rosterKey
  .command("issue")
  .description("issue a one-off join key (use --reusable for a shared key)")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--description <text>", "short label shown by `roster key list`", "")
  .option("--expires-in <days>", "expiry in days (1-90)", (v) => Number.parseInt(v, 10), 30)
  .option("--reusable", "allow more than one member to use this key")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, o: { adminSecret?: string; description: string; expiresIn: number; reusable?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      if (!Number.isInteger(o.expiresIn) || o.expiresIn < 1 || o.expiresIn > 90) {
        throw new Error("--expires-in must be an integer from 1 to 90.");
      }
      const out = await issueRosterJoinKey(
        membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id,
        await adminSecret(o.adminSecret), {
          description: o.description, expiresInDays: o.expiresIn, reusable: Boolean(o.reusable),
        },
      );
      console.log(`Join key (shown once): ${out.join_key}`);
      console.log(`Prefix: ${out.key.prefix}  Expires: ${new Date(out.key.expires_at).toISOString()}`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

rosterKey
  .command("list")
  .description("list join-key metadata without revealing secrets")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, o: { adminSecret?: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      const keys = await listRosterJoinKeys(
        membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id,
        await adminSecret(o.adminSecret),
      );
      if (keys.length === 0) { console.log("No join keys."); return; }
      const now = Date.now();
      for (const key of keys) {
        const state = key.revoked_at !== null ? "revoked" : key.expires_at <= now ? "expired" : key.used && !key.reusable ? "used" : "active";
        console.log(`${key.prefix}\t${state}\t${key.reusable ? "reusable" : "one-off"}\t${new Date(key.expires_at).toISOString()}\t${key.created_by}\t${key.description}`);
      }
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

rosterKey
  .command("revoke")
  .description("revoke one join key; --evict removes only members admitted by it")
  .argument("<name>", "local roster name")
  .argument("<prefix>", "12-character public key prefix from `roster key list`")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--evict", "remove members admitted by this key")
  .option("--yes", "confirm targeted eviction")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, prefix: string, o: { adminSecret?: string; evict?: boolean; yes?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      if (o.evict) await confirmRoster(name, `This removes members admitted by key ${prefix}.`, o.yes);
      const out = await revokeRosterJoinKey(
        membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id,
        prefix, await adminSecret(o.adminSecret), Boolean(o.evict),
      );
      if (o.evict) deleteCached(ctx.paths, name);
      console.log(`Revoked ${out.prefix}.${o.evict ? ` Evicted ${out.evicted} member(s).` : " Existing members were retained."}`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("delete")
  .description("permanently delete a roster while retaining its relay audit events")
  .argument("<name>", "local roster name")
  .option("--admin-secret <secret>", "admin secret (prefer AGENTCALL_ADMIN_SECRET to avoid shell history)")
  .option("--yes", "confirm deletion")
  .option("--line <name>", "line to act as (defaults to the primary line)")
  .action(async (name: string, o: { adminSecret?: string; yes?: boolean; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      await confirmRoster(name, "Roster deletion cannot be undone.", o.yes);
      await deleteRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id, await adminSecret(o.adminSecret));
      forgetMembership(ctx.paths, name);
      deleteCached(ctx.paths, name);
      console.log(`Deleted "${name}"; relay audit events were retained.`);
    } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
  });

roster
  .command("forget")
  .description("drop only the local roster record; use `roster leave` to remove relay membership")
  .argument("<name>", "local roster name")
  .option("--line <name>", "line to forget it for (defaults to the primary line)")
  .action((name: string, o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    try {
      forgetMembership(ctx.paths, name);
      console.log(`Forgot "${name}" locally. Your membership on the relay is unchanged; use \`roster leave\` for removal.`);
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exitCode = 1;
    }
  });

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
