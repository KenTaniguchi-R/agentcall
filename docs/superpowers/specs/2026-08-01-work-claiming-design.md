# Claiming work — stopping two sessions from taking the same issue

**Date:** 2026-08-01
**Status:** **Design, approved.** Ready for an implementation plan. Nothing built yet.

## The problem

On 2026-08-01 two sessions were working this repo at the same time, in the same
checkout, and neither could see the other. One was running the P2 experiment for
issue #3 — writing `scripts/verify-codex-deny-read-p2.sh`, driving `codex exec`
against a canary, and it committed mid-conversation (`7cfe640` → `b903fa0`). The
other was reading the issue board and treating #3 as the obvious thing to pick up,
because it is the only issue labelled `status:next`.

Nothing on GitHub said #3 was taken. Nothing on disk said it either. The collision
was caught by noticing a file mtime 20 seconds old, which is luck, not process.

Two distinct failures happened, and they need distinct fixes:

1. **Two workers took the same issue.** No claim signal existed anywhere.
2. **Two sessions shared one checkout.** `CLAUDE.md` already warns against this
   ("two sessions sharing one checkout has already cost uncommitted work here")
   but the warning is Claude-only and self-enforced.

## Constraints

- **Cross-machine.** The repo has two collaborators, `KenTaniguchi-R` and
  `sota009`, on separate machines. A claim that only exists locally is useless.
- **Agent-agnostic.** A future maintainer may run Codex, Cursor, or no agent at
  all. The mechanism cannot live in `.claude/settings.json` hooks, because that
  makes it invisible to everyone not running Claude Code.

Together these force the signal onto GitHub itself.

## A claim is the assignee

**The GitHub assignee is the claim. There is no second signal.**

A `status:wip` label was considered and rejected: it would carry no information
the assignee doesn't already, and the two would drift apart the first time
somebody set one without the other.

This keeps two axes orthogonal, which the current labels do not:

| Signal | Describes | Values |
| --- | --- | --- |
| `status:*` label | **the issue** — is it ready to be worked | `next`, `gated`, `blocked`, `deferred` |
| assignee | **a person** — someone has hands on this now | a GitHub login, or empty |

An issue keeps `status:next` while it is claimed. Readiness and occupancy are
different questions, and collapsing them is what makes a board lie.

### Assignee means active work, not ownership

This is a deliberate narrowing away from GitHub's looser "this is yours" convention,
and it is what makes the staleness rule below coherent. Under an ownership reading,
#22 (the GTM decision) could sit assigned for a month to whoever will eventually
make the call, and the reaper would strip it — correctly by its own rule, wrongly by
intent.

Adopting the narrow meaning costs nothing here: **no issue in this repo has ever had
an assignee**, so there is no existing usage to break.

## Taking and releasing work

Finding unclaimed work — both forms verified against the live repo on 2026-08-01:

```bash
gh issue list --label status:next --search "no:assignee"    # ready and free
gh issue list --search "is:open no:assignee"                # everything free
gh issue list --search "is:open assignee:*"                 # what is taken, by whom
```

Claiming, then releasing:

```bash
gh issue edit 3 --add-assignee @me
gh issue view 3 --json assignees --jq '[.assignees[].login]'   # confirm it stuck
gh issue edit 3 --remove-assignee @me
```

### The read-back is not optional

`--add-assignee` does **not** fail when someone already holds the issue. It adds
you as a second assignee and exits zero. Two sessions claiming within the same
few seconds both succeed, both believe they hold it, and nothing surfaces the
conflict.

So claiming is two steps: assign, then read back. If the list has anyone but you
in it, you lost the race — drop it and pick something else. The window is small,
but it is silent, and this is the one place the design can fail closed cheaply.

## Stale claims

A claim that is never released freezes an issue forever. Since the whole point is
that the board reflects reality, dead claims are the failure mode that would make
this worthless within a month.

One scheduled workflow, `.github/workflows/stale-claims.yml`, runs daily. For each
open issue with an assignee whose `updated_at` is older than **3 days**: unassign,
and comment saying the claim was released as stale and how to re-take it.

