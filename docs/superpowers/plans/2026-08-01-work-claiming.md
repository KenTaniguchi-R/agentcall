# Work Claiming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make it impossible for two people or two agent sessions to unknowingly take the same GitHub issue, using a signal both machines and any agent can read.

**Architecture:** The GitHub assignee field *is* the claim — no new state, no local files, no agent-specific hooks. `CONTRIBUTING.md` documents the protocol as the single source; `CLAUDE.md` and `AGENTS.md` only point at it. One scheduled GitHub Action releases claims that go stale, so the board cannot silently fill with dead claims.

**Tech Stack:** GitHub Issues + `gh` CLI, GitHub Actions (`ubuntu-latest`), bash, `jq`. No changes to `packages/` or `apps/`.

**Spec:** [`docs/superpowers/specs/2026-08-01-work-claiming-design.md`](../specs/2026-08-01-work-claiming-design.md)

## Global Constraints

- **A claim is the assignee and nothing else.** No `status:wip` label. `status:*` describes the issue, assignee describes a person.
- **Assignee means active work, not ownership.** Documented explicitly, because it is a narrowing of GitHub's usual convention.
- **Stale threshold is 3 days** of no `updated_at` activity.
- **`dry_run` defaults to `true` for manual dispatch, but must be `false` on the schedule.** Backwards, and the reaper never reaps while looking healthy in its logs.
- **Stage files explicitly** — `git add <file> <file>`, never `git add -A` or `git add .` (repo rule, `CLAUDE.md`).
- **Nothing here touches `packages/` or `apps/`.** The test suites are unaffected, but `pnpm -r test && pnpm -r typecheck && pnpm -r build` still run clean before the final commit.

## Plan-level refinement to the spec

The spec names `.github/workflows/stale-claims.yml` as the reaper. This plan puts the *logic* in `scripts/reap-stale-claims.sh` and makes the workflow a thin caller.

Reason: a workflow with inline logic can only be tested by pushing to the default branch and waiting. A script can be run locally against the live repo in dry-run before anything merges, which is a far better test, and it matches the repo's existing `scripts/*.sh` convention (`tck.sh`, `verify-codex-deny-read.sh`). Behaviour is identical to the spec.

## File Structure

| File | Status | Responsibility |
| --- | --- | --- |
| `CONTRIBUTING.md` | create | Single source: claim protocol, read-back, release, reaper, worktree rule |
| `AGENTS.md` | create | Root pointer for non-Claude agents → `CONTRIBUTING.md` + `CLAUDE.md` |
| `CLAUDE.md` | modify | Add `no:assignee` to board queries; point at `CONTRIBUTING.md`; drop the moved worktree text |
| `scripts/reap-stale-claims.sh` | create | All reaper logic; locally runnable in dry-run |
| `.github/workflows/stale-claims.yml` | create | Schedule + dispatch inputs; calls the script |

---

### Task 1: `CONTRIBUTING.md` — the single source

**Files:**
- Create: `CONTRIBUTING.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the canonical prose that Task 2's pointers and Task 3's reaper comment both reference by name. Section headings `## Claiming work` and `## One worktree per session` are linked to by later tasks — do not rename them.

- [ ] **Step 1: Verify the queries still behave as documented**

These go in the file, so confirm them against the live repo first rather than trusting the spec:

```bash
gh issue list --label status:next --search "no:assignee"
gh issue list --search "is:open assignee:*"
```

Expected: the first lists ready, unclaimed issues. The second lists claimed ones (empty today — nothing has ever been assigned).

- [ ] **Step 2: Write `CONTRIBUTING.md`**

Note the outer fence below is **four** backticks — the content itself contains
three-backtick blocks, and a three-backtick outer fence would be closed by the
first of them.

````markdown
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

## Labels

`area:*` groups by track. `status:*` carries readiness — `next`, `gated`,
`blocked`, `deferred`. `kind:*` marks `decision`, `experiment`, `bug`. Full
meanings are in [CLAUDE.md](./CLAUDE.md).

