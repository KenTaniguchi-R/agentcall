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

A2A defines no *core* WebSocket binding. Irrelevant here: HTTP is needed only outward.
(An earlier draft said this was "roadmapped for v1.1+". That was wrong — see
[upstream check](#upstream-spec-check--2026-08-01).)

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
| `busy`, capacity exceeded | no task — §3.3.2 System category, `503` (or `429`) + `Retry-After` | |
| `offline` | `SUBMITTED` | legitimate, but see the narrowed claim below |
| `agent_error` | `FAILED` | execution accepted, then failed |
| execution timeout | `FAILED` | |
| queued task expires pre-execution | `FAILED` | server-enforced expiry ≠ caller cancellation |
| caller cancels | `CANCELED` | via `CancelTask`; needs race semantics vs dispatch |
| pre-task refusals | — | **reject before task creation**; see the error mapping below |
| — | `INPUT_REQUIRED`, `AUTH_REQUIRED` | reserved, unused in v1 |

`REJECTED` is reserved for a task the server admitted and then declined. Because
authorization and capacity refusals now happen *before* admission, v1 does not produce it.

## Error mapping

Transcribed from spec **§5.4**, which is normative — not re-derived. An earlier draft of
this table invented HTTP statuses by intuition and got at least one wrong
(push-not-supported as 501; it is 400).

### A2A-specific errors — §5.4, `MUST`

| A2A error type | JSON-RPC | HTTP |
|---|---|---|
| `TaskNotFoundError` | `-32001` | `404 Not Found` |
| `TaskNotCancelableError` | `-32002` | `409 Conflict` |
| `PushNotificationNotSupportedError` | `-32003` | `400 Bad Request` |
| `UnsupportedOperationError` | `-32004` | `400 Bad Request` |
| `ContentTypeNotSupportedError` | `-32005` | `415 Unsupported Media Type` |
| `InvalidAgentResponseError` | `-32006` | `502 Bad Gateway` |
| `ExtendedAgentCardNotConfiguredError` | `-32007` | `400 Bad Request` |
| `ExtensionSupportRequiredError` | `-32008` | `400 Bad Request` |
| `VersionNotSupportedError` | `-32009` | `400 Bad Request` |

### Standard error categories — §3.3.2

| Category | HTTP | Notes |
|---|---|---|
| Authentication | `401` | SHOULD carry an auth challenge and name the required scheme |
| Authorization | `403` | but see the non-disclosure rule below |
| Validation | `400` | SHOULD name the failing parameter |
| Resource | `404` | |
| System / temporary | `500` / `503` | MAY include `Retry-After`. Rate limiting sits in this category — `429` is compatible but not spec-named |

### AIP-193 envelope — §11.6, `MUST`

REST errors use [AIP-193](https://google.aip.dev/193). `error.code` is the **HTTP status
number**, not a string — the Spike 1 stub returned `"NOT_FOUND"` and failed on `int()`
conversion. A2A-specific errors MUST additionally carry a `google.rpc.ErrorInfo` in
`error.details`:

```json
{ "error": { "code": 404, "message": "…", "details": [
  { "@type": "type.googleapis.com/google.rpc.ErrorInfo",
    "reason": "TASK_NOT_FOUND",
    "domain": "a2a-protocol.org" } ] } }
```

`reason` is the error type in UPPER_SNAKE_CASE with the `Error` suffix dropped.

### Two normative rules that change this design

§3.3.2 states servers **MUST NOT** reveal the existence of resources the client is not
authorized to access, and **SHOULD NOT** distinguish "does not exist" from "not
authorized."

1. **`blocked` and `unknown_handle` collapse to an identical `404`.** The earlier table
   returned `403` for blocked, which tells a blocked caller that the handle exists and
   that they specifically were refused. Both must now be indistinguishable. This is a
   behavior change from today's protocol, which returns a distinct `blocked` code —
   **confirmed and accepted by Ryusei, 2026-08-01.**

   Indistinguishable **to the caller only.** The callee's `calls.log` must still record
   the real reason, so the audit trail distinguishes "someone I blocked tried to call"
   from "nobody called." Losing that would be a genuine regression: the block signal is
   most useful to the person who set it. The `blocked` code therefore survives on the
   private relay↔listener link and in the log; only the public response is flattened.
2. **`task_not_offered` must not confirm the task exists.** It maps to
   `UnsupportedOperationError` (`400`) and returns only the caller's own `offered[]` —
   what they *are* entitled to — never an acknowledgement of what they asked for.

Both tighten the same leak Codex flagged in F10: the caller learns their own capability,
never the callee's policy.

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
directly attacks the procurement claim. Candidate resolutions — **Spike 1 recommends
option 1**, see [its result](#spike-1-result--2026-08-01):

1. **Per-handle origins** (`https://ken.agents.acme.internal`) with wildcard DNS/TLS.
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
- **WebSocket binding.** Not because it is coming in v1.1 — it is not on the roadmap at
  all. A documented **custom protocol binding** path exists, with a canonical URI
  (`https://a2a-protocol.org/bindings/websocket`) and `wss://` examples. It stays a
  non-goal because the TCK covers only the three core bindings, so a WS binding is
  untestable and therefore cannot carry the conformance claim. Optional and additive
  later, never the primary interface.
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

1. ~~Run the pinned TCK against the proposed per-handle URL and discovery topology.~~
   **Done — see [Spike 1 result](#spike-1-result--2026-08-01).** Binding pinned to REST,
   topology validated against the real suite (47 MUST passing, 69.8%), six missed
   normative requirements surfaced.
2. Design the durable task store, delivery lease, retention, cancellation, and
   deduplication model (separate spec).
3. Define A2A authentication → agentcall principal mapping.
4. Complete endpoint security and the threat model as a hard public-release gate.

---

## Upstream spec check — 2026-08-01

Checked `a2aproject/A2A` `main` (`2cdf197`, 2026-07-31) against the v1.0.0 tag the TCK
vendors, to see whether anything in flight changes this design. Tags now include
**v1.0.1**; there is no v1.1 tag or branch.

### The only normative change since v1.0.0 is a `tenant` clarification

The entire `specification/` diff v1.0.0 → main is 29 insertions in `a2a.proto`, almost all
of it rewording `tenant`:

> "An **opaque string** used for routing requests to a specific agent or tenant **when
> multiple agents are served behind a single A2A endpoint**. When set, clients MUST
> include this value in the `tenant` field of all request messages sent to this interface.
> The server is responsible for interpreting the value and routing requests accordingly;
> **the protocol does not define its format or semantics**."

That is agentcall's deployment described verbatim, and it removes any doubt that a
`handle` is a legal tenant value — the protocol imposes no format. The spec authors spent
their only post-1.0 normative change clarifying the exact mechanism this design depends
on.

### A new topic doc sanctions three routing approaches

`docs/topics/multi-tenancy.md` did not exist in the vendored copy. It gives three
non-exclusive approaches for "several agents behind a single host or reverse-proxy":

1. **URL-based (sub-path)** — each agent advertises its own `url`. Called out as "the
   simplest approach and requires no special client awareness beyond reading the Agent
   Card."
2. **Auth-header-based** — the gateway routes on credentials already in the request.
3. **Body-based `tenant`** — the opaque discriminator above.

**Refinement to finding 4:** approach 1 is what the Spike 1 stub actually used
(`https://localhost:9999/ken`) and what passed the TCK; its `tenant` declaration was
decorative, since the stub routed on path. So the recommendation is **URL-based routing
as primary**, optionally also setting `tenant` for gateways that route on it. "The handle
is a tenant" was right in spirit; "the handle is a URL sub-path, and may also be a tenant"
is more precise.

Note the normative client rule (§8.3.2): a client **MUST** echo `tenant` when the
interface sets it and **MUST** omit it when the interface does not.

### Per-handle cards confirmed

> "When multiple agents are deployed behind a shared domain, each agent **SHOULD** have
> its own Agent Card published at an appropriate location. Clients retrieve each agent's
> card independently."

That is finding 5's registry conclusion, stated upstream.

### Correction: the WebSocket claim was wrong

This spec said twice that A2A's WebSocket binding was "roadmapped for v1.1+". **There is
no such roadmap item.** `docs/roadmap.md` (updated 2026-03-10) lists near-term: the 1.0
release, extension support, community process; longer-term: governance, validation (TCK
and Inspector), SDKs, best practices. No transport work at all.

The claim came from the Exa research sweep and was propagated into the design without
being checked against the repo. Corrected in both places above.

What *does* exist is `docs/topics/custom-protocol-bindings.md`, which treats WebSockets as
the worked example of a custom binding and assigns it a canonical URI
(`https://a2a-protocol.org/bindings/websocket`). So a WS binding is available, documented,
and untestable by the TCK — which is why it stays a non-goal, on better reasoning than
"wait for v1.1."

### Version pin

The TCK vendors v1.0.0 (`1736957`). Keep the run pinned there so the baseline stays
comparable; revisit when the TCK itself moves to v1.0.1 or later.

## Watching

**Do not set up spec-watching.** Four months post-1.0 the entire `specification/` diff is
29 lines clarifying one field, and `docs/roadmap.md` plans no protocol work at all —
near-term is extensions and community process, longer-term is governance, validation,
SDKs, and best practices. Reading diffs by hand would mostly surface changes that do not
affect us.

**The pinned TCK in CI is the change detector**, and a better one: bump the pin, and a red
build means the protocol moved in a way that breaks *this* implementation specifically.
That is a side effect of the gate we already want, not a process to build.

### The one thing that needs a human

**The A2A extension registry** — see `docs/topics/extension-and-binding-governance.md` and
the community registry. Extensions are the designated evolution path ("continue to support
additional A2A extensions with SDK support" is the roadmap's actual near-term item), so
future capability arrives there rather than in the core.

That is where this design's stated residual risk lives: **a standardized policy or
authorization extension would erase the expression half of the differentiator.** It would
not break the build — CI stays green — so it is the one change class no automation will
surface.

| | |
|---|---|
| Watch | A2A extension registry, for a policy / authorization / delegated-authority extension |
| Cadence | Quarterly. It is a positioning signal, not an engineering one |
| If it appears | Adopt the standard expression; keep enforcement. A standard can specify how to express a grant; it cannot ship the thing that refuses the read |

### Deferred reading

`docs/topics/streaming-and-async.md` was skipped — not load-bearing here, but likely
load-bearing for
[durable-offline-delivery](./2026-08-01-durable-offline-delivery-requirements.md), whose
open questions are stream reconnection, async delivery, and disconnected clients. Read it
against that spec's real questions rather than skimming it now.

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

## Spike 1 result — 2026-08-01

**Method:** read the suite; did **not** run it. There is no SUT yet — agentcall has no
A2A endpoint — so a run would only have proved the TCK starts. Reading it answers the two
questions that gate design decisions, at a fraction of the cost. TCK pinned at
`5996b79f9cefa6fc390980e383e358a66fb9e49e` (2026-06-29). Python 3.11+, uv.

### 1. REST is not thin — keep it pinned

Codex's caveat was to switch to JSON-RPC if the REST profile proved materially
incomplete. It does not:

| Suite | Tests |
|---|---|
| `core_operations` | 81, **parameterized over `ALL_TRANSPORTS`** |
| `agent_card` | 10 |
| transport-specific: `http_json` / `jsonrpc` / `grpc` | 14 / 15 / 11 |

Because the 81 core requirement tests are parameterized across transports
(`tests/compatibility/core_operations/test_requirements.py:150`), HTTP+JSON receives the
full core requirement suite, not just its own 14. Against JSON-RPC's 15 transport-specific
tests, that is parity. **The REST pin stands; the JSON-RPC fallback is not needed.**

Transport selection is driven by the card's `supportedInterfaces`, so declaring only REST
scopes the run to REST — which matches "advertise only REST initially."

### 2. Discovery — the per-handle topology passes, but not cleanly

The TCK hardcodes the card path and has **no `--card-url` flag**:

```python
# tests/compatibility/conftest.py:100
url = f"{base}/.well-known/agent-card.json"
```

`base` is `--sut-host`, an arbitrary URL. So `--sut-host https://host/a2a/ken` resolves to
`https://host/a2a/ken/.well-known/agent-card.json`, and every card test derives from that
same base — nothing asserts origin-level discovery. **The proposed per-handle topology
passes the TCK.**

But it passes via a *nested* well-known path, and well-known URIs are origin-scoped under
RFC 8615 — the TCK's own docstring cites "Per the A2A spec (Section 8.2)". So a green run
proves the agent at that base URL is conformant; it does not prove conventional origin
discovery. That is exactly the gap a procurement reviewer probes, and it is the argument
F4 warned about.

*Superseded by finding 4 below — the workaround is unnecessary.*

### 4. A2A v1.0 has native multi-tenancy — the handle **is** a tenant

The decisive finding, and it invalidates the recommendation immediately above. Every RPC
in `a2a.proto` carries an `additional_binding` with `{tenant}` as the leading path
segment:

```
POST /{tenant}/message:send          GET  /{tenant}/tasks/{id=*}
POST /{tenant}/message:stream        GET  /{tenant}/tasks
POST /{tenant}/tasks/{id=*}:cancel   GET  /{tenant}/tasks/{id=*}:subscribe
GET  /{tenant}/extendedAgentCard     …plus the push-config variants
```

`AgentInterface.tenant` is documented as "Tenant ID to be used in the request when calling
the agent," and `SendMessageRequest.tenant` as "Optional. Tenant ID, provided as a path
parameter." `GetExtendedAgentCardRequest` and `TaskPushNotificationConfig` carry it too.

**agentcall's `handle` maps directly onto A2A's `tenant`.** One origin, one relay, no
wildcard DNS, no nested well-known path, no proprietary discovery — the multi-tenancy the
first draft treated as an unsolved deviation is a first-class concept in the spec.

This also explains why the TCK needs no `--card-url` flag: operation URLs come from the
card's own `supportedInterfaces[].url` (`tests/compatibility/conftest.py:139`), which is
independent of where the card was fetched. Setting that URL to `https://host/ken` makes
the client hit `https://host/ken/message:send` — the tenant binding, with the tenant in
the base.

### 5. Discovery is a registry problem, and A2A sanctions registries — question closed

The remaining worry was how origin-level card discovery composes with per-tenant
interfaces. It dissolves: **A2A officially recognizes three discovery mechanisms**, not
one ([agent-discovery.md](https://github.com/a2aproject/A2A/blob/main/docs/topics/agent-discovery.md)):

1. **Well-Known URI** — `https://{domain}/.well-known/agent-card.json`, RFC 8615.
2. **Curated Registries** — "an intermediary service (the registry) maintains a collection
   of Agent Cards. Clients query this registry to find agents based on various criteria,"
   for "both private and public marketplaces."
3. **Direct configuration / private discovery** — for tightly coupled or private systems.

**The relay is a curated registry.** `GET /v1/card/:handle` is already a registry query.
That is mechanism 2, officially sanctioned — not a deviation needing a workaround. And
because the spec "does not prescribe a standard API for curated registries," a registry
API cannot be non-conformant.

Options 1–3 of the discovery section, and finding 3's nested-well-known concern, are all
withdrawn. Nothing needs wildcard DNS.

**Resolved topology:**

| Concern | Resolution |
|---|---|
| Operations | tenant binding — `/{handle}/message:send`, etc. (finding 4) |
| Per-handle card | curated registry — the relay's card endpoint, returning a real `AgentCard` |
| Origin well-known | **one** card describing the *relay itself* — the directory/gateway agent. Honest and conformant: it is the relay's own card, not a per-handle fudge |
| `handle@host` | the naming/resolution layer over the registry |
| TCK run | prove conformance once for the tenant endpoint shape; it is the same code path for every handle, so per-handle conformance follows |

That last row matters for the procurement claim: we demonstrate a conformant
card-plus-endpoint pair, not conformance of every handle individually.

### 6. Corroboration — Cotal reached the same judgment independently

Cotal faces the identical problem (many agents, one deployment) and **declined A2A's
well-known discovery**: it resolves a bare name to `.cotal/agents/<name>.md` by directory
convention, "not an HTTP /.well-known card," with presence in a per-space NATS KV bucket
(TTL + heartbeat). It reuses A2A's `AgentCard` and `Message`/`Part` *shapes* while
replacing the discovery *mechanism*.

Two independent projects reading the same spec concluded that origin-scoped well-known
discovery does not fit person- or agent-scoped multiplicity. That is corroboration the
reading is right, not a shortcut.

The gap is acknowledged ecosystem-wide — Solo.io's
[agent discovery, naming and resolution](https://blog.christianposta.com/dynamic-agent-discovery-with-a2a-and-ans/)
argues A2A lacks registration, a naming service, and a gateway. **agentcall already has
all three**: the relay is registration and gateway, `handle@host` is the naming service.
Worth treating as positioning, not just as a technical resolution — it is the thing the
ecosystem says is missing.

### 3. New concrete requirement the design missed

The card endpoint needs `Cache-Control` with `max-age` and an `ETag` (both **SHOULD** —
`xfail`, so they do not block the compatibility claim) and `Last-Modified` (**MAY**).
`/v1/card/:handle` currently sets none of them — it returns a bare `c.json(...)`
(`apps/relay/src/index.ts:148`). Cheap to add; worth doing so the report is clean.

### Version pins established

| Thing | Pin |
|---|---|
| TCK | `5996b79f9cefa6fc390980e383e358a66fb9e49e` (2026-06-29) |
| A2A spec vendored in the TCK | v1.0.0 @ `173695755607e884aa9acf8ce4feed90e32727a1` |
| Toolchain | Python 3.11+, `uv` |

### REST surface the stub must serve

From `tck/transport/http_json_client.py`, with `{tenant}` prefixes per finding 4:

```
POST /{tenant}/message:send          POST /{tenant}/message:stream      (SSE)
GET  /{tenant}/tasks/{id}            GET  /{tenant}/tasks?contextId=
POST /{tenant}/tasks/{id}:cancel     …:subscribe                        (SSE)
POST|GET /{tenant}/tasks/{id}/pushNotificationConfigs[/{configId}]
```

### 7. Baseline established — the TCK was run, and the topology holds

A ~200-line dependency-free Node stub was built over the surface above and the suite run
against it:

```
./run_tck.py --sut-host http://localhost:9999 --transport http_json --level must
→ 47 passed, 16 failed, 172 skipped
```

| Level | Compatibility |
|---|---|
| MUST | **69.8%** |
| SHOULD | 100% |
| MAY | 100% |

**The resolved topology is validated empirically, not just by reading.** The TCK fetched
the card from the origin well-known path, followed `supportedInterfaces[0].url` to the
tenant path `/ken`, and executed operations there. Findings 4 and 5 hold against the real
suite.

100% SHOULD confirms finding 3: setting `Cache-Control`, `ETag`, and `Last-Modified` on
the card endpoint passes those checks.

### 8. Normative requirements the design missed

Every one of these came from a failure, and none was in the design:

| Requirement | Detail |
|---|---|
| **AIP-193 error format** | REST error bodies must follow Google's AIP-193 — `error.code` is a **number**, not a string. The stub's `"NOT_FOUND"` failed with `invalid literal for int()`. Spec §11.6 |
| **Normative error→status mapping** | Spec §5.4 defines the mapping. **Now transcribed — see [Error mapping](#error-mapping).** It also surfaced two non-disclosure rules that changed the design: `blocked` and `unknown_handle` must be indistinguishable |
| **`A2A-Version` header** | The server MUST validate it and return `VersionNotSupportedError` (400) when unsupported. Not mentioned anywhere in the design |
| **Terminal-state guards** | `CancelTask` and `SubscribeToTask` must error on an already-terminal task |
| **`SendMessage` may return a bare `Message`** | Not always a `Task`. `SendMessageResponse` is a `{message?, task?}` wrapper |
| **Artifact part shapes** | text / file / file-url / data artifact variants are individually checked |

The §5.4 mapping is the significant one — it replaces hand-reasoning in the lifecycle
table with a normative table, and it should be transcribed before implementation rather
than re-derived.

### Remaining work in Spike 1

None. The spike is complete: binding pinned, topology validated against the real suite,
baseline recorded, and six missed requirements surfaced.

The stub lives in the session scratchpad and is **not** committed — it is throwaway spike
code. If the baseline needs to be reproducible for the CI gate, it should be rebuilt
inside the repo as a proper fixture rather than resurrected from scratch.

## Sources

- [A2A specification](https://a2a-protocol.org/latest/specification/) — objects,
  transports, task states, extension mechanism, authz scope (read directly)
- [Announcing A2A 1.0](https://a2a-protocol.org/latest/announcing-1.0/) — v1.0.0, 2026-04-09
- [Google → Linux Foundation donation](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/) — 2025-06-23
- [a2a-tck](https://github.com/a2aproject/a2a-tck) — conformance suite
- [A2A#1755](https://github.com/a2aproject/A2A/issues/1755) — the 50-agent probe
