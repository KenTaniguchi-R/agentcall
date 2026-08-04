import type { Command } from "commander";
import { createRoster, joinRoster, leaveRoster } from "../api.js";
import { relayUrl } from "../config.js";
import type { LineContext } from "../line-context.js";
import { deleteCached, forgetMembership, loadMemberships, saveMembership } from "../rosters.js";

type ResolveLine = (line: string | undefined) => LineContext | undefined;

export function register(roster: Command, lineFor: ResolveLine): void {
  roster.command("create")
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
          console.error(`${message}\nRoster was created but not saved locally. Save it with a different name:\n  agentcall roster join ${roster_id} --key ${join_key} --as <name>`);
          process.exitCode = 1;
        }
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });

  roster.command("join")
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
        try {
          saveMembership(ctx.paths, { name: o.as, relay: relayUrl(cfg), roster_id: rosterId });
          console.log(`Joined. Saved locally as "${o.as}".`);
          console.log("Try: agentcall search \"<what you need to know>\"");
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          console.error(`${message}\nYou joined roster ${rosterId}, but it was not saved locally. Re-run with a different name:\n  agentcall roster join ${rosterId} --key <same-key> --as <name>`);
          process.exitCode = 1;
        }
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });

  roster.command("list")
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

  roster.command("leave")
    .description("leave a roster on the relay and remove its local record")
    .argument("<name>", "local roster name")
    .option("--line <name>", "line to leave it for (defaults to the primary line)")
    .action(async (name: string, o: { line?: string }) => {
      const ctx = lineFor(o.line);
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        const membership = loadMemberships(ctx.paths).find((r) => r.name.toLowerCase() === name.toLowerCase());
        if (!membership) throw new Error(`No roster named "${name}" — run \`agentcall roster list\`.`);
        await leaveRoster(membership.relay, { org: cfg.org, handle: cfg.handle, token: cfg.token }, membership.roster_id);
        forgetMembership(ctx.paths, name);
        deleteCached(ctx.paths, name);
        console.log(`Left "${name}" and removed its local record.`);
      } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; }
    });
}
