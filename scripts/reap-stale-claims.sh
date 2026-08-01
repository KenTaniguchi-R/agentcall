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
