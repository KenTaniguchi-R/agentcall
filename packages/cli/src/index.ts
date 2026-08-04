import { Command, CommanderError } from "commander";
import type { AgentKind } from "@benree/agentcall-shared";
import { getLinePaths, getMachinePaths, type LinePaths } from "./paths.js";
import { assertCallableLine, relayUrl, type LineConfig } from "./config.js";
// No rotateToken here: `rotate` goes through commands/rotate.ts's rotateLine,
// which owns the per-line config write and calls the api helper itself.
import { ApiError, getStatus, createRoster, joinRoster, leaveRoster,
  expelRosterMember, issueRosterJoinKey, listRosterJoinKeys, revokeRosterJoinKey, deleteRoster,
  } from "./api.js";
import { assertValidLineName, readyLines } from "./lines.js";
import { resolveAddress } from "./contacts.js";
import { resolveLine } from "./lineContext.js";
import type { LineContext } from "./lineContext.js";
import { register as registerCall } from "./commands/call.js";
import { rotateLine } from "./commands/rotate.js";
import { runRecoveryIssue, runRecoveryRedeem } from "./commands/recovery.js";
import { addLine, listLinesReport } from "./commands/line.js";
import { register as registerLineAdmin } from "./commands/line-admin.js";
import { ask as ttyAsk } from "./tty.js";
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

