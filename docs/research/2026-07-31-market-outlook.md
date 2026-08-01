# Market outlook — is this dying or growing?

**Date:** 2026-07-31
**Question:** What happens to this market over the next few years?
**Short answer:** Not dying. Every hard demand indicator is up. The threat is not
market size — it is platform absorption, and market growth does not protect against it.

Low-confidence figures have been pruned from this doc rather than included with
caveats. See [Source discipline](#source-discipline) for what was cut and why.

---

## The question has three different answers

Conflating these produces nonsense. They are separate markets moving in different
directions.

| Layer | Direction | Relevance to agentcall |
|---|---|---|
| Infrastructure / capex | **Peaking** | Low — affects sentiment, not our economics |
| Real demand (revenue, usage, retention) | **Up, no contradicting indicator** | High — validates the category |
| Inference pricing | **Deflating** | High — a direct tailwind |
| Our segment (internal knowledge/employee AI) | **Growing fast, proven** | High |
| **Platform absorption** | **The actual threat** | **Existential** |

---

## 1. Infrastructure — overbuilt, probably peaking

- Hyperscaler capex 2026: **$725B, +77% YoY**. UBS projects **+25% in 2027 and +6% in
  2028** — a cliff.
- Google raised 2026 capex $195B → $205B and **the stock fell 7%.** The market no
  longer rewards capex announcements, only ROI proof.
- Hyperscalers purchased $434B in property/equipment but booked only $149B
  depreciation. Fidelity flags this as a potential earnings bubble: current revenue
  reflects capex booked now; future earnings depend on utilisation materialising.
- Corporate bond cover ratios fell from ~5× (Feb 2026) to under 2× (July 2026).

**This is a real risk to the AI trade. It is not a risk to a small application-layer
product.** It matters to us only as sentiment — a capex correction makes enterprise
buyers more cost-conscious, which the next section shows is already happening.

## 2. Real demand — every indicator up

| Indicator | Value | Confidence |
|---|---|---|
| Anthropic annualised run rate | **$30B** (Apr 2026) | Reported — [VentureBeat](https://venturebeat.com/technology/anthropic-says-it-hit-a-30-billion-revenue-run-rate-after-crazy-80x-growth) |
| OpenAI annualised run rate | **$25B** (Feb 2026) | Reported — [Reuters](https://www.reuters.com/technology/openai-tops-25-billion-annualized-revenue-last-month-information-reports-2026-03-05/) |
| Net revenue retention, usage-based AI infra | **~108%** | Reported, weak source — directional only |
| AI engineering job postings | ~1,550/week, peaked 2,327 in June | Reported |

**NRR above 100% is the single most informative number here.** Customers are expanding
usage, not churning. Read alongside the 47% pilot-death rate in
[demand-validation](./2026-07-31-demand-validation.md): entry is brutal, but
deployments that survive expand.

**Counter-signal, and it is real:** enterprises are throttling. UBS found ~60% applying
spend guardrails (July 2026). EY (July 2026) found 82% concerned about token costs and
98% reconsidering their approach; 35% planned $10M+ AI spend and only 23% achieved it.
Palantir's Alex Karp: enterprises are "livid" about token costs delivering "no value."
Goldman Sachs (June 2026): no meaningful relationship between AI and productivity at
the economy-wide level.

**Resolution: this is rationalisation, not collapse.** Buyers are rejecting expensive
low-value token burn, not AI. Forecasters predicted $16B combined
OpenAI+Anthropic+xAI revenue by end-2025; the actual figure was $30.4B — a 2×
*under*estimate.

## 3. Pricing — volume up, unit price collapsing

Two sources appeared to contradict each other: one reported the Silicon Data token
*spend* index peaking in June 2026 and declining; another reported AI Gateway token
*volume* growing 29% month-over-month in the same period.

Both are true. The reconciling figure: **Chinese open-weight models took ~46% of token
volume but only ~5% of spend.**

Usage is growing while unit prices deflate. Bad for anyone selling tokens. **Good for
anyone consuming them** — which is us. The per-answer cost of a colleague Q&A falls
over time on its own. This does not remove the need for a spend ceiling, but it means
the economics improve rather than degrade.

## 4. Our segment — growing, and proven by a real company

**Glean** (confirmed — [TechCrunch](https://techcrunch.com/2026/05/28/gleans-top-line-crosses-300m-as-ai-budget-cutting-becomes-its-major-selling-point/)
and [Glean's own release](https://www.glean.com/press/glean-surpasses-300m-arr-unrivaled-enterprise-context-fuels-ai-adoption)):

| | |
|---|---|
| ARR | $100M (early 2025) → $200M (Dec 2025) → **$300M (May 2026)** |
| Growth | **Tripled in 15 months** |
| Valuation | $7.2B (~24× ARR), from a $150M Series F in June 2025 |
| Customers | Fortune 500 count nearly doubled YoY; 85% deploy across 5+ departments |

*Caveat Glean states themselves: consumption-based pricing, so this is an annualised
run rate rather than contracted ARR.*

Supporting: AI knowledge management rose from **14th to 5th** among CIO technology
investment priorities between 2024 and 2026; 47% of large enterprises have deployed or
are piloting AI enterprise search, up from 18% in 2023 (Gartner).

**Note what drives Glean's growth: "AI budget cutting" as the selling point** —
consolidating tool sprawl. The cost pressure in §2 is a *tailwind* for products that
can position as consolidation.

---

## 5. The actual threat: platform absorption

Market growth does not protect against this. Glean's own numbers prove the segment is
valuable; they do not prove the standalone category survives.

**All of the following are announced and shipping, not roadmap speculation:**

| Platform | Move | Timing |
|---|---|---|
| **Microsoft** | Copilot Enhanced Memory (persistent, work-data-scoped) | **GA Nov 2026** |
| Microsoft | Copilot Cowork (delegated work) GA; Work IQ semantic layer | Jun 2026 |
| **Slack / Salesforce** | **Slackbot rebuilt as a native employee agent; MCP + A2A support** | Shipping |
| Anthropic | Claude Managed Agents Memory API | Public beta, Apr 2026 |
| OpenAI | Workspace Agents with memory and tool access | Shipping |
| Google | Gemini Enterprise + Agentspace | Shipping |

Salesforce reports 86% of its own employees using Agentforce in Slack after six months.

### Precedent

- **Jasper**: $120M ARR (2023) → forecast $55M (2024) after Microsoft bundled writing
  assistance natively into 365. **Under 18 months.**
- **Salesforce acquired Fin (formerly Intercom) for $3.6B** (June 2026 — confirmed via
  [Salesforce IR](https://investor.salesforce.com/news/news-details/2026/Salesforce-Signs-Definitive-Agreement-to-Acquire-Fin/default.aspx),
  [CNBC](https://www.cnbc.com/2026/06/15/salesforce-ai-customer-service-fin-acquistion.html)).
  Fin's purpose-built model resolved ~76% of support volume autonomously, beating
  Agentforce. The lesson: incumbents will pay ~9× ARR rather than wait to build.
- Even Glean trades at a discount on the secondary market versus its official
  valuation, with declining volume — investors are already pricing absorption risk into
  a company growing 89% YoY.

### The survival criterion

Zoom survived Teams bundling. Grammarly survives Word. Jasper did not.

The distinction is **workflow-shaped vs. feature-shaped**. Coexistence works when the
product owns a workflow the platform cannot casually replicate. It fails when the
product is a feature the platform can bundle.

---

## 6. What this means for the Q&A-first decision

This is the uncomfortable part, and it revises the reasoning in
[enterprise-pivot-research §5](./2026-07-31-enterprise-pivot-research.md).

**"Ask a colleague's agent" as pure Q&A is feature-shaped.** Slack is rebuilding
Slackbot as a native employee agent with A2A support. That is the same shape. This is
the Jasper configuration.

**The execution version is workflow-shaped** — an agent on the callee's machine, doing
work in their environment, with per-caller policy and an audit trail. That requires
per-employee installation and a permission model, which a platform cannot bundle
casually.

Neither invalidates Q&A-first. The cost environment in §3 genuinely favours cheap Q&A
over $4-per-task agentic loops, and Q&A ships faster. But:

- **Q&A as a wedge that reaches something workflow-shaped inside ~12–18 months** is a
  viable plan.
- **Q&A as the destination** ends in bundling.

The window is set by Microsoft's November 2026 memory GA and Slack's employee-agent
rollout, not by our roadmap.

---

## 7. On analyst forecasts

For reference, all revised **upward** during 2026; no major firm lowered AI agent
forecasts:

| Firm | Metric | Figure |
|---|---|---|
| Gartner | Agentic AI software spend | $376B (2027, +82%); $753B (2029) |
| IDC | Agentic AI IT spend | $1.3T by 2029 (~26% of all IT) |
| McKinsey | US economic **value** (not spend — do not compare) | $2.9T by 2030 |
| Forrester | Enterprises with meaningful production deployment | **under 15%** (2026) |

**Do not lean on these.** A scoring of 160 published AI predictions found average
accuracy of 0.60 — with capability predictions at 0.87 but **timeline and market
predictions at 0.42**, worse than a coin flip. Gartner simultaneously forecasts the
spending above *and* warns that 40%+ of agentic AI projects will be cancelled by
end-2027, without netting the cancellations out of the headline number.

Glean's $300M and Salesforce's $3.6B cheque carry more information than any 2029
projection.

---

## Conclusion

- **Not dying.** Every hard demand indicator points up, with no contradicting signal.
- **Infrastructure may be overbuilt** — a risk to the AI trade, not to us.
- **Falling inference prices are a tailwind**, since we consume tokens rather than sell
  them.
- **The segment is proven** by a company that tripled to $300M ARR in 15 months.
- **Platform absorption is the only existential threat, and growth does not help.**
  The window for an independent is roughly 12–18 months.
- **Q&A alone is the most absorbable configuration.** It works as a wedge, not as a
  destination.

---

## Source discipline

**Trusted and used:** Reuters, VentureBeat, TechCrunch, CNBC, Salesforce investor
relations, Glean press, Gartner, IDC, McKinsey, Forrester, UBS via Reuters, Fidelity,
EY, Goldman Sachs, Microsoft/Anthropic/OpenAI/Slack product announcements.

**Cut from this doc entirely** — report-mill CAGR projections (Mordor Intelligence and
similar $4k-PDF vendors with no published methodology); an aggregator's "168 shutdowns,
$60.7B destroyed" figure; claimed Claude Code market share and ARR figures sourced only
to SEO aggregators; GitHub Copilot seat counts and the "+483% enterprise AI budget"
figure, which trace to the same aggregator network.

**Kept but marked directional only:** the ~108% NRR figure and job-posting volumes —
the direction is corroborated across sources, the precise values are not reliable.
