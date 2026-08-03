import { z } from "zod";

export const DEFAULT_AUDIT_EVENT_RETENTION_DAYS = 400;
export const MIN_AUDIT_EVENT_RETENTION_DAYS = 30;
export const MAX_AUDIT_EVENT_RETENTION_DAYS = 2_555;
export const AUDIT_CONTROL_REQUEST_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const AUDIT_HOLD_ID_RE = /^hold_[a-f0-9]{32}$/;

export const AuditLedger = z.enum(["org", "roster"]);

export const AuditExportEvent = z.object({
  ledger: AuditLedger,
  id: z.number().int().positive(),
  event: z.string().min(1),
  action_type: z.enum(["C", "R", "U", "D"]),
  roster_id: z.string().nullable(),
  actor: z.string(),
  actor_type: z.string(),
  target_type: z.string().nullable(),
  target_id: z.string().nullable(),
  target_role: z.enum(["admin", "member"]).nullable(),
  actor_ip: z.string().nullable(),
  actor_country: z.string().nullable(),
  description: z.string(),
  at: z.number().int().nonnegative(),
}).strict();

export const AuditCheckpoint = z.object({
  org_event_id: z.number().int().nonnegative(),
  org_event_count: z.number().int().nonnegative(),
  roster_event_id: z.number().int().nonnegative(),
  roster_event_count: z.number().int().nonnegative(),
}).strict();

export const AuditExportPage = z.object({
  events: z.array(AuditExportEvent),
  checkpoint: AuditCheckpoint,
  next_page_token: z.string(),
  completion_receipt: z.string().max(1_024).nullable(),
  acknowledged_checkpoint: AuditCheckpoint.nullable(),
}).strict();

export const AuditExportAcknowledgementRequest = z.object({
  completion_receipt: z.string().min(1).max(1_024),
}).strict();

export const AuditExportAcknowledgement = z.object({
  acknowledged_checkpoint: AuditCheckpoint,
  acknowledged_by: z.string().min(1),
  acknowledged_at: z.number().int().nonnegative(),
}).strict();

const AuditRetentionWindow = z.number().int().min(MIN_AUDIT_EVENT_RETENTION_DAYS)
  .max(MAX_AUDIT_EVENT_RETENTION_DAYS);

export const AuditRetentionPolicy = z.union([z.object({
  event_retention_days: AuditRetentionWindow,
  version: z.literal(0),
  updated_by: z.null(),
  updated_at: z.null(),
}).strict(), z.object({
  event_retention_days: AuditRetentionWindow,
  version: z.number().int().positive(),
  updated_by: z.string().min(1),
  updated_at: z.number().int().nonnegative(),
}).strict()]);

export const AuditRetentionPolicyUpdateRequest = z.object({
  event_retention_days: AuditRetentionWindow,
  expected_version: z.number().int().nonnegative(),
  request_id: z.string().regex(AUDIT_CONTROL_REQUEST_ID_RE),
}).strict();

const AuditLegalHoldCreation = {
  hold_id: z.string().regex(AUDIT_HOLD_ID_RE),
  reason: z.string().min(1).max(500),
  created_by: z.string().min(1),
  created_at: z.number().int().nonnegative(),
};

export const AuditLegalHold = z.union([z.object({
  ...AuditLegalHoldCreation,
  released_by: z.null(),
  released_at: z.null(),
}).strict(), z.object({
  ...AuditLegalHoldCreation,
  released_by: z.string().min(1),
  released_at: z.number().int().nonnegative(),
}).strict()]);

export const AuditLegalHoldState = z.object({
  active_hold: AuditLegalHold.nullable(),
}).strict();

export const AuditLegalHoldCreateRequest = z.object({
  reason: z.string().trim().min(1).max(500),
  request_id: z.string().regex(AUDIT_CONTROL_REQUEST_ID_RE),
}).strict();

export const AuditLegalHoldReleaseRequest = z.object({
  request_id: z.string().regex(AUDIT_CONTROL_REQUEST_ID_RE),
}).strict();

export type AuditExportEventType = z.infer<typeof AuditExportEvent>;
export type AuditCheckpointType = z.infer<typeof AuditCheckpoint>;
export type AuditExportPageType = z.infer<typeof AuditExportPage>;
export type AuditExportAcknowledgementType = z.infer<typeof AuditExportAcknowledgement>;
export type AuditRetentionPolicyType = z.infer<typeof AuditRetentionPolicy>;
export type AuditLegalHoldType = z.infer<typeof AuditLegalHold>;
