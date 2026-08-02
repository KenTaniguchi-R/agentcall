# Demand validation — does anyone pay for this?

**Date:** 2026-07-31
**Question:** Is "reducing internal interruptions" a real, paid-for pain? What is the
actual state of enterprise agent adoption, and what stops deals?
**Companion docs:** [agent-coordination-landscape](./2026-07-31-agent-coordination-landscape.md)
(market map) · [enterprise-pivot-research](./2026-07-31-enterprise-pivot-research.md)
(competitor and design rationale)

> **Amended 2026-08-02.** MCP Tunnels now owns the simple “reach an agent behind a
> firewall” sentence. The open position is narrower: governed, person-scoped delegation
> to the callee's own agent, with caller-specific pre-prompt policy and audit evidence.
> See [the MCP positioning decision](../superpowers/specs/2026-08-02-mcp-positioning-design.md).

---

## Verdict

**Painkiller, not vitamin — but the go-to-market is harder than the technology.**

- The pain is documented and quantified; the defensible position is governed,
  person-scoped delegation, not private-network reachability
- agentcall's architecture is structurally advantaged on the legal/privacy axis, which
  turns out to matter more than expected
- Enterprise agent selling is brutal: 47% of pilots die, 17-month pilot stagnation,
  79% purchase regret
- The #1 ranked manager pain (knowledge loss on departure) is one this architecture
  **cannot** solve. Target #2 instead.

---

## 1. The pain is real and quantified

| Metric | Number | Source |
|---|---|---|
| Developers spending 30+ min/day answering colleagues' questions | **47%** (~25% spend over an hour) | [Stack Overflow 2024](https://survey.stackoverflow.co/2024/professional-developers/) |
| Time on searching for and answering code questions (100+ eng orgs) | **5–10 hrs/week** (~10% of the week) | State of Developer Knowledge Sharing |
| Managers' #2 ranked challenge | **"People with the knowledge spend too much time answering questions" — 43%** | ibid |
| Managers' #1 ranked challenge | Knowledge loss on departure — 45% | ibid |
| 3,000-person org spend on re-answering identical questions | 450,000 hrs/year ≈ **216 FTE** | Starmind (vendor, n=1,404) |

Managers systematically underestimate it: they report 4.7 hrs/week, developers
self-report 5+.

Interruption cost research (Gloria Mark, CHI) shows interrupted workers complete tasks
in similar time but with significantly higher stress, frustration, time pressure and
effort — the speed-up is real but unsustainable.

### Nobody owns the governed-delegation position

No product has become synonymous with interruption reduction the way Slack owns async
communication. The closest proof point is Slack/TOYOTA L&F (5,618 hrs/year saved), but
that is a byproduct of async workflow, not a product sold on unblocking colleagues.

### Positioning matters more than the feature

The research conclusion, verbatim in spirit:

> "Reduce interruptions" is abstract and does not sell.
> **"Recover the 5 hours/week your architects waste explaining architecture"** is
> concrete and does.

**Metrics buyers accept, in order:**
1. Hours of senior time recovered per week (time-diary data from a pilot team)
2. Time to first useful answer
3. Bus-factor remediation
4. Repeat-question rate

Vendor ROI calculators are treated as circular and distrusted. Bring time-diary data.

---

## 2. Enterprise adoption reality

| | |
|---|---|
| Enterprises scaling agentic AI anywhere | **23%**; under **10%** at true production scale at function level (McKinsey, n=2,000, 105 countries) |
| AI initiatives stuck in pilot | **82%** (73% in 2024) |
| Pilots killed before production | **47%** (38% in 2024) |
| Average stagnation for stuck pilots | **17 months** |
| Gartner forecast | **40%** of agentic AI projects cancelled by end-2027 |
| Gartner on purchasing | **79%** of AI tech purchase decisions end in regret |
| Enterprises with mature governance for autonomous agents | **21%** (Deloitte, n=3,235) |

**Pricing anchor:** median enterprise GenAI spend is **$26/employee/month** (top
quartile $46, bottom quartile $14). Microsoft Agent 365 lists at $15/user/mo.
Realistic target band: **$5–15/user/month**.

