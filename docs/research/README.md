# Research

Market and competitive research for agentcall. **These are research notes, not
decisions.** No implementation follows from them without a separate call.

All four docs date from 2026-07-31 and were produced together; read them as one body
of work rather than four independent studies.

## Read in this order

| Doc | Answers |
|---|---|
| [agent-coordination-landscape](./2026-07-31-agent-coordination-landscape.md) | Who else is in this market? Where is the gap? |
| [enterprise-pivot-research](./2026-07-31-enterprise-pivot-research.md) | Who is the direct competitor, and how should the enterprise version work? |
| [demand-validation](./2026-07-31-demand-validation.md) | Does anyone pay for this? What blocks deals? |
| [market-outlook](./2026-07-31-market-outlook.md) | Is this market dying or growing? What kills us? |

## The five findings that matter

1. **The niche is real.** Person-scoped *execution* calling is the one unoccupied band.
   Shared-corpus Q&A, knowledge twins, and laptop-agent governance are all taken.
2. **Viven is the direct competitor** — $35M seed, Eightfold founders, on-prem ready.
   Live routing beats their indexing model on freshness, data residency, privacy
   enforcement, and departure semantics. They beat us on availability and funding.
3. **The pain is a painkiller.** 47% of developers spend 30+ min/day answering
   colleagues; it is managers' #2 ranked challenge. But say *"recover the 5 hrs/week
   your architects waste explaining architecture"* — "reduce interruptions" does not
   sell.
4. **The market is not dying.** Every hard demand indicator is up and inference prices
   are falling, which favours a token *consumer*.
5. **Platform absorption is the only existential threat**, and market growth does not
   protect against it. Roughly a 12–18 month window.

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
amendment pointing forward rather than being silently edited.
