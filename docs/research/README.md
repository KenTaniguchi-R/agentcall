# Research

The [reference implementation index](./reference-implementations.md) is living,
current design guidance for enterprise, security, and A2A work. Update it when a
reference or its adoption changes. **Read it before designing anything in
`area:enterprise`, `area:security`, or `area:a2a`.**

Everything else in this directory is a dated research note. **Notes are not
decisions.** No implementation follows from one without a separate call, and
where a later note revised an earlier conclusion the earlier file carries an
inline amendment pointing forward rather than being silently edited. They are
kept as written.

## What is here

**Enforcement surfaces — what can actually stop a tool call, and what cannot**

| Doc | Answers |
|---|---|
| [claude-code-enforcement-surfaces](./2026-07-31-claude-code-enforcement-surfaces.md) | With no OS sandbox, which Claude Code surfaces can enforce policy? |
| [codex-enforcement-surface](./2026-08-06-codex-enforcement-surface.md) | The same question for Codex, which answers it differently. |
| [skill-and-mcp-guard-reachability](./2026-08-06-skill-and-mcp-guard-reachability.md) | Which invocation paths reach the guard at all. |
| [guard-entry-import-cost](./2026-08-06-guard-entry-import-cost.md) | What the guard costs on every single tool call. |
| [mcp-source-default-trust](./2026-08-06-mcp-source-default-trust.md) | Should an MCP server's output be trusted by default? |
| [repo-seed-default-evidence](./2026-08-06-repo-seed-default-evidence.md) | What the default working-directory scope should be, on evidence. |

**Information flow — where an answer came from, and where it may go**

| Doc | Answers |
|---|---|
| [information-flow-control-for-agent-answers](./2026-08-06-information-flow-control-for-agent-answers.md) | Can classical IFC be applied to an agent's natural-language answer? |
| [ifc-claims-reverification](./2026-08-06-ifc-claims-reverification.md) | Re-checking the above against primary sources. |
| [label-creep-spike](./2026-08-06-label-creep-spike.md) | Does everything end up labelled secret in practice? |
| [provenance-signal-reliability](./2026-08-06-provenance-signal-reliability.md) | How much weight a provenance signal can carry. |
| [sink-side-provenance-enforcement](./2026-08-06-sink-side-provenance-enforcement.md) | Enforcing at the sink rather than the source. |
| [derived-access-inheritance](./2026-08-06-derived-access-inheritance.md) | What a derived value inherits from its inputs. |

**Protocol and cryptography**

| Doc | Answers |
|---|---|
| [hpke-core-selection](./2026-08-03-hpke-core-selection.md) | Which HPKE implementation, and why that one. |
| [hermes-a2a-implementation](./2026-08-04-hermes-a2a-implementation.md) | How a shipping A2A implementation actually structures itself. |
| [mcp-tunnels-ema-positioning](./2026-08-02-mcp-tunnels-ema-positioning.md) | What MCP Tunnels and Enterprise-Managed Authorization shipped, and where MCP sits beside A2A here. |

**Engineering practice**

| Doc | Answers |
|---|---|
| [loop-engineering-verification-gates](./2026-08-05-loop-engineering-verification-gates.md) | Why the verification gate is shaped the way it is. |
| [lessons-from-composio](./2026-07-31-lessons-from-composio.md) | How a shipping Claude Code plugin does this, and what is worth copying. |
| [buy-vs-build-third-party-landscape](./2026-08-02-buy-vs-build-third-party-landscape.md) | Which parts of the gap does someone else already sell — and do we pass a security review? |

`buy-vs-build` is the only note here that reads the code, and it is scoped by
[reference-implementations](./reference-implementations.md): it deliberately covers
only what that index does not already assign to a precedent. Read the index first,
otherwise its recommendations look broader than they are. Its first version was
researched against a stale branch and asserted gaps `main` had already closed; the
correction and the rule that followed are recorded in its §5 rather than edited away.

## Source discipline

Load-bearing claims are verified directly against primary sources — specifications,
official repositories, first-party vendor documentation — rather than accepted from
search results. Where a figure traces only to SEO aggregators or report-mill vendors,
it is cut or marked directional-only. Confidence is tagged per finding.

## Notes that are not published here

Market sizing, demand validation, competitive positioning, onboarding
comparables, and go-to-market sequencing live in the private repository that
operates the hosted service, not in this one. They are business research about
buyers and competitors; they say nothing about how AgentCall works, and
publishing them would mostly be publishing someone else's competitive analysis.

A few dated records in `docs/superpowers/specs/` and `docs/research/` link to those
notes by relative path — `buy-vs-build-third-party-landscape` extends
`cotal-enterprise-installability` and cites it throughout. Those links do not resolve
here. The records are kept exactly as written rather than edited after the fact, so
the dangling link is left visible instead of being quietly rewritten:

- `2026-07-31-demand-validation.md`
- `2026-07-31-market-outlook.md`
- `2026-07-31-agent-coordination-landscape.md`
- `2026-07-31-enterprise-pivot-research.md`
- `2026-08-01-cotal-enterprise-installability.md`
- `2026-08-03-agentcall-onboarding-comparables.md`
- `2026-08-03-free-landing-analytics-waitlist.md`
- `docs/superpowers/specs/2026-08-03-gtm-sequencing-design.md`

No technical finding is held back. If you hit a dangling link that looks like it
should have been engineering research rather than market research, open an issue
— that would be a mistake in this split, not a policy.
