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
  "| Event | Ledger | Action | Actor types | Target | Source IP | Available since | Migration |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];

for (const entry of AUDIT_EVENT_CATALOG) {
  lines.push(
    `| \`${entry.event}\` | ${entry.ledger} | \`${entry.action}\` | ${entry.actors.map((actor) => `\`${actor}\``).join(", ")} | \`${entry.target}\` | nullable request metadata | ${entry.available_since} | \`${entry.migration}\` |`,
  );
}

lines.push(
  "",
  "## Collection and export lag",
  "",
  "There is no asynchronous application ingestion queue. Each listed event is inserted in the same awaited D1 batch as its successful security mutation. Once the relay returns that mutation's success response, the event is committed and eligible for a newly started audit export.",
  "",
  "That is a read-after-success eligibility contract, not a wall-clock response-time or delivery SLA. Network latency, D1 availability, export rate limits, and client retries can still delay when an administrator receives the bytes. Failed or no-op mutations do not create success evidence.",
  "",
  "Source IP and country are captured from Cloudflare request metadata when available; both fields are nullable. Actor type records the credential class that authorized the mutation and does not imply that every handle is a stable human principal.",
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
  "The catalog is exhaustive for the two currently exported durable ledgers. It does **not** claim durable call, task execution, tool use, presence/access, delegation-chain, secret-scan, policy-decision, or administrator-login evidence. Endpoint `calls.log` and `tools.log` remain local files and are not part of this tenant export.",
  "",
  "Sampled traces, metrics, Workers logs, and the identity-unlinked `agentcall_status_reads` Analytics Engine dataset are observability, not a complete audit ledger. They cannot prove that an individual action occurred or did not occur and are not merged into this export.",
  "",
  "Current retention is also asymmetric: `org_events` keeps the newest 10,000 rows per organization, while `roster_events` has no time-based deletion path. The roster audit budget gates member-driven mutation churn; it is not a row-count retention ceiling. Legal holds, subject erasure, continuous export, and time-based retention are not implemented.",
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
