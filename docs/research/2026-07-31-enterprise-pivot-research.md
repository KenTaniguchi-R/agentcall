# Enterprise pivot — research and design rationale

**Date:** 2026-07-31
**Status:** Research complete. No implementation decision made.
**Companion doc:** [2026-07-31-agent-coordination-landscape.md](./2026-07-31-agent-coordination-landscape.md)
(broad market map). This doc covers the enterprise in-network pivot specifically.

> **Amended 2026-08-03.** The “we don't ingest your data” line below is too broad.
> The hosted relay processes plaintext calls and persists metadata plus authored card
> content. The accepted distinction is no retained central corpus of call content and
> no indexing of connected mail, chat, and documents into a persistent employee twin.
> See the [GTM sequencing decision](../superpowers/specs/2026-08-03-gtm-sequencing-design.md).

---

## The proposed direction

Move agentcall from public person-to-person calling to **enterprise in-network**:

- Employees install it on top of the agent they already use (Claude, ChatGPT)
- Each person connects their own tools
- Any employee can ask another employee's agent
- IT (and the individual) control what a *calling* employee is allowed to do on the
  agent they call

**Value proposition, in the owner's words:** *"a replacement of some communication
that A and B used to do on Slack or face to face. A's agent might not have the same
context as B's agent because of memory. A's agent might be able to, but it would be
much more efficient if the task is about B's."*

The unit of value is **the Slack message A didn't have to send.** Interrupt
reduction, with context asymmetry as the mechanism.

**Two decisions already made by the owner:**

1. **Drop the sandbox.** In enterprise, the answering agent should be the employee's
   own working agent — which already has their context. The current design (fresh
   sandboxed spawn confined to `~/AgentCall/public`) is incompatible with that and
   gets discarded.
2. **Q&A first, not execution.** Defer task execution entirely.

Architecture, transport, and relay are all open to complete redesign in service of UX.

---

## 1. The direct competitor: Viven

**[Viven](https://viven.ai)** — $35M seed (Oct 2025, Khosla Ventures, Foundation
Capital, FPV Ventures, Operator Collective). Founded by Ashutosh Garg and Varun
Kacholia, co-founders of Eightfold AI ($2.1B). Incubated at Eightfold. SF/Santa Clara.

Builds a "Human Digital Twin" per employee. *"Colleagues, clients, and beyond can
chat with your Twin anytime – no scheduling, no waiting."*

**Sources:** Gmail/Outlook, Slack, Teams, Box/OneDrive/SharePoint, Jira, Confluence,
Salesforce, GitHub, Zoom/Meet/Webex.
**Deployment:** SaaS / VPC / On-Prem.
**Model:** per-seat + instance licensing, demo-led sales, no public pricing, no free tier.
**Customers (from press releases — discount accordingly):** Genpact (deployed to
global leadership in 8 weeks; claims "50% faster onboarding"), Josh Bersin Company,
Prodapt, Eightfold, RedCrackle.

### How Viven handles consent and control

**No approval gate.** Their primary safeguard is query transparency. Per CEO Garg:
*"Everyone can see the query history of their digital twin, which acts as a
deterrent against people asking inappropriate questions."* The employee sees who
asked what.

Topic restriction is model-side — *"pairwise context and privacy"*, an LLM trained
to recognise questions about personal life and decline. *"You can't ask about
someone's spouse, medical condition, or income, even though they might have some
emails about those things."*

Correction is **post-hoc**: their own CFO example has the person receiving a report
of the chat and correcting details afterward. There is no documented workflow that
prevents a wrong answer being served before correction.

### Viven's three structural weaknesses

**(a) The index is always 1–3 days stale.** Their privacy policy states raw Google
data is converted to derived metadata *"within 24–72 hours."* The "continuous
learning" claim does not close this window.

**(b) Privacy enforcement is LLM judgment, not a technical boundary.** Pairwise
privacy depends on model fine-tuning deciding what to refuse. That is a policy
problem solved with a probabilistic tool — vulnerable to prompt injection and
jailbreaking. No published hard-redaction-before-the-model fallback.

