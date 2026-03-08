---
name: block-local-merge-to-main
enabled: true
event: bash
action: block
pattern: git\s+merge\s+
---

**Local Merge to Main Blocked**

Agents are **NEVER** authorized to merge branches locally via `git merge`.

**Why this is blocked:**
- All merges must go through GitHub PRs for audit trail
- The `gh pr merge` command is also blocked — only the founder merges PRs via GitHub UI
- Local `git merge` bypasses the PR review process entirely

**What to do instead:**
1. Create a PR using `gh pr create`
2. Complete triple-layer code review
3. Report: "PR #XX is ready for merge"
4. STOP and wait for founder to merge via GitHub UI

This is a hard block - the command will not execute.
