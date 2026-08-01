# CLAUDE.md

Dev guide for working in this repo. **[README.md](./README.md) is the authority on
current behavior**, with [CHANGELOG.md](./CHANGELOG.md) for what changed when and
**GitHub Issues for what is still open.**

## Where work is tracked

**Open work lives in GitHub Issues, not in a file.** `gh issue list` is the status
board; check it before starting anything, and don't reintroduce a markdown TODO.

```bash
gh issue list                                             # everything open
gh issue list --label status:next --search "no:assignee"  # ready AND unclaimed
gh issue list --search "is:open assignee:*"               # what's already taken
gh issue view <n>                                         # full context, incl. dependencies
```

**The assignee is the claim** — check it before starting, take it when you start,
release it when you stop. Full protocol in
[CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).

Labels: `area:*` groups by track (`security`, `a2a`, `deployment`, `enterprise`,
`availability`, `positioning`, `product`, `debt`). `status:*` carries state —
`next` (pick this up), `gated` (blocked on a stated precondition, **do not start
coding**), `blocked` (waiting on another issue), `deferred` (deliberately not being
worked on *by decision* — reopen the decision before touching it). `kind:*` marks
`decision`, `experiment`, `bug`.

Dependencies are written into issue bodies as "Blocked by #n" — GitHub has no native
dependency field, so keep them there when you add an issue.

Two standing constraints that aren't any single issue's property:

- **Public or enterprise deployment is blocked on #1–#8 (the C track) and #10.** A
  passing TCK says nothing about safe prompt execution.
- **Some issues collide in `apps/relay`.** #16 touches Durable Object addressing, which
  the A2A track is actively changing. Coordinate — and use one worktree per session, per
  [CONTRIBUTING.md](./CONTRIBUTING.md#one-worktree-per-session).

Everything under `docs/superpowers/` is a **historical** design/implementation
record, dated and never revised — useful for *why* a decision was made, wrong about
*what the code does now*. Each file carries a banner saying so. Don't derive current
behavior from them, and don't "fix" them to match the code. Same for
`docs/security/2026-07-16-security-review.md`, which reviews a sandbox layer that was
removed on 2026-07-31.

## Monorepo layout

pnpm workspace, TypeScript everywhere, ESM (`"type": "module"`).

```
agentcall/
├── apps/relay/          # CF Worker + Durable Object + D1 (Hono, wrangler)
├── packages/shared/     # @benree/agentcall-shared — zod protocol schemas, single source of truth
└── packages/cli/        # @benree/agentcall — the `agentcall` command (setup/listen/call/status/uninstall)
```

**Protocol types live in `packages/shared`.** If you're changing a WS frame shape,
adding a field, or touching anything both sides of a call agree on, change the zod
schema in `packages/shared/src/protocol.ts` first, then update the relay and CLI to
match. Don't duplicate frame shapes locally in `apps/relay` or `packages/cli` —
import them from `@benree/agentcall-shared`.

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

**`typecheck` does not cover the test files** — each package's `tsconfig.json` has
`"include": ["src"]`. Change a function's signature and `pnpm typecheck` stays green
while every stale call site in `test/` compiles fine and fails at runtime instead. So
`pnpm -r test` is the only thing that catches it: never take a green typecheck as
proof a refactor is complete. (Worth fixing with a `tsconfig.test.json`.)

`packages/cli` depends on the *built* `packages/shared`, so run `pnpm -r build` after
editing a shared schema or the CLI will typecheck against stale `dist` types.

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
