# A2A task store and operations — design

**Date:** 2026-08-01
**Status:** Design agreed with Ryusei, revised twice against adversarial review by Codex.
Not implemented. **One open decision blocks implementation — see
[Queue depth](#queue-depth-the-open-decision).** A second, narrower one — whether A2A
`messageId` deduplicates across contexts — resolves against the pinned spec during
implementation and does not block starting; see [Idempotency](#idempotency).
**Predecessor:** [a2a-adoption-design](./2026-08-01-a2a-adoption-design.md) — the card
surface shipped as `c94822b`. This is the second of that spec's three plans.
**Sibling:** [durable-offline-delivery](./2026-08-01-durable-offline-delivery-requirements.md)
— explicitly NOT this. See [Scope boundary](#scope-boundary).

---

## The decision

One SQLite-backed `HandleDO` per callee owns the authoritative six-minute task state,
listener routing, the task authorization boundary, transition serialization, cancellation
coordination, and ephemeral SSE subscribers. **SSE is snapshot-first and reconnectable;
persisted state — not the stream — is authoritative.**

The WSS *caller* path is deleted, not deprecated. The CLI becomes an A2A client in the
same change.

## Scope boundary

A2A conformance forces a **task store**: `GetTask` / `ListTasks` / `CancelTask` must work
when a caller's connection drops mid-call. That is this spec, it builds on the current
Cloudflare stack, and it is **not** blocked on the transport decision (companion item
D.2).

It is **not** the durable mailbox. The dividing line is not "six minutes versus days":

> The task store persists and exposes already-dispatched live work. It does not accept
> work when no listener is available, and does not redeliver work after ownership is lost.

Offline submission still fails before task creation.

## Two decisions taken by Ryusei

1. **Cutover, not dual-path.** Zero live installs, so `CallRequest`/`CallStatus`/
   `CallReply`/`CallError` and the caller-side frame unions are deleted;
   `protocol.ts` shrinks to the relay↔listener link.
2. **SSE is in scope** — `message:stream` and `tasks/{id}:subscribe`, preserving the
   live-status UX.

---

## Queue depth — the open decision

**This is the one thing to settle before implementing.**

The arithmetic: `AGENT_TIMEOUT_MS` is 300s, `RELAY_CALL_TIMEOUT_MS` is 360s from
submission, and the listener queues `new SerialQueue(5)` — 1 running + 5 pending.

- Positions 2–5 wait 5, 10, 15, 20 minutes for a call killed at 6. **They can never
  complete.** This is a live bug today, not introduced here.
- Position 1 waits up to 300s behind the running task, leaving 60s of a 300s budget.
  **It cannot receive its own execution budget either.**

An earlier draft proposed `maxPending: 1` and claimed it removed deadline propagation.
That was wrong — it only deletes the unreachable positions.

**Recommended: `maxPending: 0`.** Refuse while one task is running. It is the only value
that is deadline-honest without propagation machinery, and it collapses cancellation
phases, policy staleness, listener-restart ambiguity, and test surface. The durable
mailbox introduces real queueing later, with an intentional contract.

The alternatives, if a pending slot is wanted anyway — each requires explicitly accepting
its semantics, and none removes deadline propagation:

| Option | Semantics |
|---|---|
| Clipped runtime | agent timeout = `min(task timeout, execution_deadline - now)`; a task waiting 290s gets ~70s |
| Fresh budget on start | queue-admission deadline + new execution budget on `call_started`; tasks can reach ~11 minutes |
| Best effort | pending starts if it can, else fails at the absolute deadline; `maxPending: 1` is then an optimization, not a capacity guarantee |

## Storage

`wrangler.jsonc` already declares `new_sqlite_classes: ["HandleDO"]` — the DO has
embedded SQLite that is currently unused. No second store, and no KV prefix scans.

```sql
CREATE TABLE tasks (
  id                   TEXT PRIMARY KEY,
  caller_handle        TEXT NOT NULL,          -- from the verified principal, never the body
  context_id           TEXT,
  message_id           TEXT NOT NULL,
  request_fingerprint  TEXT NOT NULL,          -- canonical hash of the normalized submission
  state                TEXT NOT NULL,
  dispatch_state       TEXT NOT NULL,          -- see below
  version              INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  accepted_at          INTEGER,
  started_at           INTEGER,
  cancel_requested_at  INTEGER,
  execution_deadline   INTEGER NOT NULL,
  retention_deadline   INTEGER,
  request_json         TEXT NOT NULL,
  result_json          TEXT,
  failure_json         TEXT,
  CHECK (version >= 0),
  CHECK (execution_deadline >= created_at),
  CHECK (state IN ('SUBMITTED','WORKING','COMPLETED','FAILED','CANCELED','REJECTED')),
  CHECK (dispatch_state IN ('not_dispatched','dispatched','accepted','started','released')),
  CHECK (
    (state IN ('COMPLETED','FAILED','CANCELED','REJECTED') AND retention_deadline IS NOT NULL)
    OR
    (state IN ('SUBMITTED','WORKING') AND retention_deadline IS NULL)
  )
);
CREATE INDEX        tasks_by_caller  ON tasks (caller_handle, created_at, id);
CREATE UNIQUE INDEX tasks_idem       ON tasks (caller_handle, message_id);
CREATE INDEX        tasks_exec_exp   ON tasks (execution_deadline);
CREATE INDEX        tasks_ret_exp    ON tasks (retention_deadline) WHERE retention_deadline IS NOT NULL;
```

**`dispatch_state` is separate from `state` because `SUBMITTED` alone conflates six
situations** — created-not-dispatched, frame-sent-unacknowledged, accepted, cancellation
requested while dispatch is unresolved, pending, and listener-disconnected-while-owning.
Those distinctions are lost on DO restart without persisting them, and they determine
whether the relay may safely dispatch, whether the listener owns the task, and whether
`CancelTask` is awaiting confirmation.

**Two deadlines**, because one is ambiguous:

- `execution_deadline` = submission + 6 min
- `retention_deadline` = terminal transition + 6 min

Without the split a task completing at 0:10 vanishes almost immediately. **Consequence to
document: a task can occupy storage for ~12 minutes, not 6**, and the idempotency window
ends at retention deletion — a retry after that may execute again.

`ListTasks` scopes by `caller_handle`, orders by `(created_at, id)`, and pages on an
opaque cursor of that pair. Not offset, which goes unstable as records expire.

**Capacity** is an explicit per-handle ceiling on task count and bytes, with **reserved
headroom**: admission must never consume the capacity needed to write terminal results,
failure data, or cancellation intent for work already in flight. `request_json`,
`result_json`, and `failure_json` all count.

## Authorization

The Worker authenticates and passes a **verified principal** into the DO — the existing
`X-Verified-From` invariant (`apps/relay/src/index.ts:154`). The DO compares it against
`caller_handle`.

**The DO never accepts caller identity from the A2A body, the `tenant` field, the task ID,
or the context ID.** The new REST handlers must not become direct storage wrappers.

Not-owned and nonexistent tasks are indistinguishable across `GetTask`, `CancelTask`, and
subscribe. Cursors cannot be moved across principals or callees.

## Lifecycle

```
SUBMITTED → WORKING | COMPLETED | FAILED | CANCELED | REJECTED
WORKING   → COMPLETED | FAILED | CANCELED
terminal  → nothing
```

Every mutation is a conditional update checking affected-row count **before** any fanout:

```sql
UPDATE tasks SET state = ?, version = version + 1, updated_at = ?
WHERE id = ? AND state IN (...);
```

Persist-then-fan-out, never the reverse. Late results for terminal tasks are logged and
ignored — they must never resurrect a canceled or failed task.

`SUBMITTED → COMPLETED` is legal (an intermediate `WORKING` may be coalesced) but should
be exceptional: once `call_started` is persisted, completion conditions on `WORKING`, so
that accepting direct completion cannot hide a missing `call_started`.

**`REJECTED` has real producers**, and the earlier "refuse at admission" framing was
incoherent — the DO cannot know the listener's local capacity without a reservation
handshake. The honest sequence is: auth/rate/shape/known-offline failures produce an A2A
error *before* task creation; once dispatched, **listener rejection** (capacity, policy,
task-not-offered, caller blocked) transitions the task to `REJECTED`. Externally the
reason is generic, so a blocked caller cannot learn whether a private task exists; the
precise reason lives in `failure_json` for audit.

### Alarm behavior

At `execution_deadline` on a nonterminal task: atomically transition to `FAILED` with a
timeout reason, set `retention_deadline = now + 6 min`, cancel/terminate listener
execution if it may own the task, fan out. **Delete only at `retention_deadline`** —
deleting at the execution deadline would make the timeout unretrievable. Alarm
rescheduling picks the earliest execution-or-retention deadline, and alarm retries are
idempotent.

## Listener protocol

The private link is not unchanged by this plan. Pretending otherwise is what made
`CancelTask` look free.

**New frames:**

| Direction | Frame | Meaning |
|---|---|---|
| listener→relay | `call_accepted {call_id}` | listener owns it; policy resolved, admitted |
| listener→relay | `call_started {call_id}` | agent process spawned |
| relay→listener | `cancel_call {call_id}` | cancellation requested |
| listener→relay | `call_cancelled {call_id, phase}` | `phase: "pending" \| "running"` — confirmed |
| listener→relay | `call_not_cancelled {call_id, reason}` | `already_terminal \| unknown \| too_late` |

Today `call_answer` fires when the job *starts* (`listener.ts:81`), so the relay cannot
distinguish "never arrived" from "queued behind another job". The split fixes that.
Mapping: created/accepted → `SUBMITTED`; started → `WORKING`; result/failure → terminal.

`SerialQueue` gains job identity so a pending job can be removed by key and a running one
aborted. Policy is re-checked when the job starts, not only at enqueue — revocation should
take effect immediately. This stays a local listener decision; no grants move into relay
storage.

### Cancellation is a two-phase protocol, not a state write

**Delivery is not cancellation.** The relay must not transition to `CANCELED` when it
sends `cancel_call` — the frame may be lost, the listener may have reconnected, or the
process may complete first.

1. Persist `cancel_requested_at` (this also makes concurrent `CancelTask` calls
   idempotent — both observe the same pending cancellation)
2. Send `cancel_call`
3. Listener removes the pending job, or terminates the running process group
4. Listener acknowledges **only after** a pending closure was definitely removed, or the
   process group was **observed exited**
5. Conditional transition to `CANCELED`, then fan out

The task stays nonterminal while cancellation is unresolved. If completion wins, the task
is `COMPLETED` and cancellation resolves as too late; if cancellation wins, the late
result is ignored.

Full path: `CancelTask` → `cancel_call` → keyed queue cancellation → `AbortSignal` →
`runAgent` → SIGTERM process group → grace → SIGKILL → **wait for actual process exit** →
`call_cancelled`.

**At the execution deadline with cancellation still pending:** confirmed cancellation →
`CANCELED`; unconfirmed → `FAILED` with a cancellation-timeout reason plus best-effort
kill. **Never claim `CANCELED` without confirmation when execution may have started** —
otherwise A2A reports a cancelled task whose agent is still running on the callee's
laptop.

Cancellation by phase:

| Phase | Behavior |
|---|---|
| Before dispatch | DO-local → `CANCELED` |
| Dispatched, unacknowledged | `cancel_call`, resolve on ack or deadline |
| Accepted, pending | keyed removal → `CANCELED` |
| Running | terminate process group, confirm exit → `CANCELED` |
| Terminal | `TaskNotCancelableError` → 409 |

## SSE

**The contract is current-state delivery, not exactly-once event delivery.** Everything
below follows from that, and the weaker promise is what makes reconnection safe.

### Race-free subscription sequencing

Snapshot-then-register loses an update that lands in the gap; register-then-snapshot
duplicates or misorders it. The sequence must be explicit:

1. Register the subscriber in a `buffering` state
2. Read the current persisted snapshot
3. Buffer any transitions occurring during the read
4. Emit the snapshot
5. Discard buffered events with `version <= snapshot.version`
6. Emit remaining buffered events in order
7. Switch the subscriber to live mode

SQLite reads in the DO may make steps 1–2 a single uninterrupted turn, but the invariant
is written down and tested rather than assumed from event-loop behavior.

### Lifecycle

Each event carries `version` for client-side dedup and ordering. Heartbeat comments keep
the stream alive through Cloudflare idle timeouts — the current WSS client already pings
for this (`callClient.ts:64`). Use **one DO-level heartbeat timer** for all subscribers,
not one per stream, and clear it on abort, cancellation, terminal close, fanout failure,
and shutdown.

Disconnect discards the subscriber only, never the task. **DO eviction or deployment kills
every open stream** — subscribers are in-memory and must never be persisted. The CLI
treats premature EOF as reconnectable, not as task failure; reconnect re-authenticates,
re-checks ownership, and receives a fresh snapshot. A transition missed in the gap repairs
itself, which is the whole point of the weaker contract.

### Backpressure

Subscriber caps do not bound per-subscriber buffering. Policy: **coalesce intermediate
states; if a subscriber cannot keep up, close it and require snapshot resubscription.**
Define maximum queued bytes per subscriber and behavior when `controller.desiredSize <= 0`.
Terminal state displaces queued intermediate updates.

### Endpoint semantics

- Subscribing to an already-terminal task emits one terminal snapshot and closes
- `message:stream` creates the task and includes the first snapshot
- Reconnect uses `SubscribeToTask`, never a retry of `message:stream`
- Heartbeat comments are excluded from version sequencing
- **Ctrl-C disconnects; it does not cancel.** Closing a terminal must not silently cancel
  remote work. Cancellation is explicit.

## Idempotency

`UNIQUE (caller_handle, message_id)` plus `request_fingerprint`. Needed immediately, not
at mailbox scale: a lost HTTP response followed by a CLI retry would otherwise spawn two
agents on the callee's subscription.

- Same key, same fingerprint → return the existing task
- Same key, different fingerprint → conflict
- The dedup record lives until retention deletion — that is the documented window

The fingerprint is computed from the **normalized semantic submission after validation**,
not raw HTTP bytes: target task/skill, message parts, context ID where semantically
relevant, and execution-affecting extensions. Never header order or transport noise. Plain
`request_json` comparison is unsafe because field ordering and defaulted fields vary.

**Open sub-decision:** whether A2A `messageId` deduplicates across contexts. If the
protocol scopes it by context, the key becomes
`(caller_handle, context_id, message_id)` with a defined null-context representation.
Resolve against the pinned spec during implementation.

## Cutover

Zero installs, so delete rather than deprecate — but the caller path carries **product
invariants, not just transport code**, and A2A schemas validate shape, not business
limits. Port these as behavior *before* deleting anything.

**Carried over from the WSS path:** auth before callee selection; `X-Verified-From`
propagation; per-caller-per-callee hourly rate limit; oversized messages still charging
budget; `MAX_MESSAGE_BYTES`; UTF-8-boundary reply truncation; `sanitizeDetail`; `offered[]`
bounds and `TASK_ID_RE`; hard timeout with alarm cleanup; stale listener frame rejection;
unknown-handle/blocked indistinguishability; terminal closure.

**New, because the surface is new:**

- *Auth/privacy* — principal bound to ownership on create/get/list/cancel/subscribe;
  invalid credentials rejected before existence checks; cursors not transferable across
  principals; extended card on the same verified-principal path.
- *Protocol* — `A2A-Version` validated on every operation; correct AIP-193 envelope and
  status per operation; malformed Parts rejected against the pinned schema; Task/Message
  union handled; correct `contextId`/`messageId`/role/Part/Artifact projection;
  `A2A-Extensions` negotiation including unsupported-required behavior; terminal tasks
  reject further messages; `ListTasks` ordering, filters, page bounds, cursor validation;
  terminal subscribe emits and closes; cancelling a terminal task returns 409.
- *Data safety* — byte limits enforced after decoding the A2A representation, not against
  one text field; artifact limits across all Parts; stored JSON counts toward capacity;
  free-form strings reaching terminal output stay control-character safe; internal frames
  stay schema-validated and size-bounded.
- *Operational* — alarm picks the earliest deadline and retries idempotently; terminal
  tasks survive caller disconnect, SSE disconnect, DO restart, listener reconnect; expired
  tasks indistinguishable from nonexistent; duplicate submission does not redispatch;
  duplicate listener ack/result does not re-transition; DO restart between dispatch and
  acceptance has defined behavior; relay deployment mid-SSE is client-recoverable.
- *Product/CLI* — status on stderr, artifacts on stdout; stable `--json` shape; exit codes
  for `REJECTED`/`FAILED`/`CANCELED`/auth/connection failure; Ctrl-C semantics; local
  timeout vs remote cancellation; `doctor` and setup verification on the new path; contact
  resolution reaching the correct tenant URL; installed snippets no longer describing
  WSS-era `offline`/`busy`; audit logs preserving calls that finish after caller
  disconnect; request/result bodies not logged at the Worker edge.

**Sequence** — cutover, not dual-path, because nothing ships between steps:

1. Internal listener frames + listener support (accept/start/cancel, keyed queue, queue depth)
2. Task store + A2A operations
3. CLI as A2A client
4. Port the invariant tests
5. Delete caller WSS routes, types, tests
6. Full TCK + end-to-end self-call

The CLI rewrite is larger than swapping WebSocket for `fetch`: SSE parsing across chunk
boundaries, heartbeats, duplicate events, premature EOF, reconnection, poll fallback,
abort propagation, terminal-state→exit-code mapping, artifact extraction.

## Testing

Test-first per repo convention. Beyond the obvious:

- **Races**, since compare-and-set is the entire safety argument: cancel vs result, alarm
  vs result, late result after terminal, duplicate result, two concurrent cancels,
  cancellation unconfirmed at deadline.
- **Authorization**: A cannot read or cancel B's tasks and cannot distinguish "not yours"
  from "doesn't exist".
- **Pagination while records expire** — the cursor must not skip or duplicate.
- **SSE sequencing**: a transition landing during the snapshot read is delivered exactly
  once and in order.
- **Listener**: keyed removal, abort of a running job, process-exit-confirmed
  cancellation, policy re-check at start.
- **CLI**: SSE chunk-boundary parsing, premature EOF → reconnect rather than fail, poll
  fallback.
- **TCK**: the full suite now, not just `agent_card`, with a new recorded baseline.

**One non-test deliverable — a cost spike.** "SSE is the default path" is currently a cost
decision with no cost model. WebSocket Hibernation is WebSocket-only (`ctx.acceptWebSocket`);
an open `ReadableStream` has no equivalent, so it pins the DO where today's hibernating
caller socket does not. Measure, before the CLI defaults to SSE: DO duration and billing
for a six-minute stream; whether an open response definitively prevents eviction; behavior
on restart or deploy mid-stream; polling cost at 1/2/5/10s; concurrent SSE limits; whether
multiple subscribers multiply billed duration; idle-timeout behavior through Cloudflare
and enterprise proxies.

If it measures badly, snapshot-first means switching the CLI default to polling is a
client change — no protocol change, and no card change beyond flipping
`capabilities.streaming`.

## Non-goals

- The durable mailbox, and the transport decision (D.2)
- Push notifications, WebSocket binding
- Changes to the spawn path or the tool guard
- Redelivery after ownership is lost; offline submission still fails before task creation

## Review history

Two rounds with Codex, read-only against the repo. Round 1 established that DO ownership
is the right boundary but demolished three justifications: the "≤6 stored tasks" bound was
false (terminal retention and multiple callers dominate, and the rate limit is per caller
*per callee*); "polling always exists" is not cost mitigation when the CLI defaults to SSE;
and `CancelTask` cannot be implemented by DO state alone because `SerialQueue` holds bare
closures with no identity, removal, or abort. It also caught that the DO is already
SQLite-backed, making the KV-scan proposal strictly worse than available.

Round 2 found four more: `maxPending: 1` does not fix the arithmetic either;
cancellation had no acknowledgement frame; dispatch ownership was unreconstructable after
restart; and snapshot-first SSE still races on subscribe. All are incorporated above.

Its closing assessment, which shaped the emphasis of this document:

> The remaining architectural danger is cancellation, not storage. The DO/SQLite choice is
> sound; the current cancellation description can still produce a publicly `CANCELED` task
> whose agent continues running on the employee's laptop.