roster
  .command("create")
  .description("create a roster and print its initial reusable join key")
  .option("--as <name>", "local name to record it under", "roster")
  .option("--line <name>", "line to create it as (defaults to the primary line)")
  .action(async (o: { as: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const { roster_id, join_key, admin_secret } = await createRoster(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
      console.log("Roster created.\n");
      console.log(`  id:     ${roster_id}`);
      console.log(`  join key:     ${join_key}`);
      console.log(`  admin secret: ${admin_secret}\n`);
      console.log("Both credentials are shown once and are not recoverable. Store the admin secret in a password manager.");
      console.log("Share only the id and join key with colleagues:");
      console.log(`  agentcall roster join ${roster_id} --key ${join_key} --as ${o.as}`);
      try {
        saveMembership(ctx.paths, { name: o.as, relay: relayUrl(cfg), roster_id });
        console.log(`\nSaved locally as "${o.as}".`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `${message}\nRoster was created but not saved locally. Save it with a different name:\n` +
          `  agentcall roster join ${roster_id} --key ${join_key} --as <name>`,
        );
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

roster
  .command("join")
  .description("join a roster so `agentcall search` can see its members")
  .argument("<roster-id>", "roster id shared by whoever created it")
  .requiredOption("--key <key>", "a roster join key")
  .option("--as <name>", "local name for this roster", "roster")
  .option("--line <name>", "line to join as (defaults to the primary line)")
  .action(async (rosterId: string, o: { key: string; as: string; line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      await joinRoster(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token }, rosterId, o.key);
      // The key is spent here and never written to disk: from now on the
      // handle token plus the relay-side membership row is what authorizes.
      try {
        saveMembership(ctx.paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
        console.log(`Joined. Saved locally as "${o.as}".`);
        console.log(`Try: agentcall search "<what you need to know>"`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `${message}\nYou joined roster ${rosterId}, but it was not saved locally. Re-run with a different name:\n` +
          `  agentcall roster join ${rosterId} --key <same-key> --as <name>`,
        );
        process.exitCode = 1;
      }
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

roster
  .command("list")
  .description("list rosters this line has joined")
  .option("--line <name>", "line to list for (defaults to the primary line)")
  .action((o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const rosters = loadMemberships(ctx.paths);
    if (rosters.length === 0) {
      console.log("No rosters joined. Ask a colleague for a roster id and join key, then:\n  agentcall roster join <id> --key <key> --as <name>");
      return;
    }
    for (const r of rosters) console.log(`${r.name}\t${r.roster_id}\t${r.relay}`);
  });

roster
  .command("leave")
  .description("leave a roster on the relay and remove its local record")
  .argument("<name>", "local roster name")
  .option("--line <name>", "line to leave it for (defaults to the primary line)")
  .action(async (name: string, o: { line?: string }) => {
    const ctx = lineFor(o.line);
    if (!ctx) return;
    const cfg = ctx.config;
    try {
      const membership = namedRoster(ctx.paths, name);
      await leaveRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id);
      forgetMembership(ctx.paths, name);
      deleteCached(ctx.paths, name);
      console.log(`Left "${name}" and removed its local record.`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = 1;
    }
  });

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

line
  .command("add")
  .description("register another address on this machine")
  .argument("<name>", "local name for this line, e.g. codex (never shared — the handle is)")
  .option("--handle <handle>", "handle to register (prompted if omitted)")
  .option("--invite <token>", "one-time organization invite (required — each line enrolls in its own tenant)")
  .option("--agent <agent>", "agent kind: claude or codex (omit with --caller-only)")
  .option("--relay <url>", "relay URL to register against")
  .option("--caller-only", "register a handle to call others without making this line's agent callable")
  .option("--skip-service", "skip reinstalling the background listener service")
  .option("--no-verify", "skip verifying the agent can answer a test call")
  .action(
    async (
      name: string,
      o: { handle?: string; invite?: string; agent?: string; relay?: string; callerOnly?: boolean; skipService?: boolean; verify?: boolean },
    ) => {
      const machine = getMachinePaths();
      if (!o.callerOnly && o.agent !== "claude" && o.agent !== "codex") {
        console.error("Pass --agent claude or --agent codex, or --caller-only for a line that can only call out.");
        process.exitCode = 1;
        return;
      }
      // Validated here too, not just inside addLine: addLine's own check
      // never burns a handle (see its "Validate BEFORE the network call"
      // comment), but it runs AFTER the handle prompt below — so
      // `agentcall line add "Bad Name"` would ask the owner to choose a
      // handle and only then reject the name, wasting a prompt on a doomed
      // command. Failing fast here is a UX fix, not a safety one.
      try {
        assertValidLineName(name);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
        return;
      }
      // Same reasoning as the line-name check above: addLine re-checks this
      // before it touches the network, but doing it here too avoids prompting
      // for a handle on a command that cannot possibly register.
      if (!o.invite?.trim()) {
        console.error(`An organization invite is required. Run \`agentcall line add ${name} --invite <token>\`.`);
        process.exitCode = 1;
        return;
      }
      const handle = o.handle ?? (await ttyAsk(`Choose a handle for "${name}" (e.g. ${name}): `)).trim();
      if (!handle) {
        console.error("A handle is required.");
        process.exitCode = 1;
        return;
      }
      const relay = (o.relay ?? relayUrl()).replace(/\/+$/, "");
      try {
        const { address } = await addLine(machine, {
          name,
          handle,
          relay,
          invite: o.invite,
          agent: o.callerOnly ? undefined : (o.agent as AgentKind),
          callerOnly: o.callerOnly,
          verify: o.verify,
          installListenerServiceFn: o.skipService ? () => {} : undefined,
        });
        console.log(`Added line "${name}": ${address}`);
      } catch (e) {
        console.error(String(e instanceof Error ? e.message : e));
        process.exitCode = 1;
      }
    },
  );

line
  .command("list")
  .description("list the addresses this machine holds, which is primary, and whether each is online")
  .option("--json", "print the full row data (name, address, relay, state, primary) as JSON")
  .action(async (o: { json?: boolean }) => {
    const machine = getMachinePaths();
    // listLinesReport's presence callback is synchronous (it's a pure report
    // over what's already on disk), so the network round-trip has to happen
    // first: one relay status check per callable line, keyed by handle
    // (unique per machine — addLine refuses a duplicate) since listLinesReport
    // re-reads config from disk itself and won't hand back the same object
    // reference this loop read.
    const online = new Map<string, boolean>();
    for (const l2 of readyLines(machine)) {
      if (!l2.config.agent_kind) continue; // caller-only: nothing listens, nothing to probe
      try {
        online.set(
          l2.config.handle,
          (await getStatus(relayUrl(l2.config), l2.config.handle, {
            org: l2.config.org, handle: l2.config.handle, token: l2.config.token,
          })).online,
        );
      } catch {
        online.set(l2.config.handle, false);
      }
    }
    const rows = listLinesReport(machine, (cfg: LineConfig) => online.get(cfg.handle) ?? false);
    if (o.json) {
      console.log(JSON.stringify(rows));
      return;
    }
    if (rows.length === 0) {
      console.log("No lines yet. Run `agentcall setup` to create the first one.");
      return;
    }
    for (const r of rows) {
      console.log(`${r.name.padEnd(10)} ${r.address.padEnd(32)} ${r.state}${r.primary ? "   primary" : ""}`);
    }
  });

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
