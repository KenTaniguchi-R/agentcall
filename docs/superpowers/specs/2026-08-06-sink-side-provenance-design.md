> **Historical design record, dated 2026-08-06 and never revised.** It records why a
> decision was made, not what the code does now. Do not derive current behavior from
> it, and do not "fix" it to match the code. See [README.md](../../../README.md) for
> current behavior.

# Sink-side provenance enforcement

**Status:** Design. Not approved, not started.
**Amends:** [the sensitivity/clearance model](./2026-08-06-sensitivity-clearance-model-design.md).
**Evidence:** [sink-side provenance enforcement](../../research/2026-08-06-sink-side-provenance-enforcement.md),
[label-creep spike](../../research/2026-08-06-label-creep-spike.md),
[derived access inheritance](../../research/2026-08-06-derived-access-inheritance.md),
[skill and MCP guard reachability](../../research/2026-08-06-skill-and-mcp-guard-reachability.md).

## The problem, stated once

Four open issues look independent and are not:

| issue | blocked on |
|---|---|
| #392 | the guard cannot see MCP I/O, and a `SKILL.md` body loads with no tool call at all |
| #393 | directories cannot be labelled without asking someone |
| #394 | an opaque source cannot carry one sound label |
| #391 | Codex cannot enforce a read decision |

All four are consequences of enforcing **at the read**. Read-side confinement must be
re-solved for every source type, every tool surface, and every runtime, and it fails at
exactly the places that make the product useful.

There is **one exit**: the reply string at `listener.ts:419`, where `redactOutbound`
already runs. It is our code, it always executes, and it is runtime-independent.

## What this is — and what it is not

**It is not an inversion.** An earlier framing proposed replacing the read check with a
reply check. The evidence rejects that. In LIO the read-side *clearance* is precisely
what permits relaxing the output channel; the literature's default pairing is both
checks. The [constrained-output spec](./2026-08-06-constrained-output-declassification-design.md)
independently argues the read-side check is the better experience — a caller should not
burn a call to be told no.

**This spec adds a backstop and keeps the read guard.**

