# Cloud data map and residency decision

Production infrastructure metadata and Cloudflare documentation were last
verified on 2026-08-02. The application-state inventory was updated on
2026-08-03 through issue #229; deployment verification remains pending.

This is the living inventory for data persisted or processed by AgentCall's
hosted relay. Update it whenever a migration, Durable Object storage key,
analytics binding, logging sink, or retention rule changes.

## Current answer

The hosted relay does **not** currently make a regional data-residency claim.

- Production D1 database `agentcall` (`f67097f0-2521-4c41-a9d4-1402682038aa`)
  reports `running_in_region: WNAM`, `jurisdiction: null`, and read replication
  disabled. This was verified with `wrangler d1 info agentcall --json`; WNAM is
  current placement, not a configured residency guarantee.
- Neither `HANDLE_DO` nor `RATE_LIMITER_DO` derives IDs from a jurisdictional
  subnamespace. Existing objects were placed near their first access and are
  not region-restricted.
- Presence-access metadata is stored in Workers Analytics Engine for three
  months. The repository does not declare a Customer Metadata Boundary,
  Workers Logs setting, Logpush job, or Regional Services configuration;
  account/dashboard settings must be audited separately.
- The Worker runs on a custom domain and disables `workers.dev`, but that is a
  routing/security control, not regional processing.

Decision: **do not pin only the Durable Objects.** That would strand the current
object IDs while leaving identity, credential, membership, audit, analytics,
request-processing, and logging data outside the claim. A regional offering
must be a planned new deployment or migration covering every row below and the
non-database surfaces, not a one-line `.jurisdiction()` change.

Confidential computing is also not a residency substitute or a current relay
target. A Nitro Enclaves deployment could hide application-layer routing state
from an EC2 parent while still exposing network and traffic-shape metadata and
still processing data in AWS. The dated
[TEE deployment decision](../superpowers/specs/2026-08-03-tee-relay-deployment-decision.md)
keeps that option trigger-gated rather than presenting it as a roadmap.

## Accepted lifecycle direction — not implemented

AgentCall has committed to a supported subject-erasure path and bounded retention;
indefinite retention is current behavior, not the target policy. The accepted
[subject-erasure and retention design](../superpowers/specs/2026-08-02-subject-erasure-and-retention-design.md)
chooses:

- a disclosed, potentially personal but identity-unlinked address quarantine that is
  hard-deleted after 30 days, then organization-authorized reclaim onto a fresh
  `agent_id` and Durable Object;
- immediate deletion of subject-owned active data and inbound policy references;
- crypto-shredding of readable identity fields in append-only audit events, with
  source IP/country moved to a deletable 30-day sidecar;
- a 400-day audit-event default and 30-day ordinary maximum for audit network evidence;
- explicit pending/held results for Analytics Engine, logs, Time Travel, backups, or
  legal holds that prevent verified completion.

The event-window and tenant legal-hold control plane now exists, but no job
deletes audit evidence or implements subject erasure. The tables below continue
to describe deployed storage behavior. Do not promise erasure, expiry, or an SLA
from configuration alone.

## D1 inventory

D1 is the durable identity and relationship system of record. Token, recovery,
join, and admin secrets are stored only as SHA-256 hashes; hashes are still
authentication data and remain sensitive. Unless the table says otherwise,
there is no time-based cleanup job.

