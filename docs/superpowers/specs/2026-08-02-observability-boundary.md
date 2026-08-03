# Observability and GenAI telemetry boundary

Date: 2026-08-02  
Decision: accepted; implementation split across #185, #186, and #187  
Issue: #114; constrains #9, #17, #47, #110, #111, #112, and #156

## Current facts

An AgentCall crosses a short-lived caller CLI, an HTTP/WebSocket upgrade, a
Worker, a Durable Object, a long-lived listener WebSocket, and a local agent
process. `call_id` is minted inside the Durable Object and follows the call from
there, but it is not present at caller-span creation time, is omitted from
status frames, and is not attached to structured relay spans because there are
no relay spans yet. Local `calls.log` and `tools.log` can be joined by call id.

AgentCall currently initializes no OpenTelemetry SDK. The listener measures
whole-run duration. Its PreToolUse guard records attempted tool name and a local
policy verdict, but runs in a separate process before execution and observes no
completion, result, duration, or provider-side tool. The Claude/Codex output
adapters discard usage; #111 established that those optional, version-coupled
fields cannot be a hard budget input.

Cloudflare Workers tracing is an open beta. It automatically instruments
handler, fetch, binding, D1, and Durable Object operations and now supports
custom spans. It exports traces and logs over OTLP, but not custom metrics.
Cloudflare also documents three limits that determine this design:

- trace context is not propagated from Workers to external services;
- the custom-span API exposes neither span context nor manual parent wiring;
  and
- names/attributes remain subject to change, while non-I/O spans can report
  zero duration.

Therefore a Worker trace and a listener trace cannot currently be joined into
one native parent/child tree. Claiming otherwise would make a support feature
lie at exactly the moment it is needed.

## Correlation and trace-context decision

Carry two distinct identifiers and never use either as authority:

1. **`correlation_id`** is a caller-generated, non-zero 128-bit lowercase hex
   value on `call_request`, forwarded to `incoming_call` and every post-parse
   terminal or status frame. It exists even when telemetry export is disabled.
   A malicious caller can reuse it, so joins always scope it with the
   authenticated caller and relay-minted call id; it is a search hint, not a
   uniqueness guarantee.
2. **`call_id`** remains relay-minted after admission and is authoritative only
   for one relay call lifecycle. Every post-admission `call_status` gains it so
   the caller can attach it as soon as ringing begins. Relay, listener, local
   audit, reply, failure, and cancellation records retain it once minted.
   HTTP and pre-admission errors have no call id and must not invent one.

When the caller-side OTel SDK is enabled and creates an `invoke_agent` client
span context, `correlation_id` is that context's trace id and the request also
carries a W3C `traceparent`, even when the local sampling decision is
non-recording. With the SDK disabled, the CLI generates only `correlation_id`;
it must not manufacture a `traceparent` that pretends a span exists.

The shared protocol recognizes only W3C version `00` traceparent values with
lowercase hex, non-zero 16-byte trace id, non-zero 8-byte parent id, and defined
flags. When traceparent is present, its trace id must equal `correlation_id`;
otherwise application-log joins and OTel joins would name different calls.
Invalid, oversized, or mismatched optional traceparent is ignored as absent; it
never becomes a log field or parent and never rejects an otherwise valid call.
The valid required `correlation_id` remains the application-level join key.
AgentCall does not forward `tracestate` or W3C baggage in the first
implementation. Those are opaque vendor/application channels that expand the
privacy and size surface without being needed for cross-runtime correlation.

Authenticated callers still supply untrusted remote context. The sampled flag
is an eligibility hint, not a command. The callee uses a custom bounded sampler:
it ignores the default parent decision, makes selection with callee-controlled
randomness (not the caller-controlled trace id), and maintains bounded rolling
sampled/eligible counters so accepted samples cannot exceed the configured
local ratio in the window. A strict local token bucket also caps absolute
recording/export work. The default parent-based and trace-id-ratio samplers are
therefore forbidden for untrusted remote contexts. Relay head sampling and
callee sampling apply independent local ceilings. Rate limits bound call
creation, and no sampler or export path may allocate state by trace or
correlation id.

## Trace shapes

The caller CLI creates a GenAI **CLIENT** span around the complete remote call:

```text
invoke_agent <task>          kind=CLIENT
  gen_ai.operation.name     invoke_agent
  gen_ai.provider.name      agentcall
  gen_ai.agent.name         <task>, when explicit
  server.address            <relay host>
  agentcall.correlation.id  <correlation_id>
  agentcall.call.id         <call_id>, set after first status
  error.type                <bounded AgentCall error code>, on failure
```

