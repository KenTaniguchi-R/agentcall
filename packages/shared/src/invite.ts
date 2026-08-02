import { z } from "zod";
import { HANDLE_RE, ORG_RE } from "./protocol.js";

export const ORG_INVITE_ID_RE = /^[a-f0-9]{64}$/;
export const MAX_ACTIVE_ORG_INVITES = 100;
export const MAX_LISTED_ORG_INVITES = 200;
export const MAX_ORG_INVITE_DESCRIPTION = 100;
export const DEFAULT_ORG_INVITE_EXPIRY_DAYS = 7;
export const MAX_ORG_INVITE_EXPIRY_DAYS = 90;

export const CreateOrgInviteRequest = z.object({
  description: z.string().max(MAX_ORG_INVITE_DESCRIPTION).optional().default(""),
  expires_in_days: z.number().int().min(1).max(MAX_ORG_INVITE_EXPIRY_DAYS)
    .optional().default(DEFAULT_ORG_INVITE_EXPIRY_DAYS),
});

export const BootstrapOrgInviteRequest = CreateOrgInviteRequest.extend({
  org: z.string().regex(ORG_RE),
});

export const OrgInviteMetadata = z.object({
  id: z.string().regex(ORG_INVITE_ID_RE),
  description: z.string().max(MAX_ORG_INVITE_DESCRIPTION),
  created_by: z.string().regex(HANDLE_RE).nullable(),
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  used_at: z.number().int().nonnegative().nullable(),
  used_by: z.string().regex(HANDLE_RE).nullable(),
  revoked_at: z.number().int().nonnegative().nullable(),
});

export const CreateOrgInviteResponse = z.object({
  invite: z.string().min(40).max(200),
  metadata: OrgInviteMetadata,
});

export const ListOrgInvitesResponse = z.object({
  invites: z.array(OrgInviteMetadata).max(MAX_LISTED_ORG_INVITES),
});

export const RevokeOrgInviteResponse = z.object({
  id: z.string().regex(ORG_INVITE_ID_RE),
  revoked_at: z.number().int().nonnegative(),
});

export type OrgInviteMetadataType = z.infer<typeof OrgInviteMetadata>;
