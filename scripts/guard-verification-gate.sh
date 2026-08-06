#!/usr/bin/env bash
# PreToolUse hook (Edit|Write|NotebookEdit): denies edits to the grader -- the
# files that decide whether this repo's own work passes, plus this hook itself
# and the settings that register it. #335 established the layer; #374 retargeted
# it, because the original pattern list covered every *.test.ts but not this
# script or .claude/settings.json, so an agent could rewrite the check while
# being blocked from writing an ordinary failing test first.
#
# Tests are deliberately NOT in this list. Creating or editing a test is
# ordinary TDD work, and the dangerous direction -- an existing test file losing
# more lines than it gains on a branch that also changed src/ -- is caught by
# inv_test_churn in scripts/ci-local.sh at push time, in a diff, by a human,
# with --no-verify as the deliberate override. That is the durable half: it
# holds for Codex, for CI, and for any agent that never reads this
# Claude-specific config.
#
# A hard deny, not an "ask" -- it fires before the normal permission check, so
# it holds even under --dangerously-skip-permissions. The only way through is a
# human making the edit outside Claude Code -- a deliberate, out-of-band act,
# which is the point: a stuck agent must not be able to quietly relax the check
# that would catch it, or unregister it.
set -euo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')

[ -n "$path" ] || exit 0

# Edit/Write/NotebookEdit require an absolute file_path, so every real path
# here has a repo-root prefix before any of these segments -- these patterns
# do not need to handle a bare relative path.
case "$path" in
  *scripts/ci-local.sh|\
  */.github/workflows/*|\
  *scripts/guard-verification-gate.sh|\
  */.claude/settings.json|\
  */.claude/settings.local.json)
    reason="Editing the verification gate (scripts/ci-local.sh, .github/workflows/, this hook, or the .claude/settings.json that registers it) is blocked for automated edits -- see CLAUDE.md and issues #335 and #374. A stuck loop must not be able to quietly relax -- or unregister -- the check that would catch its own broken change. If this edit is genuinely needed, a human should make it directly, outside Claude Code. Note that test files are NOT blocked: edit them normally, and inv_test_churn will surface any shrinkage at push time."
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
