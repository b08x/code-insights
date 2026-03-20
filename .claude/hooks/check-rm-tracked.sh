#!/usr/bin/env bash
# PreToolUse hook: block `rm` on git-tracked files/directories.
# Suggests `git rm` instead. Allows rm on untracked/build artifacts.

set -euo pipefail

# Parse the Bash command from hook input (JSON on stdin)
input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

# Only care about rm commands
if ! echo "$command" | grep -qE '^\s*rm\s'; then
  exit 0
fi

# Allow known build artifact cleanup
if echo "$command" | grep -qE 'rm\s+(-rf?\s+)?(node_modules|\.next|dist|build|\.turbo|\.cache)\b'; then
  exit 0
fi

# Extract target paths from the rm command (skip flags)
targets=()
for arg in $command; do
  case "$arg" in
    rm|--|-r|-f|-rf|-fr|-v|--force|--recursive) continue ;;
    -*) continue ;;
    *) targets+=("$arg") ;;
  esac
done

# Check if any target is git-tracked
for target in "${targets[@]}"; do
  # For directories: check if any tracked file lives under it
  if [ -d "$target" ]; then
    tracked=$(git ls-files "$target" 2>/dev/null | head -1)
    if [ -n "$tracked" ]; then
      echo "BLOCKED: '$target' contains git-tracked files. Use \`git rm -r $target\` instead."
      echo "If intentional, run \`git rm -r $target\` to delete + stage in one step."
      exit 2
    fi
  # For files: check directly
  elif git ls-files --error-unmatch "$target" &>/dev/null; then
    echo "BLOCKED: '$target' is git-tracked. Use \`git rm $target\` instead."
    echo "To untrack without deleting from disk: \`git rm --cached $target\`"
    exit 2
  fi
done

# All targets are untracked — allow
exit 0
