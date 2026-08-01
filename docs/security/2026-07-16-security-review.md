# Security review — relay, CLI, and sandbox layer

> **⚠️ Superseded in part — the sandbox layer this reviews no longer exists.**
>
> On **2026-07-31** the OS-level sandbox (`@anthropic-ai/sandbox-runtime` /
> Seatbelt, `~/.agentcall/srt.json`) was removed deliberately: the answering
> agent is meant to be the owner's real agent with their real context, which a
> confined fresh spawn cannot be. Every finding, mitigation, and residual-risk
> statement below that depends on `denyRead`/`denyWrite`, the network
> allowlist, or write confinement to `~/AgentCall/public` **no longer holds**.
>
> What remains as enforcement: capability scoping (`--allowedTools` for claude,
> `--sandbox` level for codex) and pre-prompt task resolution. Within a granted
> capability, nothing constrains where the agent reads or writes.
>
> The relay-side and CLI-side findings here are unaffected and still apply.
> For the current posture see the security model section of
> [README.md](../../README.md). **A fresh review of the post-sandbox design has
> not been done.**

**Date:** 2026-07-16
**Status:** Findings documented, fixes not yet implemented
**Scope:** Full manual read of `apps/relay/src`, `packages/cli/src`, `packages/shared/src`
(~2,650 lines) plus D1 migrations and `wrangler.jsonc`. No automated scanner was
run; findings are from direct code reading plus one external verification (see
Finding 1).

This is a findings record, not an implementation plan. Fixes are intentionally
deferred to a follow-up pass so the findings can be reviewed/prioritized first.

## Summary table

| # | Severity | Area | One-line |
|---|----------|------|----------|
| 1 | High | Task capability model | `exec`/`fetch` caps are unenforced for codex-backed agents — only `write` maps to anything |
| 2 | Medium | Listener error handling | Internal error text (agent stderr, policy-parse errors) is relayed verbatim to the calling party |
| 3 | Medium | Protocol schema | `session_id` in `CallRequest` has no length bound, unlike `message` |
| 4 | Low | Relay auth | Token-hash comparison is `===`, not constant-time |
| 5 | Low | Relay rate limiting | `/v1/register` and `PUT /v1/card` have no throttling |
| 6 | Low | Relay rate limiting | Oversized frames are rejected before the per-hour counter is touched, so they never get throttled |

---

## Finding 1 (High) — codex-backed agents get no execution restriction from the task capability model

**Files:** `packages/cli/src/runner.ts:37-47,76-84`, `packages/cli/src/tasks.ts`
(`SkillFrontmatter.tools`), `packages/cli/src/srt.ts` (`ALLOWED_DOMAINS`/envelope
wiring)

### What the code does

A task's `SKILL.md` frontmatter declares `tools: [read | write | fetch | exec]`
(`tasks.ts:55`), which becomes an `Envelope` (`caps`, `write_paths`, `network`)
passed into `runAgent`/`buildSpawnSpec`.

For **Claude**, `claudeAllowedTools` (`runner.ts:44-47`) maps each cap to
concrete tool names and passes them via `--allowedTools` with
`--permission-mode dontAsk` (`runner.ts:62-64`). A task declared with
`tools: [read]` genuinely cannot invoke `Bash`, `Write`, or `Edit` — Claude
Code enforces the allowlist and denies everything else outright (no prompting,
since `-p` is headless).

For **codex**, there is no equivalent mapping. `buildSpawnSpec`'s codex branch
(`runner.ts:76-84`) does exactly one thing with the envelope:

```ts
const sandbox = envelope.caps.includes("write") ? "workspace-write" : "read-only";
```

`--sandbox read-only` / `--sandbox workspace-write` are **codex's own sandbox
levels**, not a tool allowlist. `fetch` and `exec` caps have no effect on the
codex spawn at all — they aren't consulted anywhere in the codex branch.

### Why this matters

Verified against OpenAI's own docs (`docs/sandbox.md` in `openai/codex`, and
the Codex CLI sandboxing reference):

> **read-only** — Reading files anywhere on the filesystem. No write
> operations. Network access (if enabled). *Use for: Code analysis, searching,
> reviewing.*

Read-only mode restricts **writes only**. It does not restrict command
execution — codex can still run arbitrary shell commands under `--sandbox
read-only`; it just can't write files. (srt's own network allowlist is a
separate, always-on layer regardless of this — see "What already mitigates
this" below.)

Net effect: a task author who writes `tools: [read]` in a SKILL.md, expecting
"this task cannot execute commands," gets that guarantee only if the owner's
`agent_kind` is `claude`. If it's `codex`, the same frontmatter grants a task
that can still execute arbitrary read/list/network-capable shell commands —
silently, with no warning anywhere in the setup flow, `agentcall card` output,
or the `SKILL_TEMPLATE` scaffold (`tasks.ts:138-153`) that this guarantee
doesn't hold for codex.