**(c) Post-employment persistence is unresolved.** [Addington Law
(2026-07-02)](https://addingtonlaw.com) flags: can the employer keep using a twin
after the person resigns or joins a competitor? Who owns the accumulated knowledge?
Plus discrimination risk if twins influence hiring/promotion/discipline, works
council and union bargaining obligations, disclosure duties if a customer thinks
they're talking to the person, and Illinois BIPA class-action exposure.

Other criticism: Constellation Research's Holger Mueller on full-autonomy risk;
diginomica calling it *"slightly creepy... people getting answers to questions they
would not ask in person."*

### Why agentcall is not the same product

Viven is a **knowledge twin** — it indexes what you wrote and answers as you. Every
integration on their list is a read surface for RAG.

agentcall's proposed model is **live routing** — the question goes to the person's
actual running agent, which already has the context. No index, no data copy.

That difference produces four advantages, each of which maps onto one of Viven's
weaknesses:

| | Viven | agentcall (proposed) |
|---|---|---|
| Freshness | 24–72h lag | Real-time |
| Data location | Indexed copy in Viven | No copy; stays in the employee's environment |
| Privacy enforcement | LLM judgment | Code, resolved pre-prompt |
| Employee departs | Twin persists (legally unresolved) | Agent leaves with the person |
| Availability | 24/7 cloud | Unsolved — see §3 |
| Funding / customers | $35M, named logos | None |

**"We don't ingest your data"** is the sales line. It is also true, which is rarer.

---

## 2. Approval model

**The tension:** if the owner must approve every answer, the product no longer saves
them from interruption. It becomes Slack with extra steps.

### Evidence on approval fatigue

- **Over-granting under load.** Users overwhelmed by permission prompts exhibit
  "privacy fatigue" and over-grant. Yet Claude, ChatGPT, and Codex all default to
  user-in-the-loop for nearly every action —
  [Michael & Roesner, 2026](https://arxiv.org/html/2607.13718)
- **Approval becomes reflex.** Confirmation bias drives 60.7% higher under-reliance
  when the AI agrees with the user's initial answer; prompts get confirmed rather
  than read — [Gor et al., ACL 2026](https://aclanthology.org/2026.findings-acl.422.pdf)
- **Adoption ≠ trust.** 87% of businesses use AI in email workflows; only 6% qualify
  as high performers.

**Implication:** per-answer approval is not just bad for the value prop, it is
*worse for security* — people stop reading and click through.

### The resolving pattern: autonomy is per-task, not global

From [Tianpan (2026)](https://tianpan.co/blog/2026-05-02-autonomy-toggle-user-setting-not-model-setting):
treating autonomy as a global setting collapses fundamentally different risk
profiles. Inbox triage can auto-send; invoice payment cannot.

This maps directly onto agentcall's existing model. `policy.callers[from] = { offer,
block }` already scopes *what* a caller may ask. Adding an autonomy level makes it a
function of **(task × caller)**:

| Asker / topic | Autonomy |
|---|---|
| Teammate → spec or past-decision question | Auto-answer, post-hoc digest |
| Other department → same question | Draft, owner approves before send |
| Anyone → sensitive topic | Refuse and escalate to the human |

**The four-tier vocabulary** in common use:

1. **Show me** — suggest only, take no action
2. **Ask me** — prepare, wait for approval each time
3. **Do it and show me** — execute, surface an immediately-revocable receipt
4. **Do it and tell me later** — execute, batch into a periodic digest

Tiers 3 and 4 are where this product lives. Choosing tier 2 makes it Slack again.

### Recommendation

1. **Draft-only for the first two weeks**, all features, as an explicit trust-building
   period — the owner reviews ~50 answers before autonomy opens up
2. **Autonomy per task, never global**
3. **Post-hoc digest, not pre-approval** — "5 questions your agent answered today"
   compresses the interruption to once daily
4. **Attach confidence, rationale, and sources to every answer** so post-hoc review
   takes 30 seconds rather than being a vague skim
5. **Query-history transparency** as the social control — Viven's approach, and it is
   consistent with the fatigue evidence

Note: the vendor blogs cited by the research pass (cxassist, aidevelopia,
answeringagent, catchagent) are small SEO-oriented sites. The academic citations
above are the load-bearing ones.

---

## 3. Availability — the only axis where Viven wins

Viven's twins are cloud-hosted and always on. A laptop-resident agent is not.
This matters more than it did for the consumer product, because "ask the agent
instead of pinging the human" is worthless precisely when the human is unavailable.

### Recommended pattern: durable mailbox + presence + human escalation

```
Colleague asks a question
    ↓
Central relay inbox (always-on, SQLite, durable)
    ↓
Agent on the laptop subscribes / polls when awake
    ↓
Colleagues see live presence: online / offline (last seen 3h ago)
    ↓
Online  → answered promptly
Offline beyond threshold → escalate to Slack channel or on-call human
```

**This is a protocol change: from a synchronous *call* to an asynchronous *letter*.**
Today a call fails if the callee isn't there. A mailbox never loses the question.

Why this pattern:

- The relay is always on, so reachability does not depend on the laptop
- Pull-based, so no thundering herd
- The mailbox is the single source of truth — duplicated or dropped wake events
  never lose a message
- Audit trail is structural, consistent with the existing `calls.log` design

**Prior art worth reading:**

- **Aerial** (GitHub: dcdeniz) — Unix-socket daemon, MCP adapter, transcript history,
  local and server modes
- **Agent Relay** (GitHub: hazzap123) — offline-first queuing, A2A-aligned, SQLite,
  MCP-native, Tailscale-friendly. Closest to agentcall's transport layer.

**Build cost:** mailbox daemon ~2–3 weeks; presence ~1 week (less with a managed
pub/sub).

### Patterns explicitly rejected for this use case

Memory-resident self-scheduling agents and wake-watchdog/subprocess-recovery designs
solve *device autonomy*, not *reachability by others*. Wrong layer — the problem
needs a relay, not a more independent laptop.

### UX position

Do not promise 24/7. Let the asker choose:

> **Tanaka's agent is offline** (last seen 3h ago)
> [ Queue the question ] [ Message Tanaka directly ]

Honest, and still a large reduction in interrupt traffic.

---

## 4. Inbound authorization — the layer the owner actually meant

"How much access does another person's agent get on my agent" is **inbound**
authorization. This is distinct from the outbound governance market (basecode,
Unbound, Singulr, Docker AI Governance — those govern *your* agent's access to *your*
systems, and none of them do agent-to-agent anything).

**This exists, and AWS shipped it last month.**

[AWS Cedar multi-agent authorization](https://aws.amazon.com/blogs/security/enforce-least-privilege-authorization-in-multi-agent-ai-chains-using-cedar/)
(2026-07-06) models the receiving agent as an **Agent entity, not a tool**:

- **Layer 2** is exactly this problem — *"whether requested tasks are a subset of the
  target agent's registered capabilities"*
- Delegation depth limits: per-pair caps plus a system-wide hard limit of 5 hops
- **Layer 3** separately validates the originating human's role and MFA

Read that next to `resolveTask()`: caller → permitted task subset, resolved before
the message is trusted. **AWS independently arrived at the same policy model.** The
design is validated; the concept is not ownable.

Supporting layer:

| | What | Maturity |
|---|---|---|
| A2A v1.0.0 §13.1 | Capability-scoped access in-protocol | Stable, Linux Foundation |
| OpenID AuthZEN AARP + COAZ | Approval/consent/delegation prerequisites; PDP before tool execution | WG drafts, Jun 2026 |
| RFC 8693 / 8707 | Delegation chains (`act` claim), audience binding | Stable RFCs |
| Solo.io agentgateway | Caller auth to an agent runtime + CEL/OPA/OpenFGA policy | Shipping, May 2026 |
| IETF agent-delegation drafts | Multi-hop semantics | Drafts; none at RFC, one expired |

### What survives

All of the above enforce at a **gateway outside the agent process** — deliberately,
because in-process checks fail under prompt injection.

agentcall's `resolveTask()` occupies a third position: the decision is made outside
the agent (pre-spawn, pre-prompt) without requiring a network gateway. Combined with
the CaMeL invariant — the caller's message cannot influence which task is selected —
this is a *technical* boundary where Viven has *model judgment*.

**With the sandbox dropped, this becomes the primary security control rather than
defence-in-depth. It should not also be dropped.**

### The residual risk to state plainly in any security review

Prompt injection is indifferent to employment status. If A pastes untrusted content
(a customer email, a scraped page) into a question, B's agent processes it with B's
full access — a lateral-movement path. "We trust our employees" is not an answer.
The answer is capability scoping: if B's agent only exposes three defined Q&A
capabilities to A, an injection cannot exceed those three.

---

## 5. Design decisions arising from this research

1. **Q&A first, positioned as live routing rather than indexing.** Same category as
   Viven, different architecture, and the difference is defensible on freshness, data
   residency, and departure semantics.

   > **Amended by later research** — see
   > [market-outlook §6](./2026-07-31-market-outlook.md#6-what-this-means-for-the-qa-first-decision).
   > Pure Q&A is *feature-shaped* and therefore the most absorbable configuration:
   > Slack is shipping a rebuilt Slackbot as a native employee agent with A2A support,
   > and Microsoft's Copilot persistent memory reaches GA in November 2026. Jasper went
   > from $120M to a forecast $55M in under 18 months on exactly this dynamic. Q&A
   > remains valid as a *wedge* toward something workflow-shaped; it is not viable as a
   > destination.
2. **Synchronous call → asynchronous mailbox**, with presence and human fallback.
3. **No approval gate.** Autonomy per (task × caller), post-hoc digest, query-history
   transparency. The fatigue research and Viven's shipped design independently reach
   the same conclusion.
4. **Keep `resolveTask()` and the pre-prompt policy resolution.** With the OS sandbox
   gone, this is the security story.

## 6. Open questions not answered by research

- Buyer: bottom-up engineering adoption vs. top-down IT purchase
- Pricing (anchor: Microsoft Agent 365 at $15/user/mo establishes the budget line)
- Whether the agent-side integration is a plugin/MCP server living inside the
  employee's existing session, or a spawn against their real config
- Multi-turn vs. single exchange
- Whether the name changes (`agentcall.co` collision — see companion doc)
- Cross-platform: dropping the Seatbelt sandbox removes the macOS-only constraint,
  which is a prerequisite for most enterprise deals

## Research provenance

Six Exa research passes plus direct verification of load-bearing claims (viven.ai,
the AWS Cedar post, Solo.io agentgateway, basecode.cloud, getunbound.ai, agentcall.co).
Primary sources and academic citations are marked; vendor-blog and
funding-aggregator claims are flagged as low confidence where used.
