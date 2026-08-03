import { describe, expect, it } from "vitest";
import {
  AuditLegalHold, AuditLegalHoldCreateRequest, AuditLegalHoldReleaseRequest,
  AuditExportAcknowledgement, AuditExportAcknowledgementRequest, AuditExportPage,
  AuditRetentionPolicy, AuditRetentionPolicyUpdateRequest,
} from "../src/audit.js";

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
      completion_receipt: "receipt",
      acknowledged_checkpoint: null,
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
      completion_receipt: null,
      acknowledged_checkpoint: null,
    }).success).toBe(false);
    expect(AuditExportPage.safeParse({
      events: [{ ...base, target_role: "owner" }],
      checkpoint: { org_event_id: 1, org_event_count: 1, roster_event_id: 0, roster_event_count: 0 },
      next_page_token: "",
      completion_receipt: null,
      acknowledged_checkpoint: null,
    }).success).toBe(false);
  });

  it("validates the strict acknowledgement wire contract", () => {
    expect(AuditExportAcknowledgementRequest.parse({ completion_receipt: "receipt" }))
      .toEqual({ completion_receipt: "receipt" });
    expect(AuditExportAcknowledgement.parse({
      acknowledged_checkpoint: {
        org_event_id: 2, org_event_count: 2, roster_event_id: 1, roster_event_count: 1,
      },
      acknowledged_by: "admin",
      acknowledged_at: 1_000,
    })).toMatchObject({ acknowledged_by: "admin", acknowledged_at: 1_000 });
    expect(AuditExportAcknowledgementRequest.safeParse({
      completion_receipt: "receipt", org: "must-not-be-client-controlled",
    }).success).toBe(false);
  });

  it("validates bounded retention policy and legal hold contracts", () => {
    expect(AuditRetentionPolicy.parse({
      event_retention_days: 400, version: 0, updated_by: null, updated_at: null,
    })).toMatchObject({ event_retention_days: 400, version: 0 });
    expect(AuditRetentionPolicyUpdateRequest.parse({
      event_retention_days: 365, expected_version: 0, request_id: "a".repeat(32),
    })).toMatchObject({ event_retention_days: 365, expected_version: 0 });
    expect(AuditRetentionPolicyUpdateRequest.safeParse({
      event_retention_days: 29, expected_version: 0, request_id: "a".repeat(32),
    }).success).toBe(false);
    expect(AuditRetentionPolicyUpdateRequest.safeParse({
      event_retention_days: 2_556, expected_version: 0, request_id: "a".repeat(32),
    }).success).toBe(false);
    expect(AuditRetentionPolicy.safeParse({
      event_retention_days: 400, version: 0, updated_by: "admin", updated_at: 1,
    }).success).toBe(false);

    const hold = {
      hold_id: `hold_${"b".repeat(32)}`,
      reason: "incident preservation",
      created_by: "admin",
      created_at: 1,
      released_by: null,
      released_at: null,
    };
    expect(AuditLegalHold.parse(hold)).toEqual(hold);
    expect(AuditLegalHold.safeParse({ ...hold, released_by: "admin" }).success).toBe(false);
    expect(AuditLegalHoldCreateRequest.parse({
      reason: " incident preservation ", request_id: "c".repeat(32),
    })).toEqual({ reason: "incident preservation", request_id: "c".repeat(32) });
    expect(AuditLegalHoldReleaseRequest.parse({ request_id: "d".repeat(32) }))
      .toEqual({ request_id: "d".repeat(32) });
    expect(AuditLegalHoldCreateRequest.safeParse({
      reason: "", request_id: "c".repeat(32), org: "must-not-be-client-controlled",
    }).success).toBe(false);
  });
});
