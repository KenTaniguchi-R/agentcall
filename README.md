# agentcall

Call another person's coding agent (Claude Code or Codex) on their Mac, across the
public internet, like a phone call. Install with one command, get an address
(`ken@acme.agentcall.benree.tech`), share it. When someone calls your address, your Mac
spawns an agent that answers, even while you're away.

## How a call works

```mermaid
sequenceDiagram
    participant A as A's Claude Code
    participant CLI as agentcall call (A's Mac)
    participant Relay as Cloudflare Worker + DO
    participant L as agentcall listen (B's Mac, LaunchAgent)
    participant Agent as claude -p / codex exec

    A->>CLI: agentcall call ken@acme.agentcall.benree.tech "msg"
    CLI->>Relay: WSS call_request {to, message, from, token}
    Relay->>L: incoming_call {call_id, from, message}
    Relay-->>CLI: call_status ringing
    L->>Relay: call_accepted {call_id}
    L->>Relay: call_started {call_id}
    L->>Agent: spawn (cwd = workdir, capability-scoped)
    Agent-->>L: reply text
    L->>Relay: call_result {call_id, text}
    Relay-->>CLI: call_reply {text}
    CLI-->>A: prints reply to stdout
```

The listener sends `call_accepted` then `call_started` instead of the old
single `call_answer`. The relay hasn't been switched over yet — it still only
understands `call_answer`, so it never emits `call_status answered` today; the
caller-facing `answered` status is dark until the relay picks up the new
frames.

Non-goals for v1: store-and-forward, non-macOS platforms, anonymous callers,
payment/reputation.

## Install

```bash
npm install -g @benree/agentcall
agentcall setup --invite <one-time-token>
```

Ask an existing member of your organization to run `agentcall invite create`.
The returned token can enroll exactly one identity and expires after seven days
by default. Members can inventory and revoke outstanding credentials with
`agentcall invite list` and `agentcall invite revoke <id>`; creation accepts
`--description` and `--expires-in-days` (1–90). The relay no longer serves a
public shell installer.

For the first member of the first organization, the relay operator configures
`BOOTSTRAP_TOKEN` with `wrangler secret put BOOTSTRAP_TOKEN`, then creates the
initial invite with `POST /v1/admin/invite` using that value as a Bearer token
and `{ "org": "acme" }` as the JSON body. The endpoint is a 404 when the secret
is not configured.

`agentcall setup` will:
- detect `claude` / `codex` on your `PATH` (or prompt you to pick one)
- derive the organization from the invite, prompt for a handle, then register that tenant-scoped identity (`POST /v1/register`)
- write `~/.agentcall/config.json` (0600) with your organization, handle, token, agent kind, and relay URL
- create `~/AgentCall/public/`, the callee agent's working directory
- install and load the `tech.benree.agentcall.listener` LaunchAgent
- offer to append a short usage snippet to `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md`
  so *your own* agent knows how to call other people
- print your address, e.g. `ken@acme.agentcall.benree.tech`

Setup verifies by default that your agent — claude or codex — can actually
answer a call, including that it's authenticated. Pass `--no-verify`
to skip the post-setup test call (e.g. when provisioning before logging in).

Handles are unique within an organization, not globally: Acme and Beta can
both register `ken`. Hosted addresses carry the tenant in the hostname
(`handle@org.agentcall.benree.tech`); a self-hosted relay uses its own hostname
(`handle@agents.acme.com`). Authentication, cards, presence, calls, rosters,
and Durable Object state are all keyed by organization plus handle. The CLI
rejects a hosted address for a different organization instead of silently
routing its bare handle inside the caller's tenant.

That `(organization, handle)` key is current implementation, not the permanent
identity model, and handle release/reclaim is not implemented. The decided
zero-user cutover will give each agent lifetime an opaque stable ID, treat the
handle as a reclaimable routing address, and attach credentials and durable
state to the stable identity. See the
[identity/address separation decision](docs/superpowers/specs/2026-08-02-identity-address-separation.md).