Note that `status:*` and the assignee answer different questions: `status:next`
means *this issue is ready to be worked*, and an assignee means *someone is
working it*. An issue keeps `status:next` while claimed.
````

- [ ] **Step 3: Verify the fenced block renders**

The file contains a nested ```bash fence inside the outer block above — check the
written file has no stray backticks and that headings are intact:

```bash
grep -c '^```' CONTRIBUTING.md    # expect an even number
grep -n '^## ' CONTRIBUTING.md    # expect: Claiming work, One worktree per session, Labels
```

- [ ] **Step 4: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add CONTRIBUTING.md — the assignee is the claim"
```

---

### Task 2: Pointers in `AGENTS.md` and `CLAUDE.md`

**Files:**
- Create: `AGENTS.md`
- Modify: `CLAUDE.md:12-16` (the board query block), `CLAUDE.md:32-34` (the worktree bullet)

**Interfaces:**
- Consumes: `CONTRIBUTING.md` from Task 1, and its `## Claiming work` heading anchor.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Create `AGENTS.md`**

Short by design — it is a signpost, not a second copy. Codex reads this file natively; several other agents have adopted it.

```markdown
# AGENTS.md

Instructions for any coding agent working in this repo.

**Before starting work on an issue, claim it.** The GitHub assignee is the
claim, and an unclaimed-looking issue may still be someone's active work if you
skip the check. The protocol — how to check, claim, confirm, and release — is in
[CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work). It is three `gh` commands.

Two sessions must not share a checkout; use a worktree per session. Also
CONTRIBUTING.md.

For everything else — repo layout, test commands, TDD expectations, where
protocol types live — read [CLAUDE.md](./CLAUDE.md). It is written for Claude
Code but nothing in it is Claude-specific.
```

- [ ] **Step 2: Add `no:assignee` to the board queries in `CLAUDE.md`**

Replace the block at `CLAUDE.md:12-16`:

```bash
gh issue list                          # everything open
gh issue list --label status:next      # what to pick up
gh issue view <n>                      # full context, incl. dependencies
```

with:

```bash
gh issue list                                             # everything open
gh issue list --label status:next --search "no:assignee"  # ready AND unclaimed
gh issue list --search "is:open assignee:*"               # what's already taken
gh issue view <n>                                         # full context, incl. dependencies
```

- [ ] **Step 3: Add the pointer line under that block**

Immediately after the code fence, before the `Labels:` paragraph, insert:

```markdown
**The assignee is the claim** — check it before starting, take it when you start,
release it when you stop. Full protocol in
[CONTRIBUTING.md](./CONTRIBUTING.md#claiming-work).
```

- [ ] **Step 4: Replace the worktree bullet with a pointer**

The rule moves to `CONTRIBUTING.md`, so `CLAUDE.md:32-34` loses its copy. Replace:

```markdown
- **Some issues collide in `apps/relay`.** #16 touches Durable Object addressing, which
  the A2A track is actively changing. Coordinate, and prefer a git worktree per working
  session — two sessions sharing one checkout has already cost uncommitted work here.
```

with:

```markdown
- **Some issues collide in `apps/relay`.** #16 touches Durable Object addressing, which
  the A2A track is actively changing. Coordinate — and use one worktree per session, per
  [CONTRIBUTING.md](./CONTRIBUTING.md#one-worktree-per-session).
```

- [ ] **Step 5: Verify no duplicated rule survives**

The point of the change is one source, so confirm the prose really moved rather than being copied:

```bash
grep -rn "cost uncommitted work" CLAUDE.md CONTRIBUTING.md
```

Expected: exactly one hit, in `CONTRIBUTING.md`.

