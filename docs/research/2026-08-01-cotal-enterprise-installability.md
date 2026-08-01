# Cotal vs agentcall — who does the enterprise actually install?

**Date:** 2026-08-01
**Status:** Research + backlog. The checklist is proposed work, not committed work.
**Amends:** [agent-coordination-landscape](./2026-07-31-agent-coordination-landscape.md) §Cotal,
which evaluated Cotal against the *consumer* product. This doc re-runs that
comparison against the enterprise pivot, where the answer changes.

---

## TL;DR

**agentcall is the one that gets installed; Cotal is the one that gets vendored.**
Cotal is infrastructure with no buyer — a platform engineer imports it, nobody signs a
contract. agentcall has a purchase order attached: eng leadership, a measured pain, a
per-seat price.

**But the inversion that matters: Cotal is easier to get through enterprise security
than agentcall is.** Cotal is a broker in your own VPC — "it's NATS, we already run
NATS." agentcall asks for an endpoint agent on every laptop that accepts inbound
instructions and spawns a process with the employee's real credentials, plus a
third-party relay that sees plaintext. Those are the two things security review hates
most, requested together.

Everything below is the work implied by closing that gap.

## What changed since 2026-07-31

The landscape doc scored Cotal as *inside-your-own-perimeter*, disjoint from a public
person-to-person product. That was right then. The enterprise pivot — one company's
employees, one network, scoped per caller — is **the same physical deployment as a
Cotal space with an org-run broker**. "Different market" is no longer the argument.
The argument is that Cotal has no product on top and no human in the loop.

Cotal has also already shipped the axis
[enterprise-pivot-research](./2026-07-31-enterprise-pivot-research.md) §2 identified as
the only one where we were losing: durable delivery. Three JetStream streams per space,
per-reader bookmarking, presence roster. They got it free by picking a transport that
hands it to them. Confidence: **high** (documented, verified against their docs).

## Current standings

| | agentcall (today) | Cotal |
|---|---|---|
| Who owns the agents | two different **people** | a mesh **you** stand up |
| Shape | 1:1 call, one-shot req/reply | many-agent space, channels, presence |
| Addressing | `handle@host` + contacts | endpoints / spaces / subjects — no human address |
| Transport | hosted CF Worker + DO + D1 | NATS + JetStream, self-hosted |
| Callee asleep | `offline` rejection | durable, bookmarked, delivered on return |
| Authz question answered | *may this caller invoke this task?* | *may this agent publish to this subject?* |
| Authz mechanism | `resolveTask()` + `policy.json`, pre-prompt | JWT + per-agent default-deny ACLs |
| Runtimes | claude, codex (experimental), macOS only | Claude Code, OpenCode, Hermes, pi |
| Standards posture | own zod protocol | reuses A2A `AgentCard` / `Message` |

**Where we are genuinely ahead:** the authorization model. Cotal's per-agent ACL is
classic in-perimeter authz. Ours is caller-scoped and resolved *before* the caller's
text reaches a prompt. Cotal has no equivalent because it never assumes the counterparty
is a possibly-adversarial human. Cedar landing on the same shape (July 2026) validates
it — see [enterprise-pivot-research](./2026-07-31-enterprise-pivot-research.md) §4.

---

## Backlog

Ordered by how hard each one blocks a deal, not by effort. Items in **A** kill
deployments outright; **B** stalls procurement; **C** is the argument to win in security
review; **D** is competitive parity; **E** is positioning.

> **Status now lives in [`TODO.md`](../../TODO.md).** The checkboxes below are a snapshot
> as of this doc's date and are not maintained — this doc keeps the *reasoning* for each
> item, `TODO.md` keeps how far along it is. The item lettering is shared, so `C.2` here
> is `C.2` there.

### A. Deployment surface — deal blockers

- [ ] **Self-hostable relay.** Internal engineering Q&A through a Cloudflare Worker
      operated by one person is a hard no under any data-residency clause. This deletes
      the single-shared-relay assumption in `apps/relay` and makes the deployment shape
      that Cotal already has table stakes for us too.