It takes two `workflow_dispatch` inputs, both of which exist to make it testable:

| Input | Default | Purpose |
| --- | --- | --- |
| `dry_run` | `true` | Log decisions without mutating anything |
| `stale_days` | `3` | Override the threshold, so a fresh claim can be made to read as stale |

On the `schedule` trigger neither input is supplied, so the workflow must fall back
to a live run at 3 days. Note the asymmetry: `dry_run` defaults to true for a manual
dispatch (a human poking at it should not mutate by accident) but must be false when
scheduled. Getting that fallback backwards yields a reaper that never actually
reaps — and it would look healthy in the logs.

Three days fits the cadence here — sessions run in hours — while surviving a
weekend of not touching something.

**Renewal is a side effect of working.** Comments, edits, and label changes all bump
`updated_at`; a commit or PR referencing the issue does the same through a
cross-reference event. Staying claimed on a long task therefore means leaving
progress notes on it, which is behaviour worth having anyway.

This workflow is the only component that mutates state, and it is the repo's first
GitHub Action — there is no `.github/` directory today, though Actions are enabled.

## Documentation layout

`CONTRIBUTING.md` (new) is the single source: the claim protocol, the read-back
step, releasing, what the reaper does, and the worktree rule below. The other files
point at it rather than restating it.

- **`CLAUDE.md`** — its "Where work is tracked" section already teaches
  `gh issue list` as the status board. Amend those queries to include
  `no:assignee`, and add one line pointing at `CONTRIBUTING.md`.
- **`AGENTS.md`** (new, root, short) — points at `CONTRIBUTING.md` for the claim
  rule and `CLAUDE.md` for the dev guide. Codex reads this natively and other
  agents have adopted it. This file is what makes the mechanism actually
  agent-agnostic rather than nominally so.

### The worktree rule moves too

`CLAUDE.md`'s existing "prefer a git worktree per working session" warning moves
into `CONTRIBUTING.md`, with a pointer left behind. It addresses the second half of
the same incident: the claim protocol stops two workers taking the same **issue**,
the worktree rule stops two sessions trampling the same **files**. Both were
violated on 2026-08-01, an hour apart, and both fixes belong in the file every
agent is pointed at.

## Verification

The protocol half needs no test — three `gh` commands and prose.

The reaper cannot be unit-tested the way the rest of this repo is tested, so it
ships with `workflow_dispatch` alongside `schedule`, taking a `dry_run` input that
**defaults to true** and logs decisions without mutating:

1. Assign a real issue. Run dry-run. Confirm it reports **no** action — a fresh
   claim correctly left alone.
2. Re-run dry-run with a threshold-override input of `0` days, so the assignment
   just made now reads as stale. Confirm it reports it **would** unassign. This
   exercises the real selection logic rather than a mock.
3. Confirm the `updated_at` renewal assumption holds — comment on a claimed issue
   and check the timestamp moves — since the whole staleness rule rests on it.
4. Only then let the schedule run live.

Nothing here touches `packages/` or `apps/`, so the test suites are unaffected.
`pnpm -r test && pnpm -r typecheck && pnpm -r build` still get run before commit,
per the repo rule.

## Rejected alternatives

- **A PreToolUse hook that blocks edits on unclaimed issues.** Real enforcement,
  but it lives in `.claude/settings.json` and so is invisible to any maintainer not
  running Claude Code — it fails the agent-agnostic constraint outright.
- **A `pull_request` workflow that fails when the linked issue is assigned to
  someone else.** Server-side and agent-agnostic, but it fires at PR time, after
  the duplicate work is already done. It deters; it does not prevent. Worth
  revisiting if claim discipline turns out to be poor in practice.
- **Draft PR as the claim.** Purely native, no custom machinery, and it drags
  branch-per-issue discipline along. Rejected as too heavy a ritual for
  exploratory work — #3 is an experiment whose honest outcome may be
  "inconclusive", and that should not cost a PR.
