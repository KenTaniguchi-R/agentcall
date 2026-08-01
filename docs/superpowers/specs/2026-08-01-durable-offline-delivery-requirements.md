# Durable offline delivery — problem statement and requirements

**Date:** 2026-08-01
**Status:** **Not designed.** Requirements captured, design pending its own brainstorm.
This document exists so the requirements are not lost and so
[a2a-adoption-design](./2026-08-01-a2a-adoption-design.md) can stop implying they are
solved. Do not implement from this — it states *what must be decided*, not what was
decided.
**Split from:** [a2a-adoption-design](./2026-08-01-a2a-adoption-design.md), whose first
draft claimed the mailbox fell out of A2A conformance for free. It does not.

---

## Why this is a separate document

The A2A spec's first draft mapped an offline callee to `TASK_STATE_SUBMITTED` and
concluded: "Same state machine, no protocol change." That was wrong, and the Codex review
demonstrated it against the code.

`SUBMITTED` is protocol-legitimate for a long-lived queued task — that part survived. But
the state label supplies **no delivery guarantee, retention policy, fairness, or eventual
execution**. A conformant server may keep a task `SUBMITTED` forever, lose it on restart,
or never deliver it at all. A2A removes a protocol-design obstacle. It does not build the
subsystem.

## Where the current implementation actually stands

Verified against `apps/relay/src/do.ts`. The relay is **socket-scoped by design** — not
partially durable:

| Behavior | Location |
|---|---|
| An offline request is refused **before** a `call_id` is created | `do.ts:108` vs `:112` |
| `CallRecord` is `{call_id, from, deadline}` — no message, status, result, attempts, or notification config | `do.ts:10` |
| The request message is never persisted; it is passed straight through to the listener | `do.ts:120` |
| The caller socket attachment is the only call→caller routing index | `do.ts:77` |
| Closing the caller socket deletes the call | `do.ts:158` |
| Results go only to a presently-connected socket, then the record is deleted; there is no retrieval | `do.ts:139`–`142` |
| Listener reconnection does not drain queued work | forwarding happens only in the initial caller message handler |
| Every insert and alarm does a full `call:` prefix scan | `do.ts:164` |

A queued task today would have **nothing to replay**. This is a new subsystem, not a
changed constant.

## Requirements

### Storage and delivery

- Durable request payload and current task state
- Durable artifacts/results, and status history or current status
- Queue ordering and per-listener concurrency control
- Delivery leases, acknowledgement, redelivery, duplicate suppression
- Caller-independent `GetTask`
- `ListTasks` with caller/tenant scoping, pagination, filtering, and authorization —
  this is a standard A2A operation and expands the storage model well past point lookup
- Stream reconnection state
- A wake-up/drain trigger when a listener reconnects
- Retention, expiry, cancellation, and deletion policy

### Idempotency

HTTP introduces an ambiguous outcome the current live-socket model does not have: client
sends → relay accepts and stores → connection fails before the response → client retries
→ two tasks spawn two paid agents. Must define:

- Server-generated task identity vs client message identity (`Task.id` vs `messageId`)
- Duplicate `SendMessage` behavior and context-scoped message uniqueness
- Retry window and how long deduplication records live
- Exactly-once is unrealistic: specify **at-least-once storage with effectively-once
  spawn via a durable execution lease**

### Authority over time

A grant checked only at submission becomes a multi-day irrevocable execution capability.
**Policy must be checked at submission and again immediately before execution.** Define
what happens when, between the two:

- the caller cancels while the callee is offline
- the callee revokes a grant, or blocks the caller
- an employee leaves with tasks still queued
- a handle is reclaimed — already an enterprise blocker, since a reused handle inherits
  the previous owner's DO state (README *Limitations*); durable tasks make it worse
- a listener starts work just as expiry or cancellation wins the race

### Capacity, quotas, retention

The current limit is 10 calls per caller per callee per hour
(`packages/shared/src/protocol.ts:31`), stored as timestamps in each callee's DO. With
durable tasks a registered but malicious caller can accumulate work faster than it
executes, and across identities. Needs:

- per-callee queued task and byte limits; per-tenant storage limits
- per-caller outstanding-task limits
- maximum retention for tasks and for results/artifacts
- separate submission vs execution rate limits
- callee daily token/cost budget — the callee's subscription pays
- queue-full semantics while offline
- administrative purge and legal retention

The listener's in-memory "1 running + 5 pending" is **not** a durable mailbox capacity
policy. They are separate queues needing separate limits.

### Product contract

"Indefinite" is rejected as a commitment; an explicit expiry policy is required even if
measured in days. The contract must state expected expiry or maximum wait, whether the
caller can cancel, whether tasks survive offboarding, whether a callee policy change
invalidates queued work, and when caller/callee quota is charged.

### CLI contract

`agentcall call` currently prints `offline` to stderr and exits nonzero. That cannot
survive a callee whose task is queued rather than refused. It must return a task ID and
exit, poll, or block with a bound — and `agentcall status` / a new subcommand must be
able to retrieve a result later. This is a user-visible change the A2A spec created and
did not specify.

## Open architectural decision

Storage substrate is **not** decided: DO storage, D1, Cloudflare Queues, or an external
transport such as NATS/JetStream. The alarm design in particular does a full prefix scan
per insert and per alarm — tolerable for a handful of six-minute calls, not obviously so
for multi-day tenant mailboxes. Needs capacity bounds, indexes, and poison-message
handling.

This decision is coupled to item **D.2** of
[cotal-enterprise-installability](../../research/2026-08-01-cotal-enterprise-installability.md)
— own-the-wire vs ride-a-mesh — which explicitly says to evaluate that *before*
rebuilding durable delivery, because JetStream supplies durable per-reader delivery,
bookmarking, and presence for free. Resolve them together.

## Next step

Its own brainstorm. Do not fold this back into the A2A spec.