- [ ] **Remove "the relay operator sees plaintext"** from the security model — either
      via E2E encryption or by making the relay customer-operated (which A.1 gives us,
      if we accept the operator being the customer's own IT).
- [ ] **Non-macOS callee.** The LaunchAgent listener is Mac-specific. Dropping Seatbelt
      already removed the technical constraint; the work is a Linux service unit and a
      container story. Most enterprise dev fleets are not all-Mac.

### B. Enterprise apparatus — procurement blockers

- [ ] **SSO / SCIM and org tenancy.** Handles are currently registered ad hoc against a
      shared relay. An enterprise expects identity to come from their IdP.
- [ ] **Handle release / reclaim.** Currently impossible by design (the DO is addressed
      by handle name — see README *Limitations*). **This is an offboarding blocker, not
      a nicety:** an employee leaves and their address cannot be revoked or reassigned.
      No enterprise ships without this.
- [ ] **Admin console + org-level audit export.** `calls.log` and `tools.log` are
      per-machine JSONL. Compliance wants a queryable org-wide trail with retention.
- [ ] **SOC 2 path.** Not a feature, but it gates the deals the demand research targets.

### C. Endpoint security review — the argument to win

- [ ] **Close or bound the `exec` gap.** A task granting `exec` has no read floor today;
      shell commands are recorded, not blocked. This is the single line a security
      architect will stop on. Either bound it or have a written answer for why the task
      envelope is the control.
- [~] **Codex read-guard parity.** A Codex answering agent has no read guard at all.
      "Depends which agent the employee happens to use" does not survive review.
      **Partly done, and renamed in the doing** — see
      [codex-read-floor-design](../superpowers/specs/2026-08-01-codex-read-floor-design.md).
      Shipped: the guard is registered on the Codex spawn in *observe* mode, the
      spawn no longer loads the owner's `~/.codex` (its MCP servers were a
      complete bypass of every control here), `~/.codex` joined the denied paths,
      and the guard's fail-closed exits were fixed — under Codex they had been
      failing *open*. Still open: the read floor itself. It cannot come from this
      hook, because Codex reaches the filesystem only through `Bash`; the design
      delegates it to Codex's own kernel-enforced `deny_read`, gated on five
      unproven preconditions. **This item cannot close before C.1** — for Codex,
      the whole tool surface is the `exec` gap.
- [ ] **Make the policy envelope legible to a non-engineer.** `policy.json` +
      `resolveTask()` is the right foundation, but the security team needs to read the
      granted surface as policy, not infer it from frontmatter. A rendered
      per-caller/per-task capability report.
- [ ] **Write the endpoint-agent threat model as a standalone document.** We are asking
      for an inbound-instruction daemon on every dev machine with the user's real
      credentials. That review is coming; showing up with an answer beats improvising.

### D. Availability — parity with Cotal

- [ ] **Synchronous call → durable mailbox**, with presence and fall-back-to-human.
      Already the conclusion of two prior docs; Cotal shipping it makes it competitive
      parity rather than a roadmap item.
- [ ] **Decide: own the wire, or ride a mesh.** If durable delivery + presence + roster
      is the destination, NATS/JetStream gives all three free and we are otherwise
      rebuilding them on DO + D1. Worth a real evaluation before building.

### E. Positioning

- [ ] **Adopt the A2A `AgentCard` shape for `agentcall card`.** Ours is already
      semantically the same object. Conforming buys interop cheaply and avoids competing
      in the standards game — which is Cotal's fight against Google's A2A, and the
      hardest game in infra.
- [ ] **Reconcile GTM sequencing with the differentiator.** The demand doc sequences
      non-EU, non-unionised 100–500 person orgs first. Our sharpest differentiator —
      "we don't ingest your employees' data" — is worth most to exactly the EU-exposed
      and regulated buyers that sequencing defers. One of the two should move.
      Confidence: **medium**; this is an inference from two docs, not new research.

---

## The uncomfortable third option

The most likely thing an enterprise installs for this pain is neither of us — it is
whatever Slack, Atlassian, or GitHub bolts on, because distribution beats architecture
in enterprise. This is the platform-absorption threat from
[market-outlook](./2026-07-31-market-outlook.md) §3, restated with a specific rival in
frame.

The window: all three will solve it by **indexing** employee knowledge, which is the
thing works councils kill. Live routing with no ingestion is genuinely differentiated.
It is also narrower than the raw demand data suggests, because it only reaches buyers
who care about that distinction — which is why item E.2 exists.

## Sources

- [cotal.ai](https://cotal.ai/) — positioning, topology model
- [github.com/Cotal-Ai/Cotal](https://github.com/Cotal-Ai/Cotal) — architecture,
  transport, ACL model, runtimes, Apache-2.0, ~217 stars
- [docs.cotal.ai](https://docs.cotal.ai/) — primitives, delivery modes
