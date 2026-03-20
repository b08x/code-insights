#!/usr/bin/env bash
# PreToolUse hook: block commits directly to main/master.
# Agents must work on feature branches.

set -euo pipefail

branch=$(git branch --show-current 2>/dev/null || echo "")

if [ "$branch" = "main" ] || [ "$branch" = "master" ]; then
  jq -n --arg branch "$branch" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "You are on \($branch). Agents must not commit directly to the main branch. Create a feature branch first: git checkout -b feature/<description>"
    }
  }'
  exit 0
fi

exit 0
