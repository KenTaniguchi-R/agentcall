import type { AuditExportEventType } from "@benree/agentcall-shared";

export const AUDIT_CSV_COLUMNS = [
  "ledger", "id", "event", "action_type", "roster_id", "actor", "actor_type",
  "target_type", "target_id", "target_role", "actor_ip", "actor_country", "description", "at",
] as const satisfies readonly (keyof AuditExportEventType)[];

export function parseAuditTime(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${flag} must be an epoch-millisecond or ISO timestamp`);
  return parsed;
}

export function parseAuditFilter(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) return undefined;
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 1 || bytes > 256) throw new Error(`${flag} must contain 1 to 256 UTF-8 bytes`);
  return value;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = String(value);
  const text = /^\s*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function auditCsvRow(event: AuditExportEventType): string {
  return AUDIT_CSV_COLUMNS.map((column) => csvCell(event[column])).join(",");
}
