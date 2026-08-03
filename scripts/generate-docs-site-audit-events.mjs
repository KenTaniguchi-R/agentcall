import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { AUDIT_EVENT_CATALOG } from "../packages/shared/dist/audit-catalog.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "docs/site/reference/audit-events.mdx");
const lines = [
  "---",
  "title: Audit event catalog",
  "description: Durable tenant audit evidence, availability, export lag, and completeness boundaries.",
  "---",
  "",
  "This catalog is generated from `packages/shared/src/audit-catalog.ts`. A repository test compares it with every durable event literal emitted by the relay, so an event cannot be added or removed silently.",
  "",
  "The availability date is when the event contract entered the repository migration history. A particular self-hosted deployment may lag until it applies that migration.",
  "",
  "| Event | Ledger | Action | Actor types | Target | Collection | Source IP | Available since | Migration |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
];

for (const entry of AUDIT_EVENT_CATALOG) {
  lines.push(
    `| \`${entry.event}\` | ${entry.ledger} | \`${entry.action}\` | ${entry.actors.map((actor) => `\`${actor}\``).join(", ")} | \`${entry.target}\` | ${entry.collection === "synchronous_d1_batch" ? "synchronous D1 batch" : "durable outbox"} | nullable request metadata | ${entry.available_since} | \`${entry.migration}\` |`,
  );
}

lines.push(
  "",
  "## Collection and export lag",
  "",
  "Organization-invite and roster events are inserted in the same awaited D1 batch as their successful security mutation. Once the relay returns that mutation's success response, those events are committed and eligible for a newly started audit export.",
  "",
  "Call events cross the Durable Object/D1 boundary through an idempotent transactional outbox. The call-state update and outbox intent commit atomically in the callee's Durable Object; the relay awaits a D1 delivery attempt before publishing the transition to the caller. If D1 is unavailable, call truth still progresses and the durable intent retries by alarm. Consequently, call evidence is normally export-eligible before the caller observes the transition, but the contract during D1 failure is eventual delivery rather than a wall-clock maximum.",
  "",
  "These are eligibility contracts, not response-time or delivery SLAs. Network latency, D1 availability, export rate limits, and client retries can delay when an administrator receives bytes. Failed/no-op administration mutations and duplicate/out-of-order call frames do not create success evidence.",
  "",
  "Source IP and country are captured from Cloudflare request metadata when available; both fields are nullable. Actor type records the credential class that authorized the mutation and does not imply that every handle is a stable human principal.",
  "",
  "## Conditional polling",
  "",
  "Every successful `GET /v1/audit/events` page returns a strong `ETag` over its validated JSON bytes plus `Cache-Control: private, no-cache, no-transform`. To poll without downloading an unchanged page, repeat the exact URL (including filters, page size, and continuation token) with `If-None-Match: <etag>`. The relay returns a bodyless `304` when the selected representation is unchanged and `200` with a new validator when its checkpoint or page output changes.",
  "",
  "Conditional requests still authenticate, authorize, rate-limit, validate signed cursors, and verify checkpoint completeness before evaluating the validator. An ETag cannot grant cross-tenant access or turn a retention gap into `304`. The CLI's `agentcall audit export` command remains a one-shot complete-stream client; polling integrations should use the API and keep each validator with its exact request URL.",
  "",
  "## Export acknowledgement",
  "",
  "Only the terminal page of an unfiltered, all-time export returns a tenant-bound `completion_receipt`; intermediate, filtered, and date-bounded pages return `null`. After durably storing every page, an administrator can POST that opaque receipt as `completion_receipt` to `/v1/audit/export-acknowledgements`. The signed receipt contains only the tenant and per-ledger ID/count checkpoint, never event or prompt/reply content.",
  "",
  "The write is idempotent and advances the organization’s `org_events` and `roster_events` acknowledgement watermarks atomically. Forged and cross-tenant receipts return `400`; a receipt older than either acknowledged ledger watermark returns `409`. Every export page exposes the current `acknowledged_checkpoint`. This records an administrator’s explicit export-completion assertion for future retention—it does not delete rows, implement a legal hold, or prove that an external destination or backup retained the bytes.",
  "",
  "## Retention and legal-hold control plane",
  "",
  "Organization administrators can read or version-update the tenant event window through `GET`/`PUT /v1/audit/retention-policy`. An absent row reads as the 400-day default; configured values are bounded to 30–2,555 days. Caller-supplied request IDs make retries idempotent, optimistic versions reject stale updates, and every successful mutation commits with `audit.retention.update` evidence.",
  "",
  "`GET`/`POST /v1/audit/legal-holds` reads or creates the tenant’s single active legal/incident hold, `GET /v1/audit/legal-holds/:hold_id` reads active or released state by opaque ID, and `POST /v1/audit/legal-holds/:hold_id/release` releases it without mutating its creation evidence. Create/release retries are idempotent, cross-tenant lookup is indistinguishable from absence, and successful mutations commit with durable audit evidence.",
  "",
  "This is a control plane only. No cron or deletion path consumes the configured window, active hold, or export acknowledgement. It does not expire events, erase a subject, or prove anything about Time Travel, backups, or external exports.",
  "",
  "## Snapshot and ordering contract",
  "",
  "- Page one captures the maximum ID and row count independently for `org_events` and `roster_events`.",
  "- Pages are ordered by event time, then ledger, then ledger-local ID. The ID is not globally comparable across ledgers.",
  "- Events committed after the checkpoint are excluded from that export, even when their timestamps sort earlier.",
  "- Continuation tokens are HMAC-bound to the organization, administrator, exact filters, page size, checkpoint, and position.",
  "- Every continuation recounts checkpointed rows. If count-bounded retention removes one, the relay returns `409`; discard the partial stream and restart.",
  "- Only a stream that reaches an empty continuation token is complete for its printed checkpoint and filters.",
  "",
  "## Evidence boundary",
  "",
  "The catalog is exhaustive for the two currently exported durable ledgers. Call evidence covers submission plus accepted/completed/failed/canceled/timed-out lifecycle outcomes and deliberately excludes prompt and response bodies. It does **not** claim durable task execution detail, tool use, presence/access, delegation-chain, secret-scan, policy-decision, or administrator-login evidence. Endpoint `calls.log` and `tools.log` remain local files and are not part of this tenant export.",
  "",
  "Sampled traces, metrics, Workers logs, and the identity-unlinked `agentcall_status_reads` Analytics Engine dataset are observability, not a complete audit ledger. They cannot prove that an individual action occurred or did not occur and are not merged into this export.",
  "",
  "Current retention is also asymmetric: `org_events` keeps the newest 10,000 rows per organization, while `roster_events` has no time-based deletion path. The roster audit budget gates member-driven mutation churn; it is not a row-count retention ceiling. The event-window and legal-hold control plane is implemented, but subject erasure, continuous export, and time-based deletion are not.",
  "",
  "For export invocation and options, see the [CLI reference](/reference/cli#audit).",
  "",
);

const generated = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) {
    console.error("Audit event reference is stale; run pnpm docs:generate and commit it");
    process.exit(1);
  }
} else {
  writeFileSync(output, generated);
}
