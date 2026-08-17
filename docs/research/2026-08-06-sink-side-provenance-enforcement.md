# Sink-side provenance enforcement: is taint at the reply sound?

**Date:** 2026-08-06
**Tests:** the proposal to stop bounding what the answering agent *reads* and
instead bound what the reply *discloses* — record the provenance of every source
touched, then refuse to send the reply if any touched source is outside what this
caller is permitted.
**Prior design:** [Sensitivity and clearance](../superpowers/specs/2026-08-06-sensitivity-clearance-model-design.md),
[Constrained-output declassification](../superpowers/specs/2026-08-06-constrained-output-declassification-design.md)
**Prior research:** [IFC for agent answers](./2026-08-06-information-flow-control-for-agent-answers.md),
[Derived access inheritance](./2026-08-06-derived-access-inheritance.md),
[Re-verification of the IFC claims](./2026-08-06-ifc-claims-reverification.md)

Every quotation below was read at the cited source. Where a quote reached me
through a summarizer rather than raw text, it is not in quote marks — see
[How this was verified](#how-this-was-verified) and
[What I could not verify](#what-i-could-not-verify).

---

## Findings first

1. **The construction is not new, is not novel, and has a name from 1969.** It is
   the **floating label** / **high-water mark**: a computation's label rises to
   the join of everything it observes, and at the output the label must be
   dominated by the sink's. LIO states the write check in one sentence that could
   be the design's own spec. This is the single most useful finding, because it
   means the design does not have to be argued from first principles — and
   because the same literature supplies the failure mode, the mitigation, and the
   soundness caveat. See §1.

2. **No shipping system enforces an output decision on which sources were read.
   That is a real negative result, and it has a structural explanation that is
   better news than it looks.** Seventeen products checked; every AI DLP product,
   AI gateway, and agent-framework output guard decides on the *text* of the
   output. The two provenance-driven cases (Purview DLP for Copilot; Copilot
   label inheritance) enforce *before* grounding or merely *label* the output —
   neither refuses at the sink. The structural reason nobody has our check: in
   every one of those systems the answer goes to the principal who already owns
   the data. AgentCall is the one shape where the recipient is not the data
   owner. See §2.

3. **FIDES and CaMeL both check before the tool call, and neither checks the
   final answer.** In the FIDES paper the policy check sits at `MakeCall` in
   Algorithm 5; the `Finish` action passes the labelled response through
   unchecked. The shipping middleware is `PolicyEnforcementFunctionMiddleware`,
   which "Checks each tool invocation". CaMeL: "The policies are checked against
   before each tool call." **Neither system ever lets a tainted read happen and
   then blocks only the answer.** See §3.

4. **The over-refusal cost has the field's own name — *label creep* — and it is
   documented as the characteristic failure of exactly this construction.** The
   measured numbers exist but do not mean what the existing repo note says they
   mean. CaMeL's 77% vs 84% is **not** the price of the taint check: the paper
   states policies do not affect utility in its measurement, and the failure
   taxonomy contains no policy-denial entries. The 7 points are the price of the
   dual-LLM *architecture*, which this design does not adopt. FIDES's 24.5%
   figure *is* a policy-enforcement cost and is the better anchor. See §4.

5. **The audit record the proposal assumes already exists does not exist.** The
   brief states "the guard already resolves and logs the path per tool call to a
   local private audit log." It resolves the path; it logs it **only on denial or
   flag**. `tools.log` records the tool name and the verdict, no path
   (`guard.ts:341-343`); the resolved path reaches `calls.log` only when
   `noteworthy` is set (`guard.ts:345-355`). An allowed read of a permitted file
   leaves no provenance entry at all. See §5.

6. **The incomplete-record fail-open is real, is unclosed by cryptography, and
   the field's honest position is that completeness is only achievable over an
   enumerable set.** Tamper-evidence and completeness are different properties.
   Schneier & Kelsey say cryptography can only guarantee *detection* of deletion
   and only via an external party; Crosby & Wallach scope their guarantee to
   events "once correctly inserted"; SLSA tried to require dependency
   completeness at L4 and retreated to "best effort" in v1.0. The buildable form
   exists — in-toto fails when expected link metadata is missing, and the Linux
   audit subsystem keeps a loss counter *outside* the record and will panic the
   kernel rather than run with a gap. See §6.

7. **The Codex claim is sound in principle and defeated in practice by two
   specific things**, one fixable and one not. Fixable: observe mode's failure
   path is *allow and write nothing* (`guard.ts:283`, `guard-entry.ts:137`), so a
   failed decide or a failed log write produces an unrecorded tool call —
   precisely the silent gap. Not fixable: under Codex the guard inspects a Bash
   command string, which structurally cannot record which files a command read.
   Over Bash the record can never be complete. See §7.

---

## 1. The construction is named, and the name is old

### 1.1 Floating labels: LIO states the design

Stefan, Russo, Mitchell, Mazières, *Flexible Dynamic Information Flow Control in
Haskell*, Haskell Symposium 2011
([PDF](https://www.scs.stanford.edu/~deian/pubs/stefan:2011:flexible.pdf)),
abstract:

> A labeled IO monad, LIO, keeps track of a current label and permits restricted
> access to IO functionality, while ensuring that the current label exceeds the
> labels of all data observed and restricts what can be modified. Unlike other
> language-based work, LIO also bounds the current label with a current clearance
> that provides a form of discretionary access control.

The read rule:

> In a floating-label system, the label of a computation can rise to accommodate
> reading sensitive data (similar to the program counter (pc) of more traditional
> language-based systems [34]). Specifically, in a floating-label system, a
> computation C with label LC wishing to observe an object labeled LR must raise
> its label to the join, LC ⊔ LR, of the two labels.

And the write rule — this is the proposal, verbatim, from 2011:

> Since the computation label directly corresponds to the labels of the data it
> has observed, printLabeledCh simply checks that the computation label flows to
> the output channel. In the example above, the trusted function checks that
> LC ⊔ LR ⊑ LO before printing to (standard) output channel O.

The label is monotone — LIO's Proposition 4 is *Monotonicity of the current
label* — which is what makes reads free and the single output check sufficient.

The idea is older still. Weissman's ADEPT-50 paper (AFIPS FJCC 1969,
[PDF](https://www.ukcert.org.uk/SecurityControlsInTheADEPT-50Time-SharingSystem_p119-weissman.pdf)):

> We speak of them, affectionately, as the security "high-water mark," with
> analogy to the bath tub ring that marks the highest water level attained.

*(The scan's OCR is damaged elsewhere on the page; this sentence is clean, but
the source is a scan. Note also that Asbestos, HiStar and LIO all attribute
high-water-mark to Landwehr's 1981 ACM survey rather than to Weissman directly.)*

### 1.2 Where our design sits in the declassification taxonomy

Sabelfeld & Sands, *Declassification: Dimensions and Principles*, CSFW'05 / JCS
17(5) 2009 ([PDF](https://www.cse.chalmers.se/~andrei/sabelfeld-sands-jcs07.pdf)),
on the **where** dimension:

> Where in a system information is released is an important aspect of information
> release. By delegating particular parts of the system to release information,
> one can ensure that no other (potentially untrusted) part can release further
> information.
> Considering where information is released, we identify two principal forms of
> locality:
> **Level locality** policies describing where information may flow relative to
> the security levels of the system, and
> **Code locality** policies describing where physically in the code information
> may leak.

The design is the conjunction of both: **code locality** (the reply in
`listener.ts` is the sole exit) plus **level locality** (that exit enforces
`context ⊑ clearance`). The first sentence quoted above is the literature's own
statement of why a single-sink architecture is worth having, and it is a better
argument for the reframe than anything in the current spec.

### 1.3 The names to avoid

Checked across LIO, COWL, Flume, HiStar, Asbestos, Sabelfeld–Sands, Vassena et
al., Zdancewic–Myers: **"egress control" and "output-side declassification"
appear in none of them.** Using either would be coining. The citable phrasings
are *"declassification points"* / *"downgrading points in the code"*
(Sabelfeld–Sands, quoting Mantel–Sands) and, for the property,
*termination-insensitive noninterference*, which is standard. "End-to-end IFC" is
real but means transitive whole-system enforcement, not "checked at the output" —
do not reuse it.

---

## 2. Does anyone ship the output decision on provenance? No.

Seventeen shipping systems were checked against vendor documentation and source.

| System | Output-side check? | Content or provenance? |
|---|---|---|
| Microsoft Purview DLP for M365 Copilot | yes, enforced pre-grounding | **provenance** (label / sender domain) |
| M365 Copilot label inheritance | yes (labels the artifact) | **provenance**, but marks rather than refuses |
| Invariant Guardrails (Snyk) / `mcp-scan` | yes | **flow**, but the sink is a tool call |
| NeMo Guardrails output rails | yes | content (`bot_message`, LLM judge) |
| Llama Guard | yes | content |
| Guardrails AI | yes | content (`validate(value, metadata)`) |
| OpenAI Agents SDK output guardrails | yes | content (`(ctx, agent, output)`) |
| Cloudflare AI Gateway Guardrails | yes | content |
| LiteLLM guardrails (`post_call`) | yes | content |
| Kong `ai-prompt-guard` | **no** (request only) | n/a |
| Kong AI PII Sanitizer | yes | content |
| Portkey `output_guardrails` | yes | content |
| Zscaler AI Guard | yes | content |
| Netskope AI Guardrails | yes | content |
| Prisma AIRS | yes | content |
| Nightfall AI | yes | content |
| Prompt Security / Lasso / WitnessAI | unverified | docs unreachable |

Purview is the closest thing to a positive and it is worth understanding
precisely, because it is provenance-driven in a way that *supports* the read-side
design rather than the sink-side one. From
[Learn about the Microsoft 365 Copilot policy location](https://learn.microsoft.com/en-us/purview/dlp-microsoft365-copilot-location-learn-about)
(`ms.date` 2026-06-10, `updated_at` 2026-07-17):

> Identified items still appear in the citations of the response, but the content
> of the item isn't used in the response or accessed by Copilot.

and, on the external-email rule, an explicit metadata-only decision:

> The policy evaluates email metadata only - specifically, the sender domain
> compared against your tenant's accepted domains. The body of the email isn't
> inspected.

That is a **read-side** provenance check: the item is excluded from grounding.
The only *sink-side* provenance behaviour Microsoft ships is labelling, not
refusal — from [Microsoft Purview data security and compliance protections for Copilot](https://learn.microsoft.com/en-us/purview/ai-m365-copilot)
(`ms.date` 2026-05-01):

> If multiple files are used to create new content, the sensitivity label with
> the [highest priority] is used for label inheritance.

The join of the sources' labels, computed at the output — the correct algebra,
attached to the artifact rather than used to withhold it.

**Invariant Guardrails** is the only policy language found with a real dataflow
operator, from the
[guardrails reference](https://invariantlabs-ai.github.io/docs/mcp-scan/guardrails-reference/):

```
raise "Must not send an email when agent has looked at suspicious email" if:
    (inbox: ToolOutput) -> (call: ToolCall)
    inbox is tool:get_inbox
    call is tool:send_email
    prompt_injection(inbox.content)
```

`inbox is tool:get_inbox` is a pure source-identity predicate — genuine
provenance. But the documented sink is a **tool call**, every documented dataflow
example conjoins the flow pattern with a content detector, and there is no
per-caller permission model: the policy is static, not "what is *this* caller
cleared for."

### 2.1 Why nobody has our check

The negative result is real but it should not be read as "this is a bad idea."
Every system above has the same shape: the answer goes back to the principal
whose data was read. Purview's own statement of it —

> All Microsoft 365 Copilot prompts run in the security context of the user who
> initiates the prompt.

— is why the industry solves the caller-permission problem *at retrieval*, and
why an answer-side confidentiality check would be redundant for them. AgentCall
inverts that: the agent runs with the **owner's** context and answers the
**caller**. The [derived-access note's §1.6](./2026-08-06-derived-access-inheritance.md)
already found the one vendor with our shape saying so out loud — Notion Custom
Agents, "the agent may expose information the end user can't access directly."

So the honest framing for the spec is: *the enforcement point is unusual because
the architecture is unusual, not because the enforcement point is wrong.* Do not
claim precedent for sink-side enforcement over an agent's answer. There is none.

---

## 3. FIDES and CaMeL check before the call, not at the answer

### 3.1 FIDES, in the paper

[Costa et al., *Securing AI Agents with Information-Flow Control*](https://arxiv.org/pdf/2505.23643)
(arXiv 2505.23643). Algorithm 5, *Planning loop with taint-tracking*, is the
enforcement algorithm. Its `MakeCall` branch opens with

```
 7:       if ¬policy(action) then abort else
```

and its terminating branch is

```
12:    | Finish 𝑟 ℓ → 𝑟 ℓ
```

**The response to the user carries a label and is not checked against anything.**
§4.3 confirms the scope:

> We express security policies on tool calls in terms of the labels of the tool
> and the call arguments.

The nearest thing to a sink check is P-F, and its sink is still a tool:

> 2. Permitted flow (P-F): This policy permits a tool call that egresses data to
> proceed only if all recipients are permitted to read the data.

> In the evaluation in Section 8, we apply P-T to each consequential tool, and
> P-T or P-F to each egress tool.

The paper does anticipate the extension, in one sentence, as future work rather
than as anything evaluated:

> note that while in this paper we focus on policies expressed in terms of the
> most recent action selected by the planner, it is straightforward to extend the
> planning loop to keep track of the labeled conversation history and sequence of
> actions executed, and to check arbitrary predicates over them.

### 3.2 FIDES, as shipped

[Agent Security with FIDES](https://learn.microsoft.com/en-us/agent-framework/agents/security),
Microsoft Learn, `ms.date` 2026-06-23, `updated_at` 2026-07-10. The four moving
parts table:

> `PolicyEnforcementFunctionMiddleware` | Middleware | Checks each tool
> invocation against the current context label and blocks, prompts for approval,
> or allows it.

> policies are enforced *before* a sensitive tool runs — not after

Both sink knobs attach to **tools**, via `@tool(additional_properties=...)`:
`accepts_untrusted: False` and `max_allowed_confidentiality: "public"`. The
enforcement rule is our rule with a different sink:

> If the current context's confidentiality is higher than the cap (e.g. context
> is `private` but the sink only accepts `public`), the call is refused.

Note "the **current context** label" — FIDES as shipped is itself a
coarse-grained floating-label monitor, not the per-value system the paper's
formalism suggests. That matters for §4: it means the shipped granularity is
already the granularity we can achieve by observing tool calls only.

The page is also explicit that answer-side inspection is the thing FIDES is
positioned *against*:

> **Pre/post-hoc monitoring** detects damage; it doesn't prevent it.

### 3.3 CaMeL

[Debenedetti et al., *Defeating Prompt Injections by Design*](https://arxiv.org/pdf/2503.18813)
(arXiv 2503.18813). Figure 4's caption:

> The policies are checked against before each tool call. If the check fails
> (i.e., the policy returns ⊥, then execution is halted.

§5.4:

> **Enforcing security policies.** Before executing a tool with a given set of
> variables as input, relevant security policies are applied to that variable and
> its dependencies, as identified by the dependency graph. If a policy violation
> is detected (e.g., private data passed to a tool with side effects), the tool's
> execution is blocked. In a real-world application, executions that violate
> security policies will not be blocked, but they will require user confirmation.

That last sentence is load-bearing for §4: **CaMeL's shipped answer to a
violation is a human approval, not a refusal.**

Granularity, §5.3:

> Capabilities consist of tags assigned to each individual value that describe
> control and data-flow relationships.

Per-value, and reachable only because CaMeL runs a custom Python interpreter over
LLM-generated code: "We build a custom Python interpreter that operates over a
restricted version of Python." **That granularity is not available to us.** A
`PreToolUse` hook sees tool calls, not the model's reasoning and not intermediate
values. Our unit is necessarily one label per source and one running label for the
context — which is what FIDES ships anyway, and which §4.3 argues is not the
weakness it appears to be.

Neither system, in paper or in shipped form, allows a tainted read and then blocks
only the answer.

---

## 4. Over-refusal: the field's own name, and what the numbers measure

### 4.1 The name is *label creep*

Vassena, Russo, Garg, Rajani, Stefan, *From Fine- to Coarse-Grained Dynamic
Information Flow Control and Back*, PACMPL 3(POPL), Article 76, January 2019
([PDF](https://people.mpi-sws.org/~dg/papers/popl19-ifc.pdf)):

> Floating-label based coarse-grained IFC systems like LIO suffer from the label
> creep problem, which occurs when the program counter gets over-tainted, e.g.,
> because too many secrets have […] unlabeled, to the point that no useful further
> computation can be performed.

*(The elision spans a page break with two intervening figures.)*

> one main drawback of coarse-grained systems is that it requires developers to
> compartmentalize their application in order to avoid both false alarms and the
> label creep problem, i.e., wherein the program gets too "tainted" to do anything
> useful.

Microsoft concedes the same thing about the shipping product, in the Learn page's
*Current limitations*:

> **Most-restrictive-wins propagation can be conservative.** Once an untrusted
> issue body enters the context, the rest of the run is untrusted unless you
> explicitly drop it.

And the FIDES paper about its own propagation rule:

> responses obtained from the model are tainted by the labels of all the messages
> and the tool declarations given as input. This is sound but may be overly
> conservative.

The design spec's risk #1 ("over-tainting … *this is the one that kills the
design*") is therefore correctly identified and correctly named. It should say
*label creep* and cite Vassena, because that gives the risk a literature and a
set of known mitigations rather than leaving it as an intuition.

### 4.2 The measured numbers, and what they are measuring

**FIDES on AgentDojo** (paper §8, average over 5 runs per task, attack is
AgentDojo's most effective against GPT-4o per their leaderboard):

> For Basic planner, the task completion rate drops significantly by up to 40 %
> for gpt-4o. For F IDES, the drop is more modest and mainly affects the reasoning
> models, by up to 24.5 % for o3 and o4-mini.

This is the right anchor: it is the *marginal* cost of turning policy enforcement
on, holding the planner fixed. **Up to 24.5 percentage points**, on a benchmark
where the policies were deliberately generic — the paper says it chose
"three generic per-tool policies" over policies fitted to the benchmark.

**CaMeL on AgentDojo** — and here the existing repo note needs correcting. The
abstract:

> We demonstrate effectiveness of CaMeL by solving 77% of tasks with provable
> security (compared to 84% with an undefended system) in AgentDojo.

Those are Table 2's o3 High row: Native Tool Calling API 84.5% ± 7.2, CaMeL
77.3% ± 8.3, difference −7.2%. **That is the best model in the table.** The same
table's range across six models:

| Model | Native tool calling | CaMeL | Difference |
|---|---:|---:|---:|
| o4 Mini High | 79.4% | 76.3% | −3.1% |
| o3 High | 84.5% | 77.3% | −7.2% |
| Claude 4 Sonnet | 86.6% | 74.2% | −12.4% |
| Claude 4 Sonnet (reasoning) | 83.5% | 70.1% | −13.4% |
| Gemini 2.5 Flash | 55.7% | 35.1% | −20.6% |
| Gemini 2.5 Pro | 73.2% | 41.2% | −32.0% |

More importantly, **the gap is not the price of the taint check.** Figure 11's
caption states it directly:

> In the left figure, only "CaMeL" is shown (and not "CaMeL (no policies)" as
> policies do not affect utility.

And Table 1's failure taxonomy for Claude across the four suites lists eight
failure modes — query misunderstanding, data requires action, wrong assumptions
from P-LLM, not enough context for Q-LLM, Q-LLM overdoes it, ambiguous task,
underdocumented API, AgentDojo bug — and **no policy-denial category at all.**
Every point of the gap is the cost of the privileged/quarantined LLM split, which
this design does not adopt.

The current [IFC research note](./2026-08-06-information-flow-control-for-agent-answers.md)
says "the cost of doing this properly is ~7 points of utility." That reads the
7 points as the price of IFC. It is the price of CaMeL's *architecture*. **Fix
that line before it becomes spec text**, and use FIDES's 24.5% for the
enforcement cost instead.

### 4.3 Coarse granularity is not the weakness it looks like

Vassena et al.'s headline result, from the abstract:

> We show that fine-grained and coarse-grained dynamic information-flow control
> (IFC) systems are equally expressive. To this end, we mechanize two mostly
> standard languages, one with a fine-grained dynamic IFC system and the other
> with a coarse-grained dynamic IFC system, and prove a semantics-preserving
> translation from each language to the other.

**Do not quote this without its side condition**, which is the part that bites:

> We show that a translation from fine- to coarse-grained is possible when the
> coarse-grained system is equipped with a primitive that limits the scope of
> tainting (e.g., when reading sensitive data). In practice, this is not an
> imposing requirement since most coarse-grained systems rely on such primitives
> for compartmentalization.

That primitive is LIO's `toLabeled` — run a sub-computation, then restore the
outer label and return the result wrapped. **A design with one output point, one
monotone label, and no `toLabeled`-equivalent is outside the theorem's
hypothesis.** The theorem also assumes well-typedness, is termination-insensitive,
and requires label introspection at runtime. Safe wording for the spec:
*coarse-grained dynamic IFC is known to be as expressive as fine-grained,
provided the coarse system offers a scope-limiting primitive and label
introspection.* Not "coarse is as good as fine, full stop."

### 4.4 What the literature actually does about over-refusal

Both systems convert a violation into a **human approval**, not a refusal.
CaMeL: "executions that violate security policies will not be blocked, but they
will require user confirmation." FIDES: `approval_on_violation=True`, documented
for "interactive UX, dev/test", with hard block reserved for
"production, low-trust environment"
([confirmed in the re-verification pass](./2026-08-06-ifc-claims-reverification.md),
claim 7).

**AgentCall has no human available at answer time.** The owner is not watching;
that is the product. So the mitigation the literature relies on is unavailable,
and the design pays over-refusal as a straight refusal. That is a genuine
disadvantage relative to both reference systems and the spec should say so.

CaMeL is also explicit that the approval path has its own cost — §9.2, headed
*De-classification and user fatigue*:

> While CaMeL can prevent many prompt injection attacks, it may also require user
> intervention in situations where the security policy is too restrictive or
> ambiguous. […] This can lead to user fatigue, where users become desensitized to
> security prompts and may inadvertently approve malicious actions

which is the same conclusion #394's approval-fatigue evidence reached from the
Vista UAC and Chrome SSL numbers.

### 4.5 The mitigations that do apply, and one is already shipped

1. **Tell the model its permitted set up front.** Already done —
   `buildPrompt(..., { dir: workdirDir, readable: readableSources(map, clearance) })`
   at `listener.ts:356-358`. Taint would be a backstop against a model that
   ignores it, not the primary mechanism. This is the single strongest argument
   that over-refusal would be rare in practice, and it is free.
2. **Keep the read-side check as a clearance bound.** See §4.6.
3. **Constrained output** is the design's `toLabeled` analogue and it already
   exists on paper — [the constrained-output spec](../superpowers/specs/2026-08-06-constrained-output-declassification-design.md)
   lets a task read above the caller's clearance and emit a capacity-bounded
   value. It is the only escape hatch in the design and it is the right shape.

**No published measurement was found of how often an agent touches out-of-scope
sources when told not to.** Both papers measure task completion, not scope
adherence. CaMeL's Figure 10 reports a policy-triggering rate per suite but only
as a figure, and its denominator is "successfully solved tasks" — not a usable
proxy. This is a genuine gap in the literature and it is why the design spec's
"cheap to measure" spike is the right next step.

### 4.6 The literature's own answer is *clearance*, and it points back at the read

LIO's clearance is an upper bound on the current label, and crucially it fails
**at the read**, not at the output:

> When the action retrieveReview R attempts to raise the current label to
> LC ⊔ LR to retrieve the review contents, the dynamic check will fail because
> LC ⊔ LR ⋢ LP.

And then LIO says the striking thing:

> For flexibility, the output channel label can simply be LO = ⊤, allowing any
> information that can be retrieved to be written to the output channel.

**With a clearance in place, LIO stops constraining the output at all.** That is
close to an argument against the inversion as stated. The correct reading is not
"read-side wins" but that the two are complementary and the literature's default
pairing is *clearance at the read plus the floating label at the write* — which is
what AgentCall would have if it kept `guard.ts` and added the sink check, rather
than replacing one with the other.

This also lands on the same conclusion as the
[constrained-output spec's §"What the parent design got wrong about the code"](../superpowers/specs/2026-08-06-constrained-output-declassification-design.md),
which already argued the shipped read-side behaviour is *better* than the
documented reply-side one because "a caller never burns a call to be told no."

---

## 5. The record the proposal assumes does not exist yet

The brief states the guard "already resolves and logs the path per tool call to a
local private audit log." Checked against `guard.ts`:

```ts
write(deps.line.toolsLog, mode === "observe"
  ? { type: "tool_call", call_id: deps.callId, ...correlation, tool: input.tool_name, mode }
  : { type: "tool_call", call_id: deps.callId, ...correlation, tool: input.tool_name, allowed: verdict.allow });

const noteworthy = verdict.allow ? verdict.flag : verdict;
if (noteworthy) {
  write(deps.line.callsLog, { type: …, rule: noteworthy.rule, detail: noteworthy.detail, … });
}
```
(`guard.ts:341-355`)

`tools.log` carries the tool **name** and the verdict. The resolved path lives in
`detail`, and `detail` reaches `calls.log` **only when `noteworthy` is set** —
i.e. only on a denial or a flagged Bash command. **An allowed `Read` of a
permitted file writes no path anywhere.** The taint set the design needs is not
being recorded today; it would have to be added.

Three consequences worth stating in the spec:

- **Adding it changes what the audit log is.** `guard.ts:14-20` states `detail`
  is audit-only and must not reach `permissionDecisionReason`; `listener.ts:485`
  notes calls.log "is what gets pasted into a bug report." A complete
  per-tool-call path record turns the log into a full inventory of everything the
  owner's agent read. That is a new sensitivity on a file that currently holds
  only exceptions.
- **Bash records no provenance at all.** `decide()` returns allow for every Bash
  command, recording at most a `bash-references-denied-path` flag from a
  substring match (`guard.ts:175-182`), with the comment "string matching is too
  weak to be a boundary." The record for Bash names a *suspicion*, never a source.
- **`WebFetch` and `WebSearch` are allowed with no argument recorded** either
  (`guard.ts:185-195`). Less central for confidentiality — those read outward, not
  inward — but they are unlogged sources.

The per-tool granularity that *is* achievable is defensible on its own terms. The
[re-verification note's](./2026-08-06-ifc-claims-reverification.md) best-sourced
finding is that a tool result is one opaque payload and the only sound bound is
the meet of every item's label — which `github/github-mcp-server` implements in
`pkg/ifc/ifc.go` and Azure AI Search computes as an aggregate. One label per
source is the right unit. It just has to actually be written down.

---

## 6. The incomplete-record fail-open

An empty log and a clean log are the same bytes. This is the failure that decides
whether the inversion is buildable, and the literature's position on it is
unusually blunt.

### 6.1 Tamper-evidence is not completeness

| Source | What it guarantees | What it excludes, in its own words |
|---|---|---|
| Schneier & Kelsey 1998 | entries before compromise cannot be altered undetectably | "no cryptographic method can be used to actually prevent the deletion of log entries: solving that problem requires write-only hardware such as a writable CD-ROM disk, a WORM disk, or a paper printout. The only thing cryptographic protocols can do is to guarantee detection of such deletion, and that is assuming U eventually manages to communicate with T." |
| Crosby & Wallach 2009 | historical consistency across commitments | "an event, once correctly inserted, cannot be undetectably hidden or modified"; "Tamper-evidence requires auditing. If the log is never examined, then tampering cannot be detected." |
| RFC 9162 (CT) | append-only superset relation between tree versions | omission is a separate misbehaviour class caught only by redeeming an out-of-band SCT |

Sources: Schneier & Kelsey, *Cryptographic Support for Secure Logs on Untrusted
Machines*, USENIX Security 1998
([PDF](https://www.schneier.com/wp-content/uploads/2016/02/paper-secure-logs.pdf));
Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging*, USENIX
Security 2009 ([PDF](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf));
[RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.txt).

The unifying structure: **every one of these makes omission detectable only by
importing information from outside the log.** A trusted party that knows the log
should exist; an auditor demanding proofs; a receipt held by someone else; a
layout enumerating expected steps; a counter maintained by the kernel.

Today AgentCall's releaser would read only the log the hook produced. It is inside
the closed world and can therefore answer only the tamper-evidence question.

### 6.2 The buildable forms, with precedent

**1. Enumerate the expected record in advance and refuse on shortfall.** in-toto's
layout does exactly this, and the reference implementation fails closed —
`in_toto/verifylib.py` raises `ThresholdVerificationError` when fewer than
`threshold` valid links are found, and documents `LinkNotFoundError` as
*"Fewer than threshold link metadata files can be found for a step of the
layout."* Missing and invalid collapse to the same outcome, which is the correct
reduction.

**2. Keep a loss counter outside the record.** The Linux audit subsystem is the
strongest precedent for the whole proposal. `struct audit_status` carries
`__u32 lost; /* messages lost */` (`include/uapi/linux/audit.h`), and
`auditctl(8)` documents the fail-closed option in one sentence that could be
lifted into our spec:

> `-f [0..2]` Set failure mode 0=silent 1=printk 2=panic. This option lets you
> determine how you want the kernel to handle critical errors. Example conditions
> where this mode may have an effect includes: transmission errors to userspace
> audit daemon, backlog limit exceeded, out of kernel memory, and rate limit
> exceeded. The default value is 1. **Secure environments will probably want to
> set this to 2.**

`kernel/audit.c`'s `audit_panic()` really does call `panic()` on
`AUDIT_FAIL_PANIC`. **A shipping OS halts the machine rather than continue with a
known gap in its provenance record.** "Refuse the reply when the record is
unverified" is a strictly milder version of an option Linux ships and recommends
for secure environments.

**3. Commit to the record's existence before the run.** Schneier & Kelsey's
startup message is a dead-man's switch for exactly our empty-log case:

> Without this protection, an attacker could delete U's whole logfile after
> compromise, and claim to simply have failed to receive M1 during the startup.

Translated: the listener must know, before spawning, that a log for this call
should exist and with what identity — otherwise absence is deniable.

**4. Sequence-number the entries.** RFC 5848's abstract lists gap detection as a
protocol deliverable:

> This document describes a mechanism to add origin authentication, message
> integrity, replay resistance, message sequencing, and detection of missing
> messages to the transmitted syslog messages.

with the warning that a gap of unknown scope tells you nothing about whether the
missing item mattered — which for a fail-closed policy means treating it as if it
did.

### 6.3 The negative finding: the field tried to mandate completeness and backed off

SLSA v0.1 had, at level 4 only:

> **Dependencies complete** — Provenance records all build dependencies that were
> available while running the build steps.
> ([slsa.dev/spec/v0.1/requirements](https://slsa.dev/spec/v0.1/requirements))

SLSA v1.0 removed L4 and downgraded it:

> Completeness: SHOULD be complete. External parameters MUST be fully enumerated.
> Completeness of resolved dependencies is best effort. [Build L3]
> ([slsa.dev/spec/v1.0/requirements](https://slsa.dev/spec/v1.0/requirements))

Read precisely: SLSA *strengthened* completeness over the enumerable set
("External parameters MUST be fully enumerated") and *conceded* it over the
open-ended set. That maps onto this design almost exactly. **"Which sources this
caller is permitted" is enumerable and completeness over it is achievable.
"Everything the agent's tool calls actually touched" is the resolved-dependency
set, and the field's considered judgement after trying is that you should not
claim completeness over it.**

### 6.4 The name for the failure

Schwartz, Avgerinos, Brumley, *All You Ever Wanted to Know About Dynamic Taint
Analysis and Forward Symbolic Execution (But Might Have Been Afraid to Ask)*,
IEEE S&P 2010 ([PDF](https://users.ece.cmu.edu/~aavgerin/papers/Oakland10.pdf)),
§III:

> Second, dynamic taint analysis can miss the information flow from a source to a
> sink, which we call **undertainting**. In the attack detection scenario,
> undertainting means the system missed a real attack.

*Undertainting* is the field's name for our fail-open. Note the paper frames it
around policy and information-flow types (control-flow dependencies, tainted
addresses), **not** around uninstrumented code paths — so it is a citation for the
failure mode, not for "taint tracking is only as sound as its instrumentation
coverage." That specific framing was not found in a primary source.

---

## 7. The Codex angle: observation is sufficient in principle, and insufficient here

The claim under test: Codex's guard runs in observe mode because it cannot
reliably block, but observation suffices for taint if enforcement moves to the
sink, which is our own code and always runs.

**The principle is right.** LIO's floating label needs only that reads be
*observed*; the single enforced check is at the write. Moving enforcement to the
reply is exactly the shape that makes an observe-only read hook sufficient. This
is the strongest argument in the proposal and it survives.

**Two things defeat it as the code stands.**

### 7.1 Observe mode fails open *and silently* — fixable

```ts
// In observe mode the guard is telemetry, not a boundary, so a failure to
// decide must not cost availability — there is nothing to fail closed *to*.
const onFailure = mode === "observe" ? ALLOW : FAIL_CLOSED;
```
(`guard.ts:281-283`)

Two paths reach `onFailure`, and in observe mode both return `ALLOW` having
written **nothing**:

- a malformed hook payload (`guard.ts:294-297`), before any log write;
- **any exception inside the main `try`, including a failed `appendLine`**
  (`guard.ts:369-370`). A full disk or a read-only home turns an executed tool
  call into an unrecorded one.

`guard-entry.ts:136-137` mirrors it: `process.exit(mode === "observe" ? 0 : 2)`.

In **enforce** mode this is safe, because the record and the enforcement fail
together — exit 2 blocks the tool. In **observe** mode they come apart, and the
tool runs unrecorded. That asymmetry is invisible today because observe mode is
telemetry. **The moment the log becomes the boundary, `onFailure = ALLOW` is a
fail-open on the boundary itself**, and the comment above it becomes false.

The fix is the in-toto/audit shape from §6.2: observe mode must still fail
*loudly* — write a gap marker to a location the agent cannot reach, with a
sequence number — and the listener must refuse when a marker is present or the
sequence has holes. That is real, buildable work, and it inverts observe mode's
stated contract rather than extending it.

### 7.2 Bash under Codex cannot be observed — not fixable

`decide()` allows every Bash command and records at most a substring match
(`guard.ts:175-182`), with the module's own assessment: *"string matching is too
weak to be a boundary and too eager to be harmless."* Command-string inspection
cannot say which files a command read; the design spec already records this as
why Codex runs in observe mode at all.

So under Codex, the provenance record is structurally incomplete over Bash, and
no amount of better logging closes it. The options are (a) refuse to release any
reply from a run that used Bash, (b) treat any Bash use as raising the context to
`secret`, or (c) accept a stated hole. Options (a) and (b) are the same thing and
are honest; (c) means the guarantee does not hold under Codex and must be
documented as not holding, not as holding weakly.

This is the finding that most threatens the "Codex benefit" framing. The
inversion does not make Codex enforceable. It makes Codex *auditable for
path-shaped tools* and leaves Bash exactly as unenforceable as it was.

---

## Verdict

**Sink-side provenance enforcement is sound as information-flow control, is a
1969 construction with a 2011 formalization, and is not what anybody ships. It is
buildable here under four constraints, none of which is optional.**

Taking the questions in order:

**Is taint tracking sound over an LLM's context window?** Yes, at the granularity
available to us, and with a caveat. The over-approximation direction is safe:
one label per source, joined into a monotone running label, checked once at the
reply, is LIO's rule. Per-value granularity is not available — CaMeL gets it only
by owning a Python interpreter — but FIDES *as shipped* is coarse-grained too
("the current context label"), and Vassena et al. establish that coarse and fine
are equally expressive **given a scope-limiting primitive**. That proviso is the
caveat: a design with one exit and no `toLabeled`-equivalent is outside the
theorem. Constrained-output tasks are the closest thing this design has to one,
and that raises their status from a nice-to-have to a structural requirement.

**Does anyone ship run-then-discard?** No. Seventeen systems; every output guard
is content classification. The two provenance cases enforce before grounding or
label rather than refuse. State this as a clear negative in the spec, together
with the structural reason — every comparable system answers the principal who
owns the data, and AgentCall does not — so it reads as an architecture difference
rather than as an unexamined novelty.

**The over-refusal cost.** Named (*label creep*), documented by the vendor of the
one shipping IFC agent framework, and measured at **up to 24.5 percentage points**
for FIDES when policy enforcement is switched on. CaMeL's 77%/84% is not this
number and should stop being cited as if it were. The literature's mitigation is
a human approval, which this product does not have — so the cost lands as a
refusal. The one mitigation that does apply is already shipped: the prompt
already names the readable sources, so taint is a backstop, not the primary
mechanism. No published measurement exists of how often an agent strays outside a
stated scope, which is why the spec's replay spike is the right and cheap next
step.

**The incomplete-record fail-open.** Real, and the honest framing is SLSA's:
completeness is claimable over the enumerable set and not over the open-ended
one. Buildable in the specific forms §6.2 lists — enumerate expectations, keep a
loss counter outside the record, commit to the record before the run,
sequence-number entries. Linux audit's `-f 2` is the precedent that makes
"refuse when the record is unverified" a shipped engineering discipline rather
than hand-waving.

### The four constraints

1. **Add the sink check; do not remove the read check.** LIO's clearance fails at
   the read and is what lets LIO relax the output channel to ⊤. `guard.ts` is
   already that clearance. The literature's default pairing is both, and the
   [constrained-output spec](../superpowers/specs/2026-08-06-constrained-output-declassification-design.md)
   already argues the read-side check is the better user experience — a caller
   never burns a call to be told no. Reframe the proposal as *adding a backstop*,
   not as an inversion.
2. **Build the record before building the check.** The per-tool-call path log the
   design assumes does not exist (§5). Land it, with sequence numbers and a gap
   marker, and treat the log's new sensitivity as a decision — it becomes a full
   inventory of what the owner's agent read, in a file the codebase already notes
   gets pasted into bug reports.
3. **Refuse on an unverified record, and make observe mode able to say so.**
   `onFailure = ALLOW` with no write (`guard.ts:283`) is the exact silent
   fail-open. Observe mode must write a gap marker or the whole claim is
   unfalsifiable.
4. **Say plainly that Bash is outside the guarantee under Codex.** No logging
   change closes it. Either a Bash-using run cannot release a reply above the
   caller's clearance, or the guarantee is documented as not holding for Bash.

### One reframe worth taking

FIDES's `max_allowed_confidentiality` on `post_comment` and our proposed check on
the reply are **the same rule with a different sink**. That is a much stronger
position than "we invert FIDES": it says the design applies the shipping
mechanism to the one sink this architecture has, rather than inventing a new
enforcement point. Combined with Sabelfeld & Sands's *where* dimension — code
locality plus level locality — the spec can describe itself entirely in borrowed,
citable vocabulary.

---

## How this was verified

The FIDES and CaMeL papers were downloaded and converted with `pdftotext`, and
every quoted sentence was located in the extracted text before quoting. The
Microsoft Learn FIDES page and the Purview pages were read as raw page markdown.
LIO, Vassena et al., Sabelfeld & Sands, Schneier & Kelsey, Crosby & Wallach,
Weissman, and Schwartz et al. quotes were extracted from the PDFs and grepped
before quoting. Kernel quotes come from `auditctl(8)` HTML, `include/uapi/linux/audit.h`
and `kernel/audit.c` read directly. RFC 5848 and RFC 9162 from raw RFC text.

Two summarizer passes over the FIDES and CaMeL PDFs produced confident-looking
quotations that do not appear in either paper; they were discarded and both papers
re-read from extracted text. A related attempt on Schwartz et al. produced two
fabricated quotes that were caught by grep. **The pattern is consistent enough to
be a working rule: do not quote a PDF that was read through a summarizer.**

## What I could not verify

1. **Vendor product rows read only through a summarizer.** Cloudflare AI Gateway,
   LiteLLM, Kong, Portkey, Llama Guard, OpenAI Agents SDK, Nightfall, and Prisma
   AIRS were assessed from a summarizer's rendering, not raw page text. The
   content-vs-provenance verdict for each is reliable; **nothing from those pages
   is quoted here** and none should be quoted without re-reading.
2. **Prompt Security, Lasso, WitnessAI.** `docs.prompt.security` fails DNS;
   `lasso.security/product` and `witness.ai/platform/` 404. Marketing homepages
   only. Genuinely unknown, though nothing in the adjacent evidence suggests a
   positive.
3. **The FIDES shipping source.** The Learn page and the paper were read; the
   Python module implementing `PolicyEnforcementFunctionMiddleware` was not
   fetched. The claim that no check runs on the final response rests on the
   paper's Algorithm 5 and on the Learn page's description, both of which are
   unambiguous — but it is a claim about absence, and absence in documentation is
   weaker than absence in source.
4. **Any measurement of how often an agent touches out-of-scope sources when told
   not to.** Not found in either paper or in any vendor documentation. CaMeL's
   Figure 10 policy-triggering rate is figure-only and its denominator is solved
   tasks, so it is not a substitute.
5. **Any measurement of the cost of run-then-discard.** Neither paper prices
   wasted work, because neither ever does it. CaMeL reports 2.73× output tokens
   and FIDES 2–3× token utilization, but both are architecture overheads, not
   discarded runs. There is no prior art on this cost.
6. **PCI DSS Requirement 10.7** on detecting failures of audit-logging
   mechanisms. The PCI SSC library is behind a click-through; the document was not
   read and is not cited.
7. **Who coined "label creep."** LIO 2011 uses it undefined; Vassena et al. 2019
   defines it and cites Austin & Flanagan 2009, which was not retrieved. The
   earliest verified *definition* is POPL 2019.
8. **A primary citation for "taint tracking is only as sound as its
   instrumentation coverage."** Schwartz et al. supplies *undertainting* but
   frames it around information-flow types, not uninstrumented code. Cavallaro,
   Saxena & Sekar (DIMVA 2008) is the lead; unretrieved, so not cited.
9. **Weissman 1969's OCR.** The two quoted sentences are clean in a visibly
   damaged scan; not cross-checked against a second copy.
10. **Invariant Guardrails' shipping status.** The hosted Explorer was shut down
    in January 2026 per its own repository README; the engine continues in
    `mcp-scan` under Snyk. Whether the dataflow operator is used in production by
    anyone was not established.

---

## Sources

Primary, in the order they carry weight:

- Stefan, Russo, Mitchell, Mazières, *Flexible Dynamic Information Flow Control in Haskell*, Haskell Symposium 2011 — [PDF](https://www.scs.stanford.edu/~deian/pubs/stefan:2011:flexible.pdf)
- Costa, Köpf, Kolluri, Paverd, Russinovich, Salem et al., *Securing AI Agents with Information-Flow Control* — [arXiv 2505.23643](https://arxiv.org/pdf/2505.23643)
- Debenedetti et al., *Defeating Prompt Injections by Design* (CaMeL) — [arXiv 2503.18813](https://arxiv.org/pdf/2503.18813)
- Microsoft Learn — [Agent Security with FIDES](https://learn.microsoft.com/en-us/agent-framework/agents/security) (`ms.date` 2026-06-23, `updated_at` 2026-07-10)
- Vassena, Russo, Garg, Rajani, Stefan, *From Fine- to Coarse-Grained Dynamic Information Flow Control and Back*, PACMPL 3(POPL) Art. 76, 2019 — [PDF](https://people.mpi-sws.org/~dg/papers/popl19-ifc.pdf), [DOI](https://doi.org/10.1145/3290389)
- Sabelfeld & Sands, *Declassification: Dimensions and Principles*, CSFW'05 / JCS 17(5) 2009 — [PDF](https://www.cse.chalmers.se/~andrei/sabelfeld-sands-jcs07.pdf)
- Krohn et al., *Information Flow Control for Standard OS Abstractions* (Flume), SOSP 2007 — [PDF](https://pdos.csail.mit.edu/papers/flume-sosp07.pdf); Zeldovich et al., *Making Information Flow Explicit in HiStar*, OSDI 2006 — [PDF](https://www.scs.stanford.edu/~nickolai/papers/zeldovich-histar.pdf)
- Weissman, *Security controls in the ADEPT-50 time-sharing system*, AFIPS FJCC 1969 — [scan](https://www.ukcert.org.uk/SecurityControlsInTheADEPT-50Time-SharingSystem_p119-weissman.pdf)
- Schneier & Kelsey, *Cryptographic Support for Secure Logs on Untrusted Machines*, USENIX Security 1998 — [PDF](https://www.schneier.com/wp-content/uploads/2016/02/paper-secure-logs.pdf)
- Crosby & Wallach, *Efficient Data Structures for Tamper-Evident Logging*, USENIX Security 2009 — [PDF](https://static.usenix.org/event/sec09/tech/full_papers/crosby.pdf)
- Schwartz, Avgerinos, Brumley, *All You Ever Wanted to Know About Dynamic Taint Analysis…*, IEEE S&P 2010 — [PDF](https://users.ece.cmu.edu/~aavgerin/papers/Oakland10.pdf)
- [RFC 5848](https://www.rfc-editor.org/rfc/rfc5848.txt) (Signed Syslog Messages); [RFC 9162](https://www.rfc-editor.org/rfc/rfc9162.txt) (Certificate Transparency 2.0)
- Linux — [`auditctl(8)`](https://man7.org/linux/man-pages/man8/auditctl.8.html), `include/uapi/linux/audit.h`, `kernel/audit.c` (torvalds/linux master)
- in-toto — [specification](https://github.com/in-toto/specification), `in_toto/verifylib.py` @ `develop`
- SLSA — [v0.1 requirements](https://slsa.dev/spec/v0.1/requirements), [v1.0 requirements](https://slsa.dev/spec/v1.0/requirements)
- Microsoft Learn — [DLP for the M365 Copilot policy location](https://learn.microsoft.com/en-us/purview/dlp-microsoft365-copilot-location-learn-about), [Purview protections for Copilot](https://learn.microsoft.com/en-us/purview/ai-m365-copilot)
- NIST SP 800-92, *Guide to Computer Security Log Management* — [PDF](https://nvlpubs.nist.gov/nistpubs/Legacy/SP/nistspecialpublication800-92.pdf)
- Invariant Labs — [Guardrails reference](https://invariantlabs-ai.github.io/docs/mcp-scan/guardrails-reference/)
- NVIDIA/NeMo-Guardrails source (`nemoguardrails/library/self_check/`); guardrails-ai/guardrails source (`guardrails/validator_base.py`)
