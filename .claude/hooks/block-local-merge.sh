#!/usr/bin/env bash
# PreToolUse hook: hard block on local git merge.
# All merges must go through GitHub PRs for audit trail.

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Local 'git merge' is not allowed. All merges must go through GitHub PRs. Use 'gh pr create' to open a PR, then wait for the founder to merge via GitHub UI."}}
EOF
exit 0
