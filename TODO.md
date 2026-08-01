# TODO — open work and status

**This file is the single place status is tracked.** It holds *what is open and how far
along it is*, never *why* or *how* — that lives in the linked docs, which stay
unrevised per the repo's doc conventions. When work lands, update the status here and
add a forward-pointer in the source doc rather than editing its checkboxes.

Last reviewed: **2026-08-01**

| Status | Means |
|---|---|
| `open` | Not started. No design. |
| `designing` | Being specced right now. |
| `gated` | Design exists and is complete, but implementation is **blocked** on a stated precondition. Do not start coding. |
| `in progress` | Being implemented. |
| `partial` | Some of it shipped; the rest is still open. Read the item. |
| `deferred` | Deliberately not being worked on, by a recorded decision. **Not** the same as `open` — don't pick it up without reopening the decision. |
| `done` | Shipped, or the question is answered. |

Item IDs (`A.1`, `C.2`, …) match the backlog in
[cotal-enterprise-installability](./docs/research/2026-08-01-cotal-enterprise-installability.md#backlog),
which is the origin of the lettering. Ordering there is by *how hard it blocks a deal*,
not effort — preserved here.

---

## In flight

| Item | Status | Note |
|---|---|---|
| [A2A track](#a2a-conformance-track) | `designing` | **Owned by a separate session.** Don't pick up S2–S4 without checking. |
| [C.2 — Codex read floor](#c-endpoint-security--the-argument-to-win) | `gated` | P1 and P3 now **pass**, P4 partial. **P2 is the sole remaining fatal precondition** and is the critical path — it needs its own experiment design, not another run of the script. |

---

## A2A conformance track

Spec: [a2a-adoption-design](./docs/superpowers/specs/2026-08-01-a2a-adoption-design.md).
Binding pinned to **REST**; TCK pinned at `5996b79`; A2A spec pinned at **v1.0.0**.

| # | Spike | Status | Note |
|---|---|---|---|
| S1 | Run the pinned TCK against the per-handle URL + discovery topology | `done` | Topology validated against the real suite. **69.8% MUST / 100% SHOULD / 100% MAY** baseline. Six missed normative requirements surfaced (AIP-193 numeric `error.code`, §5.4 error mapping, `A2A-Version` validation, terminal-state guards, bare-`Message` returns, artifact part shapes). Stub was throwaway and is **not** committed. |
| S2 | **Task store** — a task retrievable by ID for the current call lifetime | `open` | Forced by A2A conformance alone: `GetTask` / `ListTasks` / `CancelTask` must work when a caller's connection drops mid-call. Replaces today's socket-scoped model, but only for the existing ~6-minute lifetime, and **builds on the current Cloudflare stack** — *not* blocked on [D.2](#d-availability--parity-with-cotal). Scope confirmed 2026-08-01: task store only, mailbox stays out. |
| S3 | A2A principal → agentcall caller identity mapping | `open` | Missing from the first draft entirely. Identity today is a bearer token + `X-AgentCall-Handle` (`apps/relay/src/index.ts:154`). Until this exists the policy engine cannot make its defining decision. |
| S4 | Endpoint security + threat model as a hard release gate | `open` | Same work as [C.4](#c-endpoint-security--the-argument-to-win). |

**Release gate.** A2A implementation may proceed behind a non-production flag. **Public
or enterprise deployment is blocked on C.1–C.4** *and* on S3. A passing TCK says nothing
about safe prompt execution.

**Upstream watch.** Re-check `a2aproject/A2A` when the TCK moves off v1.0.0. As of
2026-07-31 (`2cdf197`) the only post-1.0 normative change is a `tenant` clarification,
which favours this design.

---

## A. Deployment surface — deal blockers

| # | Item | Status | Note |
|---|---|---|---|
| A.1 | **Self-hostable relay** | `open` | A Worker operated by one person fails any data-residency clause. Deletes the single-shared-relay assumption in `apps/relay`. Entangled with S2/D.2 — decide the transport question before building. |
| A.2 | **Remove "the relay operator sees plaintext"** | `open` | Either E2E encryption, or A.1 makes the operator the customer's own IT. Currently in README *Limitations*. |
| A.3 | **Non-macOS callee** | `open` | LaunchAgent listener is Mac-specific. Dropping Seatbelt removed the technical constraint; the work is a Linux service unit + container story. Also the reason [C.2](#c-endpoint-security--the-argument-to-win) can't lean on a macOS-only Seatbelt profile. |

## B. Enterprise apparatus — procurement blockers

| # | Item | Status | Note |
|---|---|---|---|
| B.1 | **SSO / SCIM and org tenancy** | `open` | Handles are registered ad hoc against a shared relay; enterprises expect identity from their IdP. |
| B.2 | **Handle release / reclaim** | `open` | **Offboarding blocker, not a nicety.** Impossible by design today — the DO is addressed by handle name, so a re-registered handle inherits the prior owner's state and every saved contact silently resolves to a different person. Touches `apps/relay` DO addressing → **conflicts with the A2A session**; hold until that lands. |
| B.3 | **Admin console + org-level audit export** | `open` | `calls.log` / `tools.log` are per-machine JSONL. Compliance wants a queryable org-wide trail with retention. |
| B.4 | **SOC 2 path** | `open` | Not a feature; gates the deals the demand research targets. |

## C. Endpoint security — the argument to win

| # | Item | Status | Note |
|---|---|---|---|
| C.1 | **Close or bound the `exec` gap** | `open` | A task granting `exec` has no read floor; shell commands are recorded, not blocked. The single line a security architect stops on. Either bound it or write down why the task envelope is the control. **C.2 cannot close before this** — for Codex, the whole tool surface *is* the `exec` gap. |
| C.2 | **Codex read floor** (was "read-guard parity" — renamed in the doing) | `partial` → `gated` | **Shipped:** guard registered on the Codex spawn in *observe* mode, `--ignore-user-config` (the owner's MCP servers were a complete bypass), `~/.codex` added to denied paths, guard fail-closed exits fixed (they were failing *open* under Codex). **2026-08-01:** the observe-mode guard was found to have never actually run — Codex requires persisted hook trust and silently skipped the inline `-c` hook, so there was no Codex telemetry at all. **Attempted fix reverted** — the bypass grants execution to untrusted hooks from surviving config layers ($CODEX_HOME/hooks.json still loads). Bug stands unfixed; narrow `trusted_hash` fix undecided. See CHANGELOG *Unreleased*. **Open:** the floor itself — see below. |
| C.3 | **Make the policy envelope legible to a non-engineer** | `open` | `policy.json` + `resolveTask()` is the right foundation, but security teams need to *read* the granted surface as policy, not infer it from frontmatter. Deliverable: a rendered per-caller/per-task capability report. Self-contained, `packages/cli` only — no conflict with other tracks. |
| C.4 | **Endpoint-agent threat model as a standalone doc** | `open` | We're asking for an inbound-instruction daemon on every dev machine holding real credentials. Best written *after* C.2's preconditions resolve, since P1/P2 determine what it can claim. Same item as S4. |

### C.2 preconditions — rounds 1–2 verified 2026-08-01

Design: [codex-read-floor-design](./docs/superpowers/specs/2026-08-01-codex-read-floor-design.md#preconditions--all-unproven-all-blocking).
Mechanism is Codex's **own** kernel-enforced `deny_read` (agentcall can only *require and
verify* it, never set it — it lives in root-owned `/etc/codex/requirements.toml`).
Verified against codex-cli **0.146.0**. Ordered by how badly failure damages the design.

| # | Precondition | Status | If it fails |
|---|---|---|---|
| P1 | User config cannot weaken requirements | **`pass`** | Was *"design collapses entirely."* **Verified with root 2026-08-01: 7/7 denied** — `-c` overrides, `--sandbox danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, a planted user-writable `CODEX_HOME`, and a **nested codex** launched from inside the sandboxed shell (the case argv ownership does not cover). Ceiling semantics are now tested, not inferred. Residual: malformed-requirements handling untested — a silently-skipped bad file would be fail-open. |
| P2 | `deny_read` covers every local-read surface, not just shell | `open` | **`deny_read` is not a floor** and the design dies the same way the hook did. Killed the first draft. **Now two suspects, not one:** the bundled `codex_apps` tools, and **`codex-code-mode-host`** — a sibling helper process started on every spawn even under `--ignore-user-config`. Blocked behind P1's root step. Note the obvious test does not work: Codex applies Seatbelt in-process, with **no `sandbox-exec` wrapper** to look for. |
| P3 | The `deny_read` schema is real and stable | **`pass`** | Confirmed against first-party source (`permissions_toml.rs`, `protocol/src/permissions.rs`), not binary strings. Bonus: `deny` is the **only** mode accepting glob paths, which is what `DENIED_BASENAMES` needs. `glob_scan_max_depth` is real and must be set explicitly. |
| P4 | Enforcement verified per platform and per sandbox mode | `partial` | **macOS/arm64 now verified** — the round-2 baseline is the first direct evidence `deny_read` enforces at all; everything prior was linked symbols. Linux and Windows unverified, so claim "verified on macOS, designed to be cross-platform." |
| P5 | Version qualification | `open` | 0.146.0 is now a qualified version, and `scripts/verify-codex-deny-read.sh` makes re-qualification a repeatable check. `doctor` must still fail closed on any version not on the list. |

Implementation, once cleared: (1) `agentcall codex-requirements` prints a fragment for an
admin to install — agentcall never writes `/etc`; (2) `doctor` proves the floor with a
**behavioural canary**, distinguishing `configured` / `effective` / `enforced` — only
`enforced` counts; (3) `agentcall listen` refuses Codex-routed calls absent `enforced`;
(4) the hook stays in observe mode.

**Honest-claim ceiling:** even when enforced, this is a *credential floor for the paths
named* — not read isolation. Secrets in source trees, browser profiles, `.git` history,
and env vars stay readable.

## D. Availability — parity with Cotal

| # | Item | Status | Note |
|---|---|---|---|
| D.1 | **Synchronous call → durable mailbox**, with presence and fall-back-to-human | `deferred` | The conclusion of two prior docs; Cotal shipping it makes this parity, not roadmap. Requirements: [durable-offline-delivery-requirements](./docs/superpowers/specs/2026-08-01-durable-offline-delivery-requirements.md) — *"Do not implement from this,"* it states what must be decided. This is the **separate** half from [S2](#a2a-conformance-track): extending a task's lifetime from minutes to days so a call survives a sleeping laptop. That is what drags in storage substrate, retention, quotas and delivery leases, and it waits on D.2. |
| D.2 | **Decide: own the wire, or ride a mesh** | `deferred` | If durable delivery + presence + roster is the destination, NATS/JetStream gives all three free and we're otherwise rebuilding them on DO + D1. **Deliberately unopened as of 2026-08-01.** Build the A2A work on Cloudflare as-is with offline still failing fast — that delivers the procurement claim without touching the transport question, and makes the eventual evaluation better, since NATS-vs-DO gets judged against a persisted-task shape that exists in real code. |

## E. Positioning

| # | Item | Status | Note |
|---|---|---|---|
| E.1 | **Adopt the A2A `AgentCard` shape for `agentcall card`** | `designing` | Superseded in scope by the [A2A track](#a2a-conformance-track), which goes further than the card. |
| E.2 | **Reconcile GTM sequencing with the differentiator** | `open` | Demand doc sequences non-EU, non-unionised 100–500 person orgs first; our sharpest differentiator ("we don't ingest your employees' data") is worth most to the EU-exposed, regulated buyers that sequencing defers. One of the two should move. Confidence: **medium** — inference from two docs, not new research. |

---

## Product gaps not in the backlog

From README *Limitations*. Listed because they're real open work, not because they block a deal.

| Item | Status | Note |
|---|---|---|
| **Multi-turn calls** (`agentcall call --continue`) | `open` | One-shot only today. The protocol already carries an optional `session_id` to thread through `--resume`; unimplemented. Was pencilled for v1.5. |
| `agentcall search` — resolving *who* to ask | `open` | Every doc assumes the caller already knows the address; in a 500-person org they don't. Discovery is a separate problem from calling, and only calling is built. Surfaced by [lessons-from-composio](./docs/research/2026-07-31-lessons-from-composio.md). |

## Known debt

| Item | Status | Note |
|---|---|---|
| `tsconfig.test.json` | `open` | Each package's `tsconfig.json` is `"include": ["src"]`, so `typecheck` does not cover `test/`. Change a signature and typecheck stays green while every stale call site fails at runtime. `pnpm -r test` is currently the only thing that catches it. See CLAUDE.md. |