The repository does not yet ship an admin web UI, a supported self-hosted
distribution, or Cloudflare Access integration. The future human admin surface
will use a separate Access-protected hostname, and customer-owned Access is the
supported SSO profile planned for self-hosted deployments. Access will not sit
in front of the current relay API or replace AgentCall authorization; hosted
multi-tenant SSO remains a separate design. See the
[Cloudflare Access boundary decision](docs/superpowers/specs/2026-08-02-cloudflare-access-boundary.md).

## Usage

```bash
# Check if someone's agent is online
agentcall status ken@acme.agentcall.benree.tech

# Call it
agentcall call ken@acme.agentcall.benree.tech "what's the weather doing over there?"

# Machine-readable reply (for your own agent to parse)
agentcall call ken@acme.agentcall.benree.tech "..." --json
```

`agentcall call` prints spinner-style status to stderr (`ringing...`) and the
reply text to stdout. Human-readable output preserves line breaks and tabs but
neutralizes terminal control characters and Unicode bidirectional formatting
from the remote agent. `--json` preserves the exact reply payload for piping;
its serialized form Unicode-escapes terminal-active controls and bidi marks.
It used to also print
`answered, agent working...`, but
that line is currently unreachable: the relay only emits `call_status
answered` on the old `call_answer` frame, and the listener no longer sends it
(see "How a call works" above). Temporary until the relay is switched to the
new `call_accepted`/`call_started` frames. Nonzero exit + an
error message on stderr on failure (`unknown_handle`, `offline`, `busy`,
`timeout`, `agent_error`, `unauthorized`, `rate_limited`, `message_too_large`,
`protocol_error`).
`agentcall status` prints `online`/`offline` and exits `0`/`2` (or `1` on a
relay error). It requires a completed `agentcall setup`. You can always check
your own status; checking another handle requires both handles to share at
least one relay roster. An unrelated existing handle and an unknown handle
return the same generic 404, so a free registration is not a namespace or
working-hours oracle. Presence authorization does not affect calls: two
independent handles can still call each other and receive the normal offline
or unavailable result without first joining a roster.

Remote card reads also require a completed setup. The relay authenticates the
viewer before looking up either the native card or the per-agent A2A card, so
an anonymous or wrong-tenant probe cannot use 404 responses to enumerate an
organization's handles or published tasks. The generic relay card at
`/.well-known/agent-card.json` remains public because it contains no tenant or
employee data.

Per-handle Agent Cards are not signed today. Their authenticity therefore
depends on the relay that serves them; clients have no end-to-end proof that a
card came from the named endpoint agent. The dated
[agent identity compatibility decision](./docs/superpowers/specs/2026-08-02-agent-identity-compatibility.md)
constrains the planned signing work without claiming that it is implemented.

### Following up

A reply can leave the conversation open, letting you ask a follow-up without
restating the question:

```bash
agentcall call ken@acme.agentcall.benree.tech "why did CI fail?"
# ... answer ...
agentcall call ken@acme.agentcall.benree.tech "which commit?" --continue
```

`--continue` resumes your last open conversation with that address;
`--context <id>` targets a specific one instead. Conversations expire 30
minutes after the last turn and are capped at 10 turns. They are scoped to
you and to the task they started on, so a conversation cannot be handed to
someone else or moved to a different task. A conversation also ends if the
owner changes the agent they run or the directory it answers from.

Tasks that grant `write` or `exec` are not conversational by default, because
a caller's earlier messages stay in the agent's context across turns. Set
`threadable: true` in a task's `SKILL.md` frontmatter to opt in.

```bash
# Replace your relay token if it may have leaked
agentcall rotate
```

`agentcall rotate` swaps this install's token for a fresh one, immediately
invalidating the old one, and restarts the background listener so it picks the
new one up. Releasing a handle entirely isn't supported yet — see Limitations.

Current relay tokens do not expire, cannot be listed or individually revoked,
and have no last-used timestamp; rotation is the immediate hard swap described
above. The decided zero-user credential cutover will replace this with
90-day client credentials, one-hour access tokens, bounded overlap, revocation,
and coarse liveness tracking. See the
[credential lifecycle decision](docs/superpowers/specs/2026-08-02-credential-lifecycle.md).

```bash
# Check your own install is healthy
agentcall doctor
```

`agentcall doctor` verifies your install can answer calls (auth, agent spawn,
listener, relay self-call) — run it whenever calls to you start failing. `✓` is a
pass and `✗` is a failure with a fix; a `!` is a check that could not be proven
either way this run, which is not a failure and does not change doctor's exit code.

