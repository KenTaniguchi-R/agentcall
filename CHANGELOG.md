# Changelog

All notable changes to agentcall are recorded here. Versions apply to both
`@benree/agentcall` (the CLI) and `@benree/agentcall-shared` (protocol schemas),
which are released together.

## Unreleased

### Added — administrator-managed policy ceiling

- macOS and Linux now have fixed, `AGENTCALL_HOME`-independent managed-policy
  paths. Administrators can cap every task grant and impose unoverridable caller
  blocks without rewriting the user's policy.
- Missing managed policy remains unmanaged behavior; unreadable, malformed, or
  invalid managed policy fails closed instead of falling back to user defaults.

### Changed — verifiable npm releases

- Every third-party GitHub Action is pinned to an immutable commit.
- Published releases now build and test both packages from the tagged `main`
  commit, publish through npm OIDC with keyless provenance, and attach the exact
  tarballs, SHA-256 checksums, and a CycloneDX SBOM to the GitHub release.
- Clean tarball consumers now exercise `agentcall doctor` on Node 20, 22, and
  24, enforcing the published CLI's declared runtime floor.

### Changed — roster mutations emit complete audit evidence

- Roster audit events now use stable `roster.*` names and record CRUD action,
  organization, actor authority, typed target, source IP/country, description,
  and timestamp. All seven roster mutation event types become available with
  this release: `roster.create`, `roster.join`, `roster.leave`, `roster.expel`,
  `roster.rotate`, `roster.evict_all`, and `roster.delete`.
- A persistent per-roster budget bounds membership audit growth independently
  of source IP. Exhaustion is recorded once, while administrative recovery and
  security operations remain available.

### Changed — Durable Object lifecycle is declarative

- Relay deployments now declare `HandleDO` and `RateLimiterDO` as SQLite-backed
  Durable Object exports instead of maintaining an ordered migration-tag ledger.
  This preserves the existing namespaces while making future class renames,
  transfers, and deletions explicit in Wrangler's deployment reconciliation.

### Added — multi-turn calls: `agentcall call --continue`

- **`agentcall call <address> "..." --continue`** follows up on your last
  conversation with that address instead of starting a fresh one, reusing the
  answering agent's session. `--context <id>` targets a specific conversation
  by id rather than "the last one". Conversations expire 30 minutes after
  their last turn and are capped at 10 turns; a conversation is scoped to the
  caller and to the task it started on, and cannot be handed to someone else
  or moved to another task.
- **`threadable` in a task's `SKILL.md` frontmatter** opts a task into
  `--continue`. Tasks granting `write` or `exec` are not conversational by
  default — a caller's earlier messages persist in the agent's context across
  turns, which is a materially worse risk against those capabilities than
  against a read-only one — but read-only tasks default to threadable.

### Changed — `session_id` is now an opaque callee-minted `context_id`

- The protocol's `session_id` field is renamed `context_id` and no longer
  carries the answering agent's real session id — that value never leaves the
  callee's machine. `context_id` is instead a token the callee mints and
  hands the caller back, which the callee looks up against its own local
  binding store on the next turn.
- `RATE_LIMIT_PER_HOUR` raised from 10 to 30, so a normal multi-turn
  conversation doesn't consume a caller's entire hourly budget.

### Fixed — `doctor`'s tool-guard check called healthy installs broken

The check asked a real `claude` spawn to read a canary `.env` and required a
`tool_denied` record as proof the guard fired. That proof only exists if the model
actually attempts the read — and on some models and versions it declines on its own,
or claude's own built-in protection denies the read first (which suppresses the hook
entirely). A fresh, correct install then reported `✗ tool guard — no denial was
recorded`, under a fix hint (`run pnpm build in packages/cli`) that means nothing to
anyone who installed from npm.

The check now separates "the guard did not stop a protected read" from "the guard was
never asked". The inconclusive case is settled by invoking `guard-entry.js` directly
with a synthetic `PreToolUse` payload — no model involved, ~50ms — and reports `!`
with the model's own words, leaving doctor's exit code at 0. A genuinely broken guard
still fails, and the reinstall hint now names both `npm i -g @benree/agentcall` and
the in-checkout `pnpm build`.

`VerifyCheck` gained a `warn` flag; `formatCheck` renders it as `!` with a `note:`
rather than a `fix:`.

## 0.4.0 — 2026-08-01

### Added — roster-based discovery: `agentcall search`, `agentcall roster`, task `keywords`

- **`agentcall search "<question>"`** finds which colleague's agent can answer
  something, ranked over the rosters you've joined. The ranker runs entirely
  on your machine — the relay never sees the query text, only that your
  handle refreshed a roster (and when). `--json` gives a machine-readable
  result for your own agent to parse, `--roster <name>` scopes to one roster,
  and `--offline` ranks against the last cached bundle without refreshing.
  A result is prefixed with `[roster-name]` only when more than one roster is
  in scope. If every joined roster fails to refresh, the command exits
  non-zero; a partial failure across several rosters still exits `0`, with
  the affected roster called out as stale in the output.
