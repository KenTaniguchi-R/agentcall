# A2A protocol adoption — design

**Date:** 2026-08-01
**Status:** Design approved by Ryusei. No implementation started. Research grounded in
A2A v1.0.0 primary sources (spec, GitHub, Linux Foundation) plus an Exa sweep of ~106
sources; load-bearing claims were verified directly rather than taken from subagents.
**Companion doc:** [2026-08-01-cotal-enterprise-installability](../../research/2026-08-01-cotal-enterprise-installability.md),
whose item E.1 ("adopt the A2A AgentCard shape") this supersedes with something larger.

---

## The decision

agentcall stops defining a wire protocol and becomes an **A2A gateway with a policy
engine for person-scoped agents**. The relay exposes a conformant A2A surface publicly;
the existing WSS frames are demoted to private plumbing between two components we ship
together.

## Why

Two drivers, both chosen explicitly:

1. **Procurement credibility.** An answer to enterprise architecture review that is
   *checkable* — [a2a-tck](https://github.com/a2aproject/a2a-tck) exists, so "we pass
   the official conformance suite" is falsifiable, unlike "A2A-compatible".
2. **Stop maintaining a protocol.** Schema design, versioning, and edge-case decisions
   move to a Linux Foundation project with seven founding vendors.

**Explicitly not a driver: real interop.** The research does not support it. One
community probe of 50 agents advertising A2A support found 0% responded to task
requests and ~0–4% returned a valid agent card
([A2A#1755](https://github.com/a2aproject/A2A/issues/1755), closed — one datapoint, not
a study). An HBR Analytic Services survey put production trust at 6% against 150
orgs announcing support. Practitioner writeups describe the real pattern as A2A *inside
one vendor's walls*, not open cross-vendor discovery. A2A has won mindshare, not
endpoints. The design must not assume anyone will call us over it.

The stronger argument is neither driver: **conforming is how agentcall stops being a
protocol.** Cotal chose to be a protocol and will therefore be vendored rather than
bought. One person cannot win a standards fight against the Agentic AI Foundation, and
should not enter one.

### Why the spec does not threaten the product

A2A declares **out of scope**: authorization semantics (scope, representation, validity,
revocation), trust establishment, credential provisioning, and agent identity
verification. Those, plus the audit trail, are the product. Value accrues to identity
("who is `ken@`?"), policy ("what may this caller invoke?"), and enforcement — and the
spec says it will not compete there.

Residual risk, accepted: a later A2A version may standardize a policy-expression
extension and erase the *expression* differentiator. Survivable, because the durable
asset is **enforcement** — `resolveTask()`, the tool guard, `tools.log` — which is
implementation, not protocol. A standard can specify how to express a grant; it cannot
ship the thing that refuses the read.

## Architecture

```
A's agent  →  agentcall CLI (an ordinary A2A client)
                    ↓  HTTPS: A2A JSON-RPC 2.0 / HTTP+JSON, SSE for status   ← public, conformant, TCK-gated
              Relay (Worker + DO + D1) = the A2A server
                    ↓  WSS: internal frames                                  ← private, unversioned, ours
              agentcall listen (B's Mac)
                    ↓  spawn
              claude -p / codex exec
```

The conformance boundary is the relay's **public edge**, not the listener. Consequences:

- `packages/shared/src/protocol.ts` stops being a protocol anyone else implements. It
  becomes internal RPC between two components shipped together, so it no longer needs
  versioning, negotiation, or documentation.
- The listener and spawn path are **unchanged by this spec**.
- A2A v1.0 has no WebSocket binding (roadmapped for v1.1+). Irrelevant here: HTTP is
  only needed *outward*. WSS stays inward, where the spec has no opinion.
- Transport-agnostic, and therefore decidable before the open transport questions
  (self-hostable relay, own-the-wire vs ride-a-mesh). Whatever wins those, the public
  A2A face is unchanged.

### Adapter, not replacement

**A2A is a serialization of our domain model, not our domain model.**

`packages/shared` keeps types that are ours — `Call`, `Caller`, `Task`, `Grant`,
`Policy`. A new `packages/shared/src/a2a/` serializes them to and from A2A objects. The
relay imports the adapter; nothing else does.

The cost is one indirection in a 386-line relay. It buys:

- A2A version churn (v1.1's WebSocket binding is already roadmapped) lands in the
  adapter, not the core.
- A second protocol later is another adapter, not a rewrite.
- If A2A stalls, we delete an adapter instead of unwinding a domain model — a live
  possibility given the adoption evidence above, and given that A2A's companion payments
  protocol AP2 saw daily flows collapse from 731k (Dec 2025) to 57k (Feb 2026).

## Object mapping

| agentcall domain | A2A 1.0 | Note |
|---|---|---|
| `CardTask` | `AgentSkill` | direct |
| `AgentCard` (ours) | `AgentCard` + extension | `handle` / `agent_kind` move into the extension |
| `call_request` | `SendMessage` + `Message{parts:[{text}]}` | direct |
| `call_id` | `Task.id` | direct |
| `session_id` | `Task.contextId` | delivers the multi-turn threading deferred to v1.5 |
| reply text | `Artifact` / `Message` text `Part` | direct |
| `offered[]` | extension data | no A2A equivalent |
| per-caller `grants` | **no A2A equivalent** | stays ours; authz is out of scope in A2A |

Two mappings confirm the fit is not forced:

- `Task.contextId` is exactly the call-threading concept `session_id` was reserved for.
- A2A defines `capabilities.extendedAgentCard` plus a `GetExtendedAgentCard` RPC — an
  authenticated richer view of the card. That is precisely the public-view /
  authenticated-extended-view split `packages/shared/src/card.ts` already implements.
  The same design was arrived at independently on both sides.

Everything custom collapses to **one declared extension URI** carrying `handle`,
`agent_kind`, `grants`, and `offered[]`:

```
https://agentcall.benree.tech/ext/policy/v1
```

That URI is a **stable identifier, not a per-deployment address**. It does not vary by
relay host and need not resolve. A self-hosted relay at `agents.acme.internal` declares
this same URI — otherwise every deployment would advertise a different extension and no
client could recognize any of them, which would defeat the point of declaring one.

## Task lifecycle

| agentcall | A2A state | Note |
|---|---|---|
| `ringing`, `answered` | `SUBMITTED` | |
| `working` | `WORKING` | |
| reply delivered | `COMPLETED` | text as `Artifact` |
| `busy`, within queue depth | `SUBMITTED` | listener already queues 1 running + 5 pending |
| `busy`, queue full | `REJECTED` | a refusal, not a delay |
| `task_not_offered`, `task_unknown` | `REJECTED` | `offered[]` rides in the extension |
| `timeout`, `agent_error` | `FAILED` | reason in the extension |
| **`offline`** | **`SUBMITTED`** | see below |
| `unknown_handle` | — | pre-task: HTTP 404 |
| `rate_limited` | — | pre-task: HTTP 429 |
| `unauthorized` | — | pre-task: HTTP 401 |
| `blocked` | — | pre-task: HTTP 403 |
| `message_too_large` | — | pre-task: HTTP 413 |
| `protocol_error` | — | JSON-RPC `-32600` / `-32602` |
| — | `INPUT_REQUIRED`, `AUTH_REQUIRED` | reserved, unused in v1 |

### `offline` becomes `SUBMITTED`

A2A has no presence concept. That looked like a gap and resolves the other way: an
offline callee is not an error, it is **a task that has not started yet**, which is what
`SUBMITTED` means. A2A already specifies how a caller waits on one — poll `GetTask`,
subscribe, or register a push-notification config.

So the durable mailbox — the one axis where Cotal was ahead, item D.1 of the companion
doc — arrives as a *consequence* of conforming rather than as a feature to build. The
migration is one constant: today the `SUBMITTED` deadline is `RELAY_CALL_TIMEOUT_MS`
(6 min) and fails fast; later it becomes days. Same state machine, no protocol change.

**This is the decision that commits the relay to a durable task store.** The DO already
persists `call:${call_id}` records with deadlines and an alarm, so the distance is
short — but it is a real commitment and is called out here rather than discovered later.

## CLI

`agentcall call` becomes an ordinary A2A client: HTTP+JSON out, SSE for the
`ringing…` / `answered, agent working…` status stream it currently receives over WSS.
Dogfooding the public surface is the cheapest available guarantee that it works.

`agentcall listen` is unchanged.

## Discovery and addressing

`handle@host` is retained — it is a differentiator A2A has no equivalent for, and the
whole product metaphor.

**Open decision, deliberately deferred.** A2A's discovery convention is
`/.well-known/agent-card.json`, which is per-*origin*, while agentcall is multi-tenant
(many handles, one host). The proposed resolution is `ken@agentcall.example` →
`https://agentcall.example/a2a/ken/agent-card.json`, with the origin's well-known path
describing the relay's directory rather than any single agent. Defensible — cards may
live at any URL and well-known is a convention — but it is the one place a TCK run or a
strict reviewer may push back.

Deferred because it gets *easier*, not harder: once self-hosted relays exist, each org
has its own origin and the multi-tenancy pressure largely disappears.

## Testing

Test-first, per repo convention, in this order:

1. **Adapter round-trip tests** in `packages/shared` — domain → A2A → domain for every
   object, plus rejection tests for malformed A2A input. Same shape as the existing zod
   tests.
2. **Relay state-machine tests** in `apps/relay` using the existing fake caller/listener
   sockets, covering every transition above — especially
   `offline` → `SUBMITTED` → deadline → `FAILED`.
3. **`a2a-tck` as a CI gate**, run against `wrangler dev`. This is the point of the
   exercise: it converts "we are A2A conformant" from a claim into a build step. A red
   TCK must fail the build, because a red TCK means the credibility argument is gone.

Per CLAUDE.md, `typecheck` does not cover `test/` — a green typecheck will not show the
adapter refactor is complete. Only `pnpm -r test` will.

## Non-goals

- **Real cross-vendor interop.** Not designed for, not tested for, not claimed.
- **A custom A2A transport binding (§12).** Rejected: it fails both drivers at once —
  we would still maintain a spec, and the TCK covers only JSON-RPC / gRPC / HTTP+JSON,
  so the checkable claim disappears.
- **WebSocket binding.** Wait for A2A v1.1 rather than building something to throw away.
- **Changing the listener, spawn path, or tool guard.**

## Dependency, not in scope

Conforming publishes a standard, well-documented way to drive an agent running on an
employee's laptop with no OS sandbox. Today the obscurity of a bespoke protocol does a
small amount of unearned security work; this removes it.

That does not change the decision, but it **raises the priority of the C-group items**
in the companion doc — specifically the `exec` read floor and Codex guard parity. They
are a dependency of shipping this publicly, and are recorded here so the coupling is
explicit rather than a surprise. Designing them is a separate spec.

## Sources

- [A2A specification](https://a2a-protocol.org/latest/specification/) — objects,
  transports, task states, extension mechanism, authz scope (read directly)
- [Announcing A2A 1.0](https://a2a-protocol.org/latest/announcing-1.0/) — v1.0.0,
  2026-04-09; signed AgentCards (JWS, RFC 7515) as the headline feature
- [Google → Linux Foundation donation](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/) — 2025-06-23
- [a2a-tck](https://github.com/a2aproject/a2a-tck) — conformance suite
- [A2A#1755](https://github.com/a2aproject/A2A/issues/1755) — the 50-agent probe
