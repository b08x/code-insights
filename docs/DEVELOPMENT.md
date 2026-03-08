# Development Practices — Code Insights

> Development rules, branch discipline, and operational procedures. Linked from [CLAUDE.md](../CLAUDE.md).

---

## Pre-Action Verification (CRITICAL)

Before any state-modifying command (git checkout, git push, git tag, file edits), run a **read-only check** to verify current state:

- **Branch names:** Never assume `main` vs `master` — run `git symbolic-ref refs/remotes/origin/HEAD` to detect the default branch
- **File existence:** Read a file before editing it; `ls` a directory before writing to it
- **API signatures:** When calling an unfamiliar endpoint or tool, read the function signature or documentation first
- **Build context:** Before running build scripts, verify you're in the correct sub-directory (`pwd`) and on the correct branch (`git branch`)

This applies to both **planning** and **execution**.

---

## Retry Discipline

If a command or tool call fails twice on the same input, **STOP**. Do not retry a third time. Report the failure, state what was attempted, and propose an alternative approach.

---

## Branch Discipline (CRITICAL)

`main` is the production branch. Only receives commits via merged PRs.

**Rules for ALL agents:**

```bash
# BEFORE ANY COMMIT:
git branch  # Must show feature branch, NOT main

# If on main -> STOP:
git checkout -b feature/description

# After EVERY commit:
git push origin $(git branch --show-current)  # Push IMMEDIATELY
```

**Branch naming:**
- `feature/description` (new functionality)
- `fix/description` (bug fixes)
- `docs/description` (documentation only)
- `chore/description` (maintenance, deps, config)

**Pre-commit checklist (ALL agents):**
1. `git branch` — Am I on feature branch?
2. If on `main` -> STOP, create feature branch
3. Commit to feature branch
4. Push immediately after commit

---

## Hookify Rules

| Rule | Type | Purpose |
|------|------|---------|
| `block-pr-merge` | **block** | Agents never merge PRs — founder only |
| `branch-discipline` | warn | Dev agents verify feature branch before coding |
| `cli-binary-name` | warn | Prevent using `claudeinsight` instead of `code-insights` |
| `agent-parallel-warning` | warn | Verify no dependencies before parallelizing agents |
| `no-jira` | **block** | Prevent Jira/Atlassian API calls — use GitHub Issues instead |
| `review-before-pr` | warn | Remind: code review required before PR creation (bash path) |
| `review-before-pr-mcp` | warn | Remind: code review required before PR creation (MCP path) |
| `verify-before-checkout` | warn | Verify branch exists before `git checkout/switch` |
| `ci-gate-before-pr` | warn | Run `pnpm build` before `gh pr create` — prevents wasted CI minutes |
| `ci-gate-before-pr-mcp` | warn | Run `pnpm build` before GitHub MCP PR creation |

---

## Version Bump Procedure

When bumping the version (patch, minor, or major):

1. **`cli/package.json`** — Update the `"version"` field
2. **`cli/CHANGELOG.md`** — Add a new `## [x.y.z] - YYYY-MM-DD` section at the top with changes
3. **Commit** — `chore: bump version to vX.Y.Z` with a one-line summary of what changed
4. **Publish** — `cd cli && npm publish` (runs `prepublishOnly` which builds all packages)

Files touched: `cli/package.json` + `cli/CHANGELOG.md` (minimum). Optionally update `docs/ROADMAP.md`, `docs/VISION.md`, `docs/PRODUCT.md` for minor/major bumps.

---

## Configuration

| File | Purpose |
|------|---------|
| `~/.code-insights/config.json` | User config (mode 0o600) |
| `~/.code-insights/sync-state.json` | File modification tracking for incremental sync |
| `~/.code-insights/device-id` | Stable device identifier |
| `~/.code-insights/data.db` | SQLite database |

### Hook Integration

- `install-hook` modifies `~/.claude/settings.json` to add a Stop hook
- Hook runs `code-insights sync -q` automatically when Claude Code sessions end

---

## Development Notes

- TypeScript strict mode enabled
- ES Modules (`import`/`export`, not `require`)
- No test framework configured yet
- No ESLint config file in CLI directory (lint script exists but needs config)
- pnpm is the package manager (workspace monorepo)
- CLI binary is `code-insights`
- npm package is `@code-insights/cli`