| Table | Contents and sensitivity | Application retention |
|---|---|---|
| `handles` | Organization, handle, admin/member role, token hash, agent kind, creation time. Direct identity, authority, and an authentication verifier; personal data. | Indefinite. Token rotation replaces the hash. Handle release/deletion is not implemented. |
| `invites` | Invite hash/public ID, organization, granted role, purpose, issuer handle, creation/expiry/use/revocation times, and enrolled handle. Authentication, authority, and relationship data; personal data when issuer or user handles identify people. | Active rows remain until used, revoked, or expired. An admin invite write deletes terminal rows after 30 days; D1 Time Travel and exported backups retain separate copies. |
| `audit_export_acknowledgements` | Organization, acknowledged per-ledger ID/count checkpoint, acknowledging administrator handle, and time. Retention-control evidence and personal data; no exported event or prompt/reply content. | One monotonic row per organization, replaced only by a checkpoint that does not regress either ledger. No deletion path exists; future retention may consume but must not exceed these watermarks. |
| `audit_legal_holds` | Organization, opaque hold ID, administrator-provided reason, creator/releaser handles, idempotency keys, and timestamps. Legal/incident preservation policy plus personal and potentially confidential data. | Immutable creation fields and released state are retained indefinitely. At most one active hold exists per tenant. No expiry worker consumes it yet. |
| `audit_retention_policies` | Organization, configured 30–2,555-day event window, optimistic version, updater handle/time, and last idempotency key. Retention policy and personal administration metadata. | One current row per configured organization; absent rows read as the 400-day default. No deletion path exists and the value does not yet trigger expiry. |
| `audit_retention_policy_requests` | Organization, idempotency key, requested window, expected/resulting versions, actor handle, and time. Mutation replay/conflict evidence and personal administration metadata. | Retained indefinitely. It prevents an old request ID from mutating policy again; no cleanup policy exists yet. |
| `org_events` | Organization-invite, call-lifecycle, retention-policy, and legal-hold administration action; organization; actor and target identities/types; granted target role where applicable; source IP/country; description; and time. Call rows identify caller/callee addresses and a call ID but exclude prompt/response bodies. Security audit evidence and personal data. | The newest 10,000 events per organization are retained. Invite and audit-control mutations trim in their D1 batch; call transitions use an idempotent Durable Object outbox and trim on D1 delivery. Invite-row cleanup does not otherwise delete audit evidence. Admin-only checkpointed export is supported; configured time-based/legal retention does not yet trigger expiry. |
| `cards` | Handle, agent description/type, task catalogue/examples/keywords, default offers, per-caller grants/blocks, roster-group grants, update time. User-authored content plus relationship policy; potentially confidential and personal. | Indefinite, with an upsert replacing the prior card. No delete path exists. |
| `encryption_keys` | Organization, handle, key ID, cryptographic suite, public key, monotonic epoch, validity window, predecessor, signature, and creation time. Signed key material and key-rotation provenance; cryptographic identity data. | Indefinite. Epochs are monotonic per identity to prevent relay-orchestrated key rollback. Revocation and cleanup of expired keys are not currently implemented. |
| `identity_keys` | Organization, handle, identity public key, and creation time. Cryptographic identity root; the trust anchor for a given identity pinned by contacts. | Indefinite. One per identity; the relay refuses replacement to prevent silent re-pointing of pinned relationships. Losing an identity key requires registering a new identity. |
| `rosters` | Roster ID, organization, admin-secret hash, creation time, audit-budget counters. Organization and authentication data. | Until an administrator deletes the roster. |
| `roster_join_keys` | Public key prefix, roster/organization, secret hash, description, issuer handle, lifecycle times, reuse/use state. Authentication, provenance, and personal data. | Expired/revoked keys remain for provenance; all rows are deleted with the roster. |
| `roster_members` | Roster/organization/handle membership, join time, and admitting key prefix. Personal relationship and provenance data. | Until leave, expulsion, key-based eviction, or roster deletion. |
| `roster_events` | Append-only mutation event/action, roster/organization, actor and target identities/types, source IP/country, human-readable description, time. Security audit evidence and personal data. | Indefinite, including after roster deletion. The per-roster 10,000-event counter gates member-driven join/leave churn; administrator and system events remain appendable for recovery and are not bounded by that counter. The counter is not a row-count ceiling. |
| `telemetry_health` | Sink name, cumulative locally observed write-failure count, and first/last failure times. Non-personal operational health metadata; it contains no tenant, subject, outcome, route, or network dimension. | Indefinite. There is no reset or application deletion path. It proves only that the Worker observed a binding-call failure, not how many events Analytics Engine later sampled or lost. |

The current operational and future deletion rules for both event ledgers and
their retention/hold controls are
defined in the [audit retention policy](./audit-retention.md). In particular,
the administrator-only readiness API computes cutoff and export-coverage counts
without copying or deleting event rows. It is a transactionally consistent D1
read, not a new datastore or durable authorization. The repository still has no
automated expiry or supported erasure path today; count-bounding `org_events` is
a capacity control, not a retention period.

Cloudflare also maintains `d1_migrations`, which records applied migration
filenames and is operational metadata rather than end-user data. D1 Time Travel,
Cloudflare backups, and exported SQL backups may create copies of table rows
with their own vendor/operator retention. Cloudflare account audit logs are
separate operational records that may independently contain personal metadata.
This repository does not configure a deletion schedule for any of those
surfaces.

## Durable Object inventory

### `HandleDO`

