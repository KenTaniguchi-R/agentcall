# Audit retention policy

Last reviewed: 2026-08-03 against the retention control plane in issue #227.
Deployment verification remains pending.

This document is the current retention contract for the hosted relay's D1
security-audit ledgers. It describes implemented behavior, not a compliance
certification or a promise that deletion is available.

## Current behavior

| Ledger | Current application retention | Deletion and export |
|---|---|---|
| `roster_events` | Indefinite, including after roster deletion. The 10,000-event audit budget suppresses member-driven join/leave churn after exhaustion; administrator and system security events remain appendable, so it is not a row-count ceiling. | No customer or application deletion path. Included in the supported administrator export. |
| `org_events` | Newest 10,000 events per organization. Audited invite and audit-control mutations trim in their D1 batch; call-lifecycle events trim when their idempotent Durable Object outbox reaches D1. There is no time-based window. | No customer deletion path. Included in the supported administrator export; rows removed by the rolling cap are not archived by the application. |

Both tables contain actor and target identifiers, source IP/country, event
descriptions, and timestamps. They can therefore contain personal data and
security evidence. Organization administrators can export both ledgers through
`GET /v1/audit/events` or `agentcall audit export`. The API captures maximum IDs
and row counts for both ledgers on page one, orders by event time/ledger/ID, and
uses a relay-secret HMAC to bind every continuation token to that checkpoint,
tenant, administrator, exact actor/event/source-IP filters, time filters, and
page size. The CLI streams NDJSON by default and CSV with `--format csv`; both
formats preserve the same snapshot contract. A concurrent append cannot enter
an in-progress export. Every continuation also recounts rows at or below the
checkpoint and aborts with `409` if retention removed one, so a caller must
discard partial output unless the stream reaches its final checkpoint.

An unfiltered, all-time export that reaches its terminal page receives a signed
completion receipt containing only its tenant and per-ledger ID/count
checkpoint. After storing the full stream, an administrator can explicitly
acknowledge that receipt. The relay atomically advances a monotonic checkpoint
in `audit_export_acknowledgements`; partial, filtered, date-bounded, forged,
cross-tenant, and stale-regressing receipts cannot advance it. This watermark
is implemented evidence for a future retention cutoff, but no deletion job
consumes it and the acknowledgement cannot prove the state of an external
archive or backup. The hosted service still cannot promise a tenant-level,
person-level, or time-based erasure request. That is a product/compliance
blocker for an organization that requires one.

The administrator-only retention control plane reports a 400-day event default
and accepts versioned tenant overrides from 30 through 2,555 days. Updates use
caller-supplied idempotency keys and optimistic versions, and commit atomically
with `audit.retention.update` evidence. A tenant may also have one active legal
or incident hold. Hold creation and release preserve immutable creator/reason
fields, are idempotent, and commit atomically with `audit.hold.create` or
`audit.hold.release` evidence. Released holds cannot be reactivated by replay.

These controls are prerequisites, not retention execution. No scheduled or
manual application job reads the configured window, active hold, or export
watermark to delete an event. A configured value therefore does not shorten or
extend current storage, and an active hold affects no surface yet.

Presence reads are not a third audit ledger. `agentcall_status_reads` contains
only identity-unlinked outcome points in Analytics Engine and is sampled, retained
for three months, and fail-open. The `telemetry_health` D1 singleton counts only
locally observed binding-call failures. Neither surface can establish that an
individual read occurred or support tenant audit export. The durable store for
future access decisions and centrally retained abuse verdicts belongs to issue
#17 and must satisfy this policy's export, retention, erasure, legal-hold, and
failure-visibility requirements.

## Accepted retention target — partially implemented

The [subject-erasure and retention decision](../superpowers/specs/2026-08-02-subject-erasure-and-retention-design.md)
commits the hosted product to a 400-day default for structured audit events and a
30-day ordinary maximum for source IP/country evidence. Only an explicitly authorized
legal/incident hold may exceed the network-evidence limit; that is reported as a held
exception, never configured as a longer ordinary window. Subject-bearing fields move out of
free-form descriptions and behind per-subject erasure keys. Network evidence moves to
a deletable short-retention sidecar. An authorized erasure can therefore destroy
readable identity evidence and delete subject-linked network evidence without editing
the append-only event. Pseudonymous event fields remain personal data and still expire
normally.

Automatic expiry remains gated on backup, bounded-batch, network-evidence, and
failure-visibility requirements below. The tenant window and hold control plane
is implemented, but until an expiry worker safely consumes it, the current
ledger behavior in the table above remains authoritative.

There is no Worker cron, scheduled D1 cleanup, or relay API for audit expiry.
The relay operator may perform exceptional time-based D1 maintenance, but that
is an unsupported manual operation: it must be reviewed, use an approved
cutoff and backup/legal-hold procedure, and be recorded outside the
application. Routine retention never selects rows by `actor`, `target_id`, IP
address, or event type. A legally reviewed erasure or correction request may
require different targeted handling; the application neither implements nor
prescribes that process today.

D1 Time Travel, Cloudflare-managed backups, and exported SQL backups may hold
separate copies of D1 rows with their own vendor/operator lifetimes. Cloudflare
account audit logs are separate operational records that may independently
contain personal metadata. Deleting live D1 rows does not prove any of those
surfaces were deleted. Any response to a legal deletion or preservation request
must inventory them separately.

## Requirements before automated expiry

Time-based expiry belongs to the org-level audit/export work in issue #17 and
must not ship independently. Expiry is safe only when all of these are true:

1. **Implemented:** the supported export combines `roster_events` and
   `org_events` into one ordered, tenant-scoped contract while preserving each
   event's ledger/scope.
2. **Implemented:** each stream carries stable per-ledger checkpoints, and a
   terminal unfiltered export can produce a tenant-bound completion receipt
   that advances an atomic, monotonic acknowledgement watermark. Retention
   automation must require and verify that watermark before deleting through a
   cutoff.
3. **Control plane implemented:** a documented 400-day default and 30–2,555-day
   configurable event window are schema/API bounded, versioned, and audited.
   No expiry worker applies the configured window yet.
4. Deletion runs in bounded batches, resumes safely after interruption, exposes
   lag/failure metrics, and cannot block security mutations.
5. **Control plane implemented:** legal holds and incident-preservation
   overrides are explicit, administrator-authorized, tenant-scoped, idempotent,
   and audited. A future expiry worker must fail closed on the active hold.
6. The policy states what happens to Time Travel and every managed or exported
   backup, including when deletion from those copies is impossible or delayed.
7. Tests cover tenant isolation, cutoff boundaries, interrupted retries,
   concurrent writes, export failure, legal holds, and both event ledgers.

Until the remaining requirements are implemented, the honest statement is:
both ledgers have a supported admin export and retention/hold control plane,
roster audit evidence is retained indefinitely, organization audit evidence is
count-bounded only, and neither ledger has automated expiry or a supported
erasure workflow.
