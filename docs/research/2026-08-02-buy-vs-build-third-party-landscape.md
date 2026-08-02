# What should we buy instead of build?

**Date:** 2026-08-02
**Status:** Research + backlog. Every recommendation below is *proposed* work, not
committed work. Nothing here has been decided.
**Amends:** nothing. Extends
[cotal-enterprise-installability](./2026-08-01-cotal-enterprise-installability.md) —
that doc says *what* the enterprise gap is; this one asks which parts of it someone
else already sells.
**Method:** vendor pricing and capability claims verified against primary sources
(vendor pricing pages, official docs, GitHub PRs) on 2026-08-02. Code claims are cited
by `file:line` against the tree at that date. Confidence is tagged per finding.

---

## TL;DR

Four buys, one non-move, one correction to a deferred decision.

1. **Buy SSO — and the reason is the CLI, not SAML.** WorkOS ships RFC 8628 device-code
   *and* PKCE loopback auth for command-line apps, free with hosted AuthKit. That
   collapses #15, #108, #52
   and #154 into one integration. Confirms
   #102's "buy, don't build" with a fit argument #102 did not have.
2. **Stay on Workers + Durable Objects.** Hibernation is the best-fit primitive on the
   market for mostly-idle per-identity sockets, and the one argument for leaving —
   self-hosting — was substantially solved *by Cloudflare* in May–June 2026. This is new
   information since #20 was deferred and it should reopen and close
   that decision.
3. **The security review does not fail on Cloudflare. It fails on us.** Three of our own
   open issues are disqualifying; the platform is not one of them.
4. **`ggshield` is the highest-value single buy** — it registers as a Claude Code and
   Codex hook, the same seam `guard.ts` already occupies, and lands exactly on the
   secret-echo risk our README names.
5. **We publish the CLI with no provenance and no release workflow.** Free fix, live
   exposure.
6. **Do not buy** an embedding search backend or a remote code sandbox. Both are the
   wrong shape for this product, for reasons the code already documents.

---

## 0. How much do we actually build ourselves?

Nearly all of it. The entire product ships on five runtime dependencies:

| Package | Deps |
|---|---|
| `apps/relay` | `hono`, `zod` |
| `packages/cli` | `commander`, `ws`, `yaml`, `zod` |
| `packages/shared` | `zod` |

Everything else is hand-rolled: token generation, hashing, constant-time comparison
(`apps/relay/src/auth.ts`, 25 lines), roster lifecycle, the audit log, config storage,
the agent card, the policy guard, and search.

Most of that is correct — it is the product. The items below are the ones that are not.

---

## 1. Identity and enterprise plumbing — WorkOS

**Confidence: high.** Pricing and capabilities read from `workos.com/pricing` and
`workos.com/docs/authkit/cli-auth` on 2026-08-02.

#102 already concluded "buy SSO, do not build it," citing five 2026
sources. This research confirms that and adds the detail that actually decides it for
us, which #102 did not have:

> **WorkOS ships CLI Auth — OAuth 2.0 Device Authorization Grant (RFC 8628) plus
> Authorization Code with PKCE — free with hosted AuthKit.**

That matters because our client is a CLI on an employee laptop, not a web app. The
documented pattern (PKCE by default, `--device` for SSH/containers/cloud IDEs) is the
one `aws sso login` switched to in CLI v2.22. It replaces a plaintext token in
`config.json` with a short-lived OAuth token whose lifecycle the IdP owns.

Issues it touches: #15 (SSO), #108 (token in
plaintext), #52 (lost token = lost handle),
#154 (stable identity vs. handle address).

### Verified pricing, 2026-08-02

| Product | Cost |
|---|---|
| AuthKit + CLI Auth | **Free** to 1M MAU |
| Enterprise SSO | $125/connection/mo → $50/ea at 101–200 |
| Directory Sync (SCIM) | **Separate SKU**, same tier table — a customer wanting both counts as two connections |
| Audit Logs | $125/mo per SIEM streaming connection + $99/mo per 1M events retained |
| Admin Portal | Included |
| Custom domain | $99/mo |

