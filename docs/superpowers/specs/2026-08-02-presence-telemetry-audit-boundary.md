# Presence telemetry and audit boundary

Date: 2026-08-02  
Decision: accepted and implemented for current status-read telemetry  
Issues: #156; constrains #17, #18, and #47

## Decision

`agentcall_status_reads` is statistical product telemetry, not an access log.
The Worker writes only an identity-unlinked `allowed` or `denied` outcome and an
event timestamp. Organization, viewer, target, source IP, and country do not
enter Analytics Engine. Exact timestamps can still be correlated with request
knowledge or logs held elsewhere, so this is de-identified rather than anonymous.
Removing the stable dimensions is required by the accepted
subject-erasure boundary because Analytics Engine has no application deletion
path and retains points for three months.

No feature may use this dataset alone to attribute a particular read to a
subject, reliably reconstruct an ordered sequence, export a tenant's access
history, or prove completeness. Cloudflare may retain and return individual
points, but samples at write and query time and expressly does not guarantee
that any individual record can be retrieved. Aggregate
queries must weight rows by `_sample_interval`; a raw `COUNT(*)` is not an
estimated event count. The intended query shape is:

```sql
SELECT index1 AS outcome, SUM(_sample_interval) AS estimated_reads
FROM agentcall_status_reads
WHERE timestamp >= NOW() - INTERVAL '1' DAY
GROUP BY index1
```

Cloudflare currently retains Analytics Engine data for three months, permits at
most 250 data points per Worker invocation, and does not make Workers Metrics
and Analytics available outside the US region under Customer Metadata Boundary.
The status route emits one point per invocation today, so the per-invocation
limit is not approached; any future batching or shared writer must recheck it.

## Failure visibility

Analytics Engine's `writeDataPoint()` returns immediately and ingestion happens
outside the request. The application can observe a synchronous binding-call
exception, but it cannot learn whether an accepted point is later sampled or
lost. On an observable exception, the Worker increments the singleton
`telemetry_health` D1 row for `agentcall_status_reads`, recording only a
cumulative count and first/last failure times. The row contains no tenant,
subject, network, route, or outcome dimension.

The counter outlives ordinary Workers Logs and makes a known degradation
durable. It is not a lost-event count or an ingestion completeness measure.
If the health-row update also fails, status remains available and a generic
short-lived log records that the counter was not persisted. Telemetry and its
health signal remain fail-open by design.

## Store ownership

- #17's future tenant audit/export product reads durable, tenant-scoped audit
  storage designed with export checkpoints, retention, erasure, holds, and
  completeness evidence. It may show `telemetry_health` as operator health,
  but must never export Analytics Engine points as tenant access evidence.
- #47 Tier 1 continues to read the callee's local `calls.log` and `tools.log`.
  Future centrally retained abuse verdicts use the durable audit path from #17;
  identity-unlinked Analytics Engine estimates may inform capacity trends only.
- #18 treats the three-month ceiling, sampling, US-only CMB limitation,
  asynchronous loss, and fail-open behavior as explicit telemetry constraints,
  not as a compliant audit control.

Security-relevant denied reads may justify a durable event type later, but that
is not smuggled into this change. Such a path is attacker-triggerable and must
ship with a bounded write budget, tenant isolation, retention/erasure semantics,
export, and degradation visibility.

## References

- [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- [Analytics Engine sampling](https://developers.cloudflare.com/analytics/analytics-engine/sampling/)
- [Analytics Engine SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/)
- [Workers data localization](https://developers.cloudflare.com/data-localization/how-to/workers/)
