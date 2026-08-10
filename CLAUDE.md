# code-insights-workspace — Claude Memory
> Last analyzed: 2026-08-10
> Re-analysis needed: NO — read .claude/rules/ files instead of source files

## What this project is
<div align="center">   <img src="docs/assets/logo.svg" width="120" height="120" alt="Code Insights logo" />   <h1>Code Insights</h1>

## Quick reference
- **Stack**: JavaScript + Vitest
- **Dev**: `pnpm --filter @code-insights/cli dev`
- **Test**: `vitest run`
- **Build**: `pnpm --filter @code-insights/cli build && pnpm --filter @code-insights/server build && pnpm --filter @code-insights/dashboard build`

## Memory files (read these, not source files)
- @.claude/rules/architecture.md — folder map, entry points, data flow
- @.claude/rules/stack.md — tech stack, versions, all commands
- @.claude/rules/modules.md — every module and what it does
- @.claude/rules/models.md — DB schemas and data types
- @.claude/rules/api.md — all routes and endpoints
- @.claude/rules/conventions.md — naming, patterns, testing approach
- @.claude/rules/gotchas.md — quirks, workarounds, do-not-touch
- @.claude/rules/changelog.md — what changed and when

## Instruction
You have full codebase knowledge from the files above.
Do NOT re-read source files to understand structure — use memory files.
If something seems outdated, flag it rather than re-analyzing.