- **`agentcall roster create|join|list|forget`** — an opt-in discovery group.
  One person creates a roster and shares its id and join secret once (the
  relay stores only a SHA-256 digest of the secret); everyone else joins with
  `agentcall roster join <id> --secret <secret>`. `forget` only drops the
  local record of having joined — there is no leave operation, so membership
  on the relay is unaffected.
- **`keywords` in a task's `SKILL.md` frontmatter**, published on the agent
  card and weighted highest by search (`keywords` 3, task name 2, description
  1 per matching word). A result must clear a minimum score to be shown at
  all, so a single word incidentally shared with a description does not
  surface a task that can't actually help — this came from a real
  over-firing case during development.
- Relay: `POST /v1/roster`, `POST /v1/roster/:id/join`, and
  `GET /v1/roster/:id/bundle` (filtered per caller), backed by the new
  `rosters` and `roster_members` tables (migration `0004_rosters.sql`).

### Known issue — no way to expel a roster member or rotate a roster secret (unfixed)

- A roster has no membership-lifecycle operations beyond joining: nobody can
  be removed, and the join secret can't be rotated. A leaked secret means
  abandoning the roster and creating a new one. `agentcall roster forget`
  only erases the local record of having joined; it does not leave the
  roster, so a member who believes they left is still visible to everyone
  else's search.

### Known issue — Codex reaches the filesystem without the shell, and unrecorded (unfixed)

- **`view_image` is a general file-read primitive, not an image viewer.** It does
  not validate that its argument is an image: pointed at a text file outside the
  workspace it returns the raw bytes as
  `{"image_url":"data:application/octet-stream;base64,…"}`. `apply_patch` also
  reads a file, to verify patch context. Both are reachable in the exact
  `buildSpawnSpec` shape under `--ignore-user-config --sandbox read-only`.
- **Neither leaves any record.** They emit no event that `parseCodexJsonl` reads
  (it extracts `agent_message` only), so a read through them appears in no log —
  not `tools.log`, not `calls.log`. This corrects a README claim that Codex
  "reaches the filesystem entirely through `Bash`", which was the stated
  justification for the guard being observe-only.
- **A machine-wide `deny_read` does stop them.** Verified against codex-cli
  0.146.0: with `/etc/codex/requirements.toml` installed, all three routes
  (`exec_command`, `view_image`, `apply_patch`) fail with
  `Operation not permitted (os error 1)`. That is the C.2 read floor, which is
  *not* shipped — `agentcall` neither installs nor currently requires it.
  `scripts/verify-codex-deny-read-p2.sh` is the repeatable check.

### Known issue — the Codex guard is registered but never runs (unfixed)

- **Codex spawns produce no `tools.log` telemetry at all.** Codex gates hook
  execution on *persisted trust* (`HookStateToml` carries a `trusted_hash`), and
  the guard hook is supplied inline via `-c`, which has never been trusted — so
  Codex skips it silently, with no warning on stdout or stderr and no change to
  the exit code. Verified against codex-cli 0.146.0 by controlled A/B on the
  exact `buildSpawnSpec` output. **The observe-mode guard described below has
  therefore never recorded anything on the Codex side.**
- `--dangerously-bypass-hook-trust` makes the guard run, and was tried and then
  **backed out**. It is a *blanket* bypass: it grants execution to every
  untrusted hook from every surviving config layer, not just agentcall's own.
  `--ignore-user-config` does not contain it — Codex replaces the ignored
  `config.toml` with an *empty user layer* rather than dropping the layer, and
  loads `hooks.json` per-layer independently, so `$CODEX_HOME/hooks.json` still
  runs. Confirmed by planting one: it executed. Hook commands run outside the
  tool sandbox, so this is host-level execution.
- The narrower fix is to trust only our own hook by supplying
  `hooks.state.<id>.trusted_hash` inline (SHA-256 over the normalized hook
  identity). It fails closed on mismatch but couples us to an undocumented
  hashing scheme. **Not yet decided** — see
  `docs/superpowers/specs/2026-08-01-codex-read-floor-design.md`.

### Fixed — the guard's fail-closed paths could fail open (security-relevant)

- **Exit 2 now carries a reason on stderr.** Claude blocks on exit 2 regardless
  of stderr, so this was invisible while the guard was Claude-only. Codex blocks
  on exit 2 *only* when stderr carries a reason and treats an empty one as a
  merely-failed hook — which runs the tool. Every fail-closed path was therefore
  a fail-*open* path the moment the same entry point reached a Codex spawn.

### Added — the Codex spawn is now observed, and no longer loads your `~/.codex`