One object is addressed by `org + handle`, so the object ID itself is indirect
identity metadata. Cloudflare states that a `DurableObjectId` may be logged
outside its configured jurisdiction for billing and debugging even when the
object is restricted.

| State | Contents and sensitivity | Application retention |
|---|---|---|
| WebSocket state and serialized attachments | Live listener/caller sockets; organization, caller/callee handles, source IP/country when available, relay-attested roster IDs, call ID, and test timeout. Personal/relationship metadata. Message and outcome content passes only as signed HPKE ciphertext. | Socket lifetime; attachments support hibernation and disappear with the socket. |
| `call:*` | Call ID, organization, caller/callee handles, correlation ID, deadline, timestamps, native/A2A lifecycle state, and an opaque encrypted outcome envelope. Context IDs, reply text, peer failure codes/details, and offered tasks are not relay-visible fields. Personal activity metadata plus short-lived ciphertext. | Retained through the call's original configured six-minute deadline so the caller can retrieve status after disconnecting. An alarm deletes expired records; alarm delivery may be delayed or retried, so six minutes is the logical timeout rather than a strict physical-retention maximum. |
| `audit:*` | Idempotency key plus organization, call ID, lifecycle event/outcome, caller or callee actor, nullable source IP/country, description, and timestamp. Prompt and response bodies are excluded. Security evidence and personal data awaiting D1 delivery. | Created atomically with the corresponding `call:*` transition and deleted after idempotent insertion into `org_events`. D1 failures retain the entry and schedule alarm retry; there is no wall-clock maximum while D1 remains unavailable. |
| `rl:*` | Per-caller timestamps inside the callee's object. Personal activity metadata. | One-hour logical window. A charged call starts an expired-key sweep at most once per minute; each event processes at most four 128-key pages. A short-lived cursor (temporarily repeating one `rl:<handle>` key) and alarm continue larger backlogs in bounded events until complete, then delete the cursor. An idle object with no pending sweep can retain stale keys until its next charged call, but cannot accumulate while idle. A non-identifying timestamp throttles new sweeps. |

### `RateLimiterDO`

Sixty-four SQLite-backed shard objects store a `hits` table with the full rate
limit key, hit time, and expiry. Keys include source IPs and strings containing
organizations, handles, roster IDs, or operation prefixes, depending on the
route. They are personal/security metadata. Each request deletes expired rows;
an alarm schedules cleanup after expiry, but delivery may be delayed or retried.
Current logical windows are one minute.

The native `CARD_RL`, `READ_RL`, and `ROSTER_READ_RL` bindings are a third,
Cloudflare-managed counter surface. Their keys include IP addresses or
organization/handle/roster identifiers and their configured window is 60
seconds. The application cannot enumerate this state and Cloudflare's product
documentation does not provide an application-level deletion control for it.

## Analytics, logs, secrets, and transient content

| Surface | Contents and sensitivity | Retention/location control |
|---|---|---|
| `agentcall_status_reads` (Workers Analytics Engine) | Identity-unlinked allowed/denied outcome points and timestamps. This is sampled statistical product telemetry, not an access ledger; online/offline state, tenant, subject, route, IP, and country are deliberately omitted. Exact timestamps may still be correlated with information held elsewhere. | Cloudflare retains Analytics Engine data for three months, samples at write and query time, and does not guarantee retrieval of individual records. WAE is unavailable outside the US region under CMB and has no per-dataset jurisdiction setting in this repository. |
| Workers invocation/custom/error logs | Request metadata can contain handle/roster route parameters. The status-telemetry error contains only error class and whether the D1 health counter was recorded; it never contains tenant, subject, outcome, card body, or raw error. | Workers Logs retain up to 3 days on Free or 7 days on Paid when enabled. This repository does not declare observability, sampling, Logpush, or a destination, so dashboard/account state must be verified separately. |
| Call content | Caller messages, task/context identifiers, replies, and peer failure content traverse the Worker, `HandleDO`, and WebSockets only as signed HPKE ciphertext. An opaque outcome envelope is written to `call:*` until its original deadline for live delivery; A2A projection is status-only. | Ciphertext has the bounded `call:*` retention above and is not written to D1, Analytics Engine, or console logs. The relay still processes and can log routing, lifecycle, network, timing, and size metadata; endpoint-local plaintext is outside Cloudflare residency controls. |
| Worker code and `BOOTSTRAP_TOKEN` | Deployed code plus the operator secret that can mint the first organization invite. | Cloudflare documents that Workers code and secrets are deployed globally even when Regional Services restricts execution. Customer Metadata Boundary does not cover customer configuration or operational debugging metadata. |

