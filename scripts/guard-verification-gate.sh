#!/usr/bin/env bash
# PreToolUse hook (Edit|Write|NotebookEdit): denies edits to the files that
# decide whether this repo's own work passes -- tests, the local CI gate, and
# the GitHub Actions workflows. This is the fast-feedback half of #335; the
# durable half is inv_test_churn in scripts/ci-local.sh, which holds for
# Codex, CI, and anyone who never reads this Claude-specific config.
#
# A hard deny, not an "ask" -- it fires before the normal permission check, so
# it holds even under --dangerously-skip-permissions. The only way through is
# a human editing .claude/settings.json to relax this hook, or making the
# edit themselves outside Claude Code -- a deliberate, out-of-band act, which
# is the point: a stuck agent must not be able to quietly relax the check
# that would catch it.
set -euo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

[ -n "$path" ] || exit 0

# Edit/Write/NotebookEdit require an absolute file_path, so every real path
# here has a repo-root prefix before any of these segments -- these patterns
# do not need to handle a bare relative path.
case "$path" in
  */test/*|*.test.ts|*.spec.ts|*scripts/ci-local.sh|*/.github/workflows/*)
    reason="Editing the verification gate (tests, scripts/ci-local.sh, or .github/workflows/) is blocked for automated edits -- see CLAUDE.md and issue #335. A stuck loop must not be able to quietly relax the check that would catch its own broken change. If this edit is genuinely needed, a human should make it directly, or explicitly relax this hook in .claude/settings.json."
    jq -n --arg reason "$reason" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: $reason
      }
    }'
    exit 0
    ;;
esac
exit 0
