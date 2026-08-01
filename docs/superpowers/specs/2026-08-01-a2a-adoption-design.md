# A2A protocol adoption — design

**Date:** 2026-08-01
**Status:** Design revised after adversarial review by Codex (see
[Codex review](#codex-review--2026-08-01)). The decision survived; the architecture as
first written did not. Twelve findings, two of them critical; every code-grounded claim
was verified against `apps/relay/src/do.ts` before being accepted. Two findings were
withdrawn by Codex after pushback. No implementation started — four spikes gate it.
**Research grounding:** A2A v1.0.0 primary sources (spec, GitHub, Linux Foundation) plus
an Exa sweep of ~106 sources; load-bearing claims verified directly, not taken from
subagents.
**Companion docs:**
[cotal-enterprise-installability](../../research/2026-08-01-cotal-enterprise-installability.md)
(supersedes its item E.1 with something larger) and
[durable-offline-delivery](./2026-08-01-durable-offline-delivery-requirements.md), split
out of this spec because it is a subsystem, not a state label.

---

## The decision

agentcall adopts an A2A v1.0 public API so it no longer owns its public task transport
and envelope. It retains a small data-only policy extension and a private, **explicitly
versioned** relay↔listener protocol. A thin mapping boundary isolates A2A DTOs from
persisted task and policy state. Durable offline delivery is a separate subsystem, **not
implied by conformance**. Public release is blocked on endpoint security, identity
mapping, multi-tenant discovery, and a passing pinned TCK spike.

The honest form of the benefit:

> agentcall no longer maintains a public transport, RPC, or task-lifecycle protocol. It
> maintains one small data-only policy extension and its private listener RPC.

That is narrower than "stop maintaining a protocol," which was the original claim and was
wrong.

## Why

Two drivers, both chosen explicitly:

1. **Procurement credibility.** An answer to enterprise architecture review that is
   *checkable* — [a2a-tck](https://github.com/a2aproject/a2a-tck) exists, so "passes the
   official conformance suite at a pinned version" is falsifiable, unlike
   "A2A-compatible."
2. **Stop owning the public wire.** Schema design, versioning, and edge-case decisions
   for transport, RPC, and task lifecycle move to a Linux Foundation project with seven
   founding vendors.

**Explicitly not a driver: real interop.** The research does not support it. One
community probe of 50 agents advertising A2A support found 0% responded to task requests
and ~0–4% returned a valid agent card
([A2A#1755](https://github.com/a2aproject/A2A/issues/1755), closed — one datapoint, not a
study). An HBR Analytic Services survey put production trust at 6% against 150 orgs
announcing support. Practitioner writeups describe the real pattern as A2A *inside one
vendor's walls*. A2A has won mindshare, not endpoints. Nothing here may assume anyone
will call us over it.

The stronger argument is neither driver: **conforming is how agentcall stops being a
protocol.** Cotal chose to be a protocol and will be vendored rather than bought. One
person cannot win a standards fight against the Agentic AI Foundation, and should not
enter one.

### What this does not buy

Recorded prominently because the first draft got it wrong:

> A2A gives the right nouns, states, operations, and procurement answer. It does not
> materially shorten the durable-mailbox, identity, discovery, cancellation, or
> endpoint-security work.

Representational fit is not implementation leverage.

### Why the spec does not threaten the product

A2A declares **out of scope**: authorization semantics (scope, representation, validity,
revocation), trust establishment, credential provisioning, and agent identity
verification. Those, plus the audit trail, are the product.

Residual risk, accepted: a later A2A version may standardize a policy-expression
extension and erase the *expression* differentiator. Survivable, because the durable
asset is **enforcement** — `resolveTask()`, the tool guard, `tools.log` — which is
implementation, not protocol.

## Architecture

```
A's agent  →  agentcall CLI (an ordinary A2A client)
                    ↓  HTTPS: A2A HTTP+JSON/REST + SSE   ← public, conformant, TCK-gated
              Relay (Worker + DO + D1) = the A2A server
                    ↓  WSS: private, versioned RPC
              agentcall listen (B's Mac)
                    ↓  spawn
              claude -p / codex exec
```

The conformance boundary is the relay's **public edge**, not the listener.

**Binding: HTTP+JSON/REST plus SSE, pinned.** Not "JSON-RPC 2.0 / HTTP+JSON" as first
written. REST matches the existing Hono/Worker routing model, makes per-handle resource
URLs natural, keeps auth/throttling/limits/status codes as ordinary HTTP concerns, and
dissolves the dual-layer error question ("did the HTTP request fail, or did a successful
JSON-RPC exchange return a protocol error?"). Only REST is advertised initially —
semantic equivalence across multiple bindings is pure cost until a customer asks.
*Caveat:* switch to JSON-RPC if the REST TCK profile proves materially incomplete. That
is a spike result, not a preference — credibility depends on the strongest real
conformance path.

**The private link stays a maintained contract.** The original claim that relay↔listener
frames "no longer need versioning, negotiation, or documentation" was wrong. Relay and
listeners are independently deployed and will skew: hosted relay upgrades, delayed laptop
upgrades, machines reconnecting after weeks, customer-operated relays, rollbacks, mixed
enterprise fleets. Being both ours removes third-party compatibility obligations, not
compatibility *requirements*. The link keeps its zod schemas, tests, a compatibility
policy, and a version/capability handshake.

A2A v1.0 has no WebSocket binding (roadmapped 1.1+). Irrelevant: HTTP is needed only
outward.

Transport-agnostic, and therefore decidable before the open transport questions
(self-hostable relay, own-the-wire vs ride-a-mesh).

### Boundary mapping, not a general adapter

**A2A DTOs are not the source of truth.** Once the relay must durably retain requests,
state, execution leases, results, cancellation, and expiry, storing raw A2A DTOs as
persisted state would be a mistake.

```
A2A request DTO  →parse→  internal persisted task  →transitions→  A2A response/event DTO
```

Justified by concrete divergence between what the public API says, what must be
persisted, what the listener needs, and what policy enforcement needs — **not** by
hypothetical A2A churn or a future second protocol. That rationale is withdrawn; it
encouraged ceremony beyond the requirement.

Scope limits, explicit:

- **Operation-specific one-way translators** (`toAgentCard`, `acceptSendMessage`,
  `toTask`, `toTaskStatusUpdate`). No generic bidirectional adapter — the correspondence
  is intentionally lossy and not reversible.
- **No `ProtocolAdapter` abstraction**, registry, transport-neutral response type, or
  second-protocol seam.
- **Only three domain types earn their place**: `PersistedTask`, `ExecutionAttempt`,
  `CallerPrincipal`. Not `Call`, `Caller`, `Grant`, or `Policy` — `Grant` stays policy
  *input*, not part of the task domain.

## Object mapping

| agentcall | A2A 1.0 | Note |
|---|---|---|
| `CardTask` | `AgentSkill` | direct |
| `AgentCard` (ours) | `AgentCard` + extension | |
| `call_request` | `SendMessage` + `Message{parts:[{text}]}` | direct |
| `call_id` | `Task.id` | ownership/idempotency: see durable-delivery spec |
| `session_id` | `Task.contextId` | delivers the threading deferred to v1.5 |
| reply text | `Artifact` / `Message` text `Part` | direct |
| per-caller `grants` | **never exposed** | see below |

`Task.contextId` is exactly the call-threading concept `session_id` was reserved for, and
A2A's `capabilities.extendedAgentCard` + `GetExtendedAgentCard` matches the
public/authenticated card split `packages/shared/src/card.ts` already implements. The
same design was reached independently on both sides — evidence the mapping is not forced.

### The extension is four things, not one

The first draft proposed one extension URI carrying `handle`, `agent_kind`, `grants`, and
`offered[]`. Too coarse: those differ in visibility, lifecycle, and placement.

| Field | Disposition |
|---|---|
| `handle` | stable agent identity metadata — data-only extension |
| `agent_kind` | implementation metadata — likely does **not** belong in the public contract |
| `grants` | **never leaves the policy engine.** Publishing grant structure leaks ACL topology, couples clients to policy representation, and creates stale authorization claims in cached cards |
| `offered[]` | request/rejection diagnostic — data-only, on the relevant status representation |

**Expose effective caller-visible skills, not raw grants.** The card says what the
authenticated caller may currently request; the reason stays private. The relay remains
authoritative.

The extension URI is a **stable identifier, not a per-deployment address**:

```
https://agentcall.benree.tech/ext/policy/v1
```

It does not vary by relay host and need not resolve. A self-hosted relay at
`agents.acme.internal` declares this same URI — otherwise every deployment would
advertise a different extension and no client could recognize any of them.

Owning it still means owning its schema, versioning, placement rules, privacy semantics,
`A2A-Extensions` negotiation behavior, required-vs-optional handling, validation limits,
and unsupported-but-requested behavior. Small, but real.

## Task lifecycle

| agentcall | A2A state | Note |
|---|---|---|
| `ringing` | — | extension/UI metadata; does not deserve a base state |
| `answered` (ack only) | `SUBMITTED` | still `SUBMITTED` until a process is actually spawned |
| execution begins | `WORKING` | |
| reply delivered | `COMPLETED` | text as `Artifact` |
| `busy`, within capacity | `SUBMITTED` | relay capacity, **not** the listener's in-memory 1+5 |
| `busy`, capacity exceeded | 429/503, no task | see below |
| `offline` | `SUBMITTED` | legitimate, but see the narrowed claim below |
| `agent_error` | `FAILED` | execution accepted, then failed |
| execution timeout | `FAILED` | |
| queued task expires pre-execution | `FAILED` | server-enforced expiry ≠ caller cancellation |
| caller cancels | `CANCELED` | via `CancelTask`; needs race semantics vs dispatch |
| `unknown_handle` | — | pre-task: HTTP 404 |
| `rate_limited` | — | pre-task: HTTP 429 + `Retry-After` |
| `unauthorized` | — | pre-task: HTTP 401 |
| `blocked`, `task_not_offered`, `task_unknown` | — | **reject before task creation** — a durable `REJECTED` task leaks policy facts and task existence |
| `message_too_large` | — | pre-task: HTTP 413 |
| malformed request | — | HTTP 400 |
| — | `INPUT_REQUIRED`, `AUTH_REQUIRED` | reserved, unused in v1 |

`REJECTED` is reserved for a task the server admitted and then declined. Because
authorization and capacity refusals now happen *before* admission, v1 does not produce it.

**`CancelTask` and `ListTasks` are standard operations, not optional.** `ListTasks`
materially expands the storage model: caller/tenant scoping, pagination, filtering,
retention, and authorization — not point lookup by ID.

### The narrowed `offline` claim

`SUBMITTED` is non-terminal and nothing in A2A requires a server to synthesize `FAILED`
because execution has not begun, so a long-lived `SUBMITTED` task is protocol-legitimate.
Codex withdrew its objection to that on the verified state model.

What does **not** follow, and what the first draft claimed:

- ~~"`SUBMITTED` means durable mailbox."~~
- ~~"The durable mailbox arrives as a consequence of conforming."~~

A conformant server may keep a task `SUBMITTED` forever, lose it on restart, or never
deliver it. The state label supplies no delivery guarantee, retention policy, fairness, or
eventual execution. The accurate claim:

> A2A's lifecycle can represent offline durable delivery without a custom public state.
> It removes a protocol-design obstacle. The durable mailbox remains a substantial server
> feature.

"Indefinite" is also rejected as a product commitment — an explicit expiry policy is
required even if it is measured in days, because unbounded retention creates storage,
stale-authority, offboarding, and caller-expectation problems.

Everything else about it moves to
[durable-offline-delivery](./2026-08-01-durable-offline-delivery-requirements.md).

## CLI

`agentcall call` becomes an ordinary A2A client: HTTP+JSON out, SSE for the status
stream it currently receives over WSS.

**Open, and a consequence this spec created:** the current contract — print `offline` to
stderr, exit nonzero — cannot survive a callee whose task is queued rather than refused.
The CLI must return a task ID and exit, or poll, or block with a bound. Specified in the
durable-delivery spec, not here.

`agentcall listen` is unchanged by this spec.

## Discovery and addressing

`handle@host` is retained — a differentiator A2A has no equivalent for.

**No longer deferred.** A2A's discovery convention is `/.well-known/agent-card.json`,
per-*origin*, while agentcall is multi-tenant. The first draft deferred this on the
grounds that self-hosting makes it easier; that was wrong, since one enterprise origin
still holds many employee agents. Self-hosting removes cross-company tenancy, not
per-origin multiplicity.

It is load-bearing because a reviewer may reasonably say the tested server is the
*directory* agent while person-scoped endpoints use proprietary discovery — which
directly attacks the procurement claim. Candidate resolutions, to be settled by Spike 1:

1. Per-handle origins (`https://ken.agents.acme.internal`) with wildcard DNS/TLS.
2. A directory agent at the well-known URL plus separate A2A agents reached through a
   declared directory skill — honest, but custom discovery.
3. Treat the per-handle card URL as configuration and narrow the claim to "conformant
   once the card URL is known," not conventionally discoverable.

## Testing

1. **TCK spike first**, not third. Pinned A2A version *and* pinned TCK commit, run
   against the proposed discovery topology, with no unexplained skips, an explicit list
   of unsupported optional capabilities, the exact card URL supplied to the suite, and
   well-known discovery behavior tested separately.
2. **Directional projection tests** in `packages/shared` — not round-trip, which is the
   wrong invariant because public representations are intentionally lossy:
   - A2A request → internal submission command
   - persisted task → A2A `Task`
   - state transition → A2A status event
   - internal card/policy view → public and extended `AgentCard`
3. **Relay state-machine tests** in `apps/relay` with the existing fake sockets.
4. **One independent A2A client.** Dogfooding our own client against our own server
   preserves matched mistakes. Card discovery from a clean client, auth challenges,
   submit/poll/stream-reconnect/cancel/expiry/retry, unknown optional fields, version
   skew.

Per CLAUDE.md, `typecheck` does not cover `test/` — only `pnpm -r test` will show the
refactor is complete.

## Non-goals

- **Real cross-vendor interop.** Not designed for, not claimed.
- **A custom A2A transport binding (§12).** Fails both drivers: still a spec to maintain,
  and the TCK covers only JSON-RPC / gRPC / HTTP+JSON.
- **WebSocket binding.** Wait for v1.1.
- **Push notifications.** The four-method config surface is not free — it needs callback
  URL validation, private/link-local/metadata blocking, DNS-rebinding defense, redirect
  policy, delivery auth, secret storage and rotation, retry/backoff/dead-letter, quotas,
  and cross-tenant isolation. On a Worker, accepting arbitrary callback URLs is an
  outbound-request primitive. **Explicitly not advertised in v1**, and not counted as
  evidence that durable waiting is solved.
- **Signed Agent Cards.** Deliberately unsupported optional capability, not an
  architectural gap — see the review below. Reconsider when cards cross trust boundaries.
- **Changing the listener, spawn path, or tool guard.**

## Release gate

Conforming publishes a standard, well-documented way to drive an agent on an employee's
laptop with no OS sandbox. A2A does not create the vulnerability — authenticated WSS
already drives the agent — but it changes exposure: more clients can generate valid
traffic, standard tooling makes probing and replay easier, and enterprise buyers will
expect the card's advertised security schemes to correspond to a real identity and
authorization flow. A passing TCK says nothing about safe prompt execution.

**Hard gate, not a priority note.** A2A implementation may proceed behind a
non-production flag. **Public or enterprise deployment is blocked on C.1–C.4** of the
companion doc — the `exec` read floor, Codex guard parity, a legible policy envelope, and
the endpoint-agent threat model.

**Also blocking, and missing from the first draft entirely:** there is no
A2A-principal → agentcall-caller mapping. Identity today is a bearer token plus
`X-AgentCall-Handle` (`apps/relay/src/index.ts:154`). Until the design says how an A2A
principal becomes a verified agentcall caller, the policy engine cannot make its defining
decision.

## Spikes gating implementation

1. Run the pinned TCK against the proposed per-handle URL and discovery topology.
2. Design the durable task store, delivery lease, retention, cancellation, and
   deduplication model (separate spec).
3. Define A2A authentication → agentcall principal mapping.
4. Complete endpoint security and the threat model as a hard public-release gate.

---

## Codex review — 2026-08-01

Adversarial review of the first draft, read-only, grounded in the repo. Twelve findings.
Every code claim was independently verified against `apps/relay/src/do.ts` before being
accepted; all held. Codex noted it could not reach A2A sources from its environment, so
its A2A-specific claims were re-put to it with verified facts — which moved several
findings and withdrew two.

**Verdict, agreed by both:** the decision holds, the first draft did not. "I would
approve an A2A compatibility spike, not this architecture as written."

### Accepted without argument

| # | Finding | Resolution |
|---|---|---|
| F1 | *Critical.* "Durable mailbox for free" is false; the state machine is socket-scoped. `offline` is refused at `do.ts:108` **before** a `call_id` exists (`:112`); `CallRecord` is `{call_id, from, deadline}` (`:10`) and the message is never persisted (passed through at `:120`); caller close deletes the record (`:158`); results go only to a live socket then delete (`:139`–`:142`); every insert and alarm does a full prefix scan (`:164`) | Claim narrowed; subsystem split into its own spec |
| F2 | *Critical.* Endpoint security cannot be a parallel backlog item; and no A2A-principal → caller mapping exists | Hard release gate + identity mapping added as Spike 3 |
| F3 | The private link and the public extension are both still maintained protocols | Decision statement narrowed; private link keeps explicit versioning |
| F4 | Multi-tenant discovery is load-bearing and cannot be deferred | Un-deferred; three candidate resolutions; Spike 1 |
| F6 | Retry/idempotency/duplicate execution undefined — HTTP retry can spawn two paid agents | Moved to durable-delivery spec |
| F7 | Cancellation, expiry, grant revocation, and offboarding absent; a grant checked only at submission becomes a multi-day irrevocable capability | `CancelTask` added; check policy at submission **and** immediately before execution |
| F8 | Push notifications are a new SSRF and credential subsystem, not free | Explicit non-goal in v1 |
| F9 | Binding and conformance profile unpinned | REST + SSE pinned, with the JSON-RPC caveat |
| F10 | Extended-card similarity does not justify publishing raw `grants` | Expose caller-visible skills; grants never leave the policy engine |
| F11 | Retention, quotas, billing, abuse controls undesigned | Moved to durable-delivery spec |
| F12 | Dogfooding is insufficient interop evidence | Independent A2A client added to testing |

### Withdrawn after pushback

- **F5 — "speculative generality" (adapter).** Withdrawn as the main criticism: F1 forces
  an internal persisted task model into existence regardless, so the boundary is
  justified *now*. Downgraded to "correct boundary, overgeneralized description and wrong
  test invariant." The specific limits it held — no generic bidirectional adapter, no
  protocol-pluggable interface, no second-protocol rationale, no round-trip tests, and
  only three domain types — are adopted above.
- **F12(b) — signed Agent Cards as an architectural gap.** Withdrawn. Where the
  authoritative relay serves its own current card over authenticated TLS, JWS attests to
  what the transport already attests to. It matters when cards cross untrusted
  registries, discovery and serving origins differ, cards are cached out of band, or the
  domain owner and relay operator are distinct principals — none of which is the v1
  topology. Recorded as a deliberately unsupported optional capability.

### Also withdrawn on verified facts

The objection to indefinitely-`SUBMITTED` tasks. Given the real state model, a long-lived
`SUBMITTED` task is protocol-legitimate. What remains is that legitimacy is not delivery:
see [the narrowed claim](#the-narrowed-offline-claim).

## Sources

- [A2A specification](https://a2a-protocol.org/latest/specification/) — objects,
  transports, task states, extension mechanism, authz scope (read directly)
- [Announcing A2A 1.0](https://a2a-protocol.org/latest/announcing-1.0/) — v1.0.0, 2026-04-09
- [Google → Linux Foundation donation](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/) — 2025-06-23
- [a2a-tck](https://github.com/a2aproject/a2a-tck) — conformance suite
- [A2A#1755](https://github.com/a2aproject/A2A/issues/1755) — the 50-agent probe
