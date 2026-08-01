# Changelog

All notable changes to agentcall are recorded here. Versions apply to both
`@benree/agentcall` (the CLI) and `@benree/agentcall-shared` (protocol schemas),
which are released together.

## Unreleased

### Fixed — the Codex guard was registered but never actually ran

- **`--dangerously-bypass-hook-trust` added to the Codex spawn.** Codex gates
  hook execution on *persisted trust* — each hook carries a `trusted_hash`, and
  a hook supplied inline via `-c` has never been trusted, so Codex skipped it.
  Silently: no warning on stdout or stderr, no change to the exit code. The
  observe-mode guard added below was therefore dead code from the moment it
  shipped, and Codex spawns produced **no** `tools.log` telemetry at all.
  Verified against codex-cli 0.146.0: the identical spawn logged zero
  `tool_call` lines with the flag absent and one with it present.
- The bypass is safe only because it stays paired with `--ignore-user-config`,
  which drops `$CODEX_HOME/config.toml` — the file where Codex records trusted
  project directories. With no trust list loaded, the cwd/tree/repo config
  layers stay disabled and a `.codex/hooks.json` planted in the workspace is not
  loaded. Verified by planting one: it did not run, while agentcall's own hook
  did. A test now pins both flags together.

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