The callee listener extracts a valid remote parent and creates a non-GenAI
`agentcall.call.process` **CONSUMER** span around message processing. This span
records bounded admission outcome, call id, and correlation id, so policy
refusals remain observable without pretending an agent ran. After successful
task admission it creates this GenAI **INTERNAL** child around the local runner
invocation:

```text
invoke_agent <task>          kind=INTERNAL
  gen_ai.operation.name     invoke_agent
  gen_ai.agent.name         <task>
  gen_ai.conversation.id    <context_id>, only when one exists
  agentcall.runtime.name    claude | codex
  agentcall.correlation.id  <correlation_id>
  agentcall.call.id         <call_id>
  error.type                timeout | canceled | agent_error, on failure
```

The callee does not invent `gen_ai.conversation.id` for a fresh non-threaded
call. If a fresh threadable call mints a context at completion, the span may add
that real context id before ending. The provider session id never enters
telemetry. `gen_ai.request.model` is omitted unless the adapter reports the
exact configured model; `claude` and `codex` runtime names are not model names,
and Claude may use a non-Anthropic hosting backend. CLI exit is not a model
finish reason, so `gen_ai.response.finish_reasons` is also omitted.

Relay and Durable Object custom spans use transport names such as
`agentcall.call.admit`, `agentcall.call.dispatch`, and
`agentcall.call.complete`, not GenAI operation names. They attach bounded
outcome, call id, and correlation id but no handle, agent id, task, prompt,
reply, token, policy detail, or credential. Cloudflare's independent trace tree
is searchable by the same application attributes; it is not described as a
parent of the listener span until Cloudflare supports external propagation and
manual context APIs.

## Metrics that are honest now

The local listener can initially emit exactly these custom metrics:

- `agentcall.invoke_agent.duration`: Histogram, unit `s`, explicit boundaries
  `[0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600]`;
  and
- `agentcall.invoke_agent.calls`: monotonic Counter, unit `{call}`, incremented
  once when an admitted local invocation reaches a terminal outcome.

The only allowed dimensions are `agentcall.runtime.name` (`claude` or `codex`),
`agentcall.call.outcome` (`success`, `timeout`, `canceled`, or `agent_error`),
and `error.type` from that same bounded failure set. Duration uses runtime and
terminal outcome, adding `error.type` only on failure; the counter uses the same
shape. These instruments intentionally do not claim the GenAI metric contract
while task cardinality is unbounded.

Metric dimensions are limited to runtime and low-cardinality outcome/error.
Task id remains a span attribute/name but is excluded from metrics because the
number of local task files is not globally bounded. Call id, correlation id,
context id, handles, stable agent ids, paths, rule names, and free-form error
text never become metric labels.

Do not emit the following until the stated observation exists:

- `gen_ai.invoke_agent.duration`: the current convention requires
  `gen_ai.agent.name` when available, but the resolved local task name has no
  global cardinality bound. Adopt the standard metric only with an explicit
  bounded agent-name policy;
- `gen_ai.invoke_agent.inference_calls`: neither runner observes the individual
  provider requests made inside Claude/Codex;
- `gen_ai.invoke_agent.tool_calls`: `call_id` links hook records to the outer
  invocation, but fail-open timeout/log paths provide no capture-completeness
  marker and there is no stable per-tool lifecycle id. Omit the measurement
  rather than report zero when capture is degraded;
- `gen_ai.execute_tool.duration` or `execute_tool` spans: PreToolUse has no end
  event or duration, and Codex observe mode does not establish downstream
  sandbox outcome;
- `gen_ai.client.token.usage`: allowed only from a versioned usage adapter that
  passes installed-version fixtures/probes and reports missing data as
  unavailable, per #111; and
- `chat` spans: AgentCall does not own or observe individual model API calls.

Complete tool spans require paired post-tool success/failure hooks with a stable
tool-call id and an IPC path back to the listener (or another bounded local
collector). Initial PreToolUse records remain best-effort local observations;
they must not become a standard complete count or be stretched into fabricated
completion spans.

## Local SDK and exporter boundary

Telemetry is explicitly opt-in through `AGENTCALL_OTEL=1`; installing the SDK
must not make the OpenTelemetry JS default localhost exporter run on every CLI
command. Once enabled, standard `OTEL_SERVICE_NAME`, exporter, endpoint, header,
timeout, and sampling variables configure a minimal manual SDK. Do not install
Node auto-instrumentations: they would broaden collection to HTTP, filesystem,
process, and headers beyond this decision.

Register only W3C Trace Context propagation, not the JavaScript SDK's default
W3C baggage propagator. The short-lived caller force-flushes/shuts down after a
bounded interval; the listener flushes on graceful shutdown and uses bounded
batch queues. Export timeout, queue overflow, collector outage, or malformed
configuration never changes call admission, runner outcome, reply delivery, or
the local security audit. Failures are rate-limited into the owner-facing
listener log and exposed by local health/status rather than recursively exported
through the failing sink.

