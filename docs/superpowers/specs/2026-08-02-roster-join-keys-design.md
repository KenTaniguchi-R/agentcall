# Roster join-key design

Status: implemented by issue #97. This supersedes the singleton join-secret
parts of `2026-08-01-roster-lifecycle-design.md`.

## Decision

A roster has many independently manageable join keys. The wire credential is
`agjk_<12-hex-prefix>_<high-entropy-secret>`. The prefix is public identity and
lookup material; the relay stores only SHA-256 of the secret half. A returned
credential is never stored or listable again.

Creation returns one reusable `initial` key, expiring after 30 days, to preserve
the simple onboarding path. Later issuance defaults to one-off and 30 days,
accepts 1–90 days, and can explicitly opt into reuse. A roster may have at most
100 currently usable keys. Lists return the newest 200 metadata rows, including
the issuer handle, and never return credentials or hashes.

This follows established device-enrollment semantics: Tailscale distinguishes
one-off and reusable keys, bounds expiry to 90 days, and does not remove already
authorized nodes when a key is revoked. Headscale likewise separates a stable
key identity from the stored hash. See:

- <https://tailscale.com/docs/features/access-control/auth-keys>
- <https://github.com/juanfont/headscale/blob/main/hscontrol/types/preauth_key.go>

## Authorization and lifecycle

All key administration requires both the caller's handle credential and the
roster's separate admin secret. Routes are:

- `POST /v1/roster/:id/keys` — issue and reveal once.
- `POST /v1/roster/:id/keys/list` — return metadata only.
- `POST /v1/roster/:id/keys/:prefix/revoke` — revoke, optionally evict.

Revocation prevents future admission but retains current membership. Optional
eviction deletes only membership rows whose `joined_via_prefix` equals that
key. The creator has null provenance and cannot be swept by a join-key revoke.
Expulsion remains available for a named member.

Unknown roster, key prefix, malformed credential, and wrong secret share the
same not-found response. Expired, revoked, and spent one-off keys also fail as
not found. A successful join stores provenance, consumes a one-off key, charges
the roster's persistent membership-audit budget, and writes its audit event in
one D1 batch. Concurrent use therefore admits at most one new member through a
one-off key.

## Storage and rollout

Migration `0008_roster_join_keys.sql` removes `rosters.join_secret_hash`, adds
`roster_join_keys`, and adds `roster_members.joined_via_prefix`. It deliberately
refuses to run if any roster, member, or roster-event row exists. Production had
no roster state when designed, so a clean replacement is safer than a temporary
dual protocol. Operators must verify that precondition again immediately before
deployment and retain a D1 backup.

Audit events are `roster.join_key.issue`, `roster.join_key.revoke`, and
`roster.join_key.evict`. Key rows remain after expiry or revocation for metadata
and provenance; deleting the roster removes live key and membership rows while
retaining append-only audit events.

## Audit-budget exhaustion and recovery

Issue #153 amends the original freeze behavior now that roster membership also
authorizes presence visibility. A roster may append at most 10,000 charged
membership audit events between administrator resets. Creation and successful
joins consume that persistent budget. Rejoining an already-present member is an
idempotent success and consumes nothing. At the maximum, new joins freeze with
HTTP 409 and a recovery instruction; administrative key, expulsion, and roster
deletion operations remain available.

A member's successful leave is a privacy and safety valve: it remains available
at exhaustion, appends `roster.leave`, and does not consume the charged budget.
This means audit growth from departures is not covered by the 10,000-event cap,
but an attacker cannot repeatedly cycle membership without charged joins.

`POST /v1/roster/:id/audit-budget/reset` requires both the caller's handle
credential and the roster admin secret. When the budget is exhausted, it
atomically resets the counter to zero, clears `audit_budget_exhausted_at`, and
appends `roster.audit_budget_reset`. A reset below the maximum is an idempotent
no-op and writes no event. Migration `0010_roster_audit_budget_recovery.sql`
adds the distinct reset event while preserving all existing audit rows and ids.
