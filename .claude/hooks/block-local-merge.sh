#!/usr/bin/env bash
# PreToolUse hook: hard block on local git merge.
# All merges must go through GitHub PRs for audit trail.

echo "BLOCKED: Local 'git merge' is not allowed. All merges must go through GitHub PRs."
echo "Use 'gh pr create' to open a PR, then wait for the founder to merge via GitHub UI."
exit 2
