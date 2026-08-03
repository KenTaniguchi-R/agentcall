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
[CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work) (also summarized in
[AGENTS.md](./AGENTS.md)).

Labels: `area:*` groups by track (`security`, `a2a`, `deployment`, `enterprise`,
`availability`, `positioning`, `product`, `debt`). `status:*` carries state —
`next` (pick this up), `gated` (blocked on a stated precondition, **do not start
coding**), `blocked` (waiting on another issue), `deferred` (deliberately not being
worked on *by decision* — reopen the decision before touching it). `kind:*` marks
`decision`, `experiment`, `bug`.

Dependencies are written into issue bodies as "Blocked by #n" — GitHub has no native
dependency field, so keep them there when you add an issue.

Three standing constraints that aren't any single issue's property:

- **Cross-organization routing is a non-goal.** Not deferred, not gated — the
  organization is the outermost boundary AgentCall routes within, and a human
  belongs to exactly one. Don't design for an external caller, don't add a
  federation flag, and if you find a cross-org path, **delete it rather than
  disable it**. The A2A track (#9, #11, #101, #179) is where this creeps back
  in: A2A is an *in-organization* protocol surface here. See the
  [federation non-goal](./docs/superpowers/specs/2026-08-02-cross-organization-federation-non-goal.md).
- **Public or enterprise deployment is blocked on #1–#8 (the C track).** A
  passing TCK says nothing about safe prompt execution. (#10 was part of this
  gate until the federation non-goal closed it — in-organization callers are
  already resolved by `authenticateRequest`, and there are no external ones.)
- **Some issues collide in `apps/relay`.** #16 touches Durable Object addressing, which
  the A2A track is actively changing. Coordinate — and use one worktree per session, per
  [CONTRIBUTING.md](./CONTRIBUTING.md#one-worktree-per-session).

Before designing work in `area:enterprise`, `area:security`, or `area:a2a`, read
the living [reference implementation index](./docs/research/reference-implementations.md).
It records the external precedents we follow, the boundaries we do not copy, and
the AgentCall implementations that have adopted them.

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

### `apps/relay && pnpm dev` needs local D1 migrations applied first

`wrangler dev` does not apply `apps/relay/migrations/*.sql` to the local D1
instance for you. If any migration is missing — e.g. `0002_agent_kind_nullable.sql`
(makes `agent_kind` nullable for caller-only lines) or `0003_cards.sql` (adds
the `cards` table) — `/v1/register`'s `INSERT INTO handles` throws (missing
table, or a NOT NULL violation on a caller-only registration), and the handler
(`apps/relay/src/index.ts`, the `/v1/register` route) turns ANY insert failure
into a 409 `"handle taken"`. That looks exactly like a real handle collision
and is not one. Run `wrangler d1 migrations apply agentcall --local` from
`apps/relay` before registering anything against a fresh local D1.

Before calling any task done: `pnpm -r build && pnpm -r typecheck && pnpm -r test`
must all pass at the repo root. **Build first** — `packages/cli` typechecks against
`packages/shared`'s built `dist`, so running build last checks the *previous* run's
types. `.github/workflows/ci.yml` runs exactly this order on every push and PR.

`typecheck` covers `src` *and* `test`. `shared` and `cli` each carry a
`tsconfig.test.json` (`include: ["src", "test"]`, `noEmit`) that their `typecheck`
script runs after the src pass; `apps/relay` already had `test` in its main
`tsconfig.json`. Keep it that way: without it, changing a function signature leaves
`pnpm typecheck` green while every stale call site in `test/` fails at runtime
instead — vitest strips types without checking them.

### `packages/cli/test/runner.test.ts`'s process-group-kill test has a known flake

`"kills the whole process group on timeout, so a grandchild holding stdout doesn't
hang the promise"` spawns a real detached child (which spawns its own grandchild),
waits for a real 500ms `runAgent` timeout to fire, asserts the whole thing completed
in under 5s, then sleeps 300ms and asserts the grandchild is actually gone
(`process.kill(pid, 0)` throws). All four numbers are wall-clock, not mocked, so
under load — several vitest workers doing real process spawns/kills at once, as
happens repeatedly running the full suite in this repo — either the 5s ceiling or the
300ms post-SIGTERM grace period can be missed even though the kill logic itself is
correct. Seen failing standalone and passing when re-run in isolation; not
node-version dependent. The fix is to make the deadlines a mockable/injectable clock
rather than real timers, not chase a bigger margin.

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
