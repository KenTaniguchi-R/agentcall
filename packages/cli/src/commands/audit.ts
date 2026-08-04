import type { AuditCheckpointType } from "@benree/agentcall-shared";
import { fetchAuditExportPage, ApiError } from "../api.js";
import { relayUrl } from "../config.js";
import type { LineContext } from "../lineContext.js";
import { AUDIT_CSV_COLUMNS, auditCsvRow, parseAuditFilter, parseAuditTime } from "./audit-export.js";

type LineFor = (line: string | undefined) => LineContext | undefined;

export function register(program: { command(name: string): any }, lineFor: LineFor): void {
  program
    .command("audit")
    .description("export organization audit evidence")
    .command("export")
    .description("stream an administrator-only snapshot as NDJSON or CSV")
    .option("--after <time>", "include events at or after this epoch-millisecond or ISO timestamp")
    .option("--before <time>", "include events before this epoch-millisecond or ISO timestamp")
    .option("--actor <actor>", "include events whose actor field exactly matches")
    .option("--event <event>", "include events whose event type exactly matches")
    .option("--ip <address>", "include events whose source IP exactly matches")
    .option("--format <format>", "output format: ndjson or csv", "ndjson")
    .option("--page-size <count>", "events fetched per relay page, from 1 to 500", "100")
    .option("--line <name>", "line whose organization to export (defaults to the primary line)")
    .action(async (o: {
      after?: string; before?: string; actor?: string; event?: string; ip?: string;
      format: string; pageSize: string; line?: string;
    }) => {
      const ctx = lineFor(o.line);
      if (!ctx) return;
      const cfg = ctx.config;
      try {
        const after = parseAuditTime(o.after, "--after");
        const before = parseAuditTime(o.before, "--before");
        const actor = parseAuditFilter(o.actor, "--actor");
        const event = parseAuditFilter(o.event, "--event");
        const actorIp = parseAuditFilter(o.ip, "--ip");
        const pageSize = Number(o.pageSize);
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 500) {
          throw new Error("--page-size must be an integer from 1 to 500");
        }
        if (o.format !== "ndjson" && o.format !== "csv") throw new Error("--format must be ndjson or csv");
        if (o.format === "csv") console.log(AUDIT_CSV_COLUMNS.join(","));
        let pageToken: string | undefined;
        let checkpoint: AuditCheckpointType | undefined;
        do {
          const page = await fetchAuditExportPage(
            relayUrl(cfg), { org: cfg.org, handle: cfg.handle, token: cfg.token },
            { after, before, actor, event, actor_ip: actorIp, page_size: pageSize, page_token: pageToken },
            { retryRateLimit: true },
          );
          for (const event of page.events) console.log(o.format === "csv" ? auditCsvRow(event) : JSON.stringify(event));
          checkpoint = page.checkpoint;
          pageToken = page.next_page_token || undefined;
        } while (pageToken);
        console.error(`Checkpoint org=${checkpoint?.org_event_id ?? 0} roster=${checkpoint?.roster_event_id ?? 0}`);
      } catch (e) {
        console.error(e instanceof ApiError || e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
      }
    });
}
