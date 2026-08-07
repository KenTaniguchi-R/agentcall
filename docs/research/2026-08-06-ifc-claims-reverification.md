# Re-verification of the IFC claims in #394

**Date:** 2026-08-06
**Status:** Verification pass, not new research. Adversarial check on
[#394](https://github.com/KenTaniguchi-R/agentcall/issues/394) before it becomes
spec text, prompted by that issue's own sourcing caveat:

> One research agent in this batch fabricated a claim about having received
> sub-agent results and self-corrected; its remaining findings were separately
> confirmed, but anything from that batch should be re-checked before it becomes
> normative text.

Every factual claim in #394 was checked against the source that owns it. Where a
claim could not be traced to its cited source, that is recorded as the finding —
no claim was repaired by substituting a different source that says something
similar.

## Verdicts

| # | Claim | Verdict | Source | Note |
|---|---|---|---|---|
| 1a | Authorization-First Retrieval exists at DOI `10.18653/v1/2026.trustnlp-main.15` | **CONFIRMED** | <https://aclanthology.org/2026.trustnlp-main.15> | *Authorization-First Retrieval: Enforcing Least Privilege in Multi-Agent RAG Systems*, Rohith Namboothiri, TrustNLP 2026 (6th Workshop on Trustworthy NLP), pp. 256–271. DOI resolves. |
| 1b | Quote: mixed-content chunks "cannot be tagged correctly under a single-label scheme regardless of process maturity" | **CONFIRMED** | paper §"Other forms of metadata fragility", p. 9 | Verbatim: "Mixed-content chunks (public and restricted material colocated in one indexable unit) cannot be tagged correctly under a single-label scheme regardless of process maturity." |
| 1c | **86.1%** retrieve-then-filter exposure | **CONFIRMED** | paper Tables 1/5 | D3 (Retrieve-then-filter) *structural* leak rate, 371/431 = 86.1%, identical across both models. "Structural leak" = unauthorized chunks enter the model's context, which is what #394 says ("exposing unauthorized context"). Not to be confused with *answer* leak rate (29.5–41.3%). |
| 1d | **9.7%** metadata pre-filter leakage after one policy-update cycle | **CONFIRMED** | paper Table 5 | "D2-tagged (stale) 42/431 (9.7%)"; caption: "Staleness reintroduces structural leaks on 9.7% of queries." |
| 1e | Quote: "staleness is not an edge case. It is the steady state." | **CONFIRMED** | paper p. 9 | Verbatim. |
| 2a | `pkg/ifc/ifc.go` joins to the most restrictive label | **CONFIRMED** | [ifc.go:135-152](https://github.com/github/github-mcp-server/blob/main/pkg/ifc/ifc.go) | `LabelSearchIssues` returns `PrivateUntrusted()` for mixed public/private results. |
| 2b | The long "one opaque payload… meet of every item's label" passage is genuinely in that repo | **CONFIRMED** | `ifc.go:126-134` | Verbatim source comment. #394's ellipsis elides "(a single content block) and the IFC engine makes one allow/deny decision per flow at egress" — a fair elision that does not change the sense. |
| 2c | `ifc_labels` opt-in flag is real | **CONFIRMED** | [`pkg/github/feature_flags.go:15-16`](https://github.com/github/github-mcp-server/blob/main/pkg/github/feature_flags.go) | `FeatureFlagIFCLabels = "ifc_labels"`, listed in `AllowedFeatureFlags`; every label attach is gated by `shouldAttachIFCLabel`. |
| 3 | Azure AI Search does per-reference labels *and* a response-level "most restrictive across all references", **and enforces on that** | **PARTLY** | [agentic-retrieval-how-to-retrieve](https://learn.microsoft.com/en-us/azure/search/agentic-retrieval-how-to-retrieve) | The two-level structure is real: per-reference `sensitivityLabelInfo`, response-level `metadata.responseSensitivityLabelInfo` = "An aggregate label that represents the highest-priority sensitivity label across all referenced documents in the response." **Two things are overstated.** The doc hedges the rule — "Typically, the most restrictive label wins" — and the aggregate is advisory: "Useful for client-side display banners and policy enforcement." Actual server-side enforcement is *per-document exclusion* at query time ([search-query-sensitivity-labels](https://learn.microsoft.com/en-us/azure/search/search-query-sensitivity-labels)), not enforcement on the aggregate. |
| 4 | The MCP extensions draft killed `sensitiveHint: low\|medium\|high` because "sensitivity is set-theoretic (a card number and a medical record are both sensitive but to different readers), not a single scale" | **FALSE** | see below | Wrong levels, wrong verdict, and the quotation is not a quotation. Detail in §"Claim 4". |
| 5 | Oracle Label Security `LEVEL : COMPARTMENTS : GROUPS`; dominance needs level ≥ **and** compartments ⊇ **and** group intersection; non-comparable is first-class | **CONFIRMED** | [Advanced Topics in OLS, Table B-1](https://docs.oracle.com/en/database/oracle/oracle-database/19/olsag/advanced-topics-in-oracle-label-security.html) | Level: "must be greater than or equal to". Compartments: "must contain all the compartments of `label2`". Groups: "must contain at least one of the groups of `label2`" (intersection, not containment). "Two labels are non-comparable if neither label dominates the other." All three components must dominate. |
| 6a | **93%** approval rate on Claude Code permission prompts, "Anthropic's own telemetry" | **CONFIRMED** | <https://www.anthropic.com/engineering/claude-code-auto-mode> | Verbatim, opening paragraph: "Claude Code users approve 93% of permission prompts." This was the claim flagged as most likely unsourced; it holds at the primary source. |
| 6b | Vista UAC **89–91%** | **CONFIRMED** | [Microsoft E7 blog, *User Account Control*](https://learn.microsoft.com/en-us/archive/blogs/e7/user-account-control) | "we are seeing consumer administrators approving 89% of prompts in Vista and 91% in SP1." **Not academic** — this is Microsoft's own data, not Motiee et al. Cite it as such. |
| 6c | Chrome SSL warnings **70%** | **CONFIRMED** | Akhawe & Felt, *Alice in Warningland*, USENIX Security 2013, [PDF](https://static.googleusercontent.com/media/research.google.com/en/us/pubs/archive/41323.pdf) | 70.2% clickthrough on Chrome SSL warnings. |
| 6d | "half dismissed under **1.7s**" | **PARTLY** | same paper, §7.1.2 | Verbatim: "Users clicked through 49% of untrusted issuer warning impressions within 1.7s, but clicked through 50% of name and date errors within 2.2s and 2.7s, respectively." 1.7s is one of *three* SSL error subtypes; the other two are slower. "Half of SSL warnings dismissed under 1.7s" generalizes a subtype figure to the whole class. |
| 7 | Microsoft's FIDES docs recommend `approval_on_violation=True` for "interactive UX, dev/test" and hard block for "production, low-trust environment" | **CONFIRMED** | [Agent Security with FIDES](https://learn.microsoft.com/en-us/agent-framework/agents/security), §"Policy enforcement modes" | Verbatim table rows: "**Hard block** (production, low-trust environment)" → `approval_on_violation=False`; "**Human-in-the-loop** (interactive UX, dev/test)" → `approval_on_violation=True`. Two notes: the source is the Learn page, **not** `FIDES_DEVELOPER_GUIDE.md` (which contains neither phrase); and it is a mode-selection table, not an argument against approvals — the same page's worked example runs `approval_on_violation=True`. |
| 8 | FIDES approval path shipped a replay bug — a granted `call_id` in a set never cleared | **CONFIRMED** | [microsoft/agent-framework#6966](https://github.com/microsoft/agent-framework/pull/6966), merged 2026-07-09 | Verbatim from the PR body: "A granted approval was tracked only by `call_id` in a set that was never cleared, so a reused `call_id` could satisfy a later or different policy-violating call, and an approved response was accepted without checking its own `id` / embedded `function_call`." **Fixed as of 2026-07-09** — current `security.py` binds approvals to the exact invocation and consumes on first use. Use past tense. |
| 9 | "Lies-in-the-Loop" is real and describes padding a dialog so the dangerous part scrolls off | **CONFIRMED** | [OWASP: HITL Dialog Forging (aka Lies-in-the-Loop)](https://owasp.org/www-community/attacks/Lies_in_the_Loop); Checkmarx research | Padding payloads with benign text to push dangerous commands out of the visible view is the described mechanism; Claude Code is among the named affected platforms. Industry research + OWASP community page, **not** a peer-reviewed paper. |
| 10 | "Oversight Has a Capacity" models realized safety as an inverted-U in escalation rate | **CONFIRMED** | [arXiv 2606.08919](https://arxiv.org/abs/2606.08919), *Oversight Has a Capacity: Calibrating Agent Guards to a Subjective, Fatiguing Human* | Realized safety is inverted-U in escalation rate; safety-optimal guard escalates below full escalation. **The paper states its own limit**: the inverted-U "is a direct consequence of the assumed monotonically-fatiguing reviewer — a modeling result about a plausible model, not an empirical finding about real people." #394's wording ("models … as") is accurate; normative text must not upgrade it. |
| 11a | Wijesekera et al., IEEE S&P 2017, **96.8%** accuracy | **CONFIRMED** | [arXiv 1703.02090](https://arxiv.org/abs/1703.02090) / IEEE S&P 2017 | *The Feasibility of Dynamically Granted Permissions: Aligning Mobile Privacy with User Preferences.* |
| 11b | ~4x error reduction over ask-on-first-use | **CONFIRMED** | same | "a four-fold reduction in error rate"; the abstract's stated baseline is the ask-on-first-use model. |
| 11c | **38-person** field study | **FALSE** | same | It is a **131-person** longitudinal field study. Off by ~3.5x. |
| 12 | SpiceDB `[expiration:...]` is a first-class relationship primitive, clock-enforced server-side; they moved *off* caveat-based expiry because it required clients to supply `now` and did not GC | **CONFIRMED** | [Writing Relationships that Expire](https://authzed.com/docs/spicedb/concepts/expiring-relationships); [The Evolution of Expiration](https://authzed.com/blog/the-evolution-of-expiration) | Syntax `…@user:anne[expiration:2025-12-31T23:59:59Z]`. "The clock used to determine if a relationship is expired is that of the underlying SpiceDB datastore." Both stated reasons appear verbatim as caveat limitations: clients had to "provide the `now` timestamp… additional complexity for clients", and "expired caveats are not automatically garbage collected." |
| 13 | REDACT, arXiv 2606.19881; Presidio at **0.07 recall on HIGH-sensitivity categories** | **CONFIRMED** | [arXiv 2606.19881](https://arxiv.org/abs/2606.19881) | ID resolves to *REDACT: A Systematically Controlled Multilingual Benchmark for Personal Information Detection*. Abstract verbatim: "the rule-based detector performs poorly on the highest-stakes data, including HIGH-sensitivity categories (recall 0.07)". Minor: the abstract says "the rule-based detector"; Presidio is the only rule-based system among the five evaluated (Presidio, GLiNER, OpenAI Privacy Filter, GPT-4.1, Claude Sonnet 4.6), so the attribution is a supported inference rather than a direct statement. |
| 14a | SEP-1913 split to an Extensions Track in June 2026 | **CONFIRMED** | [experimental-ext-tool-annotations](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations) | The extension draft's changelog opens **2026-06-10**: "Initial draft skeleton. Narrowed to `sensitive` + `untrusted` + `evidenceRef`; DataClass demoted to a profile; `requires_review` moved to `action-metadata`." Note PR #1913 itself remains listed as **Standards Track / Draft** in the SEP index — the Extensions Track work lives in the separate repo, so "split" is the right word. |
| 14b | Sponsor unresponsive; bot nagging through 2026-08-03 | **CONFIRMED** | [PR #1913](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/1913) comments | `sep-automation-bot` "Maintainer Activity Check" addressed to @localden on 2026-06-29 (18 days), 2026-07-20 (20 days), 2026-08-03 (14 days). PR open since 2025-11-27; last activity 2026-08-03. |
| 15 | Every spec revision through 2026-07-28 and the current draft has only the four original tool hints; zero merged SEPs for `_meta.ifc` | **CONFIRMED** | `schema/*/schema.ts` in modelcontextprotocol/modelcontextprotocol | Revisions present: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28, draft. Every one carries exactly `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (plus the unrelated `ModelHint`). No `ifc` and no `trust-annotations` anywhere in the draft schema. |
| 16 | Three incompatible wire formats exist today | **PARTLY** | see below | All three key strings are real and in real code — but one is attributed to the wrong project. Detail in §"Claim 16". |

## Claim 4 — the one outright fabrication

#394 says:

> The MCP extensions draft killed `sensitiveHint: low|medium|high` because
> *"sensitivity is set-theoretic (a card number and a medical record are both
> sensitive but to different readers), not a single scale."*

Three separate problems.

**The quotation does not exist.** The string does not appear in
`modelcontextprotocol/experimental-ext-tool-annotations`, in SEP-1913's PR body
or SEP text, in that PR's comments, or in issue #711. Searched for
"set-theoretic", "card number", "medical record", "single scale", and "different
readers" across all five. This is paraphrase presented as quotation.

**What the draft actually narrowed was not `sensitiveHint: low|medium|high`.**
Verbatim from
[`specification/draft/trust-annotations.mdx`](https://github.com/modelcontextprotocol/experimental-ext-tool-annotations/blob/main/specification/draft/trust-annotations.mdx),
§"Coarse vs. rich classification (DataClass)":

> SEP-1913 carried a four-level data classification (`public` / `personal` /
> `confidential` / `highly_confidential`) plus a regulatory scope (e.g.
> `confidential:hipaa`). **This extension deliberately keeps only the coarse
> `sensitive` boolean on the wire.**

`sensitiveHint: low|medium|high` appears only in SEP-1913's *PR description*,
which is stale relative to the SEP text it points at — the SEP body itself
carries categorical `DataClass` (`none` / `user` / `pii` / `financial` /
`credentials` / `{regulated: …}`), not a three-level hint.

**And it was not "killed" — it was demoted, for a different reason.** The draft's
stated rationale is universality, not set-theory:

> This is an explicit scope decision. The boolean is the **lowest-common-
> denominator signal**: a universal, always-actionable floor that lets any client
> apply a basic egress/consent policy that is *better than nothing*… Richer
> schemes are strictly more capable but are not universally implemented, so they
> cannot be the floor.
>
> Servers SHOULD therefore emit **both** when they can: the coarse `sensitive`
> boolean for universal actionability, **and** a richer `evidenceRef` scheme
> (e.g. `data-class.v1`, `ifc.fides.v1`) for hosts that implement it. The two are
> layered, not alternatives.

**A weaker version of the underlying point is genuinely sourced, elsewhere.** The
set-theoretic objection to linear scales is real, but it is a reviewer comment on
[issue #711](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/711),
by @JustinCappos, and it argued against linear scales *in general* rather than
killing anything:

> One thought I had is to wonder if having levels (low medium high) or really any
> sort of linear scoring system like this is the best approach. For example, I
> want an email with medical test results to be able to be read by my mail MCP
> and my credit card number to be sent to a payment MCP, but I may not want
> either bit of detail shared with the other.

SEP-1913 answers it directly in §"Why Not Information Flow Control (IFC)
Labels?", and chose categorical `DataClass` over a linear scale partly in
response. **That** is the citable chain. It supports #394's *conclusion* — a
single scale is the wrong shape — while contradicting its account of who decided
what, and why.

## Claim 16 — right formats, wrong owner

All three key strings exist in real code. The attribution is wrong for one, and
the collision is the opposite of what #394 implies.

| Wire format | Who actually emits/consumes it |
|---|---|
| `_meta["ifc"]` | **`github/github-mcp-server`** — [`pkg/github/ifc_labels.go:11-18`](https://github.com/github/github-mcp-server/blob/main/pkg/github/ifc_labels.go): "setIFCLabel writes the given IFC security label into a tool result's `_meta` under the `"ifc"` key"; `r.Meta["ifc"] = label`. |
| `_meta["com.github.ifc/labels"]` | **`microsoft/fides-gateway`** — `middleware.py:92`: `IFC_LABELS_META_PREFIX = "com.github.ifc/labels"`. This is the *gateway's* canonical namespace, despite the `com.github.` prefix. |
| `_meta["io.modelcontextprotocol/trust-annotations"]` | **`modelcontextprotocol/experimental-ext-tool-annotations`** — the extension identifier and `_meta` key in `specification/draft/trust-annotations.mdx`. |

#394 reads as though `github/github-mcp-server` emits the reverse-DNS
`com.github.ifc/labels` form. It does not — it writes the bare `ifc` key, the
same shape the FIDES developer guide describes. The reverse-DNS name is
Microsoft's, chosen for GitHub's labels but not used by GitHub.

The fragmentation claim survives, and there is direct evidence for it: the FIDES
gateway ships a prefix-remapping feature precisely because the two ends disagree,
documented at `middleware.py:364-373` — "interoperating with clients that speak a
shorter or different namespace than the gateway's canonical one — e.g. a client
that uses `"ifc/labels"` and `"ifc/policy"` while the gateway internally uses
`"com.github.ifc/labels"`". That is a *fourth* naming in the same file.

## Spot-check: the GitGuardian figures in #393

Checked because budget allowed. All four hold, verified directly against the
primary sources rather than secondary coverage.

| Claim | Verdict | Source |
|---|---|---|
| Internal repos ~6x more likely to hold secrets | **CONFIRMED** | [State of Secrets Sprawl 2026](https://blog.gitguardian.com/the-state-of-secrets-sprawl-2026/): "Internal repos are roughly 6× more likely than public ones to contain hardcoded secrets." |
| Claude Code-assisted commits 3.2% vs 1.5% baseline | **CONFIRMED** | same: "Claude Code-assisted commits showed a 3.2% secret-leak rate, versus a 1.5% baseline across all public GitHub commits." |
| 24,008 secrets in MCP config files | **CONFIRMED** | same: "we identified 24,008 unique secrets exposed in MCP-related configuration files across public GitHub, including 2,117 unique valid credentials." |
| MSR '23 dotfiles: 124,230 repos, 73.6% leaked | **CONFIRMED** | Jungwirth et al., *Connecting the .dotfiles*, MSR 2023: "We mined 124,230 public dotfiles repositories… 73.6 % of repositories leak potentially sensitive information." |

The GitGuardian figures are from the **2026** report, not a stale prior year.

## What is safe to make normative

**Use as-is.** Claims 1 (all parts), 2 (all parts), 5, 6a, 6b, 6c, 7, 8, 9, 10,
11a, 11b, 12, 13, 14, 15, and the #393 GitGuardian block. These trace to primary
sources with the quoted wording intact.

The load-bearing argument of #394 — keep whole-source labelling because a tool
result is one opaque payload and the only sound bound is the meet of every item's
label — is the best-sourced thing in the issue. `ifc.go`'s comment says it in
those words, the TrustNLP paper independently names mixed-content chunks as
untaggable, and Azure's two-level design is a real (if advisory) instance of the
same reasoning. That section can go into the spec unchanged.

**Fix before publishing.**

1. **Claim 11c is FALSE — change "38-person" to "131-person."** A wrong sample
   size in a spec's evidence section is the kind of error that discredits the
   surrounding argument. The 96.8% and the 4x both hold.
2. **Claim 4 must be rewritten.** Drop the fabricated quotation entirely. The
   defensible version: *the MCP trust-annotations extension draft narrowed
   SEP-1913's four-level `DataClass` to a single `sensitive` boolean on the wire,
   recovering richer classification through an out-of-band `evidenceRef` scheme;
   separately, review on issue #711 argued that any linear scale is the wrong
   shape, because a card number and a medical record are each sensitive to
   different readers.* Two facts, two citations, neither invented. #394's
   conclusion is unchanged.
3. **Claim 16 must re-attribute the middle format.** `github/github-mcp-server`
   emits `_meta["ifc"]`; `com.github.ifc/labels` is `microsoft/fides-gateway`'s
   namespace. The fragmentation point is strengthened, not weakened, by getting
   this right — cite the gateway's prefix-remapping shim as the evidence.

**Soften.**

4. **Claim 3.** Azure's response-level label is advisory metadata for client
   display and policy, and the doc hedges with "Typically, the most restrictive
   label wins." Enforcement is per-document exclusion. Say "also computes and
   returns" rather than "also returns … and enforces on that."
5. **Claim 6d.** 1.7s is the untrusted-issuer subtype (49%), not SSL warnings as
   a class; name/date errors are 2.2s/2.7s. Either qualify the subtype or drop
   the timing and keep the 70.2%.
6. **Claim 8.** Add "fixed 2026-07-09 in #6966." As written it implies a live
   defect. The argument — that approval paths are hard to get right — is better
   served by noting it took a dedicated hardening PR.
7. **Claim 10.** Flag that the inverted-U is a modelling result under an assumed
   fatiguing reviewer, per the paper's own caveat. #394's phrasing is already
   careful; keep it careful in the spec.
8. **Claim 6b.** Attribute to Microsoft's E7 engineering blog, not to academic
   literature. It is vendor telemetry, same category as the Anthropic 93%.

**One thing nobody checked that probably should be.** #394 asserts "As of Aug
2026, no mainstream agent product ships async approval for tool permissions —
everyone blocks or removes the human." That was not on the verification list and
is not sourced in the issue. It is a universal negative about a fast-moving
product space and is the weakest remaining claim by construction. Either source
it or soften it to a statement about the products actually surveyed.
