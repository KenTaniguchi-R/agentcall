# Agent coordination landscape — competitive research

**Date:** 2026-07-31
**Question:** Who else is doing agent-to-agent coordination, and is anyone doing
what agentcall does?
**Method:** ~570 sources across 5 parallel Exa research agents, plus direct
verification of load-bearing claims. Confidence is tagged per finding.

---

## TL;DR

The market has organized into three layers — substrate, mesh/orchestration, and
identity/directory — and **all of them assume the agents are yours**, running as
services inside a perimeter you control.

The cross-*person* boundary (my agent calls your agent, on your laptop, across
the public internet, via a shareable human-readable address) has **exactly one
funded player** — Blockit, and only for calendars. No general-purpose product
occupies it as of end of July 2026.

Three things the research says to act on:

1. **The name.** `agentcall.co` is a live company in the same semantic space.
2. **A spend ceiling.** Agent unit economics is the #1 product killer; the
   callee-pays model is currently uncapped.
3. **Lead with the sandbox.** Inter-agent prompt injection is unsolved
   industry-wide — the Seatbelt work is a differentiator, not a caveat.

---

## Name collision (act on this)

**[agentcall.co](https://agentcall.co/)** — live product. Programmable phone
numbers for AI agents: voice, SMS, OTP extraction, AI voice generation,
cross-call memory, MCP server for Claude/Cursor/OpenClaw/Hermes. Different
product from ours, but uses the name "AgentCall" throughout and targets the same
"agents + calling" mental model.

*Confidence: high — fetched directly.*

---

## Tier 1 — closest to what agentcall is building

| | What | Traction | Confidence |
|---|---|---|---|
| **[Blockit](https://www.blockit.com)** | Two people's agents negotiate a meeting time directly with each other | $5M seed led by Sequoia (Jan 2026); founder Kais Khimji, ex-Sequoia partner; 200+ companies incl. Brex, Rogo; 100k+ meetings, zero humans in loop | High — [TechCrunch](https://techcrunch.com/2026/01/22/former-sequoia-partners-new-startup-uses-ai-to-negotiate-your-calendar-for-you/) |
| **[tiny.place](https://tiny.place)** | "Social economy for AI agents" — owned agent identities that discover and coordinate with other agents | Live; works across Claude/ChatGPT/Gemini | Medium — fetched, thin detail |
| **[AgentPhone](https://www.ycombinator.com/launches/QNE-agentphone-phone-numbers-for-ai-agents)** (YC P26) | One phone number per agent; unified API for voice/SMS/RCS/iMessage/WhatsApp | ~$500K seed Mar 2026; used by Google ADK team, Replit, LangChain, Alchemy | High — YC launch page |

**Blockit is the real signal.** It's the only funded company doing genuine
cross-person agent-to-agent delegation — your agent talks to my agent, neither
human in the loop. Narrow (calendars) and transported over email/Slack rather
than a dedicated relay, but a Sequoia partner left the firm to build it. The
category is considered real.

### Unverified — worth a manual look

Both 403'd on automated fetch:

- **`agentaddress.org`** — claims an "Agent Address Protocol" with
  `steve@agentaddress.org`-style addressing. If real, this is the closest thing
  to agentcall's addressing scheme found anywhere.
- **`agentd.link`** — claims `handle@agentd.link` email addresses for agents.

---

## Tier 2 — identity, addressing, directories

The "phone book for agents" layer, consolidating fast:

- **Identity** — Microsoft **Entra Agent ID**, Google Cloud Agent Identity, AWS
  Bedrock federation. All SPIFFE-compatible. Cloud vendors are taking this
  layer; pure-play startups are being squeezed.
- **Addressing** — DNS-first is winning. **AID** (Agent Identity & Discovery) is
  on the IETF RFC track; **ADP** (Agent Discovery Protocol) builds on it with
  WebSocket messaging. Cisco's competing ARDP is losing adoption.
- **Directories** — 17+ incompatible registries. Meta-layer "switchboards" are
  emerging to map across them: MIT [Project NANDA](https://nanda.mit.edu/) Index
  v2, and Cisco-led AGNTCY Agent Directory Service.
- **A2A** (Google → Linux Foundation, June 2025) — 150+ orgs, production
  deployments in supply chain, financial services, insurance, ITops. Agent Cards
  for capability discovery; task lifecycle over HTTP/JSON/SSE.

*Confidence: medium-high. Standards status verified; adoption claims come from
secondary sources.*

---

## Tier 3 — enterprise orchestration & mesh

### High confidence

| Name | Category | Scale signal |
|---|---|---|
| [Kong](https://konghq.com) | API → agent → event gateway ("Context Mesh") | $344M raised, $2B valuation |
| [Solo.io](https://solo.io) | AI gateway + agent runtime (agentgateway) | $171.5M, $1B valuation; Microsoft, Apple, Adobe, T-Mobile |
| [Solace](https://solace.com) | Event mesh + [Solace Agent Mesh](https://github.com/SolaceLabs/solace-agent-mesh) | ~$110M revenue, 300+ enterprises (RBC, Bosch, United) |
| [Gravitee](https://gravitee.io) | Federated API + event + agent management | ~$101M, 300+ orgs |
| Microsoft Agent Framework | Orchestration runtime (.NET/Python) | 41,000 production agents at EY; BASF 1,000+ |
| Google ADK | Agent framework + managed runtime | 800+ agents at GE Appliances; ADK 2.0 Mar 2026 |
| [CrewAI](https://crewai.com) | Multi-agent orchestration | 2B workflows executed; PwC, PepsiCo, J&J, US DoD |
| [AGNTCY](https://github.com/agntcy) | Discovery + identity + messaging; Linux Foundation (Cisco/Dell/Google/Oracle) | 65+ companies; Directory v1.4.0 |

Substrate layer: NATS, Kafka, Temporal, Istio. Independent protocol bets:
Coral Protocol, Cotal.

### Low confidence — do not cite

Reported by a subagent but sourced only from funding-aggregator sites, not
primary announcements: Norm AI $120M Series C, 8090 $135M Series A, Trase $107M
seed, Orkes $60M Series B. Directionally "large rounds are happening"; verify
any specific figure before use.

### Consolidation read

Leaders are vertically integrating API gateway → event mesh → agent
orchestration into a single stack. 77% of H1 2026 agentic funding went to Series
B+ rather than seed. Expect fragmentation into ~4-5 ecosystems (Microsoft,
Google, Solace/Solo, CNCF open protocols, independent OSS) rather than
winner-take-all.

---

## Specifically evaluated

### [Cotal](https://github.com/Cotal-Ai/Cotal)

Open standard + TS implementation for coordinating agents **you own**.
NATS/JetStream underneath; three addressing modes (multicast to channels,
unicast DM, anycast to a role queue); per-agent JWT creds with default-deny
ACLs; web dashboard; connectors for Claude Code/OpenCode/Hermes; runtimes via
pty/tmux/cmux. `cotal up` starts a local NATS + daemon. Apache-2.0, ~216 stars,
1.3k commits, active.

Their docs are explicit: no cross-org federation. Agents are yours, spawned
locally or on machines you manage. It's a **fleet mesh** — "Slack for my own
swarm."

| | Cotal | agentcall |
|---|---|---|
| Whose agents | yours | someone else's, on their Mac |
| Trust boundary | inside your perimeter | across a hostile boundary |
| Transport | NATS you deploy | hosted CF Worker relay, zero user infra |
| Identity | JWT creds you mint | `handle@host` registered with a relay |
| Sandbox | none between agents | Seatbelt, deny-read secrets, confined cwd |
| Shape | long-lived mesh, channels, presence | one-shot request/reply |
| Capability surface | topology config | task cards, `offer`/`allow`/`block` per caller |

**Worth borrowing:** anycast/role addressing; a machine-readable setup doc
(`Read https://docs.cotal.ai/prompt.md, then set up`) as a nicer version of the
CLAUDE.md snippet injection; durable delivery (they get store-and-forward free
from JetStream — our explicit v1 non-goal, and the first thing users will ask
for after "my Mac was asleep").

### [Omnigent](https://github.com/omnigent-ai/omnigent)

Databricks open-source "meta-harness," launched June 2026, Apache-2.0, ~7.9k
stars, alpha. Sits *above* coding agents (Claude Code, Codex, Cursor, Pi,
custom): one uniform sandboxed session regardless of harness; stateful policy
guardrails including **cost policies that pause a session at a spend threshold
and require human confirmation**; shared history; the same session exposed over
terminal / web / native app / mobile / REST. Deploys local, Modal, or Daytona.

Overlaps agentcall on OS-level sandboxing and remote session reach. Does not
overlap on trust boundary — everything it exposes is your session to you or your
team. Nothing about cross-org contact.

**Worth borrowing:** the spend-threshold-with-human-confirm pattern, directly
applicable to the callee-pays problem.

---

## What is not working (mid-2026)

Useful because these are the failure modes agentcall inherits or must dodge.

**Standards have not converged.** MCP vs A2A vs ACP vs ANP, and the
[IETF process is in scope fights, not consensus](https://forkast.news/ietf-bets-on-agent-interoperability-but-the-scope-fight-is-just-beginning/).
Betting on any single standard right now is premature. *(High confidence.)*

**Inter-agent prompt injection is unsolved industry-wide.** Microsoft published
[RCE vulnerabilities in agent frameworks](https://www.microsoft.com/en-us/security/blog/2026/05/07/prompts-become-shells-rce-vulnerabilities-ai-agent-frameworks/)
(May 2026) where untrusted data flowing through tools becomes shell commands.
Cross-agent injection benchmarks report 250+ attack cases across 8 taxonomy
categories with all four tested defenses failing to eliminate the threat.
*(High confidence on the Microsoft research; medium on the benchmark.)*

→ **Implication for us:** the residual risk documented in our README is the
industry norm, not a shortcut we took. Reframe the security section to lead with
the sandbox as a differentiator rather than apologize for what it doesn't cover.

**Unit economics kill agent products.** Multi-step agentic loops running $4+ per
task against $20/mo subscriptions. *(Medium confidence — sourced from
low-authority blogs; directionally right, specifics unverified.)*

→ **Implication for us:** "callee's own subscription pays for answering calls" is
uncapped. Needs a ceiling before any non-friends-scale exposure.

**Thin unification layers get commoditized.** TensorZero (11.7k GitHub stars,
$7.3M seed) archived itself in June 2026 after the model labs absorbed
observability, gateways, and evaluation natively and priced them at zero.
ClickHouse acquired Langfuse for $400M in January 2026. *(Medium confidence.)*

**Multi-agent systems fail silently in production.** Cascading failures where
one agent's error propagates without triggering alarms. *(Medium confidence —
arXiv + dev.to.)*

---

## Conclusion for agentcall

The gap is real and still open. Blockit proves cross-person agent delegation is
fundable; nobody is doing it general-purpose, and nobody is doing it against a
real person's machine with a real sandbox.

Priorities the research surfaced, in order:

1. Decide on the name (`agentcall.co` collision).
2. Add a spend ceiling — Omnigent's pause-at-threshold is the reference pattern.
3. Rewrite the security section to lead with the sandbox.
4. Consider store-and-forward sooner than v1.5 — it's the first thing users hit.

## Open threads

- Manually check `agentaddress.org` and `agentd.link` (both 403 to automated
  fetch). The former claims our exact addressing format.
- Verify the Tier 3 low-confidence funding figures before using any of them.
