# What should we buy instead of build?

**Date:** 2026-08-02
**Status:** Research + backlog. Every recommendation below is *proposed* work, not
committed work. Nothing here has been decided.
**Extends:**
[cotal-enterprise-installability](./2026-08-01-cotal-enterprise-installability.md) —
that doc says *what* the enterprise gap is; this one asks which parts of it someone
else already sells.
**Read first:** [reference-implementations](./reference-implementations.md). That index
is the living guidance; this doc only covers what it does not already carry.
**Method:** vendor claims verified against primary sources (pricing pages, official
docs, upstream PRs) on 2026-08-02. Code claims verified against `origin/main` @
`af78a87`, same date.

> **Correction, 2026-08-02.** The first version of this doc was researched against a
> branch 77 commits behind `main` and asserted three things that were already false:
> that no release workflow or npm provenance existed (`release.yml` ships OIDC trusted
> publishing, `--provenance`, pinned SHAs and an SBOM — #105, #122, #161 all closed);
> that no data-flow document existed (`docs/security/data-residency.md` does — #118);
> and that D1 Time Travel blocking erasure was a new finding (the residency doc already
> states it). Four of the nine originally proposed backlog items were already done. This
> version is re-verified and the dead items are removed. The lesson is recorded in
> §5 rather than deleted.

---

## TL;DR

Three buys and one non-move survive re-verification against `main`.

1. **Buy hosted SSO — and the reason is the CLI, not SAML.** WorkOS ships RFC 8628
   device-code *and* PKCE loopback auth for command-line apps, free with hosted AuthKit.
   `reference-implementations` already settled that customer-owned Cloudflare Access is
   the *self-hosted* SSO profile and that **hosted multi-tenant SSO/SCIM remains #15** —
   this fills exactly that slot, with a fit argument #102 did not have.
2. **Stay on Workers + Durable Objects.** Hibernation is the best-fit primitive on the
   market for mostly-idle per-identity sockets, and the one argument for leaving —
   self-hosting — was substantially weakened *by Cloudflare* in May–June 2026. That is
   new information since #20 was deferred and should reopen and close that decision.
3. **`ggshield` registers as a Claude Code and Codex hook** — the same seam `guard.ts`
   already occupies — and lands on the secret-echo risk README L542 names. No issue
   currently covers it.
4. **Do not buy** an embedding search backend, a remote code sandbox, an FGA engine, or
   a prompt-injection guardrail product. Reasons in §4.

---

## 0. How much do we build ourselves?

Verified on `main`. The whole product still ships on five runtime dependencies:

| Package | Dependencies |
|---|---|
| `apps/relay` | `hono`, `zod` |
| `packages/cli` | `commander`, `ws`, `yaml`, `zod` |
| `packages/shared` | `zod` |

Hand-rolled: token generation, hashing and constant-time comparison
(`apps/relay/src/auth.ts:15`), roster lifecycle, the audit ledger, config storage, the
agent card, the policy guard, and search.

Most of that is correct — it is the product. The sections below cover the parts that
are not, minus everything `reference-implementations` already assigns to a precedent.

---

## 1. Hosted SSO — WorkOS

**Confidence: high.** Read from `workos.com/pricing` and
`workos.com/docs/authkit/cli-auth` on 2026-08-02.

#102 already concluded "buy SSO, do not build it," and `reference-implementations`
independently reached the same boundary from the Cloudflare Access side:

> *"Customer-owned Access is therefore a self-hosted SSO profile, while hosted
> multi-tenant SSO/SCIM remains #15."*

So #15 is an open slot, not a solved one. What this research adds is the detail that
decides *which* vendor fits, which neither #102 nor the index has:

> **WorkOS ships CLI Auth — OAuth 2.0 Device Authorization Grant (RFC 8628) plus
> Authorization Code with PKCE — free with hosted AuthKit.**

Our client is a CLI on an employee laptop, not a web app. The documented pattern (PKCE
by default, `--device` for SSH, containers and cloud IDEs) is the one `aws sso login`
switched to in CLI v2.22. It replaces a plaintext token in `config.json` with a
short-lived OAuth token whose lifecycle the IdP owns.

Bears on #15, #108 (token in plaintext), #52 (lost token = lost handle), #154 (stable
identity vs. handle address). Note that #52 and #154 are already being answered from the
Infisical/Headscale precedents in the index — WorkOS is the *hosted-IdP* half, not a
replacement for that work.

### Verified pricing, 2026-08-02

| Product | Cost |
|---|---|
| AuthKit + CLI Auth | **Free** to 1M MAU |
| Enterprise SSO | $125/connection/mo → $50/ea at 101–200 |
| Directory Sync (SCIM) | **Separate SKU** on the same tier table — a customer wanting both counts as two connections |
| Audit Logs | $125/mo per SIEM streaming connection + $99/mo per 1M events retained |
| Admin Portal | Included |
| Custom domain | $99/mo |

Effective cost: **$0 until the first enterprise deal**, then ~$125–250/mo per customer.

Alternatives if per-connection cost binds: **SSOJet** bundles SCIM into the connection
price (~$49.50/connection), removing the SSO+SCIM doubling, at the cost of procurement
brand. **Keycloak** removes per-connection fees entirely but costs us the Admin Portal,
which is the actual thing WorkOS sells.

### The tension to resolve first

A hosted IdP is a **subprocessor to disclose in every DPA**, and a self-hosted relay
(#12) cannot depend on one. If self-host is a real commitment, the SSO layer has to be
pluggable — OIDC in, WorkOS as *one configured provider* — rather than wired in
directly. This is the same shape as the index's Access conclusion and should stay
consistent with it.

---

## 2. The platform question: stay on Workers

**Confidence: high** on the primitives (Cloudflare docs, 2026-06 to 2026-07).
**Confidence: medium** on the self-host conclusion — the workerd cluster work is recent
and we have not run it.

### 2.1 The primitive has no close competitor

Our shape is one mostly-idle WebSocket per handle, held open for hours, woken a few
times a day. From Cloudflare's Durable Objects documentation:

- **32,768 WebSocket connections per DO** under the Hibernation API
- Hibernation bills **zero GB-s** while idle; protocol pings and
  `setWebSocketAutoResponse` app-level pings **do not wake the object**
- Cloudflare's own worked example — 100 DOs × 100 sockets, one message per minute —
  totals **~$5/month**

Every alternative bills for a live process. Synadia Cloud, the managed NATS option, is
**$49/mo for 100 connections and $199/mo for 1,000** — priced per connection, and our
connection is one always-on laptop.

### 2.2 The self-host blocker weakened — on Cloudflare's side

#12 states the objection: *"Internal engineering Q&A through a Cloudflare Worker
operated by one person is a hard no under any data-residency clause."* #20 deferred the
transport decision partly on that basis. Since then:

- [cloudflare/workerd#6780](https://github.com/cloudflare/workerd/pull/6780) (Kenton
  Varda, 2026-05-23) adds **cluster mode for self-hosted Durable Objects** — multiple
  workerd instances coordinating DO ownership through NFSv4 lease fencing on a shared
  filesystem. Before this, self-hosted DOs were single-instance and test-only.
- [workers-sdk#14294](https://github.com/cloudflare/workers-sdk/pull/14294) (2026-06)
  adds `wrangler compile` for self-hosting on standalone workerd.
- Third-party platforms (`groundflare`, `wdl`) already ship self-hosted Workers with DO
  support on stock workerd.

**"Own the wire on DO" and "the customer runs it" are no longer mutually exclusive** —
which was the premise #20 was deferred on.

Two caveats to carry. workerd's own README warns it has no defense-in-depth against
implementation bugs and must run inside a VM sandbox for untrusted code; with #1 open,
a self-hosted relay has to state that explicitly. And **D1 has no self-host path at
all**, so a self-hosted profile has to answer for the identity tables separately.

### 2.3 When the answer flips to NATS

#20 already states the trigger correctly: *"If durable delivery + presence + roster is
the destination, NATS/JetStream gives all three free and we are otherwise rebuilding
them on DO + D1."*

The research supports that with specifics — JetStream **leaf nodes with domains** are
exactly the in-network shape: the customer runs their own `nats-server`, it keeps
serving locally when the hub is unreachable, and NATS accounts give JWT-authenticated
tenant isolation. That is the structural-isolation property `reference-implementations`
already cites NATS accounts for, applied to transport rather than to tenancy modelling.

**The trigger is starting #19, not dissatisfaction with Workers.**

### 2.4 What #13 is not

No platform change fixes *"the relay operator sees message plaintext"* (README L728).
Not Fly, not NATS, not Postgres. Only end-to-end encryption or a customer-operated
relay does. A platform migration must not be allowed to masquerade as progress on #13.

---

## 3. `ggshield` — a second hook on the seam we already own

**Confidence: high** (GitGuardian docs, `integrations/ai-coding-tools`, 2026-07-01).
No open or closed issue currently covers secret scanning on agent output.

The README names the risk precisely:

> *"A caller's prompt could induce the agent to read and echo back the callee's Claude
> Code session history (`~/.claude/projects/*`, which can contain pasted secrets and
> private code)"* — README L542

`ggshield` ≥ 1.49 (≥ 1.51 for Codex) **registers as a hook in Claude Code and Codex**,
scanning three stages with 500+ secret detectors:

| Stage | Behavior |
|---|---|
| Prompt submission | **blocks** |
| Pre-tool-use (commands, file reads, MCP calls) | **blocks** |
| Post-tool-use (tool output) | desktop notification |

We already own that seam. `packages/cli/src/guard-entry.ts` and `guard.ts` are
registered as exactly this hook for both runtimes — Claude through
`--settings guardSettingsJson()` (`runner.ts:189`), Codex through
`-c guardCodexConfigArg()` (`runner.ts:211`, `:229`). This is additive.

**Decide this before adopting, not after:** ggshield is **fail-open** by design — if it
cannot authenticate or its API is unreachable, it allows the action and warns. Our guard
is deliberately fail-closed (`FAIL_CLOSED_REASON`, `packages/cli/src/guard.ts`), and
that choice is load-bearing on both runtimes. Mixing them yields a secret-scanning layer
with weaker semantics than the layer beside it. Acceptable if stated; a hole if
discovered later.

### 3.1 The sandbox gap, and why the well-known vendors are wrong for us

`packages/cli/src/runner.ts:169` records what was removed on 2026-07-31: the spawn used
to be wrapped in `npx @anthropic-ai/sandbox-runtime --settings <file>`. Today the
envelope is enforced by each agent's own permission flags. `runner.ts:197-198` is blunt
about the residue: *"Note it does NOT confine reads: `codex exec --sandbox read-only`
still reads `~/.ssh`."* Both Codex paths run the guard in `observe` mode (`:214`,
`:232`); Claude runs it in enforce mode with `AGENTCALL_ALLOWED_ROOT` (`:192`).

The 2026 agent-sandbox market is large — E2B, Daytona, Modal, Vercel, Cloudflare
Sandbox SDK — and **almost all of it is the wrong shape.** Those are *remote* sandboxes.
Our answering agent must run on the callee's own machine against their own repo;
shipping the customer's source to a third-party sandbox is strictly worse than the
problem being solved.

Shapes that fit are local:

- **microsandbox** — local microVMs, Apple Silicon supported, sub-100ms boot,
  embeddable with no daemon, ships Agent Skills and an MCP server for Claude Code and
  Codex. Closest fit, but **self-describes as beta** — a spike, not a dependency.
- **Codex's own kernel-enforced `deny_read`** — which is what #2 already says, and #3
  (the probe that gated it) is now closed. #2 remains `status:blocked`; its blocker
  should be re-read before anything new is filed here.
- **Apple `sandbox-exec`** — the zero-dependency macOS option.

Cloudflare Sandbox SDK becomes relevant only if we ever offer a hosted-callee mode.

---

## 4. Do not buy

- **Embedding / vector search.** `packages/cli/src/search.ts:1-5` documents the
  decision: the ranker *"runs entirely on the caller's machine — the query text never
  reaches the relay — and its output is consumed by an LLM, which does the final
  semantic pick."* A vector backend would add a subprocessor and break that property.
- **Remote code sandboxes** (E2B, Daytona, Modal). Wrong shape — §3.1.
- **An authorization engine** (OpenFGA, SpiceDB, Cerbos). Our model is membership,
  living in D1 next to the data. Buying an FGA engine now is the "picked the tool before
  defining the model" mistake. Revisit if delegation (#112) grows depth — and note the
  index already assigns that problem to kitelogik and paddock.
- **A prompt-injection guardrail product, yet.** Invariant Labs is the interesting one
  (runs locally; its canonical rule taint-tracks a prompt injection from a tool output
  into a later tool call — the shape of #112). But our guard works, and buying detection
  before #114 provides telemetry means buying blind.

---

## 5. What this doc got wrong, and the rule that follows

The first version asserted four gaps that `main` had already closed — release
provenance (#105, #122, #161), the data-flow document (#118), jurisdiction pinning
(#118), and D1 Time Travel as a novel erasure finding (already in
`docs/security/data-residency.md`). All four were artifacts of researching a branch 77
commits stale, on a repository averaging roughly 40 commits a day.

**Rule: verify code claims against `origin/main`, not the working tree, and record the
commit.** A dated research doc that cites `file:line` is a snapshot; at this velocity a
snapshot is stale within days. Every code citation in this version names
`origin/main` @ `af78a87`. This is the same discipline `reference-implementations`
already applies with its "record the check date for version-sensitive claims" rule,
extended from external sources to our own repository.

---

## 6. Proposed backlog

Not filed. Four items survive; the original nine included four already done and one
(a `file:line` correction pass) folded into this rewrite.

| # | Proposed | Kind | Relates to |
|---|---|---|---|
| 1 | Adopt `ggshield` as a second hook; decide the fail-open/fail-closed mismatch explicitly | `area:security` | #1, #11 |
| 2 | Reopen and close #20 "stay on DO", citing workerd cluster mode; note D1 has no self-host path | `kind:decision` | #20, #12, #19 |
| 3 | Record "buy hosted SSO" and evaluate WorkOS against the #15 slot the Access boundary left open | `kind:decision` | #15, #102 |
| 4 | Spike a local confinement boundary (microsandbox / `sandbox-exec`) — read #2's blocker first | `kind:experiment` | #1, #2, #11 |

Items 1 and 2 are independent and cheap. Item 3 should be recorded before anyone spends
a sprint either way. Item 4 waits on someone owning #1.

**Standing constraint, unchanged.** None of this shortens the C track. A perfect relay
posture does not survive one reviewer asking what `exec` can reach — as CLAUDE.md says,
*"a passing TCK says nothing about safe prompt execution."*
