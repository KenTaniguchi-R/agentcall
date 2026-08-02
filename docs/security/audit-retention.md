# Audit retention policy

Last verified: 2026-08-02 against repository migration
`0009_org_invite_lifecycle.sql`.

This document is the current retention contract for the hosted relay's D1
security-audit ledgers. It describes implemented behavior, not a compliance
certification or a promise that deletion is available.

## Current behavior

| Ledger | Current application retention | Deletion and export |
|---|---|---|
| `roster_events` | Indefinite, including after roster deletion. The 10,000-event audit budget suppresses member-driven join/leave churn after exhaustion; administrator and system security events remain appendable, so it is not a row-count ceiling. | No customer or application deletion path. No supported export exists. |
| `org_events` | Newest 10,000 events per organization. Every audited organization-invite mutation atomically trims older rows, but there is no time-based window. | No customer deletion path. No supported export exists. Rows removed by the rolling cap are not archived by the application. |

Both tables contain actor and target identifiers, source IP/country, event
descriptions, and timestamps. They can therefore contain personal data and
security evidence. The hosted service cannot currently promise a tenant-level,
person-level, or time-based erasure request. That is a product/compliance
blocker for an organization that requires one.

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

1. A supported export combines `roster_events` and `org_events` into one
   ordered, tenant-scoped contract while preserving each event's ledger/scope.
2. The operator can prove export completeness through the deletion cutoff,
   using a stable checkpoint or equivalent deduplication boundary, before any
   row is removed.
3. A documented default window and a bounded configurable window are applied
   uniformly by event time. Configuration changes are themselves audited.
4. Deletion runs in bounded batches, resumes safely after interruption, exposes
   lag/failure metrics, and cannot block security mutations.
5. Legal holds and incident-preservation overrides are explicit, authorized,
   tenant-scoped, auditable, and take precedence over ordinary expiry.
6. The policy states what happens to Time Travel and every managed or exported
   backup, including when deletion from those copies is impossible or delayed.
7. Tests cover tenant isolation, cutoff boundaries, interrupted retries,
   concurrent writes, export failure, legal holds, and both event ledgers.

Until those requirements are implemented, the honest statement is: roster
audit evidence is retained indefinitely, organization audit evidence is
count-bounded only, and neither ledger has a supported erasure workflow.
