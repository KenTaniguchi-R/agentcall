# Caller-only mode

**Date:** 2026-07-16
**Status:** Approved design, pending implementation plan

## Problem

`agentcall setup` forces every user into being callable: it hard-errors if
neither `claude` nor `codex` is on PATH, always installs the launchd background
listener, and always seeds srt.json. But some users only want to *call* other
people's agents — they never intend to expose their own machine. Today they
can't complete setup at all without an agent binary, and even with
`--skip-launchd` they end up with a config that claims an agent they don't run.

## Decision summary

- Add a **caller-only mode**: register a handle + token, skip agent detection,
  launchd, and srt.json. (Chosen over receiver-only or a role picker.)
- Caller-only users **still register** — callees keep caller identity and the
  relay keeps per-caller auth/rate-limit hooks. (Chosen over anonymous calls.)
- Setup **asks interactively**: "Make your agent callable by others? [Y/n]",
  with a `--caller-only` flag for non-interactive use. When no agent binary is
  found, setup falls back to caller-only with a notice instead of erroring.
  (Chosen over flag-only or silent auto-detect.)
- Model it as **optional `agent_kind`** end-to-end (Approach A): absent
  `agent_kind` = caller-only. Rejected: a `"none"` sentinel (pollutes the
  `"claude" | "codex"` type everywhere it's spawned) and a CLI-only placeholder
  hack (lies to the relay's DB).

A useful property that keeps this small: the relay only *stores* `agent_kind`
at registration and never reads it again — call routing and spawning are
driven entirely by the CLI's local config. Upgrading caller-only → callable is
therefore a purely local operation.

## Changes by package

### packages/shared

`RegisterRequest.agent_kind` becomes optional:

```ts
agent_kind: z.enum(["claude", "codex"]).optional(),
```

Tests: round-trip with and without `agent_kind`; still rejects invalid values
(e.g. `"gpt"`); `RegisterRequestType` reflects optionality.

### apps/relay

- Migration `0002`: allow NULL `agent_kind`. SQLite can't drop a CHECK or
  NOT NULL constraint in place, so rebuild: create `handles_new` with
  `agent_kind TEXT CHECK (agent_kind IN ('claude','codex'))` (nullable), copy
  rows, drop old table, rename.
- `/v1/register`: bind `agent_kind ?? null` in the INSERT.
- No other relay change: status, call routing, and the DO never read
  `agent_kind`. A caller-only handle simply never has a listener connected, so
  `status` reports `offline` and calls to it fail with `offline` (see
  Deferred).

Tests: register without `agent_kind` → 200, row stored with NULL; register
with `agent_kind` unchanged; 409 on duplicate still works for caller-only
handles; a caller-only handle can authenticate as a caller and complete a call
to a listening handle (fake sockets, existing DO test harness).

### packages/cli

**Config** (`config.ts`): `agent_kind` becomes optional:

```ts
interface Config {
  handle: string;
  token: string;
  agent_kind?: "claude" | "codex"; // absent = caller-only
  relay: string;
}
```

**Setup flow** (`setup.ts`, `index.ts`): new `--caller-only` flag; mode is
decided *before* agent detection:

1. `--caller-only` passed → caller-only.
2. Reuse branch (existing config for the same handle):
   - Existing config is full → unchanged behavior (reuse, no prompt).
   - Existing config is caller-only → this run is the **upgrade path**: ask
     the callable question (or honor `--caller-only` to stay as-is). On "yes",
     run agent detection, add `agent_kind` to config, seed srt.json, install
     launchd. Handle/token are kept; no relay round-trip (the relay's stored
     NULL is stale but unread — acceptable).
3. Fresh setup, interactive: if no `claude`/`codex` on PATH, print
   "No claude or codex found — setting up as caller-only. Re-run
   `agentcall setup` after installing one to make your agent callable." and
   proceed caller-only (replaces today's hard error). Otherwise ask
   "Make your agent callable by others? [Y/n]" (default Y).
4. Fresh setup, non-interactive (`--yes`): callable if an agent is found
   (current behavior), caller-only with a notice if not.

In caller-only mode setup **skips**: agent detection, both
`warnIfOutsideLaunchdPath` warnings, srt.json seeding, `publicDir` creation,
and the launchd install. It **keeps**: handle prompt/registration, config
save, and the CLAUDE.md/AGENTS.md snippet (the snippet documents *calling*
others — caller-only users want it most). `registerHandle` passes
`agent_kind: undefined`.

The final summary message adapts: caller-only prints the handle/relay/address
and how to call others, and mentions the upgrade path instead of "Share your
address so others can call your agent".

**Listener** (`index.ts` `listen` command): if the loaded config has no
`agent_kind`, exit with a clear error: "This install is caller-only — re-run
`agentcall setup` to make your agent callable." Guard at the command level so
`startListener`/`runner` keep their non-optional `agent_kind` types.

**`call` / `status`**: no changes — they already only need handle/token/relay.

Tests (mocked ws/fs, fake bins as today): caller-only setup registers without
`agent_kind`, saves config without it, never calls `installLaunchAgent`, never
writes srt.json; no-agent-found falls back to caller-only instead of throwing;
upgrade re-run adds `agent_kind` + launchd + srt while keeping handle/token;
`listen` with caller-only config exits with the error message; full-mode setup
behavior unchanged.

## Compatibility & rollout

- **Deploy the relay first.** The old relay's zod schema requires
  `agent_kind`, so a new caller-only CLI registering against an old relay gets
  a 400. New relay accepts both old CLIs (send `agent_kind`) and new ones.
- Existing configs all have `agent_kind`; making the field optional is
  backward-compatible with every saved config.
- `pnpm -r test && pnpm -r typecheck && pnpm -r build` must pass at root.

## Out of scope / deferred

- **`not_callable` status**: calling a caller-only handle reports `offline`
  ("try again later"), which invites futile retries. A distinct
  `not_callable` error/status (relay checks `agent_kind IS NULL`) is a fast
  follow once this data model lands; requires a protocol + relay change.
- **Downgrade** (full → caller-only): not supported by setup; `agentcall
  uninstall` already removes the listener. `--caller-only` against an existing
  full config prints a message pointing at `uninstall` and makes no changes.
- **Receiver-only mode** and **anonymous calling**: considered and rejected
  for now (see Decision summary).
