# CLAUDE.md

Dev guide for working in this repo. See [README.md](./README.md) for what agentcall
is and how it works; see `docs/superpowers/specs/2026-07-13-agentcall-design.md` for
the full design spec.

## Monorepo layout

pnpm workspace, TypeScript everywhere, ESM (`"type": "module"`).

```
agentcall/
├── apps/relay/          # CF Worker + Durable Object + D1 (Hono, wrangler)
├── packages/shared/     # @agentcall/shared — zod protocol schemas, single source of truth
└── packages/cli/        # agentcall — the npm CLI (setup/listen/call/status/uninstall)
```

**Protocol types live in `packages/shared`.** If you're changing a WS frame shape,
adding a field, or touching anything both sides of a call agree on, change the zod
schema in `packages/shared/src/protocol.ts` first, then update the relay and CLI to
match. Don't duplicate frame shapes locally in `apps/relay` or `packages/cli` —
import them from `@agentcall/shared`.

## Test commands

Per package (run from that package's directory), or `-r` from root for all:

```bash
pnpm -r test         # vitest run, all packages
pnpm -r typecheck    # tsc --noEmit, all packages
pnpm -r build        # tsc build, all packages

cd packages/shared && pnpm test
cd apps/relay && pnpm test      # @cloudflare/vitest-pool-workers — exercises HandleDO directly
cd packages/cli && pnpm test    # vitest, mocked ws/fs — no live agent spawn
```

`apps/relay && pnpm dev` runs the Worker locally against `wrangler dev` for manual
testing (WS auth, register, status).

Before calling any task done: `pnpm -r test && pnpm -r typecheck && pnpm -r build`
must all pass at the repo root.

## TDD

This codebase was built test-first and stays that way. Write the failing test before
the implementation — schema round-trip/rejection tests in `packages/shared`, DO
relay-logic tests with fake caller/listener sockets in `apps/relay`, and
protocol-client/runner/config tests with mocked `ws`/`fs` in `packages/cli`. No live
`claude`/`codex` spawn in CI — `packages/cli/test/runner.test.ts` uses a fake agent
binary.

## Git

Stage files explicitly (`git add <file> <file>`) — never `git add -A` or `git add .`.
Review what's staged before committing.
