# Contributing

How work gets picked up here. [CLAUDE.md](./CLAUDE.md) is the dev guide —
layout, tests, TDD. [README.md](./README.md) is the authority on current
behavior. This file covers only how two people avoid doing the same work twice.

## Claiming work

**Open work lives in GitHub Issues, and the assignee is the claim.** Before
starting anything, check whether it is already taken:

```bash
gh issue list --label status:next --search "no:assignee"   # ready and free
gh issue list --search "is:open no:assignee"               # everything free
gh issue list --search "is:open assignee:*"                # taken, and by whom
```

Claim it, then confirm the claim stuck:

```bash
gh issue edit <n> --add-assignee @me
gh issue view <n> --json assignees --jq '[.assignees[].login]'
```

**The read-back is not optional.** `--add-assignee` does not fail when someone
already holds the issue — it adds you as a second assignee and exits zero. Two
people claiming within a few seconds both succeed, both think they hold it, and
nothing surfaces the conflict. If that list has anyone but you in it, you lost
the race: drop it and pick something else.

Release it when you stop working, whether or not you finished:

```bash
gh issue edit <n> --remove-assignee @me
```

### Assignee means active work, not ownership

This is deliberately narrower than GitHub's usual "this is yours" reading. An
assignee here means *someone has hands on this right now*, which is what makes
the staleness rule below safe. Don't assign an issue to somebody to indicate
they will eventually own the decision — that is what the issue body is for.

### Stale claims are released automatically

A claim nobody releases would freeze an issue forever, so a scheduled workflow
(`.github/workflows/stale-claims.yml`) unassigns any open issue with no activity
for **3 days** and comments saying so. Re-claim it the normal way if you are
still working on it.

**It sweeps once a day, at 09:00 UTC** — it is not continuous. A claim that goes
stale at 10:00 UTC survives until the next morning's run. Nothing is broken when
that happens; the reaper simply hasn't run yet.

**It comments first, then unassigns** — that order is deliberate. If the comment
fails, the claim survives with a stray note, which is recoverable. Unassigning
first and then failing would strip a claim with no explanation of where it went.
Don't "tidy" the order. It also means the release comment on your issue is
expected behavior, not somebody else editing your issue by hand.

Renewal is a side effect of working: comments, edits, and label changes all bump
the issue's activity timestamp. Staying claimed on a long task means leaving
progress notes on it, which is worth doing anyway.

## One worktree per session

**Two sessions must not share a checkout.** This has already cost uncommitted
work in this repo, and on 2026-08-01 two sessions committed to the same checkout
minutes apart while neither could see the other.

```bash
git worktree add .claude/worktrees/<topic> -b <branch>
```

Claiming stops two people taking the same *issue*. This stops two sessions
trampling the same *files* — you need both.

## Verification runs on your machine

Automatic GitHub Actions runs are paused while billing is unavailable, so
nothing enforces the build, the tests, or any invariant on the way to `main`
except a local hook. Set it up once per clone:

```bash
git config core.hooksPath "$(git rev-parse --show-toplevel)/scripts/hooks"
```

Use the absolute path. Git resolves a relative `core.hooksPath` against the
current directory, so the relative form silently stops firing the moment you
push from a subdirectory — and a gate that quietly stops running is worse than
no gate.

That setting lives in `.git/config`, which every worktree shares, so one
invocation covers all of them. Each push runs the *pushing worktree's* copy of
the script, against the tree being pushed. A worktree branched before the gate
landed has no copy and will refuse to push until you merge `main` into it.

```bash
scripts/ci-local.sh fast       # what the hook runs: build, typecheck, test, invariants
scripts/ci-local.sh packaged   # the Node 20/22/24 packed-CLI job — slow, run before a release
```

`--no-verify` exists and there are honest uses for it, like pushing a WIP branch
for another pair of eyes. It should not become the habit; nothing else is
checking right now.

Changing a check in `.github/workflows/` means changing `scripts/ci-local.sh`
too. A drifted mirror reports green for a rule CI would fail, which is the one
failure mode worse than a missing check — so confirm a new check actually fails
on a planted violation, not just that it passes.

## Labels

`area:*` groups by track. `status:*` carries readiness — `next`, `gated`,
`blocked`, `deferred`. `kind:*` marks `decision`, `experiment`, `bug`. Full
meanings are in [CLAUDE.md](./CLAUDE.md).

Note that `status:*` and the assignee answer different questions: `status:next`
means *this issue is ready to be worked*, and an assignee means *someone is
working it*. An issue keeps `status:next` while claimed.

## Documentation site

Public documentation lives in [`docs/site/`](./docs/site/). Mintlify publishes
that directory from `main`; files elsewhere in `docs/` are repository records
and must not be added to the site's navigation. After changing CLI commands or
protocol schemas, run `pnpm build && pnpm docs:generate`, commit both generated
references, and run `pnpm docs:check` before opening a pull request.
