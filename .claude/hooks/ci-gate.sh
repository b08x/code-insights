#!/usr/bin/env bash
# CI Gate Hook — runs build + tests before allowing PR creation.
# Called by Claude Code PreToolUse hooks.
# Exit 0 = allow, non-zero = block (stderr shown as blocking message).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "Running build..." >&2
if ! pnpm build >/dev/null 2>&1; then
  echo "BLOCKED: pnpm build failed. Fix build errors before creating a PR." >&2
  exit 1
fi

echo "Running tests..." >&2
if ! pnpm test >/dev/null 2>&1; then
  echo "BLOCKED: pnpm test failed. Fix failing tests before creating a PR." >&2
  exit 1
fi

echo "Build and tests passed. PR creation allowed." >&2
exit 0