Exporter endpoints and headers are credentials and data-routing policy. The
listener may read them, but the answering Claude/Codex process and its hook
subprocess must not inherit any `OTEL_*` or AgentCall exporter configuration.
Besides exposing collector credentials, inheritance could make a third-party
CLI begin exporting a broader data set under AgentCall's destination. The
runner passes only a bounded internal trace context to the guard for local
correlation. Enterprise deployment later sources exporter policy from the
machine-owned managed layer; a user cannot redirect mandatory organization
telemetry to another collector.

## Content and subject boundary

The initial implementation never emits:

- caller message, callee reply, system prompt, tool arguments/results, task
  description, local path, policy rule/detail, stdout, or stderr;
- authorization headers, line tokens, OTLP headers, provider credentials, or
  real agent session ids; or
- caller/callee handle or stable agent id in exported spans/metrics.

OpenTelemetry marks instructions, input/output messages, tool definitions,
arguments, and results as opt-in sensitive content. AgentCall does not expose
that switch in this issue. A future content-export feature needs its own policy,
consent, redaction, access control, retention/erasure, residency, and employee
transparency decision; “OTel supports it” is not authorization to ship it.

`call_id`, `correlation_id`, and short-lived `context_id` are still linkable
metadata. Enabling local export or Cloudflare persistence is a new data flow and
must be reflected in employee transparency, data residency, and retention docs.
No sampled trace or metric is an audit ledger or completeness proof.

## Cloudflare rollout boundary

Cloudflare transport tracing is a separate implementation slice:

- enable traces explicitly at a 5% head sample initially; the default is 100%,
  which is not an acceptable accidental production default;
- decide and document `persist` plus the named OTLP destination before deploy.
  `persist: false` avoids a duplicate Cloudflare dashboard copy only when a
  working external destination exists;
- treat built-in URL, request, D1 query, region, version, and timing attributes
  as retained metadata in the residency/retention review;
- use custom spans only for bounded transport phases, with attributes available
  at span creation when sampling depends on them; and
- record configuration/version and a live synthetic trace in deployment
  evidence. A green deploy alone does not prove destination delivery.

Cloudflare custom metrics cannot currently use its OTel export. Existing
Analytics Engine points remain statistical product telemetry under #156; they
must not be relabeled as complete latency, security, or billing records.

The protocol and local SDK slice is #185. Cloudflare transport tracing is #186
and stays blocked until its destination/persistence choice is explicit. Honest
paired tool lifecycle spans are #187 after #185 supplies the local collector
substrate.

## Acceptance boundary

The protocol/local implementation must prove:

- matching valid traceparent and correlation id survive caller → relay → DO →
  listener, while invalid, mismatched, all-zero, or oversized optional
  traceparent is ignored and cannot reject or delay delivery;
- sampled=1 floods and adversarial caller-chosen trace ids cannot raise local
  listener recording above its configured rolling ratio and token-bucket
  ceilings;
- call id appears on the first post-admission status and every later lifecycle
  frame, while pre-admission errors omit it;
- old/new relay and listener overlap preserves call delivery while optional
  fields are absent;
- caller, listener consumer, and listener agent spans use the exact
  CLIENT/CONSUMER/INTERNAL shapes above, with bounded errors and no invented
  model/provider/finish data;
- fresh calls omit conversation id and resumed/minted contexts use only the
  public context id;
- messages, replies, handles, paths, policy details, sessions, and secrets are
  absent from captured export fixtures;
- metric labels pass a cardinality allowlist and unsupported metrics are absent;
- exporter failure/timeout/queue saturation cannot fail or delay a call beyond
  the documented bounded shutdown flush; and
- spawned agents/hooks cannot read exporter credentials but can correlate their
  local audit records.

The Cloudflare slice separately proves configured sampling/persistence, expected
transport span names, absence of subject/content attributes, correlation search,
and a live canary reaching the selected destination. It explicitly demonstrates
that Worker and local traces are correlated trees, not a fabricated single
parent chain.

## References

- [OpenTelemetry GenAI agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)
- [OpenTelemetry GenAI model/tool spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md)
- [OpenTelemetry GenAI metrics](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-metrics.md)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)
- [Cloudflare Workers traces](https://developers.cloudflare.com/workers/observability/traces/)
- [Cloudflare custom spans and limitations](https://developers.cloudflare.com/workers/observability/traces/custom-spans/)
- [Cloudflare tracing known limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/)
- [Cloudflare OTel export](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
