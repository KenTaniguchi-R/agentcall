# Contributing

How work gets picked up here. [CLAUDE.md](./CLAUDE.md) is the dev guide —
layout, tests, TDD. [README.md](./README.md) is the authority on current
behavior.

**Security issues do not go through this file.** Read
[SECURITY.md](./SECURITY.md) — a public pull request is a public disclosure, and
several things that look like findings are documented properties of the design.

## Start here if you do not have write access

Fork, branch, and open a pull request. You do not need permission first and you
do not need to claim anything for a small fix — a typo, a broken link, a
documentation claim that overstates what the code does. Those are welcome as-is.

For anything larger, **open or comment on an issue before you write the code.**
Not as a formality: this repository has three standing constraints that quietly
invalidate whole categories of otherwise good work, and it is much cheaper to
hear about them before the diff than after.

- **Cross-organization routing is a permanent non-goal**, not a missing feature.
  A patch that adds a federation flag will be closed regardless of quality. See
  the [federation non-goal](./docs/superpowers/specs/2026-08-02-cross-organization-federation-non-goal.md).
- **Public and enterprise deployment is gated** on the C track (#1–#8).
- Issues labelled `status:gated` are blocked on a stated precondition and
  `status:deferred` means a decision was made not to do it. Reopen the decision
  before writing the code.

Then:

```bash
pnpm install
pnpm verify          # must pass before you push — this is the whole gate
git commit -s        # the -s is required, see below
```

`pnpm verify` is not advisory. It is the only definition of done in this
repository, it runs everything CI would run, and a maintainer will ask for it
before reading the diff.

The rest of this file — claiming, worktrees, labels — describes how people with
write access avoid colliding. Read it if you are one; skip it if you are not.

## Developer Certificate of Origin

Every commit needs a `Signed-off-by:` line. `git commit -s` adds it.

It certifies the [DCO](https://developercertificate.org/): that you wrote the
patch, or that you have the right to submit it under the license of the files
you touched. It is one line, not a contract, and **there is no CLA** — you keep
your copyright, we never ask you to sign it over, and we therefore cannot
relicense your work into something proprietary later.

Inbound equals outbound. `packages/shared` is MIT; everything else is
FSL-1.1-ALv2 and converts to Apache-2.0 two years after each release. Full map
in [LICENSING.md](./LICENSING.md).

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
git worktree add /tmp/agentcall-<topic> -b <branch>
```

**Put it outside the repo.** Earlier guidance here used `.claude/worktrees/`,
and nesting turned out to cost more than it saved: those checkouts reached
3.8 GB, buried real untracked files in `git status`, sat one `git clean -fdx`
away from deletion, and held their branches hostage — `main` checked out at
`.codex/worktrees/issue49` makes `git switch main` fail in the main checkout
with "already used by worktree". Both nested paths are now gitignored, but a
path outside the repo avoids the problem rather than hiding it.

Remove a worktree when you are done with it. `git worktree remove <path>`
deletes only the directory; the branch and its commits stay in the repo.

```bash
git worktree list                  # what exists
git worktree remove <path>         # done with it
git worktree prune                 # drop records of directories already gone
```

Claiming stops two people taking the same *issue*. This stops two sessions
trampling the same *files* — you need both.

## Verification runs on your machine

Automatic GitHub Actions runs are paused while billing is unavailable, so
nothing enforces the build, the tests, or any invariant on the way to `main`
except a local hook. (Standard runners are free for public repositories, so this
constraint lifts when the repository goes public — until someone has confirmed a
green run on `main` and updated this paragraph, assume it still holds.) Set it up
once per clone:

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