**Named blockers:** legacy integration, data readiness (Gartner expects 60% of agentic
projects to fail on AI-ready data alone), undefined process ("organizations deploy
agents without defining what they're replacing"), governance gaps, CISO approval —
where the most common failure is declared permissions not matching observed behaviour.

GitLab's CIO, on procurement: 6–12 month RFP cycles produce decisions based on
12-month-old data.

---

## 3. The employee and labour-law dimension — the underrated risk

This is the part that most threatens a per-employee agent product, and it is not
technical.

**Documented incidents:**

- **Politico** deployed AI reporting tools without union consent. NewsGuild-CWA forced
  arbitration; **management removed the tools.** The guild now holds 85–90 contracts
  with explicit AI provisions (July 2026).
  [Axios](https://www.axios.com/2026/07/26/union-contracts-ai-workplace-disruption)
- **Salesforce** (May 2026) — Benioff disclosed using AI to analyse employee Slack
  messages to determine "what employees are upset about." Sparked broad surveillance
  backlash even after clarifying it scanned only public channels.
- **Kaiser Permanente** (2025) negotiated the first comprehensive AI labour agreement,
  with a joint National AI Task Force — the template for how this gets done properly.
  [MIT Sloan](https://mitsloan.mit.edu/sites/default/files/2026-07/Negotiating-Partnership-KP-Alliance-AI.2026.pdf)

**Employee resistance is a primary failure mode.** HBS (Narayandas): ~30% of generative
AI projects are quietly abandoned because employees resist — not because tools fail.
Three identity threats: role compression, control shift, span erosion. A Finnish study
of 33 knowledge workers found that when employees know prompts are logged they
self-censor, optimising for appearance over honest exploration.

**EU works councils hold veto power.** Germany (BetrVG §87), Netherlands (WOR Art. 27),
France (CSE) grant statutory co-determination over systems that monitor or evaluate
employee behaviour or performance. Without consent, a works council can compel
deactivation through the labour courts.

> **EU rollout: 6–18 months. US rollout: 6–8 weeks.**

GDPR Article 35 DPIA and EU AI Act Article 26 deployer obligations run in parallel —
6–9 months as one integrated workstream if done competently.

---

## 4. Why this is a tailwind for agentcall's architecture

**[Viven](https://viven.ai)** is the direct competitor — $35M seed, Eightfold founders,
building a per-employee knowledge twin. Full introduction in
[enterprise-pivot-research §1](./2026-07-31-enterprise-pivot-research.md#1-the-direct-competitor-viven).

Their model — ingest email, Slack, and Docs into a per-employee twin — is close to
the worst possible shape for a works council. Live routing is a materially easier
conversation:

| Works council concern | Viven | agentcall (live routing) |
|---|---|---|
| Employee data ingestion | Full index of mail/chat/docs | **None** |
| Creation of a "data double" | A twin is built | **It is the person's own agent** |
| Employee control | Admin + user settings | **Owner grants per caller** |
| After departure | Twin persists (legally unresolved) | **Leaves with the person** |
| Repurposing for surveillance | Technically feasible | **No index to repurpose** |

**"We do not ingest your employees' data"** is a sentence that works in a security
review *and* in a works council negotiation. In the EU that difference is plausibly
worth 6–12 months of deployment timeline.

---

## 5. The trade-off to state honestly

Managers' **#1** ranked challenge is knowledge loss on departure (45%).

**This architecture cannot solve it.** The agent leaves with the person; nothing is
retained. That is Viven's territory, and it is the direct cost of the privacy
advantage above — the same property produces both.

- **Viven:** strong on knowledge retention / bus factor. High legal exposure.
- **agentcall:** strong on in-employment interrupt reduction. Low legal exposure.

Chasing #1 means entering the same legal minefield. Targeting **#2 (43%)** is
consistent with the architecture rather than fighting it.

---

## 6. How people actually use agents today (context)

| | |
|---|---|
| Developers using agents at work | **59%**, up from 31% in 2025 ([Stack Overflow Pulse](https://stackoverflow.blog/2026/05/27/agents-on-a-leash-agentic-ai-remains-mostly-single-agent-and-monitored-at-work/), n=1,100) |
| Running 2+ agent tools regularly | 73% |
| **Rarely or never let agents run on autopilot** | **63%** |
| Prefer single-agent setups | 68% |
| Trust in AI accuracy | fell **40% → 29%** ([Stack Overflow 2025](https://survey.stackoverflow.co/2025/ai), n=49,000) |
| Do not fully trust AI code is correct | **96%**; only **48%** always verify before committing ([Sonar](https://www.sonarsource.com/state-of-code-developer-survey-report.pdf), n=1,149) |
| Weekly hours reviewing AI-generated code | **11.4 hrs**, +31% YoY — the single largest time sink |
| Expect to use agents vs. have a secure way to | **65% vs 33%** ([1Password](https://1password.com/blog/survey-ai-agent-adoption-is-outpacing-governance), n=1,000) |

**Two implications:**

1. **The autopilot number (63%) tensions with the "no approval gate" recommendation** in
   the pivot doc. Both hold: per-answer approval fails (fatigue research), *and* blanket
   day-one autonomy is rejected. The resolution is the graduated ramp — draft-only for
   two weeks, then per-task autonomy. Note the 63% concerns agents *changing code*;
   read-only Q&A for a colleague is materially lower stakes.
2. **Trust is falling, not rising.** Attaching confidence, rationale, and sources to
   every answer is mandatory, not a nice-to-have.

The 65%/33% gap is the sales opening: demand for agents exceeds safe ways to run them
by 32 points.

---

## 7. What this implies for sequencing

The data points away from a frontal enterprise assault and toward:

- **Start where the legal process is light** — outside the EU, non-unionised,
  100–500-person engineering orgs
- **Instrument from day one** — time-diary measurement in the pilot team, because that
  is the evidence buyers accept
- **Lead with senior-time recovery**, not interruption reduction
- **Price in the $5–15/user/month band**

## Source quality

Trustworthy: McKinsey, Gartner, Deloitte, Pew, HBS, Microsoft, BCG, Stack Overflow,
JetBrains, Sonar, 1Password, MIT Sloan, Gloria Mark (CHI).
Discount: Prosigns, SMF Clearinghouse, VendorBenchmark, Contentstack, Starmind,
Internode, Digital Applied, Ivern, agentmodeai — small samples, vendor-sponsored, or
undisclosed methodology. Anthropic's State of AI Agents report is vendor-published.
