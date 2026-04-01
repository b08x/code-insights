```markdown
# code-insights Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches you how to contribute effectively to the `code-insights` repository, a TypeScript project focused on code analysis, CLI tooling, and dashboard integration. You'll learn the project's coding conventions, how to implement and test new features, manage database schema changes, integrate APIs, and follow the established workflows for consistent, maintainable development.

## Coding Conventions

- **File Naming:**  
  Use `camelCase` for file names.  
  _Example:_  
  ```
  analysisDb.ts
  migrateTest.ts
  ```

- **Import Style:**  
  Use relative imports for modules within the project.  
  _Example:_  
  ```typescript
  import { migrateSchema } from '../db/migrate'
  ```

- **Export Style:**  
  Prefer named exports.  
  _Example:_  
  ```typescript
  // Good
  export function runAnalysis() { ... }

  // Avoid
  export default function runAnalysis() { ... }
  ```

- **Commit Messages:**  
  Follow [Conventional Commits](https://www.conventionalcommits.org/) with prefixes like `fix:`, `feat:`, `chore:`, `docs:`.  
  _Example:_  
  ```
  feat(cli): add session-end command to track user sessions
  ```

## Workflows

### Add or Migrate Database Table
**Trigger:** When you want to introduce a new table or modify the database schema  
**Command:** `/new-table`

1. Edit `cli/src/db/schema.ts` to define or update the table.
2. Edit `cli/src/db/migrate.ts` to add migration logic.
3. Update or add tests in `cli/src/db/__tests__/migrate.test.ts` and `cli/src/db/schema.test.ts`.
4. Update `cli/src/db/queue.ts` or other DB helper files if needed.
5. Update `cli/package.json` exports if new DB helpers are added.

_Example:_
```typescript
// cli/src/db/schema.ts
export const sessionTable = pgTable('session', {
  id: serial('id').primaryKey(),
  startedAt: timestamp('started_at').notNull(),
});
```

### Add or Update CLI Command
**Trigger:** When you want to add or enhance a CLI command  
**Command:** `/new-cli-command`

1. Create or modify command implementation in `cli/src/commands/{command}.ts`.
2. Register the command in `cli/src/index.ts`.
3. Add or update tests in `cli/src/commands/__tests__/{command}.test.ts`.
4. Update documentation or changelog if needed.

_Example:_
```typescript
// cli/src/commands/sessionEnd.ts
export function sessionEnd(args: Args) { ... }

// cli/src/index.ts
import { sessionEnd } from './commands/sessionEnd'
cli.register('session-end', sessionEnd)
```

### API Endpoint and Dashboard Integration
**Trigger:** When you want to expose new backend data to the dashboard UI  
**Command:** `/new-api-endpoint`

1. Implement the endpoint in `server/src/routes/{endpoint}.ts` and register in `server/src/index.ts`.
2. Update `dashboard/src/lib/api.ts` to call the new endpoint.
3. Create or update React hooks in `dashboard/src/hooks/` to fetch/process data.
4. Update or add `dashboard/src/components/` to display new data.

_Example:_
```typescript
// server/src/routes/insights.ts
export function getInsights(req, res) { ... }

// dashboard/src/lib/api.ts
export async function fetchInsights() { ... }
```

### Feature Development with Tests and Docs
**Trigger:** When you want to deliver a user-facing feature or enhancement  
**Command:** `/feature`

1. Implement feature logic in relevant source files.
2. Write or update automated tests (unit/integration).
3. Update `README.md`, `docs/ROADMAP.md`, or other documentation as needed.
4. Update `cli/CHANGELOG.md` and/or `cli/package.json` version if releasing.

_Example:_
```typescript
// src/insights/usage.ts
export function getUsageStats() { ... }

// src/__tests__/usage.test.ts
import { getUsageStats } from '../insights/usage'
test('returns usage stats', () => { ... })
```

### Deduplicate or Move Shared DB Helpers
**Trigger:** When you want to avoid code duplication and centralize DB logic  
**Command:** `/deduplicate-db-helpers`

1. Move helper implementations to `cli/src/analysis/` (e.g., `analysis-db.ts`).
2. Update `server/src/llm/` to re-export or import from CLI.
3. Update `cli/package.json` exports map to expose new modules.
4. Refactor code to use the new shared helpers.
5. Update or add tests in `cli/src/analysis/__tests__/`.

_Example:_
```typescript
// cli/src/analysis/analysisDb.ts
export function getAnalysisResults() { ... }

// server/src/llm/analysis-db.ts
export * from '../../../cli/src/analysis/analysisDb'
```

### Version Bump and Release Checklist
**Trigger:** When you want to prepare a new release  
**Command:** `/bump-version`

1. Update `cli/package.json` version.
2. Update `cli/CHANGELOG.md` with release notes.
3. Optionally update `.claude/commands/release.md` to adjust release checklist.
4. Commit with a version bump message.

_Example:_
```json
// cli/package.json
{
  "version": "1.2.0"
}
```

## Testing Patterns

- **Framework:** [Vitest](https://vitest.dev/)
- **Test File Pattern:** `*.test.ts`
- **Location:** Tests are co-located in `__tests__` directories or alongside source files.

_Example:_
```typescript
// cli/src/db/__tests__/migrate.test.ts
import { migrateSchema } from '../migrate'
import { describe, it, expect } from 'vitest'

describe('migrateSchema', () => {
  it('migrates schema successfully', () => {
    expect(migrateSchema()).toBe(true)
  })
})
```

## Commands

| Command                | Purpose                                                        |
|------------------------|----------------------------------------------------------------|
| /new-table             | Add or migrate a database table                                |
| /new-cli-command       | Add or update a CLI command                                   |
| /new-api-endpoint      | Add a new API endpoint and integrate with dashboard            |
| /feature               | Implement a new feature with tests and documentation           |
| /deduplicate-db-helpers| Deduplicate or move shared DB helpers between CLI and server   |
| /bump-version          | Bump package version and update release checklist              |
```
