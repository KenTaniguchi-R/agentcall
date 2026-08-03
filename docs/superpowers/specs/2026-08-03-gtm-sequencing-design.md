# GTM sequencing and privacy positioning

> **Historical design record — not current documentation.** This file records the
> decision made for issue #22. Current product behavior lives in `README.md`, current
> data handling in `docs/security/`, and open work in GitHub Issues.

**Date:** 2026-08-03  
**Status:** Accepted product decision  
**Issue:** [#22](https://github.com/KenTaniguchi-R/agentcall/issues/22)

## Decision

Keep the initial buyer sequence from the demand research: start with non-EU,
non-unionized, 100–500-person engineering organizations. Do not make the first
pilot carry EU residency, works-council consultation, and regulated-enterprise
procurement at the same time that it is proving the core product value.

Keep the privacy architecture as the long-term differentiator, but narrow the
claim and change its role in the first sale:

- **Economic headline:** recover senior engineering time now spent answering
  repeat questions. Measure hours recovered and time to first useful answer.
- **Trust proof:** AgentCall does not retain a central corpus of call prompts and
  replies or index connected employee mail, chat, documents, and meetings into a
  persistent digital twin. It routes a request live to the employee's own agent
  and applies caller policy before the request enters that agent.
- **Current limitation:** do not say “we do not ingest employee data.” The hosted
  relay still processes plaintext call content and stores identity,
  relationship, policy, and audit metadata. Cards also centrally retain
  employee-authored descriptions, task catalogues, examples, and keywords;
  endpoint-local logs retain bounded prompt/reply excerpts. The exact
  no-call-corpus claim is true today; a stronger content-confidentiality claim
  is gated on #13.

The beachhead and the moat therefore do not need to be the same sentence. The
first segment optimizes for learning speed. The architecture preserves a path
to buyers for whom a centralized employee-knowledge corpus or persistent twin
is disqualifying.

## Segment sequence

### Phase 1 — prove value in a low-friction engineering team

Target non-EU, non-unionized engineering organizations with 100–500 employees.
This segment is a product inference from the adoption-cycle and interruption
evidence, not a directly observed conversion result. Run a bounded pilot in one
team. Lead with a concrete baseline and outcome: senior hours spent answering
repeat architecture questions, time to first useful answer, repeat-question
rate, and answer quality verified by the owner.

Every callee is a volunteer. Before setup, each receives the current
`docs/security/employee-transparency.md`, explicitly opts in, and can stop the
listener or withdraw from the pilot without manager approval. Non-unionized is
an adoption-sequencing choice, not permission to skip informed participation.

Before launch, the sponsor and pilot security owner sign one measurement
protocol that fixes:

- the repeat-question categories and measurement window;
- one observation per relay-minted call ID, with transport retries deduplicated;
- every admitted call in those categories as eligible, including refusals and
  failures after admission; pre-admission failures are excluded;
- one required owner rating per eligible call, with an absent rating counted as
  not useful rather than removed from the denominator;
- time to first useful answer starts at the first authenticated, in-scope caller
  attempt for a question and ends when the first reply later rated useful is
  delivered; pre-admission failures, admitted failures, and questions with no
  useful reply are reported rather than dropped, and the protocol fixes the
  aggregation statistic and no-result treatment before launch;
- the same named participants, weekly time-diary instrument, and question
  categories for baseline and pilot time measurement; and
- a written security-severity rubric, including what constitutes critical
  unauthorized disclosure or out-of-policy execution.

The protocol and exclusions cannot change after the first pilot call. Any
exception is reported separately and does not silently change the denominator.

Privacy is part of the security answer and competitive contrast, not a substitute
for measured value. A buyer who does not care about the no-corpus boundary should
still understand why the product pays for itself.

### Phase 2 — regulated non-EU expansion

Enter regulated or procurement-heavy accounts only after endpoint security,
organization policy, tenant-scoped audit export, retention/erasure behavior,
administrative identity, SSO, and bounded runtime authority are implemented and
can be demonstrated. Sell enforcement as the product foundation and evidence,
retention, export, SSO, and support as enterprise value only after each named
control ships. This is a packaging direction, not a committed price or edition
matrix.

### Phase 3 — coordinated EU offering

Treat an EU offering as a separate deployment and adoption profile, not a region
toggle. It requires all Phase 2 controls plus the data-residency adoption gate in
`docs/security/data-residency.md`, employee transparency, and customer-led legal,
privacy, and worker-representation review.

That ordering remains correct even when a particular AgentCall use is not
classified as high-risk under the EU AI Act. The Act requires workplace notice
for deployment of high-risk systems and links deployer duties to GDPR impact
assessment where applicable; German co-determination separately covers technical
systems intended to monitor employee behavior or performance. Product
architecture can make those reviews easier, but cannot remove them.

## Entry and exit gates

| Phase | Enter when | Advance when |
|---|---|---|
| 1 — low-friction pilot | A sponsor and pilot security owner are named; 3–10 volunteer callees record informed opt-in; a two-week repeat-question/time baseline exists; the eligibility, rating, missing-data, time-diary, exclusion, deduplication, and security-severity protocol above is signed before launch | After at least four weeks and 50 eligible questions: at least 70% are owner-rated useful, weekly senior time spent answering eligible repeat questions falls at least 20% from baseline, and zero critical unauthorized disclosure or out-of-policy execution occurs. AgentCall's product owner and the customer's pilot security owner jointly decide advancement. |
| 2 — regulated non-EU | The public/enterprise C-track gate (#1–#8), organization administration and SSO (#15/#102), tenant audit/export plus implemented retention/erasure (#17), bounded call/runtime budgets (#181), and the exact endpoint policy promised to the buyer are shipped and tested | A regulated design partner completes security and procurement review using deployed evidence, and the customer's security owner accepts the documented residual risks without roadmap controls being presented as current. |
| 3 — EU profile | A named EU sponsor approves an exact regional claim and funds a deployment plan; customer privacy and worker representatives approve the pilot process before employee enrollment | A new regional deployment passes every verification step in the living residency adoption gate; retention and transparency behavior are tested; customer legal and security owners approve the exact deployed claim. |

No calendar date substitutes for these gates. A named customer may change
priority, but it does not make an unimplemented control true.

## Messaging contract

Use:

> Recover the hours senior engineers lose re-answering architecture questions.
> AgentCall routes each question to the colleague's own agent, under that
> colleague's policy, without retaining a central corpus of call content or
> indexing connected mail, chat, and documents into an employee-knowledge twin.

Do not use:

- “We do not ingest employee data.”
- “EU compliant,” “GDPR compliant,” or a residency claim derived from a
  Cloudflare location hint.
- “Audit-ready” while tenant export, bounded retention, erasure, and delivery
  evidence remain unimplemented.
- token- or currency-budget claims when the product can bound only calls and
  agent runtime.

## Why the alternative loses

Starting in the EU because the privacy distinction is most valuable there would
combine three unknowns in the first sale: whether the workflow saves enough
time, whether employees accept it, and whether the deployment satisfies regional
and worker-governance requirements. A failed pilot would not reveal which
assumption was wrong.

Dropping the privacy distinction to simplify the first sale would push AgentCall
into the shared-corpus category it is structurally designed to avoid. The right
move is sequencing: prove economic value where deployment is lighter, while
building the controls required to take the same architecture into harder
accounts honestly.

## Revisit triggers

Revisit this sequence when any of these occurs:

1. a named EU design partner will sponsor the coordinated residency and
   worker-governance work rather than accept roadmap language;
2. three Phase 1 pilots show that no-corpus architecture materially improves
   conversion or shortens security review enough to outweigh the longer EU
   adoption cycle;
3. Phase 1 buyers consistently reject the product despite measured time savings
   because they need retained knowledge after employee departure; or
4. the hosted relay's confidentiality, residency, audit, and erasure contracts
   change enough that the messaging limitations above are stale.

## References

- [EU AI Act, Regulation (EU) 2024/1689](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=celex%3A32024R1689), especially Article 26 on deployer obligations and workplace notice
- [German Works Constitution Act §87](https://www.gesetze-im-internet.de/betrvg/__87.html) on co-determination for technical monitoring systems
- [Cloudflare Data Localization Suite](https://developers.cloudflare.com/data-localization/) and [Customer Metadata Boundary](https://developers.cloudflare.com/data-localization/metadata-boundary/), which are separate enterprise controls rather than defaults
- [Stack Overflow 2024 Professional Developers Survey](https://survey.stackoverflow.co/2024/professional-developers/) for the interruption baseline; the chosen company-size and regional beachhead remain an inference
- [AgentCall cloud data map and residency decision](../../security/data-residency.md)
- [Demand validation](../../research/2026-07-31-demand-validation.md) and [enterprise pivot research](../../research/2026-07-31-enterprise-pivot-research.md)
