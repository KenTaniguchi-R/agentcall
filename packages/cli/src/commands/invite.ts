import { ApiError, createInvite, listInvites, revokeInvite } from "../api.js";
import { relayUrl } from "../config.js";
import type { LineContext } from "../line-context.js";

type LineFor = (line: string | undefined) => LineContext | undefined;

export function register(program: { command(name: string): any }, lineFor: LineFor): void {
  const invite = program.command("invite").description("manage one-time organization invites");

  invite
    .command("create")
    .description("create a one-time invite")
    .option("--description <text>", "purpose shown in the organization invite inventory", "")
    .option("--expires-in-days <days>", "expiry from 1 to 90 days", "7")
    .option("--role <role>", "enrolled organization role: member or admin")
    .option("--line <name>", "line whose organization to invite into (defaults to the primary line)")
    .action(async (o: { description: string; expiresInDays: string; role?: string; line?: string }) => {
      const ctx = lineFor(o.line);
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        if (o.role !== undefined && o.role !== "admin" && o.role !== "member") {
          throw new Error("--role must be member or admin");
        }
        const created = await createInvite(
          relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token },
          {
            description: o.description, expires_in_days: Number(o.expiresInDays),
            ...(o.role ? { role: o.role } : {}),
          },
        );
        console.log(created.invite);
        console.error(`ID ${created.metadata.id}`);
        console.error(`Expires ${new Date(created.metadata.expires_at).toISOString()}`);
      } catch (e) {
        console.error(e instanceof ApiError ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  invite
    .command("list")
    .description("list organization invite lifecycle metadata")
    .option("--line <name>", "line whose organization to list (defaults to the primary line)")
    .action(async (o: { line?: string }) => {
      const ctx = lineFor(o.line);
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        const invites = await listInvites(relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token });
        console.log(JSON.stringify(invites, null, 2));
      } catch (e) {
        console.error(e instanceof ApiError ? e.message : String(e));
        process.exitCode = 1;
      }
    });

  invite
    .command("revoke")
    .description("revoke an unused organization invite")
    .argument("<id>", "64-character invite ID from `agentcall invite list`")
    .option("--line <name>", "line whose organization the invite belongs to (defaults to the primary line)")
    .action(async (id: string, o: { line?: string }) => {
      const ctx = lineFor(o.line);
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        const revoked = await revokeInvite(
          relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token }, id,
        );
        console.log(`Revoked ${revoked.id} at ${new Date(revoked.revoked_at).toISOString()}`);
      } catch (e) {
        console.error(e instanceof ApiError ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