### What already mitigates this

- srt (`@anthropic-ai/sandbox-runtime`) wraps codex too (`runner.ts:68-76`),
  so filesystem reads are still deny-by-default outside `publicDir` +
  allowlisted dirs, and network is still confined to `ALLOWED_DOMAINS.codex`
  plus `envelope.network` (`srt.ts:74-77,149-152`) regardless of codex's own
  sandbox mode. A codex task with only `read` cap can execute shell commands,
  but srt still stops it from reading `~/.ssh`, writing outside `publicDir`,
  or reaching arbitrary hosts.
- The actual damage window is "arbitrary shell exec confined to srt's
  filesystem/network boundary," not "arbitrary shell exec, full stop." That's
  a meaningfully smaller blast radius than a naive reading of the gap
  suggests — but it's still strictly more than what the `tools: [read]`
  frontmatter promises the task owner.

### Suggested direction (not yet implemented)

Two independent options, not mutually exclusive:
1. Surface the asymmetry — warn in `agentcall card`/`task new` output when
   `agent_kind: codex` and a task's caps exclude `exec`, since the exec
   restriction won't actually apply.
2. Look at whether codex's approval-policy flags (`--ask-for-approval never`
   combined with a policy that denies shell tool calls, if codex exposes one)
   can approximate per-tool denial the way Claude's `--allowedTools` does. If
   codex has no such mechanism, cap (1) may be the only honest fix short of
   dropping the `exec`/`fetch` distinction for codex tasks entirely and
   documenting that codex tasks are always exec-capable.

---

## Finding 2 (Medium) — internal error text is relayed verbatim to the calling party

**Files:** `packages/cli/src/listener.ts:64-66,91`, `packages/cli/src/policy.ts`
(errors thrown from `loadPolicy`/`resolveTask` propagate into the listener's
catch blocks), `packages/cli/src/runner.ts:217` (stderr embedded in the thrown
`AgentRunError` message)

### What the code does

Any registered handle can call any other handle's agent, gated only by the
callee's `policy.json` (`block`/`offer`). When the local agent process errors
out, `runAgent` throws `AgentRunError` with a message that includes up to
2000 characters of the spawned process's stderr (`runner.ts:217`). The
listener catches this and sends up to 500 characters of `String(e)` straight
back to the caller as `call_failed.detail` (`listener.ts:91`). A malformed
`policy.json` produces a similar path: the zod parse error is stringified,
truncated to 300 characters, and sent to whichever caller happened to trigger
the load (`listener.ts:64-66`).

### Why this matters

The calling party in this design can be anyone who knows the callee's handle
and isn't explicitly blocked — not necessarily someone the callee trusts with
diagnostic detail about their own machine. Stderr from `claude`/`codex` or a
zod validation error can plausibly include local file paths (revealing the
owner's home directory / username), environment specifics, or fragments of
the owner's task/policy configuration. An external caller who wants to probe
the callee's local setup has an easy way to do it: send a message likely to
crash the agent (or is offered a task with a broken `SKILL.md`) and read the
`call_failed.detail` that comes back.

### Suggested direction (not yet implemented)

Return a generic `agent_error`/`policy_error` message to the caller by
default; keep the full detail in the local audit log (`calls.log`, which
already captures `status`/`duration_ms` per call — `listener.ts:88,92`) where
only the machine owner can read it. If detail-to-caller is wanted for
debugging, gate it behind an explicit opt-in rather than making it the
default.

---

## Finding 3 (Medium) — `session_id` in `CallRequest` has no length bound

**File:** `packages/shared/src/protocol.ts:31` (`CallRequest.session_id`)

### What the code does

```ts
export const CallRequest = z.object({
  type: z.literal("call_request"),
  to: z.string().regex(HANDLE_RE),
  message: z.string().min(1),
  session_id: z.string().optional(),
  task: z.string().regex(TASK_ID_RE).optional(),
});
```

`message` is capped at `MAX_MESSAGE_BYTES` (64,000 bytes), enforced explicitly
in the DO before anything else happens (`do.ts:91-93`). `session_id` has no
`.max()` at all, and the DO never checks its size.

### Why this matters

This is a real gap relative to the size discipline the rest of the protocol
takes seriously (`MAX_MESSAGE_BYTES`, `MAX_REPLY_BYTES`, `MAX_OFFERED_TASKS`
are all explicit, commented constants — see `protocol.ts:5-19`). A caller can
send a `session_id` far larger than 64KB, bounded only by whatever ceiling
Cloudflare's own WebSocket/Worker request-size limits impose rather than by
the app's declared cap.

Current blast radius is small: the DO forwards `session_id` to the listener
in `incoming_call` (`do.ts:109-112`), but `listener.ts:53` destructures only
`{ call_id, from, message, task: requestedTask }` off the frame — the
oversized `session_id` is read off the wire and then silently dropped. It
isn't persisted (`CallRecord` at `do.ts:10` doesn't include it) and isn't
used in `buildPrompt`. So today this is wasted bandwidth/parse cost, not a
storage or prompt-injection amplifier — but it's still an unbounded
attacker-controlled string moving through the system, and any future code
that starts using `session_id` (e.g. to thread multi-turn conversations)
would inherit the gap silently.

