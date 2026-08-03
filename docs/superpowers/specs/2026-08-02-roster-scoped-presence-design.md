# Roster-scoped presence

**Date:** 2026-08-02

**Status:** Implemented

**Issue:** [#116](https://github.com/KenTaniguchi-R/agentcall/issues/116)

## Decision

Presence is directional authorization derived from an existing relay-owned
relationship:

- a handle may always read its own status;
- a handle may read a peer's status when both are current members of at least
  one roster in the same organization;
- every unrelated or nonexistent target receives the same generic 404;
- call delivery remains independent of roster membership.

This adopts issue #116's roster-scoped option without adding an XMPP-style
pair-subscription state machine. The latter would need a consent inbox and a
new lifecycle UI that the product does not have. Shared roster membership is
already attested by the relay for calls and card projection, and membership
leave, expulsion, eviction, and roster deletion revoke presence immediately.

The self exception keeps setup verification and owner diagnostics useful. It
does not create an existence oracle because successful authentication already
proves that identity exists.

## Authorization and non-enumerability

Peer authorization uses `sharedRosterIds`, the same D1 query that attests group
membership for call admission and card projection. A non-empty result proves
both the target's membership and the viewer's authorization. No separate
handle-existence lookup runs before denial, so an existing unrelated target
and an unknown target take the same code path and produce the same status,
headers, and body.

Authentication remains first. Anonymous and invalid-token requests return 401
before the target is inspected. Rate limiting remains ahead of authorization
so denied namespace sweeps consume the same read budget as allowed reads.

## Status-read evidence

Reads do not enter `roster_events`: that bounded D1 ledger is append-only
evidence for successful membership mutations. The later
[presence telemetry and audit boundary](./2026-08-02-presence-telemetry-audit-boundary.md)
removed subject-bearing access metadata from Analytics Engine. The Worker now
writes one identity-unlinked statistical point per authenticated, rate-limit-admitted
status probe to `agentcall_status_reads`.

The positional schema is:

| Field | Meaning |
|---|---|
| `index1` | `allowed` or `denied` (sampling and grouping boundary) |
| `double1` | event time in epoch milliseconds |

The target's online/offline state and all tenant, subject, and network dimensions
are deliberately absent. The dataset records statistical volume, not access
evidence or a presence timeline. A locally observable binding failure increments
the non-personal `telemetry_health` D1 singleton; asynchronous ingestion and
sampling remain unknowable and do not turn observability into availability.

Cloudflare's current Analytics Engine contract permits 250 points per invocation
and retains points for three months. This route writes one small point. Queries
must weight sampled rows by `_sample_interval`; individual records and exact
sequences are not guaranteed retrievable.

## Verification invariants

- self status continues to report online/offline;
- shared-roster peers receive status;
- unrelated and unknown targets are byte-identical;
- allowed and denied authenticated probes emit the documented event shape;
- anonymous and bad-token probes remain 401;
- read throttling remains enforced before authorization.

## References

- [Cloudflare Analytics Engine get started](https://developers.cloudflare.com/analytics/analytics-engine/get-started/)
- [Cloudflare Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [RFC 6121 roster semantics](https://datatracker.ietf.org/doc/html/rfc6121#section-3)
