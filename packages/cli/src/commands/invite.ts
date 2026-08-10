import {
  sanitizeTerminalCell, stringifyTerminalSafeJson, type OrgInviteMetadataType,
} from "@benree/agentcall-shared";
import { authOf, createInvite, listInvites, revokeInvite } from "../api.js";
import { relayUrl } from "../config.js";
import type { Installation } from "../config.js";
import { fail } from "../errors.js";

type InstallationFor = () => Installation | undefined;

// What an administrator does next with an invite is send it to a person, so
// on a terminal print the message rather than the raw material for it. The
// piped shape is a contract and stays a bare token — see the isTTY branch.
//
// The ID is sha256 of the token (apps/relay/src/invites.ts:58), so showing
// both discloses nothing the holder cannot already derive, and it saves an
// `invite list` round trip when a mis-sent invite has to be cancelled.
function shareableInvite(invite: string, meta: OrgInviteMetadataType): string {
  const expiresAt = new Date(meta.expires_at);
  const days = Math.max(0, Math.round((meta.expires_at - Date.now()) / 86_400_000));
  const role = meta.role === "admin" ? "ADMIN" : meta.role;
  return [
    `Invite created — ${role}, expires in ${days} days (${expiresAt.toISOString().slice(0, 10)}).`,
    // The single most consequential flag on this command used to produce
    // output shape-identical to a member invite. Say what it grants.
    ...(meta.role === "admin"
      ? ["  Grants organization admin: issue and revoke invites, and export the audit log."]
      : []),
    "",
    "  Send this:",
    "",
    "    npm install -g @benree/agentcall",
    `    agentcall setup --invite ${invite}`,
    "",
    `  Revoke it with:  agentcall invite revoke ${meta.id}`,
  ].join("\n");
}

// The four lifecycle fields are nullable timestamps, but the question an
// administrator actually brings to this inventory is "which of these can I
// still revoke?". State is therefore derived for display and never stored.
// Order matters: revocation is terminal, and a used invite that has since
// passed its expiry is still "used" — the expiry stopped being interesting
// the moment it was redeemed.
function inviteState(m: OrgInviteMetadataType, now: number): string {
  if (m.revoked_at !== null) return "revoked";
  if (m.used_at !== null) return `used by ${m.used_by ?? "unknown"}`;
  if (m.expires_at <= now) return "expired";
  return "active";
}

// `ADMIN` in caps for the same reason `invite create` shouts it (#304): an
// admin invite can itself issue invites, revoke invites, and export the org
// audit log, so "did I issue any admin invites?" has to be answerable by
// scanning rather than by reading every row.
function inviteRows(invites: OrgInviteMetadataType[], now: number): string[] {
  const cells = invites.map((m) => [
    inviteState(m, now),
    m.role === "admin" ? "ADMIN" : m.role,
    new Date(m.expires_at).toISOString().slice(0, 10),
    m.description || "—",
    m.id,
    // Description is the caller-controlled cell: MAX_ORG_INVITE_DESCRIPTION
    // bounds its length, nothing bounds its character set, so it arrives able
    // to carry an erase sequence or a line feed. sanitizeTerminalCell rather
    // than sanitizeTerminalOutput, because a row is one line and the newline
    // the latter preserves would forge another. Applied to every cell, not
    // just that one: the rest are regex- or enum-constrained upstream today,
    // and running them through the same call means a later schema relaxation
    // cannot quietly reopen this.
  ].map(sanitizeTerminalCell));
  // Description is caller-supplied and runs to MAX_ORG_INVITE_DESCRIPTION, so
  // the widths come from the data rather than being fixed — one long purpose
  // string would otherwise shear every following column out of alignment.
  const widths = cells.reduce<number[]>(
    (w, row) => row.map((c, i) => Math.max(w[i] ?? 0, c.length)), [],
  );
  // The last column is never padded: trailing spaces are invisible, and the
  // 64-char ID sits there so a narrow terminal wraps the ID instead of
  // breaking the readable columns in front of it.
  return cells.map((row) =>
    row.map((c, i) => (i === row.length - 1 ? c : c.padEnd(widths[i]))).join("  "),
  );
}

export function register(program: { command(name: string): any }, installationFor: InstallationFor): void {
  const invite = program.command("invite").description("manage one-time organization invites");

  invite
    .command("create")
    .description("create a one-time invite")
    .option("--description <text>", "purpose shown in the organization invite inventory", "")
    .option("--expires-in-days <days>", "expiry from 1 to 90 days", "7")
    .option("--role <role>", "enrolled organization role: member or admin")
    .action(async (o: { description: string; expiresInDays: string; role?: string }) => {
      const ctx = installationFor();
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        if (o.role !== undefined && o.role !== "admin" && o.role !== "member") {
          throw new Error("--role must be member or admin");
        }
        const created = await createInvite(
          relayUrl(cfg), authOf(cfg),
          {
            description: o.description, expires_in_days: Number(o.expiresInDays),
            ...(o.role ? { role: o.role } : {}),
          },
        );
        if (process.stdout.isTTY) console.log(shareableInvite(created.invite, created.metadata));
        else {
          // Piped or redirected: stdout stays exactly the token and nothing
          // else, so `agentcall invite create > token.txt` keeps working.
          console.log(created.invite);
          console.error(`ID ${created.metadata.id}`);
          console.error(`Expires ${new Date(created.metadata.expires_at).toISOString()}`);
        }
      } catch (e) {
        fail(e);
      }
    });

  invite
    .command("list")
    .description("list organization invites: state, role, expiry, and the ID to revoke")
    .option("--json", "print the raw invite array")
    .action(async (o: { json?: boolean }) => {
      const ctx = installationFor();
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        const invites = await listInvites(relayUrl(cfg), authOf(cfg));
        // stringifyTerminalSafeJson, not JSON.stringify: JSON escapes C0
        // controls but passes C1 and bidi through literally, and `--json`
        // still lands in a terminal often enough to matter.
        if (o.json) { console.log(stringifyTerminalSafeJson(invites)); return; }
        if (invites.length === 0) {
          console.log("No invites yet. Create one with:\n  agentcall invite create");
          return;
        }
        for (const row of inviteRows(invites, Date.now())) console.log(row);
      } catch (e) {
        fail(e);
      }
    });

  invite
    .command("revoke")
    .description("revoke an unused organization invite")
    .argument("<id>", "64-character invite ID from `agentcall invite list`")
    .action(async (id: string) => {
      const ctx = installationFor();
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        const revoked = await revokeInvite(
          relayUrl(cfg), authOf(cfg), id,
        );
        console.log(`Revoked ${revoked.id} at ${new Date(revoked.revoked_at).toISOString()}`);
      } catch (e) {
        fail(e);
      }
    });
}
