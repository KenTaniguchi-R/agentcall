# How Hermes Agent shipped A2A v1.0 — and what it says about our boundary

**Date:** 2026-08-04
**Status:** Research. Our A2A track was deprioritized on 2026-08-01 and nothing
here reopens it — the conclusion is explicitly *do not adopt their
architecture*. §8.4 audits our code against theirs. Unusually for this
directory, two findings from that audit were filed and shipped the same day
(#327 → #329, #328 → #330); §9 records what landed and how it differed from
what this document first proposed. Both are in our one-to-one call path, and
neither is A2A.
**Source discipline:** Primary sources only — the merged source of
`NousResearch/hermes-agent` at `plugins/platforms/a2a/` (PR #77109, merged
2026-08-02, +5,967/-1 across 15 files, closing issue #514), its `DESIGN.md`
and `README.md`, and the v0.20.0 (`v2026.8.3`) release notes. Line counts and
constants are read from the merged files, not from the prose.

## Executive summary

Hermes shipped a complete, security-conscious A2A v1.0 implementation as a
**bundled plugin with zero core edits** — 2,114 lines across `adapter.py`
(1,272) and `protocol.py` (842), plus `tools.py` (23.6 KB) and `security.py`
(14.4 KB). Stdlib only; they deliberately declined a dependency on `a2a-sdk`.
It serves the JSON-RPC binding and nothing else, and the Agent Card advertises
exactly that.

Two design choices are worth reading carefully:

1. **Live-session injection.** Inbound A2A tasks are answered by the *same*
   agent session that is serving the human user, with full memory — not a
   spawned clone. This is the hard part of inbound agent-to-agent, and their
   solution is legible. It is also the wrong choice for us; see §8.3.
2. **Security defaults that bind rather than warn.** No token configured means
   the listener binds `127.0.0.1` and refuses to widen; a token alone still
   does not widen it.

For us, the implementation is most useful two ways. As a **negative space map**
it demonstrates in shipped code exactly which problems A2A does *not* solve —
identity and discovery — and those are the problems agentcall exists to solve
(§8.1). As a **checklist** it exposed two real gaps in our own call path
(§8.4): we frame inbound caller text but never transform it, and we send the
agent's reply back unscanned.

The headline for anyone reading this to decide whether to adopt their design:
**don't.** On seven of the nine mechanisms where both codebases solve the same
problem, ours is equal or better, usually because we removed a failure mode
where they manage one. The two exceptions are content filters, not
architecture.

## 1. Why a plugin, and why that mattered

`DESIGN.md` opens by naming four prior attempts that failed — #4135, #4948,
#4952, #11025 — each of which added a standalone `a2a_adapter/` server package
and/or patched `gateway/run.py` and `gateway/config.py`. The standing policy in
that repo is that plugins must not touch core files, so every attempt stalled
against it.

What changed is that the codebase grew `ctx.register_platform()` (the plugin
platform-adapter API, already used by irc, line, teams, ntfy, simplex) and
`ctx.register_tool()`. Once both existed, A2A became expressible entirely
inside `plugins/platforms/a2a/`.

The lesson is not about A2A. It is that a four-times-rejected feature landed
the week after the extension point it needed appeared. Worth remembering when
we are deciding whether to bend an invariant for a feature or grow the seam
that would let the feature respect it.

## 2. Scope: one binding, on purpose

Implemented: A2A Protocol **v1.0**, JSON-RPC binding.

Explicitly out of scope in `DESIGN.md`:

- `a2a-sdk`, gRPC and HTTP+JSON bindings
- `tenant` field, extended Agent Card, `stateTransitionHistory`
- True task abort (`tasks/cancel` marks canceled and drops the reply, but
  cannot abort the live session's in-flight turn)
- DID / Ed25519 identity, OAuth2 scopes, x402 micropayments — dismissed as
  "heavy, niche; revisit if there's real demand"

That last bullet is the interesting one. The identity layer — durable,
verifiable agent identity — is the thing they deferred, and it is roughly the
thing agentcall is.

### Wire-format details they got right

- Task states and roles are SCREAMING_SNAKE_CASE (`TASK_STATE_*`, `ROLE_*`).
- Parts are **member-presence discriminated** — no `kind` field. All three
  Part types are supported (text, file, data). `extract_text` renders file and
  data Parts into the text stream so the model sees them, and stays tolerant of
  v0.3 (`kind`) and pre-0.3 (`type`) shapes from older peers. Outbound replies
  remain text-only.
- `contextId` lives inside the Message; a legacy top-level field is accepted
  inbound only.
- SSE events are `StreamResponse` objects; stream closure signals the terminal
  state — there is no `final` field.
- A2A-reserved error codes are used only with spec semantics (`-32001`
  TaskNotFound, `-32002` TaskNotCancelable); custom errors sit at
  `-32050..-32052`.

## 3. Live-session injection — the mechanism

This is the part worth reading in full. `adapter.py:696` `_prepare_task` runs
on an HTTP worker thread and does, in order:

1. **Anti-loop check first.** `self._turns.track(context_id)`; if the turn
   count exceeds `A2A_MAX_PINGPONG_TURNS` (default 5, hard max 20) the task is
   created and immediately completed as `TASK_STATE_REJECTED` with a message
   naming the cap. Rejection happens *before* any agent work.
2. Empty-text check → same immediate-rejection path.
3. `security.wrap_inbound(peer, text)` frames the text as untrusted peer
   input; `security.audit("inbound", …)` logs it; `protocol.persist_message`
   writes it to the conversation log.
4. `self.tasks.create(...)` registers the task in the store.
5. `fut = self._add_pending(task_id, context_id)` — a `concurrent.futures.
   Future` keyed by task id, with a **per-context FIFO deque**
   (`_pending_order`) alongside it.
6. A normal `MessageEvent` is constructed with `chat_id=context_id`,
   `chat_name=f"a2a:{peer}"`, `chat_type="dm"`, `message_id=task_id`, and
   dispatched via `asyncio.run_coroutine_threadsafe(self.handle_message(event),
   self._loop)` — i.e. straight into the gateway's ordinary message path.
7. Task moves to `TASK_STATE_WORKING`; the pending dict (carrying the future)
   is returned so the HTTP handler can block on it.

The reply comes back through the adapter's `send()` (`adapter.py:1223`), which
is where the subtlety lives:

```python
if not (metadata or {}).get("notify"):
    logger.debug("A2A: ignoring non-final send for context %s", chat_id)
    return SendResult(success=True, message_id=message_id)
if not self._resolve_oldest_for_context(chat_id, protocol.STATE_COMPLETED, content or ""):
    logger.debug("A2A: send() for context %s had no pending waiter", chat_id)
```

Two things: only sends marked `metadata['notify']` — the gateway's documented
final-reply marker — satisfy the JSON-RPC caller, so progress updates, status
lines, and editable previews do not accidentally resolve the RPC. And
resolution is *oldest-pending-for-this-context*, which is why the per-context
FIFO exists: concurrent same-context requests cannot cross-talk, because the
gateway session processes messages in order.

`on_processing_complete` (`adapter.py:1251`) is the escape hatch — it maps
`FAILURE` → `TASK_STATE_FAILED`, `CANCELLED` → `TASK_STATE_CANCELED`, and
anything else → completed-with-empty. Without it, a run that ends without ever
calling `send()` would make the HTTP thread wait out the full
`A2A_REPLY_TIMEOUT` (300 s).

`_await_reply` (`adapter.py:928`) blocks on the future with a deadline, and on
SSE paths wakes every `_SSE_KEEPALIVE` (5 s) to emit a keepalive comment —
if the keepalive raises, the client is gone and it stops waiting rather than
burning the full timeout.

`_finalize_task` (`adapter.py:896`) does outbound redaction, then detects the
`[INPUT_REQUIRED]` marker: if a completed reply starts with it, the state
becomes `TASK_STATE_INPUT_REQUIRED` and the marker is stripped, with the
question carried in `status.message`. That is a prompt-level convention doing
protocol-level work — the platform hint tells the agent to prefix its reply
that way — which is cheap and works, but is exactly the kind of in-band
signalling that gets fragile at scale.

## 4. Task store and watchdog

`protocol.py:577` `TaskStore` is an in-memory `OrderedDict` under a lock:

- Terminal tasks are **kept** so `tasks/get` still answers, bounded to the last
  500 (`_MAX_TERMINAL`, trimmed on each `complete()`).
- `complete()` is idempotent — it returns `None` if the task is already
  terminal, which is what prevents the watchdog from double-counting metrics.
- Every record carries `agent_slug` and `tenant`, and every read/write helper
  takes optional scope arguments and returns not-found when the task exists but
  is out of scope. That is the spec's authorization-scoping rule enforced at
  the store, not at each call site — the right place for it.
- `watch()` returns a Future per task; `complete()` resolves all watchers.
  `tasks/subscribe` reattaches to a running task's stream through this.

The watchdog (`adapter.py:470`) is a background thread waking every
`_WATCHDOG_INTERVAL` (60 s) calling `tasks.fail_orphans(_ORPHAN_TIMEOUT)` —
300 s. Orphans are non-terminal tasks older than the timeout; they get completed
as `TASK_STATE_FAILED` with `"[task orphaned — no reply produced]"` and stay
queryable. Because `complete()` is idempotent, a task that resolves in the same
tick is not counted twice.

## 5. Security model

The whole model is worth listing because it is what an *open* cross-agent
protocol costs.

- **Bind safety.** No `A2A_BEARER_TOKEN` and no `A2A_PEER_TOKENS` ⇒ bind
  `127.0.0.1`. A token alone does **not** widen the bind; remote exposure needs
  a token *and* an explicit `A2A_HOST`. Misconfiguration logs and downgrades
  rather than exposing.
- **Peer identity.** `A2A_PEER_TOKENS="alice:tok1,bob:tok2"` gives each peer
  its own credential; the matched name is the authenticated identity used for
  rate limiting, the trust gate, message framing, and audit. A shared
  `A2A_BEARER_TOKEN` degrades identity to `ip:<addr>`. Nothing in the request
  body can assert identity. Comparisons are constant-time.
- **Trust gate.** `A2A_TRUSTED_PEERS` optionally allow-lists which
  authenticated identities may run tasks at all.
- **Injection filters.** *All* inbound text including `/`-prefixed is defanged
  (ChatML, role-prefix, and override patterns → `[filtered]`) and framed with a
  prefix marking it untrusted peer input. Remote peers can never reach operator
  slash commands.
- **Outbound redaction.** Credential-shaped strings (`sk-…`, `ghp_…`, JWTs,
  bearer tokens, emails) scrubbed before anything leaves.
- **Rate limiting.** Sliding window per authenticated identity,
  `A2A_RATE_LIMIT`/min (default 60).
- **Anti-loop.** Per-context turn cap as described above.
- **Push callbacks.** SSRF-guarded URLs, HMAC-SHA256 signed as
  `X-A2A-Signature` with `A2A_PUSH_SECRET` falling back to the bearer token.
- **Audit.** Append-only `~/.hermes/a2a_audit.jsonl` for every exchange, both
  directions.

## 6. Persistence outside compaction

A2A conversations are written to `~/.hermes/a2a_conversations/<context>.jsonl`,
deliberately outside the context-compaction pipeline, so compaction and
restarts cannot lose them. `a2a_history(context_id)` recalls them. This was a
stated requirement from #11025.

State placement is explicit in `DESIGN.md`: task store, turn tracker, and rate
limiter are **adapter-instance** objects; the metrics counter bag is a module
singleton *because* it is intentionally shared between the inbound adapter and
the outbound client tools, so `/metrics` and `a2a_list` report both directions.

## 7. Outbound tools

Five, registered in the `a2a` toolset (off by default — `a2a` is in
`_DEFAULT_OFF_TOOLSETS` in `hermes_cli/tools_config.py`):

| Tool | Does |
|---|---|
| `a2a_discover(url)` | Fetch and summarize a peer's Agent Card; v1.0 `supportedInterfaces` aware, tolerates 0.3 cards |
| `a2a_call(agent, message, context_id?)` | JSON-RPC `message/send`; multi-turn via `context_id`; surfaces `TASK_STATE_INPUT_REQUIRED` |
| `a2a_list()` | Configured peers + persisted conversations + metrics |
| `a2a_history(context_id, limit?)` | Recall a persisted conversation |
| `a2a_orchestrate(capability, message, mode?)` | Fan-out to every peer advertising a capability. Modes `all` / `first` / `best` |

`best` is worth flagging as an anti-pattern they self-document: it picks the
**longest successful reply**, which `DESIGN.md` calls "a deliberately coarse
heuristic." Errors never win, and an all-error fan-out reports the failures
instead of picking one. If we ever build fan-out, longest-reply is not the
selector — but the failure handling is right.

Peers are resolved from `config.yaml` → `a2a_agents`, or a direct URL.

## 8. Read against agentcall

### 8.1 The identity gap is now visible in shipped code

Hermes peers are **URLs in a config file with bearer tokens**:

```yaml
a2a_agents:
  researcher:
    url: "http://localhost:9999"
    auth: { type: bearer, token: "sk-..." }
    capabilities: [web_search, research]
```

There is no handle, no address, no durable reachability, and no discovery
beyond fetching a card at a URL you already possess. `a2a_discover` answers
*what can this agent do* — it cannot answer *which agent should I ask*.

That is the gap #6 of our research sequence
([lessons-from-composio](./2026-07-31-lessons-from-composio.md)) identified as
`agentcall search`: resolving *who* to ask. It is no longer a hypothetical gap
in an abstract protocol. It is a gap in a 6,000-line implementation shipped by
a well-resourced team who thought carefully about everything else, and who
explicitly deferred the identity layer as "heavy, niche."

### 8.2 Their security surface is the tax our boundary avoids

Per-peer tokens, trust allow-lists, injection defanging, outbound redaction,
rate limiting, anti-loop caps, SSRF guards, HMAC signing, audit logs — all of
it exists because in an open A2A deployment the caller could be anyone.

Our [federation non-goal](../superpowers/specs/2026-08-02-cross-organization-federation-non-goal.md)
makes the organization the outermost boundary, and callers are resolved by
`authenticateRequest` before any of this matters. Hermes's `security.py` is a
concrete, honest price tag for the alternative. That is a useful thing to be
able to point at.

It does **not** follow that we need none of it. Two of their controls are about
the *callee protecting itself from a peer it already trusts*, and survive
inside a single organization:

- **Anti-loop turn caps.** Two agents in the same company can ping-pong just as
  easily as two across companies. A per-context turn cap is cheap.
- **Untrusted-input framing for agent-authored text.** An in-organization peer
  agent's output is still model-generated text arriving at another model. Their
  rule — inbound text is framed as untrusted and can never reach operator
  commands — is orthogonal to federation.

### 8.3 Live-session injection is elegant, and wrong for us

On first read the injection pattern looked like the thing to steal. It is not.

It means the inbound task is answered by the agent instance already serving the
human, carrying that human's full context and whatever tools that session
holds. Our model is deliberately the opposite: the callee's agent answers inside
a task cap, in a spawn envelope fixed before the prompt is built
(`runner.ts:222-306`), with the task selected by policy before untrusted text
enters the prompt (README L228). Adopting their injection would delete
capability scoping — the caller would reach whatever the owner's live session
can reach.

We already have the half that is actually useful: `resume`/`contextId`
threading gives conversational continuity across calls without merging the
caller's task into the owner's session.

### 8.4 Per-mechanism comparison against `origin/main` @ `c55b84d`

Read on 2026-08-04. Where the two implementations solve the same problem, ours
is ahead in every case but one, and the one exception is not architectural.

| Mechanism | Hermes | agentcall | Verdict |
|---|---|---|---|
| Reply correlation | Per-context FIFO deque + `Future`; needed because concurrent same-context requests can cross-talk | One call per caller socket — a second frame on a socket that already carries `att.call_id` is a hard `protocol_error` and close (`do.ts:480-485`) | **Ours.** The bug is unrepresentable rather than managed |
| Final-vs-progress reply | `metadata['notify']` marker gate in `send()`, so progress sends cannot resolve the RPC (`adapter.py:1243`) | No streaming; `runAgent` settles once and the single outcome is sent (`listener.ts:392`) | N/A — we have no non-final sends to confuse |
| Orphan / timeout | 60 s polling thread calling `fail_orphans(300)` over an in-memory dict | DO `alarm()` + `expireTask` inside `ctx.storage.transaction`, so "a concurrent terminal completion can never be overwritten by timeout" (`do.ts:425`) | **Ours.** Transactional, not a poll loop |
| Idempotent terminal transitions | `complete()` returns `None` if already terminal | `terminateAuthorizedCall` returns unchanged when `.terminal` is set; `advanceAuthorizedCall` rank-rejects backward frames (`call-lifecycle.ts:77-87`) | Tie; ours is typed |
| Authorization scoping | Optional scope args on every store helper | `taskBelongsToCaller` shared by GetTask *and* list, documented as "the authorization boundary, not merely a display filter" (`task-store.ts:168-171`) | **Ours** |
| Task listing | None — 500-entry ring buffer, `tasks/list` over whatever survives | HMAC-signed cursors bound to caller + scope + query fingerprint, sorted on immutable `created_at` because "sorting by updated_at can move an unseen task ahead of a page cursor" (`task-store.ts:176-178`) | **Ours**, not close |
| Anti-loop | Per-context turn cap, default 5, hard max 20 | Nested calls hard-disabled — `AGENTCALL_CALL_ID` present in env ⇒ exit 1 (`commands/call.ts:24-28`); #179 tracks governed re-enablement | **Ours.** A cap of 0 beats a cap of 5 |
| Inbound text handling | `wrap_inbound` **defangs then frames** (`adapter.py:732`) | `buildPrompt` frames but never transforms; `message` is interpolated raw (`prompt.ts:15-50`, `listener.ts:334`) | **Theirs.** Filed as #327 |
| Outbound text handling | `redact_outbound` on credential-shaped strings, first statement of `_finalize_task` (`adapter.py:904`) | `out.text` sent unscanned (`listener.ts:392-393`); audit keeps `.slice(0, 500)`, a truncation not a redaction | **Theirs.** Already open as #173; commented with this evidence |

## 9. Recommendation

Do not migrate anything. The relay-side architecture is ours to keep, and §8.4
is the evidence: on seven of nine overlapping mechanisms we are equal or better,
usually because we removed a failure mode rather than managing it.

Two narrow content filters were worth adopting, and both were ~40 lines in
`packages/cli` — not architecture, and neither touching the relay, the protocol
schemas, or A2A. **Both shipped on 2026-08-04, the same day as this document:**

1. **Inbound defanging** inside `buildPrompt` — #327, merged in #329. Our fence
   tokens are literal strings the caller can also write, so the fence could be
   forged by the text it fences. Landed narrower than first proposed: the `---`
   divider and role prefixes are deliberately *not* filtered, because Markdown
   rules and pasted transcripts are legitimate, and a filter that fires on
   ordinary messages is one someone turns off.
2. **Outbound redaction** before `trySendOutcome` — filed as #328 and merged in
   #330, *not* as part of #173. #173 is gated on authorization for third-party
   egress to a scanning service; a local redactor has no egress at all, so it
   sits outside that precondition rather than resolving it. #173 stays gated.
   The two compose: #328 is the fail-closed floor, #173 the ceiling, and a
   fail-open scanner layered over a fail-closed floor degrades to the floor
   instead of to nothing.

Both were `area:security` and neither reopened the deprioritized A2A track
(#9, #11, #101, #179). The findings came from reading their A2A plugin, but the
defects were in our existing one-to-one call path and were live with no A2A
surface enabled.

Two things the implementation turned up that the research did not predict:

- **README's residual-risk paragraph had been deleted.** #173 cites "README
  L542" for the echo-back exposure; `fd1152b` ("streamline repository README",
  #248) cut README from 1,411 to 352 lines and removed it, and nothing replaced
  it. #330 restores a successor bullet. The exposure never changed — only its
  documentation.
- **Word anchoring is load-bearing in the redactor.** Without `\b` on `sk-`,
  every hyphenated word containing it would be redacted, and this repo already
  contains one: `owner-task-with-unbounded-name` in `telemetry.test.ts`.

If the A2A track *is* ever reopened, one thing to carry forward: use
`DESIGN.md`'s requirement-tracing table and out-of-scope list as a free spec.
It is the most honest scoping document I have read for this protocol, and it
names which parts of v1.0 you can skip and still be compatible.

What is explicitly **not** worth taking: the rest of their `security.py` — 
per-peer tokens, trust allow-lists, SSRF guards, bind safety. All of it exists
because in an open A2A deployment the caller could be anyone, and
`authenticateRequest` resolves ours before any of it matters. Defanging and
redaction are the two exceptions precisely because they defend the callee
against a peer it has *already* authenticated.

One thing to note for the positioning docs: the A2A ecosystem is now
demonstrably converging on transport and task semantics while leaving identity
and discovery to implementers. #8
([mcp-tunnels-ema-positioning](./2026-08-02-mcp-tunnels-ema-positioning.md))
concluded we should stop leading with transport. This is independent evidence
for the same conclusion from the other protocol.

## Sources

- `NousResearch/hermes-agent` @ `plugins/platforms/a2a/` — `DESIGN.md`,
  `README.md`, `adapter.py`, `protocol.py`, `security.py`, `tools.py`,
  `plugin.yaml`, `__init__.py`
- PR [#77109](https://github.com/NousResearch/hermes-agent/pull/77109),
  merged 2026-08-02, closing issue #514
- Release `v2026.8.3` — Hermes Agent v0.20.0, "The Herald Release", 2026-08-03
- `hermes_cli/tools_config.py` (`_DEFAULT_OFF_TOOLSETS`)
