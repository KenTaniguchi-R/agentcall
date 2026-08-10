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

- **Cross-organization durable routing is a non-goal.** Not deferred, not gated — the
  organization is the outermost boundary AgentCall routes durable Team identities within, and a human
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
the `cards` table) — `/v1/register`'s D1 work throws (missing table, or a NOT
NULL violation on a caller-only registration), and the route's `catch` returns a
**503** `"registration temporarily unavailable"` with `Retry-After: 5`
(`apps/relay/src/index.ts:115-120`). The CLI renders that as `Registration is
temporarily unavailable. Try again shortly.` — which reads like the relay is
having a moment, not like your schema is wrong.

**The signal is in the `wrangler dev` output, not the response.**
`registrationDatabaseFailure` classifies the error before discarding it and logs
`registration database failure { name, kind }` (`index.ts:50-62`). `kind:
"schema"` is a missing table or column; `kind: "constraint"` is the NOT NULL
case. It deliberately never echoes the raw D1 message, which can carry SQL and
bound values — so the classification is all you get, and it is enough. Run
`wrangler d1 migrations apply agentcall --local` from `apps/relay` before
registering anything against a fresh local D1.

A 409 `"handle taken"` here is real. The route confirms the row exists via
`handleExists` before returning 409 and falls through to 404 `"invalid invite"`
otherwise (`index.ts:110-113`), so it is not the migration symptom in disguise
— an earlier revision of this note said it was.

**Before calling any task done: `pnpm verify` must pass at the repo root.** That is
the whole gate and the only definition of done — `scripts/ci-local.sh fast`, which
runs the `verify` job's six steps *and* every invariants check.

```bash
pnpm verify                    # = scripts/ci-local.sh fast (the pre-push default)
scripts/ci-local.sh packaged   # packed-cli-consumer job on Node 20/22/24 — slow, run before a release
```

Running `pnpm -r build && pnpm -r typecheck && pnpm -r test` by hand is a *weaker*
check than `pnpm verify`: it skips `pnpm lint`, `docs:check`, the wrangler bundle,
and all eight invariants. It used to be quoted here as the done-criterion, which
meant the stated bar was lower than the gate that actually blocks the push. Use
`pnpm verify`.

Step order inside it mirrors `ci.yml` and is load-bearing. **Lint first** — it reads
source directly and needs nothing built, so the cheapest failures surface first.
**Build second** — `packages/cli` typechecks against `packages/shared`'s built
`dist`, so running build last checks the *previous* run's types. `.github/workflows/ci.yml` runs exactly this
order when manually dispatched; automatic push and PR runs are temporarily paused
while GitHub Actions billing is unavailable, which is why the local gate is the gate.

A pre-push hook runs `fast` automatically once per clone — `git config core.hooksPath
"$(git rev-parse --show-toplevel)/scripts/hooks"`. Use an absolute path: git resolves a
relative `core.hooksPath` against the current directory, so the relative form silently
stops firing when you push from a subdirectory.

**Keep the script in step with the workflows.** A local gate that has drifted is worse
than none, because it reports green for a rule CI would fail. When you add a check to
`invariants.yml`, add it to `ci-local.sh` and confirm it actually fails on a planted
violation — not just that it passes.

That rule was aspirational until it wasn't: `docs:check` and the wrangler bundle step
ran in CI and not locally, so the hook passed commits CI would have failed. The
`inv_gate_mirrors_ci` check now enforces it in the one direction a script can. It
classifies every shell step in ci.yml's `verify` job as either mirrored (the command
must appear verbatim inside `run_verify`) or deliberately unmirrored with a reason. A
step added to `ci.yml` is in neither list and fails the check until someone classifies
it. Adding a step to `run_verify` alone still won't fail anything — that direction is
harmless.

`pnpm lint` is oxlint, pinned exactly in the root `devDependencies` and configured
by `.oxlintrc.json`. It runs over `apps` and `packages` — src *and* test — at
`--max-warnings 0`, so every finding fails the gate. The default rule set is on;
the config turns off exactly two rules and says why in place. Add a disable there
with its reason rather than a bare `oxlint-disable` comment at a call site, and
never loosen a validator to quiet a rule.

**What it does not cover: type-aware rules.** oxlint does not read the type
checker, so `no-floating-promises` and `no-misused-promises` are not available —
an unawaited D1 write or a dropped `ctx.waitUntil` in `apps/relay` still
typechecks clean, lints clean, and fails in production. Closing that needs
typescript-eslint, which is a separate decision (see #336).

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

**Test files are yours to edit; the grader is not.** `scripts/guard-verification-gate.sh`
is a `PreToolUse` hard deny (registered in `.claude/settings.json`) covering
`scripts/ci-local.sh`, `.github/workflows/`, the hook itself, and the settings that
register it. It fires before the permission check, so it holds even under
`--dangerously-skip-permissions`, and the only way through is a human editing those
files outside Claude Code. Tests are deliberately outside that set — blocking them
blocked writing the failing test first, which is the workflow above. The direction
that actually matters is caught at push instead: `inv_test_churn` fails the gate when
an existing test file loses more lines than it gains on a branch that also changed
`src/`, and warns when `src/` changed with no test lines added. When that fires,
confirm by eye that it is a real simplification and not a weakened check, then push
with `--no-verify`. See #335 for why the layer exists and #374 for why it is scoped
this way.

## Git

Stage files explicitly (`git add <file> <file>`) — never `git add -A` or `git add .`.
Review what's staged before committing.