- **`--ignore-user-config` on the Codex spawn.** A Codex answering agent used to
  inherit the owner's whole `~/.codex`: MCP servers, plugins and apps. Those are
  separate processes that reach the filesystem outside Codex's sandbox, so a
  caller could route around every control in the CLI — on a typical dev machine
  that means a filesystem MCP server, and often `claude mcp serve`, which
  re-exposes `Read` and `Bash`. Claude fences these off with `--allowedTools`, an
  allowlist `mcp__*` names never match; Codex has no equivalent, so not loading
  them is the only lever. Codex's own bundled `codex_apps` tools are **not**
  removed by this flag.
- **The PreToolUse guard is registered on the Codex spawn**, inline via `-c` so
  the owner's `~/.codex/hooks.json` is untouched — the Codex analogue of the
  inline `--settings` used for Claude. It runs in **observe** mode: it records
  attempts and never blocks. Codex has no `Read`/`Grep`/`Glob` and reaches the
  filesystem through `Bash`, which the guard records rather than blocks, so
  enforcing would add no protection while denying Codex tools it cannot classify
  (`apply_patch`) and breaking the runtime. **This is not read-guard parity, and
  the README no longer implies it is.** `tools.log` lines from a Codex spawn
  carry `"mode":"observe"` and omit `allowed`, because PreToolUse reports what
  was attempted, not what was permitted.
- **`~/.codex` joins the denied paths** for a Claude answering agent, on the same
  argument that put `~/.claude` there: it holds `auth.json` and a `config.toml`
  that routinely carries API keys in plaintext.

### Changed — the callee side is now cancellable (relay not yet switched over)

- **`call_answer` is split into `call_accepted` and `call_started`.** The
  listener now sends the two separately instead of one combined
  acknowledgement, so a future relay can distinguish "the listener has
  admitted this call" from "the agent has actually started running." The
  relay is deliberately untouched by this change and still only understands
  `call_answer` — it never receives either new frame, so it never emits
  `call_status answered`. **The caller-facing `answered` status is dark until
  the relay is switched to the new frames in the next plan.**
- **New `cancel_call` / `call_cancelled` / `call_not_cancelled` frames.** The
  relay can ask the listener to cancel a call in flight; the listener
  acknowledges only after the pending job is confirmed removed or the running
  agent's process group is confirmed exited — never on signal-sent — and
  reports `call_not_cancelled` when the `call_id` is unrecognized. (`reason`s
  `too_late` and `already_terminal` are reserved for the next plan; see
  `docs/superpowers/plans/2026-08-01-a2a-listener-protocol.md`.)
- **`maxPending` changed from 5 to 0.** The listener now refuses a second
  concurrent call outright instead of queuing it. With a 5-minute agent
  timeout running against a 6-minute relay deadline measured from submission,
  a queued call would not have enough budget left to finish in time, so
  queuing it was never actually safe.

### Removed — the OS-level sandbox (breaking, security-relevant)

- **Spawned agents are no longer wrapped in Seatbelt.** Every call used to run
  under `npx @anthropic-ai/sandbox-runtime --settings <file>`, with
  deny-by-default reads and a network allowlist. That wrapper is gone: the
  answering agent is meant to be the owner's real agent with the owner's real
  context, which a confined fresh spawn cannot be. Enforcement is now
  capability scoping (`--allowedTools` for claude, `--sandbox` level for codex)
  plus pre-prompt task resolution. **Within a granted capability, nothing
  constrains where the agent reads or writes** — see the security model in the
  README before sharing your address.
- `~/.agentcall/srt.json` is no longer written or read. Existing files are
  inert and can be deleted; `agentcall uninstall --purge` removes them.
- `~/AgentCall/public` as the working directory is now a prompt instruction
  rather than an enforced boundary.

### Removed — `write_paths` and `network` task frontmatter

- Both fields existed only to populate the sandbox's `allowWrite` and
  `allowedDomains` lists, so they no longer grant anything. They are ignored if
  present in an existing `SKILL.md`, which keeps old task files loading. Task
  capabilities are now expressed by `tools:` alone.

### Added — optional `workdir`

- **`workdir` in `~/.agentcall/config.json`** sets the absolute directory the
  answering agent runs in, so calls can be answered with real project context
  instead of from an empty share folder. Defaults to `~/AgentCall/public`, and
  is deliberately *not* prompted for during setup — it's a two-second question
  for a developer and an unanswerable one for everyone else.
- Resolved once at listener start, so a relative, missing, or non-directory
  path stops `agentcall listen` with a clear message rather than failing every
  inbound call. `agentcall doctor` reports it as its own check.
- When `workdir` is set, the prompt no longer instructs the agent to stay
  inside its working directory.

### Removed — the `tier` field