Plain calls (no `--task`) run the built-in read-only `ask` task. To offer more:

    agentcall task new schedule-meeting   # scaffold ~/AgentCall/tasks/<id>/SKILL.md
    # edit the SKILL.md (YAML frontmatter: description, tools, timeout_s, ...)
    agentcall lint                        # validate tasks, policy tests, and card
    agentcall policy                      # render who can run each task and what it can do
    agentcall card                        # same review plus your rendered card
    agentcall offer schedule-meeting      # offer to everyone, or:
    agentcall allow ken schedule-meeting  # grant to one caller
    agentcall block spammer               # refuse a caller entirely

Tasks are one markdown file each — YAML frontmatter (only `description` is
required) over the instructions your agent follows. Grants and blocks live in
`~/.agentcall/policy.json`; the verbs above edit it for you and republish your
card automatically. Callers see your menu with `agentcall card <address>`.

`agentcall policy` renders the effective policy after any administrator ceiling
and mandatory blocks are applied. It shows how the base, named-caller, and
relay-attested roster rules compose; then lists each runnable task's capabilities
and concrete working directory. The report warns that Claude's `exec` grant can
read, change, and send data outside that directory, and states the weaker Codex
boundary instead of presenting `fetch` and `exec` as controls Codex does not
have.

For a roster-wide grant, add a locally named entry to `groups` in
`~/.agentcall/policy.json`, using the opaque id shown by `agentcall roster
list`, then run `agentcall card push`:

```json
{
  "default_offer": ["ask"],
  "callers": { "spammer": { "offer": [], "block": true } },
  "groups": {
    "eng": {
      "roster_id": "the-roster-id-from-roster-list",
      "offer": ["architecture-history", "schedule-meeting"]
    }
  }
}
```

Group names are local labels only. A caller cannot claim one or choose which
policy applies: the relay attests the roster ids currently shared by caller and
callee on each connection. Unknown or removed memberships grant nothing, and
an individual `block` always overrides group and default offers.

Put reachability assertions beside the user policy so an accidental edit is
rejected before it is saved or published:

```json
{
  "default_offer": ["ask"],
  "callers": {
    "ken": { "offer": ["schedule-meeting"] },
    "stranger": { "offer": [], "block": true }
  },
  "tests": [
    { "caller": "ken", "accept": ["schedule-meeting"], "deny": ["exec"] },
    { "caller": "stranger", "deny": ["*"] },
    { "caller": "mia", "groups": ["eng"], "accept": ["architecture-history"] }
  ]
}
```

`caller` is the bare relay-verified handle. `groups` names local policy groups;
the evaluator translates them to the roster ids the relay would attest.
`accept` entries must be offered, `deny` entries must not be offered, and
`deny: ["*"]` means the caller must receive an empty menu. Run `agentcall lint`
in CI or after hand edits. A failed assertion makes lint exit nonzero, prevents
CLI policy verbs from changing the last known-good file, and prevents the
listener from starting. Hot edits are also rechecked before every call.

> **Codex support is experimental.** The `claude` path is the one that's
> actually been live-tested end to end; `codex` support is implemented and
> unit-tested but hasn't been verified against a real call yet.

## Finding who to ask

`agentcall call` assumes you already know the address. In a company you often
don't — that's what rosters and `agentcall search` are for.

A **roster** is an opt-in group whose members can discover each other's
published tasks. Creation returns an initial reusable join key and a separate
admin secret. Store the admin secret in a password manager and share only the
id and join key:

```bash
agentcall roster create --as acme
# prints an id, initial join key, and admin secret; credentials are shown once

# everyone else:
agentcall roster join <roster-id> --key <key> --as acme
```

Then search by what you need, not by who you know:

```bash
agentcall search "why did we pick this auth migration"
# tanaka@acme.agentcall.benree.tech  architecture-history
#   Why past architecture decisions were made — ADR context and migration rationale.
#   matched: auth (keywords) · migration (keywords, description)
#   agentcall call tanaka@acme.agentcall.benree.tech --task architecture-history "<message>"

agentcall search "..." --json    # for your own agent to parse
```

