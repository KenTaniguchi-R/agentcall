# Information-flow control for agent answers

**Date:** 2026-08-06
**Status:** Research note, not a decision. The decision it fed is
[the sensitivity/clearance design](../superpowers/specs/2026-08-06-sensitivity-clearance-model-design.md).

## Why this was opened

A caller who has run nothing but `agentcall setup` gets an answering agent with
`caps: ["read"]` pointed at `~/AgentCall/<line>/public`, which `setup` never
creates or fills. The agent can read four tools' worth of an empty directory.
It cannot invoke a skill, cannot reach an MCP server, and cannot read outside
that root — `--allowedTools Read,Grep,Glob,LS` omits `Skill` and `mcp__*`, and
`AGENTCALL_ALLOWED_ROOT` is enforced as a hard root by the guard hook.

The product is therefore secure and useless at the same time. The question this
note investigates: **where is the setting that is both secure enough and useful
enough**, given that every owner's environment is different and unknowable to us.

## What does not work

### Detection

Classifier-based prompt-injection defenses (Lakera Guard, Meta Prompt Guard /
LlamaFirewall, NVIDIA NeMo Guardrails, AWS Bedrock Guardrails, Azure Prompt
Shields, Rebuff) degrade sharply under adaptive attack. One published review
measures Lakera Guard at 60–70% effectiveness on optimized bypasses, indirect
framing, and encoding obfuscation. The precision/recall trade is structural, not
a tuning defect: tightening the threshold raises false positives on legitimate
queries about the attack class, loosening it raises bypass rate.

A control an attacker may retry against, with no signal on the misses, is not a
control. Detection is usable as a *risk signal*; it cannot be the boundary.

### Per-tool allowlisting

Naming safe MCP servers does not converge. `mcp: [openmemory]` is exactly as
dangerous as whatever is in that owner's openmemory. The list is per-owner,
changes without notice, and pushes a permanent security-review burden onto
people who will not do it.

It also mis-locates the risk. In "how is this Jira ticket going", the injection
does not arrive in the caller's message — it arrives in the *ticket body*, which
any employee or customer can write. Scanning the caller's message finds nothing.

## What does work: information-flow control