- [ ] **Step 6: Commit**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: point CLAUDE.md and AGENTS.md at the claim protocol"
```

---

### Task 3: The stale-claim reaper

**Files:**
- Create: `scripts/reap-stale-claims.sh`
- Create: `.github/workflows/stale-claims.yml`

**Interfaces:**
- Consumes: nothing structurally. The reaper's comment names `CONTRIBUTING.md`
  as plain text — deliberately not a relative link, which resolves unreliably
  inside GitHub issue comments.
- Produces: a script driven entirely by three environment variables — `DRY_RUN` (`"true"`/`"false"`, default `"true"`), `STALE_DAYS` (integer string, default `"3"`), `REPO` (`owner/name`, defaults to the current repo). The workflow sets all three.

- [ ] **Step 1: Write the failing test — run the script before it exists**

```bash
DRY_RUN=true STALE_DAYS=0 bash scripts/reap-stale-claims.sh
```

Expected: FAIL — `bash: scripts/reap-stale-claims.sh: No such file or directory`

- [ ] **Step 2: Write the script**

```bash
#!/usr/bin/env bash
# Release work claims that have gone stale.
#
# A claim is a GitHub assignee (see CONTRIBUTING.md). A claim nobody releases
# would freeze an issue forever, so this unassigns any open issue whose holder
# has not touched it in STALE_DAYS days, and says so in a comment.
#
# Design: docs/superpowers/specs/2026-08-01-work-claiming-design.md
#
#   DRY_RUN=true  STALE_DAYS=3 bash scripts/reap-stale-claims.sh   # report only
#   DRY_RUN=false STALE_DAYS=3 bash scripts/reap-stale-claims.sh   # act
set -euo pipefail

STALE_DAYS="${STALE_DAYS:-3}"
DRY_RUN="${DRY_RUN:-true}"
REPO="${REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"