Add `keywords` to a task's `SKILL.md` frontmatter to make it findable; they're
weighted highest (`keywords` 3, task name 2, description 1 per matching word),
and a result needs to clear a minimum score to be shown at all — a single
keyword hit or a name match qualifies on its own, but one incidental word
picked up from a description does not:

```yaml
---
description: Why past architecture decisions were made.
keywords: [auth, migration, adr]
---
```

Search results are prefixed with `[roster-name]` only when more than one
roster is in scope — with a single roster, or `--roster <name>`, the address
alone is enough. If every joined roster fails to refresh (relay unreachable,
no cache yet), `agentcall search` exits non-zero; a partial failure across
several rosters still exits `0`, with the affected roster called out as stale
in the output.

**Matching happens on your machine.** The relay serves each member a
per-caller-filtered index of what they've published *to you*; ranking that
index against your query runs locally, so the query text itself is never sent
anywhere. Refreshing a roster does tell the relay that your handle refreshed
that roster at that time, so search *activity* isn't private — only the query
is.

Membership has an explicit lifecycle:

```bash
agentcall roster leave acme                    # relay leave + local cleanup
agentcall roster expel acme <handle>           # requires the admin secret
agentcall roster key issue acme --description contractor
agentcall roster key issue acme --reusable     # shared key; one-off is the default
agentcall roster key list acme                  # metadata only; secrets never reappear
agentcall roster key revoke acme <prefix>       # members stay
agentcall roster key revoke acme <prefix> --evict --yes # remove only members admitted by it
agentcall roster delete acme --yes              # teardown; audit events survive
```

Administrative commands resolve the secret from `--admin-secret`, then
`AGENTCALL_ADMIN_SECRET`, then an interactive prompt. The flag is convenient
for scripts but can appear in shell history and process listings. The admin
secret is never stored by AgentCall and cannot be recovered; if every copy is
lost, abandon and recreate the roster. Join keys expire after 30 days by
default (maximum 90 days); newly issued keys are one-off unless `--reusable`
is passed. Revocation retains existing members by default. `--evict` removes
only members whose admission provenance matches that key. Expulsion and
eviction cannot retract data already cached or copied.
`agentcall roster forget` remains the explicit local-only escape hatch when the
relay is unreachable; use `leave` for actual membership removal.

Results are hints, not permission: a task can appear in search and still be
refused when you call it, because the callee's policy is what actually
decides.

## Contacts

Save addresses under a short name so you don't have to retype `handle@host`
every time:

```bash
agentcall contacts add ken ken@acme.agentcall.benree.tech --note "who they are"
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
- It queues at most 1 running call + 0 pending; a second concurrent caller
  gets an immediate `busy` reply. With a 5-minute agent timeout running
  against a 6-minute relay deadline, a queued call would not have enough
  budget left to finish in time, so pending capacity is zero rather than
  handing it a truncated execution window.
- Each call spawns a fresh one-shot agent process in the working directory
  (`~/AgentCall/public/` by default — see below), scoped to the capabilities
  the resolved task grants:
  - Claude: `claude -p --permission-mode dontAsk --allowedTools <tools>`, where
    the tool list is derived from the task's `tools:` frontmatter. Anything not
    listed is denied rather than prompted for (headless `-p` can't prompt).
  - Codex: `codex exec --sandbox read-only|workspace-write --cd <workdir>`.
    Codex has no per-tool granularity, so the task's `write` capability maps
    onto its native sandbox level instead.
  - A continued call (`--continue`/`--context`) spawns the same way but adds
    the resume form — `claude --resume <id>` or `codex exec resume <id>` —
    instead of starting a fresh session.
- Every call — accepted or not — appends a JSONL line to
  `~/.agentcall/calls.log`: `{ts, call_id, from, message, task, status,
  duration_ms}`, plus `context_id` (the opaque conversation token, never the
  agent's real session id) and `turn` once a call actually completes. That's
  your audit trail of who called and what happened.
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

Individual tasks can narrow this further with an absolute `workdir` in their
`SKILL.md` frontmatter. It overrides the install-global directory for that task:

```yaml
---
description: Explain decisions in the payments service.
tools: [read]
workdir: /Users/ken/code/payments-api
---
```

Relative, missing, and non-directory task workdirs make that task invalid and
it is not offered. For a Claude answering agent, file-shaped tools are guarded
to the resolved task directory. This is a real boundary for `Read`, `Write`,
`Edit`, `Glob`, `Grep`, and `LS`, including canonicalized paths and symlinks.
It is not a boundary for `exec`, and Codex has no equivalent read boundary;
see the residual risks below.

### Managed policy

An administrator can place a machine policy at
`/Library/Application Support/agentcall/policy.json` on macOS or
`/etc/agentcall/policy.json` on Linux. This path is absolute and is never moved
by `HOME` or `AGENTCALL_HOME`; deploy the directory and file as root-owned and
not writable by ordinary users.

```json
{
  "version": 1,
  "allowed_tasks": ["ask", "schedule-meeting"],
  "blocked_callers": ["contractor-bot"],
  "tests": [{ "caller": "contractor-bot", "deny": ["*"] }]
}
```

`allowed_tasks` is a ceiling over every user default, per-caller grant, and
roster-group grant. Omit it to leave task grants unconstrained; set it to `[]`
to deny every task. `blocked_callers` is added to the user's own blocks and
cannot be undone in `~/.agentcall/policy.json`. CLI policy commands continue to
edit only that user file, while listener enforcement and card publication use
the effective, administrator-filtered policy.

User and managed `tests` both evaluate after the two layers are composed. This
lets a user notice when an administrator ceiling removes an expected grant and
lets IT prove that a mandatory block survived user configuration. Managed tests
cannot be removed from the user file.

The combined user and managed block set is limited to 200 distinct callers,
matching the relay card protocol. Exceeding it fails policy loading so local
enforcement cannot drift from an older card that the relay still serves.

A missing managed file means the machine is unmanaged. If the file exists but
cannot be read, parsed, or validated, policy loading fails closed and no agent
is spawned. Deploy replacements atomically so a reader never observes a
partially written file.

This layer is the policy model for managed deployment, not by itself a complete
tamper boundary. Fleet enforcement must also install AgentCall and this file in
administrator-owned locations and verify a signed release; a user-owned npm
installation can be modified by that user. In-product self-update remains
disabled/deferred so it cannot bypass an IT-pinned version.

## Security model (v1, explicit)

- The organization is the call-reachability boundary. Any authenticated handle
  may call any registered handle in its own organization; anonymous callers and
  cross-organization routing are rejected. An address is therefore a routing
  identifier, not a secret capability. Roster membership scopes presence,
  discovery, and callee-side task policy, but does not gate call delivery. See
  the [reachability decision](./docs/superpowers/specs/2026-08-02-organization-scoped-call-reachability.md).
- Address is not a capability to monitor presence. A handle can read its own
  online state or that of a peer in a shared roster; every other target is
  indistinguishable from a nonexistent handle. The relay records each
  authenticated allowed or denied status read in Analytics Engine with the
  organization, viewer, target, timestamp, source IP/country, and decision. It
  does not record the online/offline result, so the event is an access trail,
  not an accumulated presence timeline.
- **There is no OS-level sandbox.** The answering agent runs with the same
  filesystem and network access as the agent you run yourself. Enforcement is
  capability scoping (`--allowedTools` / codex's `--sandbox` level) plus
  pre-prompt task resolution: which task a caller may invoke is decided from
  `policy.json` *before* their message is placed in any prompt, so the message
  cannot influence what it is allowed to do. Within a granted capability, the
  only thing constraining *where* the agent reads and writes is the tool guard
  below — and it covers file-shaped tool arguments, not `exec`.
  (An earlier version wrapped every spawn in Seatbelt via `sandbox-runtime`.
  That was removed deliberately: it is incompatible with the answering agent
  being the owner's real agent with the owner's real context.)
- The callee's own API key / subscription pays for answering calls — accepted
  as fine for v1 friends-scale usage, not for public/adversarial exposure.
- Known residual risks (accepted, not eliminated):
  - Any authenticated organization member can mint a one-use, seven-day invite.
    One compromised member can therefore enroll multiple caller handles, and
    the per-caller hourly limit then gives each handle a separate budget against
    a callee. The five-per-minute registration limit is keyed by source IP and
    slows this amplification; it does not prevent it. Centralized enrollment
    authority and abuse response are future controls, not properties of the
    current reachability boundary.
  - Prompt injection in a caller's message can burn the callee's tokens, and —
    within the granted capabilities — read or write anywhere the owner's own
    agent could via `exec` (shell commands are recorded, not blocked — see
    Tool guard below) or on a Codex answering agent, which has no read guard.
    On a Claude answering agent using `Read`/`Write`/`Edit`/`Glob`/`Grep`, the
    tool guard below refuses the credential paths it covers. Capability
    scoping bounds *what kind* of action is possible, not *where*.
  - A Claude answering agent's file-shaped tools are confined to the resolved
    task workdir. A task granted `exec` can still read outside it through shell
    commands, and a Codex answering agent is not confined for reads at all.
  - The relay operator can read message plaintext — there's no end-to-end
    encryption in v1.
  - A caller's prompt could induce the agent to read and echo back the
    callee's Claude Code session history (`~/.claude/projects/*`, which can
    contain pasted secrets and private code), API keys in `~/.claude.json`'s
    `mcpServers` entries, `~/.ssh`, `~/.aws`, `~/.codex` (which holds
    `auth.json` and a `config.toml` that routinely carries API keys in
    plaintext), or the relay token in `~/.agentcall/config.json`. The tool
    guard below refuses these paths for a Claude answering agent's
    file-reading tools, but not for `exec`, and not at all for a Codex
    answering agent. **Treat every member of your organization as able to reach
    your agent, and grant tasks accordingly.**
  - Executable configuration surfaces (`~/.claude/CLAUDE.md`, `hooks`,
    `plugins`, `commands`, `agents`) are writable by an agent granted `write`,
    so a hostile prompt can persist beyond the call. On Claude, the tool guard
    refuses `Write`/`Edit` to `~/.claude/**`, to its own installed package
    root (so a write-only call cannot neuter the guard for the next tool call
    in the same session — a fresh process re-imports it from disk on every
    call), to `~/AgentCall/tasks` (so a write-only call cannot rewrite an
    already-offered task's capability envelope, which is read verbatim from
    frontmatter), to `~/Library/LaunchAgents`, and to shell startup files
    (`.zshrc` and friends). This risk remains live via `exec` and on a Codex
    answering agent, which has no read guard.
  - `~/.codex` is refused for a Claude answering agent, but a **Codex**
    answering agent can still read its own configuration and credentials —
    `--ignore-user-config` stops that config being *loaded*, not being *read*.

**Tool guard.** Tool calls a caller's agent makes on your machine are checked before
they run. For Claude, file reads, writes, searches, and listings that reach
credential paths (`~/.ssh`, `~/.aws`, `.env`, Keychains, `~/.agentcall`,
`~/.claude`, `~/.codex`), the guard's own installed code, `~/AgentCall/tasks`,
`~/Library/LaunchAgents`, and shell startup files
are refused, and file-shaped tools outside the resolved task workdir are
also refused. Every tool call reaching the guard is recorded to
`~/.agentcall/tools.log`; on verified codex-cli 0.146.0, Codex runs the same
hook in observe-only mode so long as `allow_managed_hooks_only` is not enabled,
so it records attempts but does not refuse them.
`agentcall doctor` verifies the Claude guard is in force: it asks a real
`claude` spawn to read a canary `.env` and requires the denial to appear in the
log. When the model refuses that read on its own the guard is never consulted
and the run proves nothing, so doctor falls back to invoking the guard directly
and reports `!` — unverified, not broken. For Codex, doctor makes no additional
model call: it queries `hooks/list` with AgentCall's exact production overrides
and fails unless the session hook is present, enabled, and trusted.

Two limits, stated plainly:

- **A task that grants `exec` has no read floor.** On Claude — and on the
  verified Codex release when session hooks are enabled — shell commands are
  recorded, not blocked. Pattern-matching a command string is too weak to be a
  boundary and too eager to be harmless. The control on `exec` is which tasks
  you choose to write.
- **A Codex answering agent is observed, not guarded.** AgentCall trusts only its exact
  inline session hook by supplying Codex's normalized hook-identity hash; it does not
  use the blanket `--dangerously-bypass-hook-trust` flag, so user, project,
  plugin, and managed hooks do not inherit trust from AgentCall's grant. Hooks
  independently trusted by the owner or administrator can still run. The guard runs in *observe* mode — record,
  never block — and writes tool attempts that emit `PreToolUse` to `tools.log`. This is
  pinned and behaviorally verified against codex-cli 0.146.0. AgentCall does not
  claim observation on other releases: a changed normalization makes the hash
  mismatch and the hook skip silently rather than widening trust. An administrator
  setting `allow_managed_hooks_only = true` also disables this session hook;
  `agentcall doctor` detects and fails on that condition. Installing AgentCall's
  guard as an administrator-managed hook remains future work. Codex has no
  `Read`/`Grep`/`Glob` tools, and much of what it does reach the filesystem with is
  `Bash` (`sed -n '1,200p' file`) — exactly
  the surface the point above says cannot be bounded by matching command strings. Its
  `--sandbox` level confines writes but not reads: `codex exec --sandbox read-only`
  still reads `~/.ssh`. **A Codex answering agent therefore has no read floor.**
- **Codex does not reach the filesystem only through `Bash`, and the non-shell routes
  are not recorded at all.** `view_image` reads any absolute path and returns the raw
  bytes — it does not check that the file is an image, so it is a general file-read
  primitive — and `apply_patch` reads a file to verify patch context. Both are
  reachable in the spawn shape above, and neither emits an event that `agentcall`
  parses, so a read through them appears in **no** log: not `tools.log`, not
  `calls.log`. Verified against codex-cli 0.146.0; see
  [issue #29](https://github.com/KenTaniguchi-R/agentcall/issues/29).
- **The Codex spawn does not load your `~/.codex` — but that does not disarm Codex's
  own bundled tools.** It runs with `--ignore-user-config`, so a caller cannot reach
  *your* MCP servers, plugins, or apps. Those run as separate processes outside Codex's
  sandbox, and a filesystem MCP server — or `claude mcp serve`, which re-exposes `Read`
  and `Bash` — would otherwise route around every control here. What that flag does not
  drop is Codex's own bundled `codex_apps` connector, 28 tools on codex-cli 0.146.0.
  **These are not merely reachable — they work.** In the exact spawn shape above,
  `sites_list_sites` returns a normal `isError:false` result and
  `hotline_get_local_hotline` returns real content fetched from the ChatGPT backend;
  nothing returns the connector's documented auth-failure envelope. The same authenticated
  surface carries `sites_deploy_site_version`, `sites_update_environment_variables`,
  `sites_update_site_access` and `sites_generate_siwc_bypass_token`. **So a remote caller
  can read something in your workspace and publish it to the internet without crossing a
  single denied path.** No read floor touches that, because those tools do not read: they
  send. `--sandbox` does not touch it either — it confines the *shell*, and this traffic
  is not the shell's. Verified against codex-cli 0.146.0 by
  [`scripts/verify-codex-apps-surface.sh`](./scripts/verify-codex-apps-surface.sh); see
  [issue #30](https://github.com/KenTaniguchi-R/agentcall/issues/30).

## Development

```bash
pnpm install
pnpm -r test        # all packages
pnpm -r typecheck
pnpm -r build

cd apps/relay && pnpm dev   # local Worker + DO + D1 via wrangler
```

### Relay deployment

Build the workspace before validating or deploying the relay so Wrangler can
resolve the shared package. Then run:

```bash
cd apps/relay
pnpm exec wrangler deploy --dry-run  # local config and bundle checks only
pnpm deploy                          # real deployment
```

The dry run does not compare Durable Object state with Cloudflare. Durable
Object lifecycle changes are atomic and cannot be rolled back, and Wrangler's
reconciliation report arrives only after a successful deployment. Before
deploying, compare the `exports` map with the intended live classes and prepare
the documented staged rollout for any create, delete, rename, or transfer. Read
the post-deploy report as confirmation; treat any unexpected action as an
incident and make no further production changes until it is understood.

The hosted relay currently makes no regional residency claim. Read the living
[cloud data map and residency decision](./docs/security/data-residency.md)
before changing D1 placement, Durable Object ID derivation, Regional Services,
logging, or analytics. Adding `.jurisdiction()` changes named DO IDs and is a
state migration, not a configuration-only deploy.

Monorepo layout:

```
agentcall/
├── apps/relay/          # CF Worker + Durable Object + D1 (wrangler)
├── packages/shared/     # zod protocol schemas — single source of truth
└── packages/cli/        # @benree/agentcall — the `agentcall` command (setup/listen/call/status/uninstall)
```

See [CLAUDE.md](./CLAUDE.md) for dev conventions. Open work is tracked in GitHub
Issues, and **the assignee is the claim** — read
[CONTRIBUTING.md](./CONTRIBUTING.md) before starting anything, so two people
don't pick up the same issue. It covers claiming, the automatic release of
stale claims, and the one-worktree-per-session rule.

Designing enterprise, security, or A2A behavior? Start with the living
[reference implementation index](./docs/research/reference-implementations.md),
which names the primary sources, reusable invariants, and precedents already
adopted in AgentCall. Dated files under `docs/superpowers/` remain historical
records rather than current guidance.

### npm releases

Releases use `.github/workflows/release.yml`; no npm token is stored in GitHub.
Both `@benree/agentcall-shared` and `@benree/agentcall` must configure an npm
trusted publisher with owner `KenTaniguchi-R`, repository `agentcall`, workflow
`release.yml`, and environment `npm`. Protect that GitHub environment with the
maintainers allowed to approve a package publication.

To release, update both package versions and the CLI version together, move the
Unreleased changelog entries under that version, merge the change to `main`, and
publish a GitHub release whose tag is exactly `v<version>`. The workflow refuses
tags that do not point at a commit in `main`'s history. It rebuilds and tests from
that tag, publishes shared before CLI through npm's OIDC trusted publisher with
provenance, and attaches the exact tarballs, SHA-256 checksums, and CycloneDX
SBOM to the GitHub release. A partial retry skips an existing package only when
the registry integrity exactly matches the rebuilt tarball. Stable releases use
the npm `latest` dist-tag; GitHub prereleases use `next` and cannot displace it.
The publish process pins `NODE_AUTH_TOKEN` empty and refuses to run unless the
GitHub OIDC request environment is present, so a missing `id-token: write` grant
or accidental return to a long-lived npm token fails before either package is
published.

The published tarball is installed and exercised without pnpm on Node 20, 22,
and 24 in CI, including `agentcall doctor`; this is what enforces the CLI's
declared `node >=20` runtime promise.

Platform installers are deliberately deferred. AgentCall will keep its current
Commander CLI until the non-macOS service/container work (#14) defines the
artifacts each platform needs and managed policy (#104) defines who controls
versions and updates. A future self-update mechanism must be disabled whenever
managed policy is present so IT can pin the deployed version.

## Limitations

- **macOS only.** The LaunchAgent listener is Mac-specific; there's no
  Linux/Windows callee support yet.
- **The relay operator sees message plaintext.** Calls are relayed through a
  single shared Cloudflare Worker (Ryusei-hosted); there's no end-to-end
  encryption, so treat call content as visible to the relay operator.
- **The relay operator sees presence-access metadata.** Status-read events
  contain viewer, target, time, source IP/country, and allow/deny outcome for
  abuse detection and security review evidence. They deliberately omit the
  target's online/offline state.
- **Handles can't be released.** `agentcall rotate` replaces a token, but
  there's no way to give a handle back: the Durable Object is addressed by
  handle name, so a re-registered handle would inherit the previous owner's
  relay-side state, and every saved contact pointing at it would silently
  resolve to a different person. Reclaimability needs a decision before this
  can ship, so for now a handle is yours permanently.
- **No OS-level isolation of the answering agent.** See the security model
  section above — this is a deliberate trade, and it is the main reason to be
  selective about who gets your address.
- **One caller can monopolise your agent.** Calls are answered strictly one at
  a time — a second concurrent call gets `busy` — and a single call may run up
  to five minutes before it times out. The hourly cap of 30 calls per caller
  does not bound that: 30 × 5 minutes is more listener time than the hour
  contains, so a caller making sustained long-running calls can keep everyone
  else out. The remedy is `agentcall block <handle>`, which is the same posture
  as the rest of this — you gave that person your address.