**It is not content classification.** Classifying a reply for sensitivity is the thing
this project has already rejected on measurement (Presidio at **0.07 recall** on
HIGH-sensitivity categories, [arXiv 2606.19881](https://arxiv.org/abs/2606.19881)). This
check asks *where the answer came from*, which is recorded fact.

**It is not novel, and the name is old.** It is the **floating label** / **high-water
mark** construction: a computation's label rises to the join of everything it observes,
and at output the label must be dominated by the sink's. LIO gives the modern
formalization.

**It is the same rule FIDES ships, at a different sink.** FIDES's
`max_allowed_confidentiality` on `post_comment` and this check on the reply are the same
mechanism applied to the one sink this architecture has. That is the honest framing —
not "we invert FIDES".

## The design

Per call:

1. The listener resolves the caller's permitted source set — as today,
   `clearanceFor(policy, from, groups)` then `readableSources(map, clearance)`.
2. `buildPrompt` names that set in the prompt, as today.
3. The agent runs. The read guard denies above-clearance reads, as today.
4. **New:** every tool call's resolved source is appended to a per-call provenance
   record, with a sequence number.
5. **New:** at `listener.ts:419`, before `redactOutbound`, the running label — the join
   of every recorded source — is checked against the caller's clearance. If it does not
   dominate, or **if the record cannot be shown to be complete**, the reply is refused.

The guard stays a pure function of `(path, clearance)` and gains no network and no
caller identity. All new judgment lives at the listener, which already holds the
caller's verified identity and runs once per call.

## Why nobody ships this, and why that is fine

Seventeen systems were surveyed. Every AI-DLP product, AI gateway, and agent-framework
output guard decides on the **text** of the output. The two provenance-driven cases
(Purview DLP for Copilot; Copilot label inheritance) enforce *before* grounding or merely
*label* the output. **No shipping system refuses an output based on which sources were
read.**

The structural reason is not that the idea is bad: in every one of those systems the
answer goes to the principal who already owns the data. AgentCall is the one shape where
the recipient is not the data owner — the same property that
[the derived-access research](../../research/2026-08-06-derived-access-inheritance.md)
found makes every fail-open default in the industry inapplicable here.

Record this as a stated negative with its reason, so it reads as an architecture
difference rather than an unexamined novelty.

## The four constraints

None is optional.

### 1. Add the sink check; do not remove the read check

See above. The reframe from "inversion" to "backstop" is the whole difference between a
design the literature supports and one it does not.

### 2. Build the record before building the check

**The record does not exist today.** `tools.log` carries every call but only the tool
name and verdict (`guard.ts:340-342`). The resolved path reaches `calls.log` **only when
`noteworthy` is set** — a denial or a flag (`guard.ts:344-355`). An allowed read of a
permitted file leaves no provenance entry at all.

So step 4 above is new work, and it carries its own decision: the record becomes a full
inventory of everything the owner's agent read. That file is more sensitive than
anything currently written, and this codebase already notes that logs get pasted into
bug reports.

Requirements: sequence numbers, an explicit gap marker, and a decision about the
record's own sensitivity.

### 3. Refuse on an unverified record, and make observe mode able to say so

`onFailure = ALLOW` in observe mode with no write (`guard.ts:283`) is the exact silent
fail-open: a failed decide produces an unrecorded tool call, and the sink then concludes
nothing sensitive was touched.

Cryptography does not close this — tamper-evidence and completeness are different
properties. Schneier & Kelsey can guarantee only *detection* of deletion, and only via an
external party; Crosby & Wallach scope their guarantee to events "once correctly
inserted"; SLSA attempted to require dependency completeness at L4 and retreated to
"best effort" in v1.0.

The honest framing is SLSA's: **completeness is claimable over an enumerable set, not an
open-ended one.** The buildable precedent is the Linux audit subsystem, which keeps a
loss counter *outside* the record and will panic the kernel rather than run with a gap.
`in-toto` fails when expected link metadata is missing. Both are the shape to copy.

Observe mode must write a gap marker, or the completeness claim is unfalsifiable.

### 4. Bash under Codex is outside the guarantee

Under Codex the guard inspects a **command string**. It structurally cannot record which
files a command read. No logging change closes this.

Two acceptable resolutions, and the choice is a product decision:

- a run that used Bash cannot release a reply above the caller's clearance, or
- the guarantee is documented as not holding for Bash.

Silence is not an option — that is the defect #390 fixed in the docs, and it must not
reappear here.

## The over-refusal cost

The failure mode has the field's name — **label creep** — and is documented as
characteristic of exactly this construction. FIDES measures **up to 24.5 percentage
points** of task success lost when policy enforcement is switched on. That is the right
anchor.

**A correction to an earlier note:** CaMeL's 77% vs 84% is *not* this number and should
stop being cited as if it were. That paper states policies do not affect utility in its
measurement and its failure taxonomy contains no policy-denial entries; the 7 points are
the price of the dual-LLM architecture, which this design does not adopt.

The literature's standard mitigation is a human approval, which this product
deliberately does not have — [#394](https://github.com/KenTaniguchi-R/agentcall/issues/394)
records why. The mitigation that does apply is already shipped: `buildPrompt` names the
readable sources, so the sink check is a backstop rather than the primary mechanism.

[The pilot](../../research/2026-08-06-label-creep-spike.md) observed **0 out-of-scope
reads in 6 calls**, with the one deliberately nosy question producing zero tool calls at
all. That is n=6 — it bounds the true rate at roughly 40% and no better — and **the
adversarial case, where content read from a permitted source instructs the agent to read
elsewhere, was not tested.** ReadSecBench measures up to 85% exfiltration through
exactly that channel. Until that is run, treat the backstop as load-bearing.

## Soundness caveat, stated

Per-value taint is not available to us: CaMeL achieves it only by owning a Python
interpreter, and we can observe tool calls but not the model's reasoning. Coarse
granularity is defensible — FIDES as shipped is coarse too — and Vassena et al. show
coarse and fine are equally expressive **given a scope-limiting primitive**. We have no
`toLabeled` equivalent. Constrained-output tasks (#387) are the closest thing this design
has to one, which raises their status from nice-to-have to structural.

Aggregation and inference remain out of scope, as they have been since Goguen & Meseguer
excluded them in 1982. That residual is what #173 tracks; this design does not shrink it.

## What this would resolve

- **#391** — enforcement stops depending on the runtime's ability to block, except over Bash.
- **#392** — an opaque source needs a *record that it was touched*, not a sound label.
- **#393 / #394** — the labelling burden shrinks to naming the grant, not bounding every read.

None of them closes automatically. Each needs its own decision, informed by this.
