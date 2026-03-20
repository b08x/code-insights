#!/usr/bin/env bash
# PreToolUse hook: hard block on PR merges.
# Only the founder merges PRs via GitHub UI — agents are never authorized.

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Agents are NEVER authorized to merge pull requests. Report 'PR #XX is ready for merge' and wait for the founder to merge via GitHub UI."}}
EOF
exit 0
