# Changelog

All notable changes to agentcall are recorded here. Versions apply to both
`@benree/agentcall` (the CLI) and `@benree/agentcall-shared` (protocol schemas),
which are released together.

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
