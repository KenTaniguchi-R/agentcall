#!/usr/bin/env bash
# Release work claims that have gone stale.
#
# A claim is a GitHub assignee (see CONTRIBUTING.md). A claim nobody releases
# would freeze an issue forever, so this unassigns any open issue where
# nobody has touched it in STALE_DAYS days, and says so in a comment.
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

stale="$(gh issue list --repo "$REPO" --search "is:open assignee:* sort:updated-asc" \
  --json number,updatedAt,assignees --limit 200 |
  jq -r --arg cutoff "$cutoff" '
    .[] | select(.updatedAt < $cutoff)
        | "\(.number)\t\(.updatedAt)\t\([.assignees[].login] | join(" "))"')"

if [ -z "$stale" ]; then
  echo "no stale claims"
  exit 0
fi

failed=0
while IFS=$'\t' read -r number updated logins; do
  echo "stale: #${number} last active ${updated}, held by ${logins}"
  # An if-block, not `[ x ] && continue`, purely for readability here.
  if [ "$DRY_RUN" = "true" ]; then
    continue
  fi
  # Comment BEFORE unassigning: if this fails the claim survives with a
  # spurious note, which is recoverable. Unassigning first and then failing
  # strips the claim with no explanation — the exact harm this comment exists
  # to prevent.
  #
  # `< /dev/null` on this and every other gh call in the loop: without it,
  # gh reads from stdin and consumes bytes out of the `while` loop's
  # herestring, so the next stale issue in `$stale` is silently skipped.
  if ! gh issue comment "$number" --repo "$REPO" < /dev/null --body \
"Claim released — no activity on this issue for ${STALE_DAYS} days.

If you are still working on this, take it again:

\`\`\`bash
gh issue edit ${number} --add-assignee @me
\`\`\`

The protocol is in CONTRIBUTING.md, at the repo root."; then
    echo "WARNING: could not comment on #${number}; leaving the claim in place"
    failed=1
    continue
  fi
  unassign_failed=0
  for login in $logins; do
    if ! gh issue edit "$number" --repo "$REPO" --remove-assignee "$login" < /dev/null; then
      echo "WARNING: could not unassign ${login} from #${number}"
      failed=1
      unassign_failed=1
    fi
  done
  if [ "$unassign_failed" = "1" ]; then
    echo "partially released #${number}"
  else
    echo "released #${number}"
  fi
done <<< "$stale"

exit "$failed"
