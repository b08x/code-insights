---
name: ci-gate-before-pr
enabled: true
event: bash
action: warn
pattern: gh\s+pr\s+create
---

**CI Gate: Run Checks Before PR Creation**

You are about to create a pull request. Before proceeding, you MUST run and confirm all checks pass:

```bash
cd /Users/melagiri/Workspace/codeInsights/code-insights && pnpm build
```

**Why this matters:** GitHub Actions usage costs money after the free tier. Running checks locally first prevents wasted CI minutes on PRs that will fail.

**If checks fail:** Fix the issues first, then create the PR.
**If checks pass:** Proceed with PR creation.

Do NOT skip this step. Do NOT create the PR if any check fails.
