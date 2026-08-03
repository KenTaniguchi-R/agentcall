# Callee-owned budget boundary

Date: 2026-08-02  
Decision: accepted; implementation tracked by #181 after #154  
Issue: #111; constrains #17, #22, #47, #99, #104, #114, #154, and #181

## Current facts

An inbound AgentCall spends the callee's local Claude or Codex allowance. The
relay rate limits requests, but neither the relay nor the listener limits the
number or runtime of accepted agent processes. The callee's `calls.log` records
completed duration, which is useful history but cannot stop a run in progress.

The current private frame identifies the caller only by handle. This is not a
durable budget subject: the accepted identity decision in #100 makes
relay-assigned `agent_id` stable across rename and gives a reclaimed handle a
new principal. The zero-user cutover in #154 must land before the budget ledger
so this feature does not create another handle-keyed state migration.

AgentCall does not mediate model traffic. Its Claude JSON parser currently keeps
only the answer and session id, and its Codex JSONL parser keeps only the agent
message and thread id. Claude documents usage and cost in non-interactive JSON
output and exposes related fields to status-line integrations, but those fields
may be absent. No documented stable Codex `exec --json` usage schema was found.
Either parser is an adapter to an installed CLI, not an enforcement point that
the product controls.

## Decision

Ship callee-owned **call-count and agent-runtime budgets** before claiming token
or currency budgets. They are crude resource proxies, but they use inputs the
listener owns and can enforce before and during a run.

The first implementation is local and per line:

- `policy.json` can set an optional default budget and narrower per-caller
  budget using `max_calls_per_utc_day` and
  `max_agent_seconds_per_utc_day`;
- managed policy can set ceilings for the same fields. Effective limits are the
  minimum of every applicable managed, default, and caller value. A user can
  narrow an administrator limit but cannot raise or remove it;
- an omitted limit means that dimension is not locally capped. Zero denies all
  calls on that dimension. Limits are non-negative integers;
- the relay-attested immediate caller `agent_id`, scoped by relay trust domain
  and organization, is the ledger key. The current handle is stored only as an
  event-time display snapshot. Group and organization hierarchy remain future
  layers because AgentCall does not yet have stable organization accounting
  principals. Neither ID nor handle is presented as a person or billing
  identity; and
- windows are UTC calendar days. The day in which a job starts owns the charge,
  including runs that cross midnight.

The policy shape is intentionally additive to the stable caller entries created
by #154:

```json
{
  "budget": {
    "max_calls_per_utc_day": 20,
    "max_agent_seconds_per_utc_day": 3600
  },
  "callers": {
    "agt_01JEXAMPLE": {
      "handle": "ryu",
      "offer": ["ask"],
      "budget": { "max_calls_per_utc_day": 5 }
    }
  }
}
```

Managed policy uses `budget_ceiling` and optional
`caller_budget_ceilings[agent_id]` objects with the same two dimensions. An
absent caller field inherits the applicable default; it does not erase it.
Group membership does not currently change a budget because a caller can be in
multiple groups and no stable organization accounting hierarchy exists yet.

The budget protects the callee, so the caller cannot override it in a request.
Task timeouts remain independent safety limits and can only make the effective
runtime shorter.

## Reserve before spawn

A post-run debit is accounting, not enforcement. Admission uses this order:

1. Resolve the authenticated caller, effective policy, task, and context without
   spawning an agent.
2. Under an exclusive per-line ledger lock, roll the ledger to the current UTC
   day, reject an exhausted call count, and calculate remaining runtime.
3. Reserve one call and `min(task hard deadline, remaining runtime)` seconds
   against the call id. If no positive runtime remains, reject. Persist the
   reservation atomically before sending `call_accepted` or launching the
   child.
4. Run the child against that hard deadline. Begin graceful termination early
   enough that the existing kill grace ends at the reserved deadline; send
   `SIGKILL` no later than the deadline rather than starting the grace period
   there.
5. Under the same lock, settle runtime to `ceil(actual milliseconds / 1000)` and
   release unused reserved seconds. Settlement is capped at the reservation and
   can never increase it. If process exit is observed after the deadline due to
   signal or scheduler lag, retain the full reservation and emit an overrun
   degradation event with the observed lag. The call-count charge is not
   refunded: an accepted process consumed callee capacity even if it failed or
   was canceled.

The listener currently has no pending queue, but the reservation belongs inside
the queued job immediately before `call_accepted`; this keeps the rule correct
if queuing is added later. The file lock must cover multiple listener processes,
not only one JavaScript event loop. A stale or unreadable lock is an operator
error that fails closed until repaired; guessing that no reservation exists
would reopen the cap.

