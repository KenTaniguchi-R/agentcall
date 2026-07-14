# agentcall — design spec

Date: 2026-07-13
Status: approved in brainstorming session (Ryusei + Claude)

## What it is

Call another person's coding agent (Claude Code or Codex) on their Mac, across the
public internet, like a phone call. Install with one command, get an address
(`ken@agentcall.benree.tech`), share the address. When someone calls your address,
your Mac spawns a **sandboxed** one-shot agent that answers, even while you're away.

Explicit non-goals for v1: address book / contacts, store-and-forward, multi-turn
conversations (v1.5), non-macOS platforms, anonymous callers, payment/reputation.

## Decisions log (from brainstorming)

| Decision | Choice |
|---|---|
| Relay hosting | Single shared relay, Ryusei-hosted (Cloudflare Worker + DO + D1) |
| Domain | `agentcall.benree.tech` (temporary) |
| Callee permission model | Sandboxed answerer: fixed cwd `~/AgentCall/public/`, OS sandbox (Seatbelt) |
| Interaction model | One-shot call v1; `--resume` threading v1.5 (schema carries `session_id` from day 1) |
| Address format | Chosen handle: `ken@agentcall.benree.tech`, first-come-first-served, secret token |
| Delivery latency | Instant: resident listener (LaunchAgent KeepAlive) holding a WebSocket |
| Packaging | Approach 1: one npm CLI (`agentcall`) + curl-pipe-sh bootstrap served by the Worker |
| Language | TypeScript everywhere (pnpm workspace); Go binary is a possible v2 packaging change |
| Caller integration | CLI + CLAUDE.md/AGENTS.md skill snippet (no MCP in v1) |
| Caller auth | Callers must be registered; `from` handle is relay-verified; anonymous rejected |
| Method | TDD; Sonnet subagents implement, Fable plans/verifies |

## Architecture

```
A's Claude Code ──bash──► agentcall call ken@… "msg"
                              │ WSS (role=call)
                              ▼
                Cloudflare Worker ─► DO "handle:ken" ◄─ WSS (role=listen)
                     │  D1: handles                        │
                     │                                     ▼
                GET /install.sh                B's Mac: agentcall listen (LaunchAgent)
                                                    │ spawn, cwd ~/AgentCall/public
                                                    ▼
                                         srt claude -p …  /  codex exec --sandbox …
```

### Monorepo layout

```
agentcall/
├── apps/relay/          # CF Worker + Durable Object + D1 (wrangler)
├── packages/shared/     # zod schemas for the protocol; single source of truth
├── packages/cli/        # the `agentcall` npm package (setup/listen/call/status/uninstall)
└── docs/
```

## Protocol (packages/shared)

All WS frames are JSON, validated with zod on both ends. Envelope: `{type, ...}`.

Caller → relay (role=call):
- `call_request {to, message, from, token, session_id?}` — message ≤ 64KB.

Relay → caller:
- `call_status {state: "ringing"|"answered"|"working"}`
- `call_reply {call_id, text, session_id?, exit: "ok"}` — text ≤ 256KB
- `call_error {code, detail}` codes: `unknown_handle | offline | busy | timeout |
  agent_error | unauthorized | rate_limited | message_too_large`

Relay → listener (role=listen, authed by Bearer token):
- `incoming_call {call_id, from, message, session_id?}`

Listener → relay:
- `call_answer {call_id}` (accepted, spawning)
- `call_result {call_id, text, session_id?}` / `call_failed {call_id, code, detail}`
- `pong` (relay pings for liveness)

## Relay (apps/relay)

- **D1** table: `handles(handle TEXT PK, token_hash TEXT, agent_kind TEXT, created_at INTEGER)`.
  Handle rules: `^[a-z0-9][a-z0-9-]{1,30}$`, lowercase, reserved list (admin, www, relay…).
  Token: 32 random bytes base64url, stored as SHA-256 hash. Verify = hash compare.
- **Routes** (Hono):
  - `GET /install.sh` → static bootstrap script (text/x-shellscript).
  - `POST /v1/register {handle, agent_kind}` → `{token, address}` or 409.
  - `GET /v1/status/:handle` → `{online}` (asks DO).
  - `GET /v1/ws?role=listen` (Authorization: Bearer token, handle derived) → DO.
  - `GET /v1/ws?role=call` → DO of the **target** handle; auth happens on first frame
    (`call_request` carries from+token, validated against D1 before forwarding).
