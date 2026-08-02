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
evidence for successful membership mutations. Instead, the Worker writes one
point per authenticated, rate-limit-admitted status probe to the
`agentcall_status_reads` Analytics Engine dataset.

The positional schema is:

| Field | Meaning |
|---|---|
| `index1` | organization (sampling and query boundary) |
| `blob1` | viewer handle |
| `blob2` | requested target handle (malformed values capped at 256 characters) |
| `blob3` | `allowed` or `denied` |
| `blob4` | source IP, or empty when unavailable |
| `blob5` | source country, or empty when unavailable |
| `double1` | event time in epoch milliseconds |

The target's online/offline state is deliberately absent. The dataset records
access, not a presence timeline. Analytics failure is reported with safe
metadata and does not turn observability into an availability dependency.

Cloudflare's current Analytics Engine contract permits one index, twenty blobs,
twenty doubles, 16 KB total blob data, and a 96-byte index. `ORG_RE` caps the
index at 63 ASCII characters; authenticated viewer handles are bounded and a
malformed target is capped before writing, keeping each data point well below
the blob limit. Datasets are created on first write from the Wrangler binding.

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
