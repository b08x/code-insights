---
name: add-or-migrate-database-table
description: Workflow command scaffold for add-or-migrate-database-table in code-insights.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /add-or-migrate-database-table

Use this workflow when working on **add-or-migrate-database-table** in `code-insights`.

## Goal

Adds a new database table or migrates schema, including migration scripts, schema updates, and related code/tests.

## Common Files

- `cli/src/db/schema.ts`
- `cli/src/db/migrate.ts`
- `cli/src/db/__tests__/migrate.test.ts`
- `cli/src/db/schema.test.ts`
- `cli/src/db/queue.ts`
- `cli/package.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit cli/src/db/schema.ts to define or update the table.
- Edit cli/src/db/migrate.ts to add migration logic.
- Update or add tests in cli/src/db/__tests__/migrate.test.ts and cli/src/db/schema.test.ts.
- Update cli/src/db/queue.ts or other DB helper files if needed.
- Update cli/package.json exports if new DB helpers are added.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.