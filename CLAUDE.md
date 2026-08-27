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

## Development Guidelines

### Resolving Node Shared Library Errors (libnghttp3)

**Context**: When running Node installed via Linuxbrew (`~/.local/apps/homebrew/bin/node`), it may fail to start with `error while loading shared libraries: libnghttp3.so.X: cannot open shared object file: No such file or directory`.

**Pattern**: Force Homebrew to recreate the missing symlinks for the upgraded dependency.
```yaml
approach: Run `brew link --overwrite libnghttp3` (or the missing library) to restore broken symlinks.
validation: Run `node -v` or `brew missing` to confirm the shared library is correctly resolved.
examples:
  - case: Node fails to start due to missing `libnghttp3.so.9` after a brew upgrade cleanup.
    implementation: /home/b08x/.local/apps/homebrew/bin/brew link --overwrite libnghttp3
```

**Avoid**: 
- Reinstalling Node completely without checking if it's just a broken symlink for a dependency.
- Manually copying or creating symlinks in the Homebrew `lib` directory.

**Confidence**: High
**Source**: 2026-08-19 (Homebrew dependency upgrade orphaned symlink resolution)
