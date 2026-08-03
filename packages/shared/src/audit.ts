import { z } from "zod";

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

export type AuditExportEventType = z.infer<typeof AuditExportEvent>;
export type AuditCheckpointType = z.infer<typeof AuditCheckpoint>;
export type AuditExportPageType = z.infer<typeof AuditExportPage>;
export type AuditExportAcknowledgementType = z.infer<typeof AuditExportAcknowledgement>;