# BSD date (macOS, local runs) and GNU date (ubuntu runners) disagree on flags.
cutoff="$(date -u -v-"${STALE_DAYS}"d +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -d "${STALE_DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"

echo "repo=${REPO} stale_days=${STALE_DAYS} cutoff=${cutoff} dry_run=${DRY_RUN}"

stale="$(gh issue list --repo "$REPO" --search "is:open assignee:*" \
  --json number,updatedAt,assignees --limit 200 |
  jq -r --arg cutoff "$cutoff" '
    .[] | select(.updatedAt < $cutoff)
        | "\(.number)\t\(.updatedAt)\t\([.assignees[].login] | join(" "))"')"

if [ -z "$stale" ]; then
  echo "no stale claims"
  exit 0
fi

while IFS=$'\t' read -r number updated logins; do
  echo "stale: #${number} last active ${updated}, held by ${logins}"
  # NOTE: `[ x ] && continue` would return non-zero on the last loop iteration
  # and kill the script under `set -e`. Use an if-block.
  if [ "$DRY_RUN" = "true" ]; then
    continue
  fi
  for login in $logins; do
    gh issue edit "$number" --repo "$REPO" --remove-assignee "$login" < /dev/null
  done
  gh issue comment "$number" --repo "$REPO" < /dev/null --body \
"Claim released — no activity on this issue for ${STALE_DAYS} days.

If you are still working on this, take it again:

\`\`\`bash
gh issue edit ${number} --add-assignee @me
\`\`\`

The protocol is in CONTRIBUTING.md, at the repo root."
  echo "released #${number}"
done <<< "$stale"
```

Two things in there are load-bearing and easy to "clean up" into bugs: the
`if`-block instead of `[ ] && continue` (which exits under `set -e` when the
condition is false), and `< /dev/null` on the `gh` calls (which otherwise eat the
`while` loop's herestring and process only the first issue).

- [ ] **Step 3: Run it — nothing is assigned, so nothing is stale**

```bash
DRY_RUN=true STALE_DAYS=0 bash scripts/reap-stale-claims.sh
```

Expected: PASS — prints the settings line, then `no stale claims`. `STALE_DAYS=0`
means *everything* qualifies as stale, so this proves the query and the empty
path, not just an accidental no-op.

- [ ] **Step 4: Claim a real issue as the fixture**

Use #25 (`typecheck does not cover test files`) — low stakes, unclaimed, and not
what any other session is touching. Do **not** use #3; another session is on it.

```bash
gh issue edit 25 --add-assignee @me
gh issue view 25 --json assignees --jq '[.assignees[].login]'
```

Expected: `["KenTaniguchi-R"]`

- [ ] **Step 5: Confirm a fresh claim is left alone**

```bash
DRY_RUN=true STALE_DAYS=3 bash scripts/reap-stale-claims.sh
```

Expected: `no stale claims` — #25 was claimed seconds ago, so the real 3-day
threshold must ignore it.

- [ ] **Step 6: Confirm a stale claim is detected**

```bash
DRY_RUN=true STALE_DAYS=0 bash scripts/reap-stale-claims.sh
```

Expected: `stale: #25 last active <timestamp>, held by KenTaniguchi-R` and **no**
`released #25` line — dry-run must detect without mutating. This exercises the
real selection logic rather than a mock.

- [ ] **Step 7: Confirm the renewal assumption the whole design rests on**

The staleness rule assumes activity bumps `updated_at`. Verify rather than assume:

```bash
gh issue view 25 --json updatedAt --jq .updatedAt
gh issue comment 25 --body "Testing claim-renewal timestamp behaviour; ignore."
gh issue view 25 --json updatedAt --jq .updatedAt
```

Expected: the second timestamp is later than the first. If it is not, stop — the
3-day rule is unsound and the design needs revisiting before this ships.

- [ ] **Step 8: Release the fixture**

Leaving #25 assigned would be a false claim — exactly the thing this prevents.

```bash
gh issue edit 25 --remove-assignee @me
gh issue view 25 --json assignees --jq '[.assignees[].login]'
```

Expected: `[]`

- [ ] **Step 9: Write the workflow**

```yaml
name: Release stale claims

on:
  schedule:
    - cron: '0 9 * * *'
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'Report what would happen, without changing anything'
        type: boolean
        default: true
      stale_days:
        description: 'Days of inactivity before a claim is released (blank = 3)'
        type: string
        required: false

permissions:
  issues: write
  contents: read

jobs:
  reap:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Release stale claims
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          # A manual dispatch defaults to dry-run so poking at it is safe. The
          # schedule supplies no inputs, so this must evaluate to 'false' there
          # or the reaper never actually reaps — and the logs still look fine.
          DRY_RUN: ${{ inputs.dry_run == true && 'true' || 'false' }}
          # Left empty by the schedule; the script falls back to 3.
          STALE_DAYS: ${{ inputs.stale_days }}
        run: bash scripts/reap-stale-claims.sh
```

- [ ] **Step 10: Check the workflow parses**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/stale-claims.yml')); print('yaml ok')"
```

Expected: `yaml ok`

- [ ] **Step 11: Full repo checks**

Unaffected by this change, but the repo rule is that they pass before anything is called done:

```bash
pnpm -r test && pnpm -r typecheck && pnpm -r build
```

Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add scripts/reap-stale-claims.sh .github/workflows/stale-claims.yml
git commit -m "ci: release stale work claims on a schedule"
```

---

## After the plan: what cannot be verified before merge

`workflow_dispatch` only appears in the GitHub UI once the workflow is on the
default branch. So Task 3 verifies the *logic* locally, which is the part that can
be wrong; the workflow wrapper itself is only exercised after merge.

Once merged, before trusting the schedule:

1. Dispatch it with `dry_run: true`, `stale_days: 0` — expect it to report every
   claimed issue and release none.
2. Confirm the run's `DRY_RUN` env resolved to `true` in the logs, then dispatch
   with the defaults and confirm the same.
3. Leave the schedule to run. The first live run is at 09:00 UTC.

There is one residual risk worth stating: nothing forces anyone to *check* before
starting. This design makes the collision visible and cheap to avoid, not
impossible. If claim discipline turns out poor in practice, the rejected
`pull_request` guard from the spec is the next step up.