If the listener dies after reservation and before settlement, the full reserved
runtime remains charged through that UTC window. This can underutilize the daily
allowance, but cannot overspend it. Ordinary startup does not infer liveness
from a PID or silently forgive the reservation: PIDs can be reused, and a crash
can occur before child identity is durably attached. No automatic early-release
path ships in the first implementation. A later explicit repair flow needs a
boot-scoped process identity and an audited owner decision.

The store retains any prior-day window that still has an unsettled reservation.
Settlement is written back to the reservation's start-day window, never the
current day. A new UTC day receives a new allowance; retaining the old record
prevents late settlement or repair from rewriting the new day's usage.

The ledger is a separate atomic JSON store, not a reconstruction from
`calls.log`. An absent store is initialized under the lock on the first
budgeted call. Audit append failure must not mutate or erase the enforcement
state. Conversely, a malformed, unreadable, locked, or unwritable ledger denies
a call whenever an effective budget applies. Unbudgeted calls do not acquire
the ledger lock.

## Verdicts, warnings, and records

Budget exhaustion is a distinct protocol verdict, `budget_exhausted`, sent
before spawn. It is not `busy`, `rate_limited`, or `agent_error`. The caller is
not told the remaining amount or which layer supplied the limit, because that
would provide a remote budget oracle.

The local audit record distinguishes `budget_exhausted`, `budget_reserved`,
`budget_settled`, and `budget_degraded`, with call id, stable caller `agent_id`,
event-time handle snapshot, UTC window, dimension, and integer units. It never
contains prompts, model credentials, or agent session ids. The owner-facing
status/history surface shows limit, used, reserved, and remaining values plus
their user/managed provenance.

Soft warnings are owner-facing events when committed plus reserved usage first
crosses 80% in a window. They do not alter admission and are emitted at most
once per caller, dimension, and UTC day. Managed policy may lower the threshold
but user policy cannot raise it. A future admin export can retain these bounded
events; aggregate sampled telemetry is not a complete ledger and must never be
used to enforce or prove a cap.

## Usage and cost telemetry

Parsing Claude/Codex usage is worth pursuing once for budgets and OpenTelemetry,
but it starts as optional observation:

- keep a versioned adapter and captured fixtures for every supported CLI
  version/format;
- accept only finite, non-negative integer token counts and explicitly tagged
  currency/units;
- record missing or unknown fields as unavailable, never as zero;
- expose adapter degradation locally and test it against installed-version
  probes; and
- do not use parsed values for a hard stop until the upstream format is a
  documented compatibility surface or AgentCall controls the model boundary.

After-the-fact tokens can populate local history and OTel metrics. They cannot
produce a real-time token stop for a single non-streaming CLI invocation. A
monthly currency answer also requires an explicit price table and subscription
semantics; token counts must not be relabeled as dollars or subscription quota.

## Rejected model proxy

Do not inject `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, or a transparent model
proxy for the current product. Exact gateway metering would require model
requests, prompts, responses, and credentials to traverse a newly operated
boundary. It conflicts with the local-processing/E2EE direction and would also
capture unrelated work unless the answering run had isolated credentials and a
forced network substrate. That is a different deployment product, not an
incremental budget feature.

## Acceptance boundary

The implementation is complete only when tests prove:

- count exhaustion rejects before `call_accepted` and before runner invocation;
- runtime is reserved before spawn, bounds the child's hard deadline, and
  refunds only unused seconds after process exit;
- cancellation and runner failure keep the call charge and settle runtime;
- a simulated crash leaves a conservative reservation;
- UTC rollover does not release an active prior-day reservation or misattribute
  its settlement;
- rename preserves the stable subject's usage, while handle reclaim starts a
  fresh subject with no inherited usage or reservations;
- user settings cannot exceed a managed ceiling;
- a missing store initializes safely, while corrupt, unreadable, locked, and
  unwritable budget state fail closed without affecting unbudgeted calls;
- concurrent listener processes cannot both spend the same remaining units;
  and
- a child that delays exit after `SIGTERM` is forcibly stopped at the reserved
  hard deadline, settlement never exceeds the reservation, and any observed
  deadline lag produces degradation evidence.

No UI, org ledger, currency cap, or model proxy is implied by this first local
control.

## References

- [Claude Code sessions](https://code.claude.com/docs/en/sessions) documents
  non-interactive JSON output with session, usage, and cost information.
- [Claude Code status line](https://code.claude.com/docs/en/statusline) documents
  nullable cost, duration, and context-window usage inputs.
- [Codex CLI reference](https://developers.openai.com/codex/cli/reference)
  documents JSONL output mode but does not define a stable token-usage event
  contract for this integration.