FIDES — [Costa, Köpf, Kolluri, Paverd, Russinovich, Salem et al., *Securing AI
Agents with Information-Flow Control*](https://arxiv.org/pdf/2505.23643)
(Microsoft Research, 2025-05) — shipping as
[`agent_framework.security`](https://learn.microsoft.com/en-us/agent-framework/agents/security)
in Microsoft Agent Framework (experimental, Python-only as of 2026-06-23).

The framing:

> FIDES sidesteps the model entirely. Trust and confidentiality become *labels on
> content*, propagated by middleware, checked deterministically before each tool
> call. The model is still in charge of *deciding what to do*, but the framework
> is in charge of *deciding what is allowed to happen*. That split is what lets
> the security guarantee be deterministic instead of probabilistic.

Two axes on every piece of content:

| Axis | Values |
|---|---|
| integrity | `trusted`, `untrusted` |
| confidentiality | `public` < `private` < `user_identity` |

Labels combine most-restrictive-wins and propagate automatically through tool
calls. Sinks declare what context they will run in — `accepts_untrusted: False`
and `max_allowed_confidentiality`. A violation blocks, or with
`approval_on_violation` becomes a human approval request.

**Nothing stops unless an illegal flow is actually attempted.** That is the
property that answers the cost objection to blanket human review: the human sees
only the calls that would have leaked.

### Capacity-based declassification

The paper's contribution that matters most here. The label lattice is extended
with a type lattice ordered by information capacity:

> `bool ⊑ enum["a", "b", "c"] ⊑ string` … Low capacity outputs are less useful to
> deliver prompt injection payloads or exfiltrate information. This allows us to
> create policies that take into account information capacity, effectively
> offering declassification or endorsement as escape hatches.

A quarantined LLM with constrained decoding extracts a typed value from
high-sensitivity content, and *that value may cross a sink the raw string could
not* — an enum cannot carry a payload. This is a principled, auditable
declassification rule rather than a heuristic, and it is what makes a
"status of ticket X" answer safe without review.

### Known limits, from the shipping docs

1. Labels are opt-in per source. An unlabeled source falls back to the
   configured default (secure-by-default `UNTRUSTED` + `PUBLIC`).
2. **Most-restrictive-wins propagation is conservative.** "Once an untrusted
   issue body enters the context, the rest of the run is untrusted unless you
   explicitly drop it." Over-tainting is the historical failure mode of IFC and
   is the main risk to validate before committing.
3. Approvals are coarse — the violating call is named, the label algebra is not
   explained to the user.
4. The quarantined LLM is single-turn and tool-free by design.

## Adjacent prior art

- **CaMeL** — [Debenedetti et al., *Defeating Prompt Injections by Design*](https://arxiv.org/abs/2503.18813)
  (Google DeepMind). Privileged LLM plans from the trusted query only; a
  quarantined LLM processes untrusted data with no tool access; capabilities
  enforce data flow. Solves 77% of AgentDojo tasks with provable security vs 84%
  undefended — the cost of doing this properly is ~7 points of utility.
  **`packages/cli/src/policy.ts:217` already cites this invariant by name.**
- **Design patterns for securing LLM agents** —
  [Beurer-Kellner et al.](https://arxiv.org/html/2506.08837v2). Action-Selector,
  Plan-Then-Execute, Dual LLM, Context-Minimization. Argues detection is
  insufficient and control flow must be fixed before untrusted data is read.
- **MCP `_meta.ifc`** — the
  [FIDES developer guide](https://github.com/microsoft/agent-framework/blob/main/python/samples/02-agents/security/FIDES_DEVELOPER_GUIDE.md)
  lists "MCP Auto-Labeling and Result IFC Parsing — auto-label MCP tools from
  hints and parse server `_meta.ifc` labels". An MCP-level IFC label convention
  is forming. Worth tracking: if it lands, per-server labeling stops being the
  owner's job.
- **MCP Security Gateway** —
  [Microsoft agent-governance-toolkit](https://microsoft.github.io/agent-governance-toolkit/specs/MCP-SECURITY-GATEWAY-1.0/).
  Call interception, response scanning, approval workflows. Useful as a
  component inventory; the mechanism is allowlist-plus-classifier wearing a
  gateway, so it inherits the detection limits above.
- **MCP tool annotations** — the
  [MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
  states clients **MUST** treat annotations as untrusted unless from trusted
  servers. `readOnlyHint` can seed a default; it cannot be the boundary.

## What IFC does *not* solve

**It bounds the audience, not the content.** A secret pasted into a source
labeled `internal` flows to any caller cleared for `internal`. That is
[#173](https://github.com/KenTaniguchi-R/agentcall/issues/173)'s gap — content
scanning of the reply — and it remains open and complementary. #173's own
framing is the right one and survives this change intact:

> That is a **path** boundary. It cannot see a secret that arrives through an
> allowed path — a key pasted into a tracked config file, a token in a test
> fixture, a credential printed by an allowed command.

Substituting labels for paths widens the boundary from "which directory" to
"which audience". It does not make the boundary content-aware.

## Sources

- <https://arxiv.org/pdf/2505.23643> — FIDES paper
- <https://learn.microsoft.com/en-us/agent-framework/agents/security> — shipping docs
- <https://github.com/microsoft/agent-framework/blob/main/python/samples/02-agents/security/FIDES_DEVELOPER_GUIDE.md>
- <https://arxiv.org/abs/2503.18813> — CaMeL
- <https://arxiv.org/html/2506.08837v2> — design patterns
- <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- <https://microsoft.github.io/agent-governance-toolkit/specs/MCP-SECURITY-GATEWAY-1.0/>
- <https://aisecreviews.com/posts/lakera-guard-review/> — detection efficacy
- <https://learn.microsoft.com/en-us/visualstudio/liveshare/reference/security> — the
  files-permissive / ports-restrictive split, and `.vsls.json` subtraction
