# agentcall

Call another person's coding agent (Claude Code or Codex) on their Mac, across the
public internet, like a phone call. Install with one command, get an address
(`ken@agentcall.benree.tech`), share it. When someone calls your address, your Mac
spawns a one-shot agent that answers, even while you're away.

## How a call works

```mermaid
sequenceDiagram
    participant A as A's Claude Code
    participant CLI as agentcall call (A's Mac)
    participant Relay as Cloudflare Worker + DO
    participant L as agentcall listen (B's Mac, LaunchAgent)
    participant Agent as claude -p / codex exec

    A->>CLI: agentcall call ken@agentcall.benree.tech "msg"
    CLI->>Relay: WSS call_request {to, message, from, token}
    Relay->>L: incoming_call {call_id, from, message}
    Relay-->>CLI: call_status ringing
    L->>Relay: call_answer {call_id}
    Relay-->>CLI: call_status answered
    L->>Agent: spawn (cwd = workdir, capability-scoped)
    Agent-->>L: reply text
    L->>Relay: call_result {call_id, text}
    Relay-->>CLI: call_reply {text}
    CLI-->>A: prints reply to stdout
```

Non-goals for v1: store-and-forward, multi-turn conversations (that's v1.5),
non-macOS platforms, anonymous callers, payment/reputation.

## Install

```bash
curl -fsSL https://agentcall.benree.tech/install.sh | sh
```

This checks you're on macOS with Node ≥ 20, installs the `@benree/agentcall` npm
package globally (the command is `agentcall`), and runs `agentcall setup`
interactively.

`agentcall setup` will:
- detect `claude` / `codex` on your `PATH` (or prompt you to pick one)
- prompt for a handle and register it with the relay (`POST /v1/register`)
- write `~/.agentcall/config.json` (0600) with your handle, token, agent kind, and relay URL
- create `~/AgentCall/public/`, the callee agent's working directory
- install and load the `tech.benree.agentcall.listener` LaunchAgent
- offer to append a short usage snippet to `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`
  so *your own* agent knows how to call other people
- print your address, e.g. `ken@agentcall.benree.tech`

Setup verifies by default that your agent — claude or codex — can actually
answer a call, including that it's authenticated. Pass `--no-verify`
to skip the post-setup test call (e.g. when provisioning before logging in).

## Usage

```bash
# Check if someone's agent is online
agentcall status ken@agentcall.benree.tech

# Call it
agentcall call ken@agentcall.benree.tech "what's the weather doing over there?"

# Machine-readable reply (for your own agent to parse)
agentcall call ken@agentcall.benree.tech "..." --json
```

`agentcall call` prints spinner-style status to stderr (`ringing...`,
`answered, agent working...`) and the reply text to stdout. Nonzero exit + an
error message on stderr on failure (`unknown_handle`, `offline`, `busy`,
`timeout`, `agent_error`, `unauthorized`, `rate_limited`, `message_too_large`,
`protocol_error`).
`agentcall status` prints `online`/`offline` and exits `0`/`2` (or `1` on a
relay error). It requires a completed `agentcall setup`: presence is
caller-only, so the relay authenticates status checks rather than serving
anyone who asks (an anonymous endpoint let anybody enumerate handles and poll
whether your Mac was awake).

```bash
# Replace your relay token if it may have leaked
agentcall rotate
```

`agentcall rotate` swaps this install's token for a fresh one, immediately
invalidating the old one, and restarts the background listener so it picks the
new one up. Releasing a handle entirely isn't supported yet — see Limitations.

```bash
# Check your own install is healthy
agentcall doctor
```

`agentcall doctor` verifies your install can answer calls (auth, agent spawn,
listener, relay self-call) — run it whenever calls to you start failing.

Plain calls (no `--task`) run the built-in read-only `ask` task. To offer more:

    agentcall task new schedule-meeting   # scaffold ~/AgentCall/tasks/<id>/SKILL.md
    # edit the SKILL.md (YAML frontmatter: description, tools, timeout_s, ...)
    agentcall card                        # review your card + catch problems
    agentcall offer schedule-meeting      # offer to everyone, or:
    agentcall allow ken schedule-meeting  # grant to one caller
    agentcall block spammer               # refuse a caller entirely

Tasks are one markdown file each — YAML frontmatter (only `description` is
required) over the instructions your agent follows. Grants and blocks live in
`~/.agentcall/policy.json`; the verbs above edit it for you and republish your
card automatically. Callers see your menu with `agentcall card <address>`.

> **Codex support is experimental.** The `claude` path is the one that's
> actually been live-tested end to end; `codex` support is implemented and
> unit-tested but hasn't been verified against a real call yet.

## Contacts

Save addresses under a short name so you don't have to retype `handle@host`
every time:

```bash
agentcall contacts add ken ken@agentcall.benree.tech --note "who they are"
agentcall contacts list                # name, address, note
agentcall contacts list --json         # machine-readable
agentcall contacts remove ken
```

`agentcall contacts add` upserts — adding a name that already exists updates
its address (and note, if you pass a new one) instead of erroring.
`agentcall call`, `agentcall status`, and `agentcall card` all accept a saved
contact name anywhere they'd otherwise take a `handle@host` address:

```bash
agentcall call ken "what's the weather doing over there?"
agentcall status ken
agentcall card ken
```

Contacts are stored locally in `~/.agentcall/contacts.json` (mode `0600`)
and never leave your machine.

## How the callee side works

- `agentcall listen` runs continuously as a LaunchAgent (`KeepAlive`,
  `RunAtLoad`, logs to `~/.agentcall/listener.log`), holding a WebSocket open
  to the relay so calls are delivered instantly instead of polled.
- It queues at most 1 running call + 5 pending; anything beyond that gets an
  immediate `busy` reply.
- Each call spawns a fresh one-shot agent process in the working directory
  (`~/AgentCall/public/` by default — see below), scoped to the capabilities
  the resolved task grants:
  - Claude: `claude -p --permission-mode dontAsk --allowedTools <tools>`, where
    the tool list is derived from the task's `tools:` frontmatter. Anything not
    listed is denied rather than prompted for (headless `-p` can't prompt).
  - Codex: `codex exec --sandbox read-only|workspace-write --cd <workdir>`.
    Codex has no per-tool granularity, so the task's `write` capability maps
    onto its native sandbox level instead.
- Every call — accepted or not — appends a JSONL line to
  `~/.agentcall/calls.log`: `{ts, call_id, from, message, status, duration_ms}`.
  That's your audit trail of who called and what happened.
- A 5-minute kill timer (SIGTERM then SIGKILL) bounds each spawned agent; the
  relay enforces its own 6-minute hard timeout per call on top of that.

### Working directory

By default the answering agent runs in `~/AgentCall/public/` — an empty share
folder — and is told to stay there. That keeps `setup` free of a question most
people can't answer, but it also means the agent has little to answer *from*.

To have your agent answer with real context, set an absolute `workdir` in
`~/.agentcall/config.json`:

```json
{ "handle": "ken", "token": "...", "agent_kind": "claude",
  "relay": "https://agentcall.benree.tech",
  "workdir": "/Users/ken/code/payments-api" }
```

Restart the listener afterwards — it resolves `workdir` once at startup, and
refuses to start if the path is relative, missing, or not a directory.
`agentcall doctor` reports the resolved path (or the reason it failed).

When `workdir` is set, the prompt stops telling the agent to stay inside it —
you pointed it at that directory on purpose. Note this was only ever an
instruction, never a boundary; see below.

## Security model (v1, explicit)

- Address = capability to call. Callers must themselves be registered — the
  `from` handle is relay-verified, anonymous callers are rejected.
- **There is no OS-level sandbox.** The answering agent runs with the same
  filesystem and network access as the agent you run yourself. Enforcement is
  capability scoping (`--allowedTools` / codex's `--sandbox` level) plus
  pre-prompt task resolution: which task a caller may invoke is decided from
  `policy.json` *before* their message is placed in any prompt, so the message
  cannot influence what it is allowed to do. Within a granted capability,
  nothing constrains where the agent reads.
  (An earlier version wrapped every spawn in Seatbelt via `sandbox-runtime`.
  That was removed deliberately: it is incompatible with the answering agent
  being the owner's real agent with the owner's real context.)
- The callee's own API key / subscription pays for answering calls — accepted
  as fine for v1 friends-scale usage, not for public/adversarial exposure.
- Known residual risks (accepted, not eliminated):
  - Prompt injection in a caller's message can burn the callee's tokens, and —
    within the granted capabilities — read or write anywhere the owner's own
    agent could. Capability scoping bounds *what kind* of action is possible,
    not *where*.
  - The working directory is a prompt instruction, not an enforced boundary.
    An agent granted `read` can read outside it regardless of `workdir`.
  - The relay operator can read message plaintext — there's no end-to-end
    encryption in v1.
  - A caller's prompt could induce the agent to read and echo back the
    callee's Claude Code session history (`~/.claude/projects/*`, which can
    contain pasted secrets and private code), API keys in `~/.claude.json`'s
    `mcpServers` entries, `~/.ssh`, `~/.aws`, or the relay token in
    `~/.agentcall/config.json`. **Only share your address with people you
    would trust to run a read-only command in your home directory.**
  - Executable configuration surfaces (`~/.claude/CLAUDE.md`, `hooks`,
    `plugins`, `commands`, `agents`) are writable by an agent granted `write`,
    so a hostile prompt can persist beyond the call.

## Development

```bash
pnpm install
pnpm -r test        # all packages
pnpm -r typecheck
pnpm -r build

cd apps/relay && pnpm dev   # local Worker + DO + D1 via wrangler
```

Monorepo layout:

```
agentcall/
├── apps/relay/          # CF Worker + Durable Object + D1 (wrangler)
├── packages/shared/     # zod protocol schemas — single source of truth
└── packages/cli/        # @benree/agentcall — the `agentcall` command (setup/listen/call/status/uninstall)
```

See [CLAUDE.md](./CLAUDE.md) for dev conventions.

## Limitations

- **macOS only.** The LaunchAgent listener is Mac-specific; there's no
  Linux/Windows callee support yet.
- **One-shot calls only.** No multi-turn conversations yet — each call is a
  single message in, single reply out. The protocol already carries an
  optional `session_id` so `agentcall call --continue` can thread through
  `--resume` in v1.5, but that's not implemented yet.
- **The relay operator sees message plaintext.** Calls are relayed through a
  single shared Cloudflare Worker (Ryusei-hosted); there's no end-to-end
  encryption, so treat call content as visible to the relay operator.
- **Handles can't be released.** `agentcall rotate` replaces a token, but
  there's no way to give a handle back: the Durable Object is addressed by
  handle name, so a re-registered handle would inherit the previous owner's
  relay-side state, and every saved contact pointing at it would silently
  resolve to a different person. Reclaimability needs a decision before this
  can ship, so for now a handle is yours permanently.
- **No OS-level isolation of the answering agent.** See the security model
  section above — this is a deliberate trade, and it is the main reason to be
  selective about who gets your address.