- **Durable Object `HandleDO`** (one per handle, addressed by name):
  - Holds ≤1 listener socket (new listener connection replaces old) using WebSocket
    Hibernation API; ping/pong keepalive.
  - In-flight calls map `call_id → caller socket`. `crypto.randomUUID()` call ids.
  - Rate limit: 10 calls/hour per caller handle (in-DO sliding window).
  - Relay semantics: no listener attached → `call_error offline` immediately.
    Listener attached → forward `incoming_call`, emit `ringing`; on `call_answer`
    emit `answered`; pipe `call_result`/`call_failed` back; 6-minute relay-side
    hard timeout per call (listener kills the agent at 5).
  - Socket close with in-flight calls → `call_error` to the counterparties.

## Listener (packages/cli — `agentcall listen`)

- Run by LaunchAgent `tech.benree.agentcall.listener.plist` (KeepAlive true,
  RunAtLoad true, stdout/err → `~/.agentcall/listener.log`).
- Connects WSS with backoff (1s→60s cap, jitter). Serial queue: 1 running,
  ≤5 pending, overflow → `call_failed busy`.
- Per call: append JSONL audit line to `~/.agentcall/calls.log`
  `{ts, call_id, from, message, status, duration_ms}`.
- Spawn (agent_kind from config):
  - `claude`: `npx -y @anthropic-ai/sandbox-runtime --settings ~/.agentcall/srt.json --`
    `claude -p <prompt> --output-format json`, cwd `~/AgentCall/public`.
    srt.json: allowWrite `~/AgentCall/public`, `~/.claude`, `~/.claude.json`, tmp;
    network allow: `api.anthropic.com`, `statsig.anthropic.com`, `sentry.io`;
    denyRead: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.agentcall`, `~/.config`.
  - `codex`: `codex exec --sandbox workspace-write --cd ~/AgentCall/public
    --skip-git-repo-check <prompt>` (native Seatbelt; network off by default).
- Prompt preamble prepended to every call:
  "You are {handle}'s public agent answering a one-shot call from {from}.
   You can only access ~/AgentCall/public. Answer helpfully and concisely.
   Caller's message follows." — caller message included verbatim after a divider.
- Result: claude → parse `--output-format json`, take `result` field; codex → stdout
  tail. Truncate to 256KB. 5-minute kill timer (SIGTERM then SIGKILL).
- v1.5 hook: capture claude `session_id` from JSON output and return it.

## CLI (packages/cli)

Commands:
- `agentcall setup [--handle H] [--agent claude|codex]` — interactive (reads /dev/tty):
  detect agents on PATH, prompt handle, POST /v1/register, write
  `~/.agentcall/config.json` (0600) `{handle, token, agent_kind, relay}`, write
  srt.json, mkdir `~/AgentCall/public`, install + load LaunchAgent, offer to append
  usage snippet to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, print address.
- `agentcall listen` — internal (LaunchAgent target), also runnable manually.
- `agentcall call <address> <message> [--json]` — spinner states ringing/answered/
  working; prints reply text to stdout; nonzero exit + stderr message on error.
  `--json` prints the full reply envelope (for agents).
- `agentcall status <address>` — online/offline via GET /v1/status.
- `agentcall uninstall` — unload LaunchAgent, remove plist; keeps config unless
  `--purge`.
- Config/env: `AGENTCALL_RELAY` overrides relay URL (dev/testing).

## install.sh (served by the Worker)

Darwin check → node ≥ 20 check → `npm install -g agentcall` → `exec agentcall setup < /dev/tty`.
Flags pass through: `curl … | sh -s -- --handle ken`.

## Security model (v1, explicit)

- Address = capability to call. Callers must themselves be registered (verified `from`).
- The spawned agent is Seatbelt-sandboxed; writes confined to `~/AgentCall/public`
  (+ claude state dirs); secrets dirs denyRead; relay token unreadable from sandbox.
- The callee's own API/subscription pays for answering — acceptable for v1 friends-scale.
- Known residual risks (accepted): prompt injection can burn callee tokens and write
  junk into `~/AgentCall/public`; Seatbelt default-allows most reads (mitigated by
  denyRead list, not eliminated); relay operator can read message plaintext (no E2E
  in v1).

## Testing (TDD)

- `packages/shared`: schema round-trip + rejection tests (vitest).
- `apps/relay`: DO logic via `@cloudflare/vitest-pool-workers` — register (dup 409,
  bad handle 400), auth failures, offline call, happy-path call relay (fake listener
  + fake caller sockets), busy, timeout, rate limit.
- `packages/cli`: unit-test protocol client + runner arg-building + config IO with
  mocked ws/fs; runner parsing of claude/codex output fixtures. LaunchAgent install
  = template snapshot test. No live-agent spawn in CI.
- e2e (manual, post-build): MacBook ↔ Mac mini over real internet.

## v1.5 (deliberately deferred, schema-ready)

`agentcall call --continue <call_id>` → relay looks up session_id → listener passes
`claude -p --resume <session_id>` / `codex exec resume`. CLI+listener change only.
