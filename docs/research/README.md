# Research

The [reference implementation index](./reference-implementations.md) is living,
current design guidance for enterprise, security, and A2A work. Update it when a
reference or its adoption changes.

The dated files below are market and competitive research for agentcall. **They
are research notes, not decisions.** No implementation follows from them without
a separate call.

Docs #1–6 date from 2026-07-31 and were produced together; read them as one body of
work rather than six independent studies. #7 is a later addition and the first of the
two that carry a backlog; #10 is the other. #8 records the protocol and positioning implications of MCP
tunnels and Enterprise-Managed Authorization. #9 is the exception to the
"not decisions" rule above — an approved decision followed it the same day, and it
carries a forward amendment saying which of its recommendations that decision
rejected. #10 asks the build-or-buy question the other nine leave implicit.

## Reading order

A qualifying sequence — is there a pain, is there a market, is the position open, what
do we build, what can enforce it. It is deliberately **not** the order the docs were
produced in. Later research revised earlier conclusions, so the production order
(landscape → pivot → demand → outlook) puts an amendment *after* the doc it amends.

| # | Doc | Answers |
|---|---|---|
| 1 | [demand-validation](./2026-07-31-demand-validation.md) | Does anyone pay for this? What blocks deals? |
| 2 | [market-outlook](./2026-07-31-market-outlook.md) | Is this market dying or growing? What kills us, and how long do we have? |
| 3 | [agent-coordination-landscape](./2026-07-31-agent-coordination-landscape.md) | Who else is in this market? Where is the gap? |
| 4 | [enterprise-pivot-research](./2026-07-31-enterprise-pivot-research.md) | Who is the direct competitor, and how should the enterprise version work? |
| 5 | [claude-code-enforcement-surfaces](./2026-07-31-claude-code-enforcement-surfaces.md) | With the OS sandbox gone, what can actually enforce policy — and what can't? |
| 6 | [lessons-from-composio](./2026-07-31-lessons-from-composio.md) | How does a shipping Claude Code plugin do this, and what should we copy? |
| 7 | [cotal-enterprise-installability](./2026-08-01-cotal-enterprise-installability.md) | Which tool does an enterprise actually install — and what has to be true for it to be ours? |
| 8 | [mcp-tunnels-ema-positioning](./2026-08-02-mcp-tunnels-ema-positioning.md) | What did MCP tunnels and EMA actually ship, and where should MCP sit beside A2A? |
| 9 | [agentcall-onboarding-comparables](./2026-08-03-agentcall-onboarding-comparables.md) | How do adjacent tools get a stranger to a first result, and where do they introduce accounts, administrators, and invitations? |
| 10 | [buy-vs-build-third-party-landscape](./2026-08-02-buy-vs-build-third-party-landscape.md) | Which parts of that gap does someone else already sell — and do we pass a security review? |

Eight notes on the sequence:

- **#3 predates two decisions made the same day.** `agent-coordination-landscape` was
  written before the sandbox was dropped and before Q&A-first was chosen. Its
  *Conclusion* and *What is not working* sections recommend leading with the sandbox and
  treat callee-pays as the live economic model; both are obsolete. It sits at #3 so that
  #4 supersedes it immediately rather than leaving it unresolved.
- **#5 is not an optional appendix.** It is a technical reference, but its §5 also
  constrains #4: `ask` rules error under `claude -p`, so the draft-then-approve flow
  recommended there cannot be built on Claude's own permission mechanism and has to live
  in our protocol. Read it in sequence, not on demand.
- **#6 found a gap the other five missed.** `agentcall search` — resolving *who* to ask.
  Every other doc assumes the caller already knows the address. In a 500-person company
  they do not, and that is the asker's half of the #2 pain in #1. Discovery is a
  separate problem from calling, and only calling is built.
- **#7 amends #3 and is the first doc with a backlog.** #3 scored Cotal as
  inside-your-own-perimeter and therefore disjoint from us. The enterprise pivot makes
  that deployment shape ours too, so #7 re-runs the comparison and turns the differences
  into checklist items. Read it last; it depends on #1–#6 and cites them by section.
- **#8 narrows the position after a protocol release.** MCP Tunnels makes
  private-network reachability a substitute rather than differentiation. EMA supplies a
  useful enterprise-authorization shape, but no non-MCP compatibility claim. The
  companion decision keeps A2A as the public protocol and defers an MCP facade.
- **#9 is the only doc a decision followed directly, and it was partly overruled.**
  [#259](https://github.com/KenTaniguchi-R/agentcall/issues/259) took its two-lane
  separation of constrained evaluation from durable administration, and shipped it as
  Room versus Team. It rejected #9's recommended first experiment — a vendor-operated
  demo callee — in favour of 2–6 real people who already know each other. #9 carries
  that amendment inline; read #259 for what was decided.
- **#7's GTM conflict is resolved.** Keep the first beachhead at non-EU,
  non-unionized 100–500-person engineering organizations, lead with measured
  senior-time recovery, and preserve the narrower no-retained-call-corpus/no-connected-
  system-indexing distinction. The absolute “we do not ingest employee data” line is
  retired. See the [GTM sequencing decision](../superpowers/specs/2026-08-03-gtm-sequencing-design.md).
- **#10 is the only doc that reads the code, and it is scoped by
  [reference-implementations](./reference-implementations.md).** #1–#9 study the
  market and assume we fill the gap; #10 asks which parts of #7's gap are commodity,
  and deliberately covers only what the reference index does not already assign to a
  precedent. Read the index first, then #10 — otherwise its recommendations look
  broader than they are. Its first version was researched against a stale branch and
  asserted four gaps `main` had already closed; the correction and the rule that
  followed are recorded in its §5 rather than edited away. Code claims cite
  `origin/main` @ `af78a87`.

## The five findings that matter

1. **The pain is a painkiller.** 47% of developers spend 30+ min/day answering
   colleagues; it is managers' #2 ranked challenge. But say *"recover the 5 hrs/week
   your architects waste explaining architecture"* — "reduce interruptions" does not
   sell.
2. **The market is not dying.** Every hard demand indicator is up and inference prices
   are falling, which favours a token *consumer*.
3. **Platform absorption is the only existential threat**, and market growth does not
   protect against it. Roughly a 12–18 month window.
4. **The niche is real.** Person-scoped *execution* calling is the one unoccupied band.
   Shared-corpus Q&A, knowledge twins, and laptop-agent governance are all taken.
5. **Viven is the direct competitor** — $35M seed, Eightfold founders, on-prem ready.
   Live routing beats their indexing model on freshness, data residency, privacy
   enforcement, and departure semantics. They beat us on availability and funding.

## Two things to keep in view

- **Managers' #1 pain — knowledge loss on departure — is one this architecture cannot
  solve.** The agent leaves with the person. That is the direct cost of the privacy
  advantage; the same property produces both. Target #2.
- **Pure Q&A is feature-shaped**, which is the most absorbable configuration. Valid as
  a wedge, not as a destination.

## Conventions

Confidence is tagged per finding. Load-bearing claims were verified directly against
primary sources rather than accepted from search results. Where a figure traces only to
SEO aggregators or report-mill vendors, it is either cut or marked directional-only —
see the source-discipline section at the end of `market-outlook`.

Where later research revised an earlier conclusion, the earlier doc carries an inline
amendment pointing forward rather than being silently edited. The reading order above
puts most of those revisions before the doc they revise, but the pointers remain so the
docs stay correct when read individually.
