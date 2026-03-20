#!/usr/bin/env bash
# PreToolUse hook: hard block on PR merges.
# Only the founder merges PRs via GitHub UI — agents are never authorized.

echo "BLOCKED: Agents are NEVER authorized to merge pull requests."
echo "Report 'PR #XX is ready for merge' and wait for the founder to merge via GitHub UI."
exit 2