Effective cost: **$0 until the first enterprise deal**, then ~$125–250/mo per customer.

### Alternatives, if per-connection cost ever binds

- **SSOJet** — bundles SCIM into the connection price (~$49.50/connection), which
  removes the SSO+SCIM doubling. Weaker procurement brand.
- **Keycloak** — Apache 2.0, no per-connection fee, full data ownership. Costs us the
  Admin Portal, which is the actual thing WorkOS sells. Relevant only if
  #12 makes a hosted IdP unacceptable.

### The tension to resolve first

A hosted IdP is a **subprocessor to disclose in every DPA**, and a self-hosted relay
(#12) cannot depend on one. If self-host is a real commitment, the
SSO layer has to be pluggable — OIDC in, WorkOS as *one configured provider* — rather
than wired in directly.

---

## 2. The platform question: stay on Workers

**Confidence: high** on the primitives (Cloudflare docs, 2026-06 to 2026-07).
**Confidence: medium** on the self-host conclusion — the workerd cluster work is recent
and we have not run it.

### 2.1 The primitive has no real competitor

Our shape is one mostly-idle WebSocket per handle, held open for hours, woken a few
times a day. Verified against Cloudflare's Durable Objects docs:

- **32,768 WebSocket connections per DO** under the Hibernation API
- Hibernation bills **zero GB-s** while idle; protocol pings and
  `setWebSocketAutoResponse` app-level pings **do not wake the object**
- Cloudflare's own worked example — 100 DOs × 100 sockets, 1 msg/min — totals **~$5/mo**

Every alternative bills for a live process. Synadia Cloud, the managed NATS option, is
**$49/mo for 100 connections and $199/mo for 1,000** — priced per connection, and our
connection is one always-on laptop.

### 2.2 The self-host blocker weakened — on Cloudflare's side

#12 states the objection: *"Internal engineering Q&A through a
Cloudflare Worker operated by one person is a hard no under any data-residency
clause."* #20 deferred the transport decision partly on that basis.
Since then:

- [cloudflare/workerd#6780](https://github.com/cloudflare/workerd/pull/6780) (Kenton
  Varda, 2026-05-23) adds **cluster mode for self-hosted Durable Objects** — multiple
  workerd instances coordinating DO ownership via NFSv4 lease fencing on a shared
  filesystem. Before this, self-hosted DOs were single-instance and test-only.
- [workers-sdk#14294](https://github.com/cloudflare/workers-sdk/pull/14294) (2026-06)
  adds `wrangler compile` for self-hosting on standalone workerd.
- Third-party platforms (`groundflare`, `wdl`) already ship self-hosted Workers with DO
  support on stock workerd.

**"Own the wire on DO" and "the customer runs it" are no longer mutually exclusive** —
which was the premise #20 was deferred on.

Caveat to carry: workerd's own README warns it has no defense-in-depth against
implementation bugs and must run inside a VM sandbox for untrusted code. Given
#1 is open, a self-hosted relay has to state that explicitly.

### 2.3 What should change instead

| Piece | Verdict |
|---|---|
| Workers + DO | Keep. Best fit, now self-hostable. |
| D1 | The weak link, not Workers. Least portable, and see §3.4. Our write volume is far below the ~50-writes/sec and 10 GB ceilings, so those are not binding — the retention behaviour is. |
| Transport boundary | Put an interface here so #20 stays a swap, not a rewrite. |
| #13 | **No platform change fixes this.** Not Fly, not NATS, not Postgres. Only E2E encryption or a customer-operated relay does. |

### 2.4 When the answer flips to NATS

#20 already states the trigger correctly: *"If durable delivery +
presence + roster is the destination, NATS/JetStream gives all three free and we are
otherwise rebuilding them on DO + D1."*

The research supports that with specifics — JetStream **leaf nodes with domains** are
exactly the in-network shape: the customer runs their own `nats-server`, it keeps
serving locally when the hub is unreachable, and NATS accounts give JWT-authenticated
multi-tenant isolation. That is #12, #13 and #19 in one move.

**The trigger is starting #19, not dissatisfaction with Workers.**

---

## 3. Will this pass an enterprise security review?

**Not today.** The gaps are ours, not Cloudflare's.

### 3.1 What already passes

**We do not persist message content at the relay.** `apps/relay/src/do.ts:115` stores
only `{ call_id, from, deadline }` per call and deletes it on reply (`:142`), error
(`:151`) and disconnect (`:158`). The prompt and answer are forwarded (`:120`, `:139`),
never written. This is a strong DPA answer that is currently **written nowhere a
reviewer can find it**.

**Data residency is a config change, not an architecture change.** Verified in
Cloudflare docs on 2026-08-02, and we use none of it:

- Durable Objects support jurisdiction pinning: `eu`, `fedramp`, and **`us` as of
  2026-06-26**. Compute *and* storage stay in-region.
- D1 supports `eu` / `fedramp` at creation (jurisdiction overrides location hint);
  read replicas stay inside the jurisdiction.
- Regional Services controls where requests are terminated.

**Credentials are handled correctly server-side** — SHA-256 hashed, constant-time
compare (`apps/relay/src/auth.ts`); roster secrets returned once, never stored
(`apps/relay/src/roster.ts:41`).

**Cloudflare's own posture** (SOC 2 Type II, ISO 27001) covers the infrastructure layer
as a subprocessor. It does not transfer to us.

### 3.2 What fails, in the order it kills the deal

| # | Gap | Why it fails | Issue |
|---|---|---|---|
| 1 | **The endpoint, not the relay** | README L274: *"There is no OS-level sandbox."* L306: the guard blocks file reads *"but not for `exec`, and not at all for a Codex answering agent."* A reviewer reads "an external party's prompt can cause `exec` in an employee's home directory containing our source" and stops. No platform choice touches this. | #1, #11, #8 |
| 2 | **Relay operator sees plaintext** | README L410: *"treat call content as visible to the relay operator."* Hard fail for internal engineering Q&A unless the operator **is** their IT. | #13, #12 |
| 3 | **No deletion path** | `handles`, `cards`, `invites`, `roster_events` have no delete. Plus §3.4 below. GDPR Art. 17 answer today is "we cannot." | #160, #159 |
| 4 | **Metadata retention** | `rl:*` keys are never deleted, so a callee's DO becomes a permanent list of everyone who ever called them. Questionnaires ask about metadata specifically. | #155 |
| 5 | **Audit can wedge, and cannot be exported** | Budget exhaustion is permanent and blocks `leave`; no org-level export. "Show me the access log" has no answer. | #153, #17 |
| 6 | **No SOC 2, no pen test, no telemetry** | Not fatal alone, but #114 means we cannot answer "how would you detect and reconstruct an incident." | #18, #114 |
| 7 | **Works council / transparency** | EU and Japan: an agent on an employee laptop answering outsiders is a co-determination question. Arrives from Legal, not Security. | #110 |

### 3.3 SOC 2 timing and observed cost

**Confidence: medium** — vendor pricing is quote-only; figures below are third-party
procurement observations, not rate cards.

Vendr-observed Vanta contracts run **$7,500–$56,781/yr (median ~$20,000)**. Cheaper
tiers exist (Sprinto ~$6–12K, Delve/TryComp ~$3–9K). The **CPA audit is separate** at
$10–50K. The gate is a signed deal, not a milestone — and the prerequisite is our own
audit log, which is #153/#156/#159.

### 3.4 New finding: D1 Time Travel makes erasure impossible for 30 days

**Confidence: high** (Cloudflare D1 docs, `reference/time-travel`, read 2026-08-02).

Time Travel is **always on, cannot be disabled, and retains 30 days of point-in-time
history** on the Workers Paid plan (7 days on Free). There is no purge API. Even a
correct `DELETE` leaves the row restorable for 30 days.

Our answer to an erasure request is therefore structurally *"within 30 days, not on
request."* This is independent of everything else on this page and is an argument for
moving personal data off D1. It sits underneath #160 and constrains
what #159's retention policy can promise.

### 3.5 Residency tradeoff to know before promising it

With **Customer Metadata Boundary set to EU, Durable Object logs and analytics are not
available outside the US** — the Workers metrics tab for DO goes empty. CMB=EU and our
observability story (#114) are in direct tension. Corroborates
#156.

---

## 4. Endpoint, supply chain, and distribution

### 4.1 `ggshield` — the highest-value single buy

**Confidence: high** (GitGuardian docs, `integrations/ai-coding-tools`, 2026-07-01).

Our README names the risk precisely:

> *"A caller's prompt could induce the agent to read and echo back the callee's Claude
> Code session history (`~/.claude/projects/*`, which can contain pasted secrets and
> private code)"* — README L299

`ggshield` ≥ 1.49 (≥ 1.51 for Codex) **registers as a hook in Claude Code and Codex**,
scanning three stages with 500+ secret detectors:

| Stage | Behavior |
|---|---|
| Prompt submission | **blocks** |
| Pre-tool-use (commands, file reads, MCP calls) | **blocks** |
| Post-tool-use (tool output) | desktop notification |

We already own that seam — `guard-entry.ts` / `guard.ts` are registered as exactly this
hook for both runtimes (`packages/cli/src/runner.ts:50`). Additive, not a rewrite.

**Decide this before adopting, not after:** ggshield is **fail-open** by design — if it
cannot authenticate or the API is unreachable, it allows the action and warns. Our guard
is deliberately fail-closed (`FAIL_CLOSED_REASON`; see the reasoning at
`packages/cli/src/guard.ts:23-28`). Mixing them gives a secret-scanning layer with
weaker semantics than the layer beside it. Acceptable if stated; a hole if discovered
later.

### 4.2 The sandbox gap — and why the obvious vendors are wrong for us

`packages/cli/src/runner.ts:99-104` records what was removed on 2026-07-31:

> *"This used to additionally wrap every spawn in `npx @anthropic-ai/sandbox-runtime
> --settings <file>` … the envelope is enforced by the agent's own permission flags,
> which is the whole of it now."*

And `:124` is blunt: *"it does NOT confine reads: `codex exec --sandbox read-only` still
reads `~/.ssh`."* The guard runs in `observe` mode for Codex — it records and always
allows (`guard.ts:34-38`).

The 2026 agent-sandbox market is large (E2B, Daytona, Modal, Vercel, Cloudflare Sandbox
SDK) and **almost all of it is the wrong shape.** Those are *remote* sandboxes. Our
answering agent must run on the callee's own machine against their own repo — shipping
the customer's source to a third-party sandbox is strictly worse than the problem.

Shapes that fit are local:

- **microsandbox** — local microVMs, Apple Silicon supported, sub-100ms boot,
  embeddable with no daemon, ships Agent Skills and an MCP server for Claude Code and
  Codex. Closest fit. **Self-describes as beta** — treat as a spike, not a dependency.
- **Codex's own kernel-enforced `deny_read`** — which is what #2
  already says. Free, and the right boundary for the Codex path.
- **Apple `sandbox-exec`** — the zero-dependency macOS option.

Cloudflare Sandbox SDK becomes relevant only if we ever offer a hosted-callee mode.

### 4.3 Supply chain — live exposure, free fix

**Confidence: high** — verified against the tree on 2026-08-02.

`.github/workflows/` contains `ci.yml`, `invariants.yml`, `stale-claims.yml`. There is
**no release workflow, and no `npm publish`, `--provenance`, or `id-token: write`
anywhere in the repo.** `@benree/agentcall` v0.4.0 was published by hand, with no
provenance attestation.

This matters more for us than for a typical package:

- The CLI is `npm install -g` and runs **with the user's full privileges** (§4.2)
- `apps/relay/src/install-sh.ts:22` serves a `curl | sh` that runs
  `npm install -g @benree/agentcall` with no integrity check
- #45 notes our docs point at `npx agentcall` — **someone else's
  package**

Fix costs nothing: publish from GitHub Actions with `id-token: write` and
`npm publish --provenance`, or use npm **Trusted Publishing**, which generates
provenance automatically *and* removes the long-lived token. Consumers verify with
`npm audit signatures` (Sigstore-signed, logged in Rekor).

**Note on #161:** it describes a bug in "the release workflow's
`NODE_AUTH_TOKEN` guard," but that workflow is not in the tree. Either the premise is
stale or the file was never committed. Check before working it.

### 4.4 MDM is the enterprise *distribution* channel, not just a control

**Confidence: medium** — the argument is sound and sourced, but no customer has asked
for it yet.

Deploying a terminal AI agent to a Mac fleet is already an MDM exercise, and **Claude
Code's own governance path is a managed settings file pushed to
`/Library/Application Support/ClaudeCode/managed-settings.json` via MDM** — the same
shape as our `managedPolicyFile` (#104).

So "how does IT roll agentcall out to 300 laptops, with policy, and prove it?" has an
existing answer to adopt rather than invent:

- **Fleet** — MIT core, self-hostable, **GitOps-native** (policies as YAML, applied by
  `fleetctl gitops` in CI). Matches how this repo already works, covers Linux (relevant
  to #14), and osquery answers "which machines run the listener, at
  what version."
- **Kandji/Iru** or **Jamf** where the customer already has them — we ship a config
  profile, not an integration.

This also gives #110 a real answer: what is deployed, to whom, under
what policy, becomes a reviewed pull request.

---

## 5. Do not buy

- **Embedding / vector search.** `packages/cli/src/search.ts:1-4` documents the
  decision: *"why this does not need embeddings: the expensive judgment already has a
  [model]."* That reasoning holds, and a vector backend would add a subprocessor for no
  gain.
- **Remote code sandboxes** (E2B, Daytona, Modal). Wrong shape — see §4.2.
- **An authorization engine** (OpenFGA, SpiceDB, Cerbos). Our authorization model is one
  relation — roster membership — living in D1 next to the data. Buying an FGA engine now
  is the "picked the tool before defining the model" mistake the comparisons warn about.
  Revisit if delegation (#112) grows depth.
- **A prompt-injection guardrail product, yet.** Invariant Labs is the interesting one
  (runs locally; its canonical rule is taint-tracking a prompt injection from a tool
  output into a later tool call — the shape of #112). But our guard is a path allow/deny
  list and it works. Buying detection before #114 provides telemetry
  means buying blind.

---

## 6. Proposed backlog

Not filed. Ordered by value per unit of work.

| # | Proposed | Kind | Relates to |
|---|---|---|---|
| 1 | Adopt `ggshield` as a second hook; decide the fail-open/fail-closed mismatch explicitly | `area:security` | #1, #11 |
| 2 | Publish via GitHub Actions with npm provenance / Trusted Publishing | `area:security`, `area:deployment` | #161, #45 |
| 3 | Write the data-flow / security-posture doc — §3.1 is already true and unwritten | `area:enterprise` | #18, #17 |
| 4 | Pin DO and D1 jurisdictions (`us` / `eu`) | `area:enterprise` | #156 |
| 5 | File the D1 Time Travel erasure finding (§3.4) | `area:enterprise`, `kind:bug` | #160, #159 |
| 6 | Reopen and close #20 "stay on DO", citing workerd cluster mode | `kind:decision` | #20, #12, #19 |
| 7 | Decide "buy SSO" and record it; split #15 three ways per #102 | `kind:decision` | #15, #102 |
| 8 | Spike microsandbox for a local confinement boundary | `kind:experiment` | #1, #2, #11 |
| 9 | MDM packaging (Fleet first) as the enterprise install path | `area:deployment` | #14, #110, #104 |

**Sequencing note.** Items 1–5 are cheap and independent. Items 6–7 are decisions that
should be recorded before anyone spends a sprint either way. Items 8–9 wait on a
trigger: #8 on someone owning #1, #9 on the first multi-seat deal.

**Standing constraint, unchanged.** None of this shortens the C track. A perfect relay
posture does not survive one reviewer asking what `exec` can reach — as CLAUDE.md
already says, *"a passing TCK says nothing about safe prompt execution."*
