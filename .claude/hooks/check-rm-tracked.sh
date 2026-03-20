#!/usr/bin/env bash
# PreToolUse hook: block `rm` on git-tracked files/directories.
# Suggests `git rm` instead. Allows rm on untracked/build artifacts.
# Protocol: JSON on stdout, exit 0 always. permissionDecision controls allow/deny.

set -euo pipefail

# Parse the Bash command from hook input (JSON on stdin)
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Only care about rm commands
if ! echo "$command" | grep -qE '^\s*rm\s'; then
  exit 0
fi

# Allow known build artifact cleanup (use [/\s]|$ instead of \b — slashes aren't word boundaries)
if echo "$command" | grep -qE 'rm\s+(-rf?\s+)?(node_modules|\.next|dist|build|\.turbo|\.cache)([/[:space:]]|$)'; then
  exit 0
fi

# Extract target paths: use jq to split command, skip verb and flags.
# Avoids shell word-splitting issues with quoted paths.
targets=$(echo "$command" | jq -rR '
  split(" ") |
  map(select(length > 0)) |
  .[1:] |
  map(select(startswith("-") | not)) |
  .[]
')

# Nothing to check
if [ -z "$targets" ]; then
  exit 0
fi

# Check if any target is git-tracked
echo "$targets" | while IFS= read -r target; do
  # Strip surrounding quotes if present
  target="${target%\"}"
  target="${target#\"}"
  target="${target%\'}"
  target="${target#\'}"

  [ -z "$target" ] && continue

  # For directories: check if any tracked file lives under it
  if [ -d "$target" ]; then
    tracked=$(git ls-files "$target" 2>/dev/null | head -1)
    if [ -n "$tracked" ]; then
      jq -n --arg target "$target" '{
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: ("\($target) contains git-tracked files. Use `git rm -r \($target)` instead.")
        }
      }'
      exit 0
    fi
  # For files: check directly
  elif git ls-files --error-unmatch "$target" &>/dev/null; then
    jq -n --arg target "$target" '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: ("\($target) is git-tracked. Use `git rm \($target)` instead. To untrack without deleting: `git rm --cached \($target)`")
      }
    }'
    exit 0
  fi
done

# All targets are untracked — allow
exit 0
