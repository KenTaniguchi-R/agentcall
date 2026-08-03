import { describe, expect, it } from "vitest";
import { AuditExportPage } from "../src/audit.js";

describe("audit export protocol", () => {
  it("validates a checkpointed mixed-ledger page", () => {
    const page = {
      events: [{
        ledger: "org", id: 1, event: "org.invite.issue", action_type: "C",
        roster_id: null, actor: "admin", actor_type: "handle", target_type: "invite",
        target_id: "invite-id", target_role: "member", actor_ip: null, actor_country: "US",
        description: "issued", at: 1,
      }],
      checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 0, roster_event_count: 0 },
      next_page_token: "",
    } as const;
    expect(AuditExportPage.parse(page)).toEqual(page);
  });

  it("rejects tenant leakage and malformed authority evidence", () => {
    const base = {
      ledger: "org", id: 1, event: "event", action_type: "C", roster_id: null,
      actor: "admin", actor_type: "handle", target_type: null, target_id: null,
      target_role: null, actor_ip: null, actor_country: null, description: "event", at: 1,
    };
    expect(AuditExportPage.safeParse({
      events: [{ ...base, org: "must-not-cross-boundary" }],
      checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 0, roster_event_count: 0 },
      next_page_token: "",
    }).success).toBe(false);
    expect(AuditExportPage.safeParse({
      events: [{ ...base, target_role: "owner" }],
      checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 0, roster_event_count: 0 },
      next_page_token: "",
    }).success).toBe(false);
  });
});