- Task frontmatter, the `Task` type, and the `CardTask` protocol schema all
  carried a `tier` of `"T1" | "T2"`, with T2 reserved for approval-gated tasks.
  Nothing ever branched on it and the approval gate isn't being built, so it's
  gone. `tier` in an existing `SKILL.md` or in a card already stored on the
  relay is ignored rather than rejected, and `agentcall card` no longer prints
  a `[T1]` marker next to each task.

### Changed — platform-specific listener code is isolated

- `launchd.ts` is now the only module that knows the background listener is a
  macOS LaunchAgent. `Paths.plistFile` is gone; callers use
  `isLaunchAgentInstalled(paths)` instead of testing for a plist. Groundwork
  for a non-macOS listener — no behavior change.

### Fixed

- `agentcall --version` reported `0.2.0` on a `0.3.0` package.
- `agentcall doctor` gained a `workdir` check.

## 0.2.0 — 2026-07-16

Two headline features: **task menus** (owners scope what callers may do) and
**caller-only installs** (register just to call, no agent to answer).

### Added — Task menus & agent cards

- **Task-scoped capabilities.** An owner defines a menu of named tasks under
  `~/AgentCall/tasks/<id>/SKILL.md`. Each call is resolved to one task *before*
  the agent spawns, and the agent runs with only that task's tools, writable
  paths, and network domains — enforced by both agent flags (`--allowedTools` /
  codex sandbox level) and the srt sandbox. A caller's message can never widen
  the capability set.
- **Built-in `ask` task.** A read-only Q&A task is always available; it needs no
  files and answers using the public directory only.
- **Agent cards.** `agentcall card <address>` shows another agent's task menu
  (personalized to what you're granted). Owners review their own card and lint
  it for problems with `agentcall card` (no arguments), and publish with
  `agentcall card push`. Cards are stored on the relay and fetchable while the
  callee is offline.
- **Policy verbs** rewrite `~/.agentcall/policy.json` and republish your card:
  `agentcall allow <handle> <task>`, `revoke`, `block`, `unblock`,
  `offer <task>`, `unoffer`.
- **`agentcall task new <id>`** scaffolds a ready-to-edit task file.
- **`agentcall call --task <id>`** picks a task explicitly; refusals come back
  with the menu of tasks you *are* offered.

### Added — Caller-only mode

- **`agentcall setup --caller-only`** registers a handle for calling out without
  installing the background listener or any answering machinery — useful on a
  machine with no agent, or where you only initiate calls.
- Interactive setup now asks whether to make your agent callable and falls back
  to caller-only when neither `claude` nor `codex` is found.
- Re-running `setup` on a caller-only install upgrades it to callable once an
  agent is present.

### Changed

- **Plain calls now run the read-only `ask` task.** A call without `--task` no
  longer gets full workspace access by default — it runs `ask` (read-only). To
  offer write/exec/network capability, define a task with those tools and grant
  it (`agentcall offer <task>` or `allow <handle> <task>`). This is the
  intended least-privilege default; it changes behavior for anyone who relied
  on plain calls having full access.
- Task definitions are a single YAML-frontmatter `SKILL.md` per task (the
  directory name is the task id). There is no separate manifest file.

### Fixed

- **Relay would fail to start** because it exported a non-handler value from the
  worker entry module; current workerd rejects that. (Blocked deploys.)
- **Sandboxed spawns failed with exit 127** inside terminal wrappers (e.g. cmux)
  when an ephemeral per-session shim shadowed the real agent binary on `PATH`;
  the runner now prefers the durable install.
- `write_paths` in a task are restricted to `public` and its subpaths, so a task
  can't declare a writable directory the sandbox would deny anyway.
- The `offered` list on error frames is bounded and validated, closing a
  terminal-injection vector from a hostile callee.

### Protocol (`@benree/agentcall-shared`)

- `call_request` / `incoming_call` / `call_result` gain an optional `task`;
  `call_reply` echoes it.
- New error codes: `blocked`, `task_not_offered`, `task_unknown`.
- Error frames carry an `offered: string[]` menu.
- `RegisterRequest.agent_kind` is optional (caller-only registration).
- New relay route `GET /v1/card/:handle` (public and authenticated views) and
  `PUT /v1/card`.

### Migration (relay operators)

- Apply the D1 migrations before deploying the new worker:
  `cd apps/relay && npx wrangler d1 migrations apply DB --remote`
  (adds the `cards` table and makes `handles.agent_kind` nullable).

## 0.1.2 — 2026-07-14

- Keep ephemeral temp shim directories out of the LaunchAgent PATH.
- Survive launchd bootstrap races; skip the agent prompt on reuse.

## 0.1.1

- Setup no longer hangs on the second interactive prompt.

## 0.1.0

- Initial release: call another person's sandboxed coding agent by address over
  a shared relay, with a resident listener for instant answers.