### Suggested direction (not yet implemented)

Add a `.max()` to `session_id` (and consider one for `task`, though it's
already constrained by `TASK_ID_RE`'s length-bounded pattern) consistent with
the other size constants in `protocol.ts`.

---

## Finding 4 (Low) — token-hash comparison is not constant-time

**File:** `apps/relay/src/auth.ts:14`

```ts
return row.token_hash === (await sha256Hex(token));
```

Comparing two SHA-256 hex digests with `===` is a non-constant-time
comparison. In practice this is very hard to exploit over a network (the
avalanche effect means a timing signal would need to distinguish
individual-byte-correct hash prefixes against noise from network jitter and
Worker cold starts), and the underlying secret has 256 bits of entropy
(`generateToken`, `auth.ts:6-9`) regardless. Still, this is the entire bearer-
auth mechanism for the relay, and a constant-time compare (e.g. via
`crypto.subtle`-compatible constant-time byte comparison, or comparing
`Uint8Array`s in constant time) costs nothing to add and fully closes the
theoretical side channel.

---

## Finding 5 (Low) — no rate limiting on `/v1/register` or `PUT /v1/card`

**File:** `apps/relay/src/index.ts:23-37` (`/v1/register`), `:46-57`
(`PUT /v1/card`)

Both endpoints have no application-level throttling beyond whatever
Cloudflare's platform-level abuse protection provides. `/v1/register` allows
unlimited handle-registration attempts (handle squatting/enumeration,
D1 write spam); `PUT /v1/card` allows unlimited card republishing by anyone
holding a valid token for a handle (D1 write spam bounded by however many
handles one attacker controls). Neither is exploitable for privilege
escalation — it's a resource-exhaustion/cost concern, not an auth bypass.

---

## Finding 6 (Low) — oversized frames dodge the per-hour rate limit

**File:** `apps/relay/src/do.ts:91-97`

```ts
if (new TextEncoder().encode(frame.message).byteLength > MAX_MESSAGE_BYTES) {
  return this.fail(ws, "message_too_large");
}
const now = Date.now();
const rlKey = `rl:${att.from}`;
const stamps = ((await this.ctx.storage.get<number[]>(rlKey)) ?? []).filter((t) => now - t < 3_600_000);
if (stamps.length >= RATE_LIMIT_PER_HOUR) return this.fail(ws, "rate_limited");
```

The `message_too_large` check runs and returns before the rate-limit counter
is read or incremented. A caller can send unlimited over-cap frames without
ever tripping `RATE_LIMIT_PER_HOUR` — none of them reach the listener/agent
(so no agent-spawn cost), but each one still costs relay-side compute
(DO wake, WS message parse) for free, indefinitely.

---

## What's already done well (for context, not action items)

- `spawn()` is always called with an args array, never through a shell —
  no command-injection surface from the caller's message reaching the local
  process (`runner.ts`).
- `srt.ts`'s sandbox design is unusually careful: deny-by-default home-
  directory reads with an explicit allowlist, `denyWrite` carve-outs for
  persistence surfaces (`CLAUDE.md`, hooks, settings, plugins, commands,
  agents, skills), and a documented, deliberate residual-risk call on
  `~/.claude.json` with explicit rationale (`srt.ts:56-64`).
- Task resolution happens strictly before the caller's message enters any
  prompt — the "CaMeL invariant" comment at `policy.ts:56-58` documents this
  explicitly, and `resolveTask` only ever consumes relay-verified `from` and
  local files.
- `X-Verified-From` on the Durable Object is set server-side only after
  `verifyHandleToken` succeeds (`index.ts:93,108`); the DO's `fetch` isn't
  publicly routable (`wrangler.jsonc` only routes the Worker, not the DO
  directly), so the header can't be spoofed by an external client.
- Token generation uses `crypto.getRandomValues` over 32 bytes — full
  256-bit entropy, making brute-force infeasible independent of any rate-
  limiting gaps noted above.
- Truncation helpers (`truncateUtf8`/`truncateUtf8Bytes`) correctly cut on
  UTF-8 codepoint boundaries rather than UTF-16 code units, avoiding
  corruption of non-ASCII replies.

---

## Suggested priority for a follow-up fix pass

1. Finding 1 (codex exec-cap gap) — highest severity, and the fix is mostly
   documentation/warning-surfacing rather than a deep architecture change.
2. Finding 2 (error detail leak) — straightforward: stop forwarding raw
   error text to callers by default.
3. Finding 3 (`session_id` bound) — one-line schema change.
4. Findings 4-6 — low severity, cheap to fix, can be batched together.