Endpoint-local files such as `~/.agentcall/config.json`, policies, contacts,
roster cache, context bindings, `calls.log`, `tools.log`, and task/work directories
remain on the user's machine. They are outside Cloudflare residency controls and
must be covered separately by endpoint retention, backup, and device-management
policy. The cloud map does not turn local storage into relay storage.

## What Cloudflare controls actually mean

These controls are independent and do not compose automatically:

| Control | Current Cloudflare guarantee | AgentCall implication |
|---|---|---|
| D1 jurisdiction | Creation-time only; currently `eu` and `fedramp`. The database runs and stores data inside that jurisdiction. It cannot be added or changed on an existing database. | Production has none. A compliant D1 requires a new database plus a controlled data migration/cutover. D1 has no `us` or `jp` jurisdiction today. |
| D1 location hint | Best-effort primary placement (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`), not a guarantee. | WNAM/APAC is a latency choice, never acceptable evidence for US/Japan residency. |
| Durable Object jurisdiction | `eu`, `us`, or `fedramp`; object compute and storage remain in the selected jurisdiction. | Must cover both DO namespaces. The same name produces a different ID inside a jurisdiction, so existing `org:handle` objects and limiter shards require migration or abandonment. DO IDs may still be logged outside the jurisdiction. |
| Durable Object location hint | Best effort on first `get()` only; objects do not currently relocate. | `apac-ne` can reduce Japan latency but is not Japan residency. |
| Regional Services | Restricts where a regionalized custom domain terminates TLS and executes Worker requests. | Needed in addition to store jurisdictions for a processing-location claim. It does not regionalize outgoing subrequests, code, or secrets. |
| Customer Metadata Boundary | Enterprise account-level EU or US boundary for covered logs/analytics, with product-specific gaps. Global is the default. | Must be audited outside the repository. WAE's EU limitation means an EU deployment must remove/replace the current presence dataset or obtain a documented supported path. |
| Logpush | Exports supported datasets to operator-controlled storage; it is transport, not Cloudflare search/storage. | Destination region, retention, failures, and duplicate delivery become the operator's responsibility. No job is declared here. |

Official references:

- [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)
- [Durable Objects data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Data Localization Suite product compatibility](https://developers.cloudflare.com/data-localization/compatibility/)
- [Regionalizing Workers](https://developers.cloudflare.com/data-localization/how-to/workers/)
- [Customer Metadata Boundary](https://developers.cloudflare.com/data-localization/metadata-boundary/)
- [Workers Analytics Engine limits and retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Workers Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
- [Logpush](https://developers.cloudflare.com/logs/logpush/)

## Regional conclusions

- **EU:** technically reachable only as a new, coordinated deployment: EU D1,
  both DO namespaces in EU, Regional Services, CMB, and an explicit replacement
  for the current WAE presence dataset. Claims must still disclose globally
  deployed Worker code/secrets and DO-ID billing/debug metadata.
- **US:** not fully supportable on this D1 architecture today. DOs support `us`,
  but D1 does not; WNAM is merely a placement hint/result.
- **Japan:** not supportable through Cloudflare jurisdictions today. Neither D1
  nor DO has `jp`; `apac`/`apac-ne` hints are best effort. An in-country
  requirement needs a different store/deployment architecture or a self-hosted
  relay in Japan.

## Adoption gate

Before any residency claim or jurisdiction code change:

1. choose the exact claim (storage, processing, logs/analytics, backups, and
   operator access) and region;
2. create new jurisdictional stores rather than mutating existing IDs;
3. define export/import, validation, cutover, rollback, and deletion of old
   D1/DO state and backups;
4. regionalize the custom domain and audit account-level CMB, Workers Logs,
   Logpush, Analytics Engine, and Cloudflare audit settings;
5. verify every table and storage key in this document after deployment; and
6. have legal/security review the vendor guarantees and residual metadata,
   rather than deriving a compliance statement from configuration alone.

Until that gate is complete, the truthful statement is: **the hosted relay uses
Cloudflare's global platform, with production D1 currently running in WNAM and
no configured storage jurisdiction.**

The supported [customer-owned relay](../self-hosting.md) moves operational
control and every declared Cloudflare resource into the customer's account. It
does not move AgentCall off Cloudflare and does not turn account ownership into
a residency guarantee. The customer must evaluate and configure every surface
in this document before making a locational claim.
