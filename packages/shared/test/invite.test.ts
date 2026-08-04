import { describe, expect, it } from "vitest";
import {
  CreateOrgInviteRequest, CreateOrgInviteResponse, ListOrgInvitesResponse,
  MAX_ACTIVE_ORG_INVITES, MAX_LISTED_ORG_INVITES, RevokeOrgInviteResponse,
} from "../src/invite.js";

const metadata = {
  id: "a".repeat(64), description: "contractor onboarding", created_by: "ken",
  created_at: 1, expires_at: 2, used_at: null, used_by: null, revoked_at: null,
  role: "member" as const,
};

describe("organization invite protocol", () => {
  it("defaults bounded creation options", () => {
    expect(CreateOrgInviteRequest.parse({})).toEqual({ role: "member", description: "", expires_in_days: 7 });
    expect(CreateOrgInviteRequest.parse({ role: "admin" }).role).toBe("admin");
    expect(CreateOrgInviteRequest.safeParse({ role: "owner" }).success).toBe(false);
    expect(CreateOrgInviteRequest.safeParse({ expires_in_days: 91 }).success).toBe(false);
    expect(MAX_ACTIVE_ORG_INVITES).toBeLessThanOrEqual(MAX_LISTED_ORG_INVITES);
  });

  it("validates public lifecycle metadata without exposing the invite secret", () => {
    expect(CreateOrgInviteResponse.parse({ invite: "i".repeat(43), metadata }))
      .toEqual({ invite: "i".repeat(43), metadata });
    expect(ListOrgInvitesResponse.parse({ invites: [metadata] })).toEqual({ invites: [metadata] });
    expect(RevokeOrgInviteResponse.parse({ id: metadata.id, revoked_at: 3 }))
      .toEqual({ id: metadata.id, revoked_at: 3 });
    expect(ListOrgInvitesResponse.safeParse({
      invites: Array.from({ length: MAX_LISTED_ORG_INVITES + 1 }, () => metadata),
    }).success).toBe(false);
    const { role: _role, ...missingRole } = metadata;
    expect(CreateOrgInviteResponse.safeParse({ invite: "i".repeat(43), metadata: missingRole }).success)
      .toBe(false);
  });
});
