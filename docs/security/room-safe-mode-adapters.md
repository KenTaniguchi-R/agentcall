# Room safe-mode adapter evidence

Room execution fails closed. A client may become callable in a Room only when its
agent, operating system, and architecture appear in the passing catalog in
`packages/cli/src/room-safety.ts`. Claude Code versions are not pinned; the catalog's
recorded version identifies the probe that established support for its adapter,
platform, and architecture. Unprobed agents and platforms are unsupported. Passing
evidence also expires after 90 days; malformed, future-dated, or commandless evidence
is rejected.

## Support matrix

| Agent | CLI | Platform | Decision | Reason |
|---|---|---|---|---|
| Claude Code | Any version | macOS arm64 | Supported | The adapter's safety contract passed the opt-in live canary on 2.1.220 on 2026-08-03 PDT. |
| Codex CLI | 0.146.0 | macOS arm64 | Unsupported | `read-only` controls writes but still exposes reads outside the workdir, and this CLI has no switch that removes its shell/file tools. |
| Any other agent/platform | any | any | Unsupported | No passing adapter evidence. |

The Claude adapter runs in an empty, non-symlink workdir with no built-in tools,
safe mode, no persisted or resumed session, no setting sources, an explicitly empty
MCP configuration, no Chrome integration, disabled slash commands, and a minimal
environment. Its process must be started as a detached process group and cancelled
with `SIGTERM`, followed by `SIGKILL` after ten seconds.

Claude subscription authentication requires preserving `HOME`. Claude Code's
`--safe-mode` is therefore the enforcement against user and project
customizations; it explicitly leaves administrator-managed policy in force. Such
policy is trusted machine-owner configuration and remains outside the Room caller
threat boundary. A deployment that cannot trust its managed policy must not enable
this adapter without an additional OS sandbox.

## Reproducing the live probe

The probe is deliberately skipped in ordinary tests because it uses the installed
CLI and local authentication:

```sh
AGENTCALL_PROBE_ROOM_SAFETY=1 pnpm --filter @benree/agentcall \
  exec vitest run test/room-safety.probe.test.ts
```

The Claude probe uses a positive control to load hostile settings, execute a hook,
load a plugin skill, and persist a uniquely identified canary session. A resume
control must recover that session canary; the adapter rejects resume input and the
safe-mode treatment must observe none of it. The probe removes its temporary session
afterward. MCP servers, file writes and shell processes, browser and general network
paths, and image generation use separate markers or endpoints. Claude Code 2.1.220
has no separate bundled-app execution surface, so `apps` is recorded explicitly as
`not_applicable` rather than treating another MCP process as independent app proof.

The Codex decision has its own executable negative probe:

```sh
AGENTCALL_PROBE_CODEX_ROOM_SAFETY=1 pnpm --filter @benree/agentcall \
  exec vitest run test/room-safety-codex.probe.test.ts
```

It passes by reproducing the unsafe behavior: Codex 0.146.0 in `read-only` mode
reads a randomized canary outside the empty workdir. A future release that no longer
reproduces this result forces reassessment rather than silently becoming supported.

It plants randomized canaries for parent/project instructions, outside-workdir
files, AgentCall-like state, user configuration, skills, hooks, MCP, environment,
write attempts, and a loopback network endpoint. A passing run must reveal no
canary, execute no hook or MCP process, perform no write or network request, and
leave the empty workdir unchanged. Existing runner integration tests provide the
shared process-group behavior, and the Room executor regression test proves the
Room contract uses that same cancellation path.

The probe command is a candidate builder separate from participant admission. Only
the catalog-backed builder is valid for Room execution, preventing a new CLI
version from accidentally using stale evidence.
