---
name: tdd-domain-check
enabled: true
event: prompt
action: warn
conditions:
  - field: user_prompt
    operator: regex_match
    pattern: (/start-feature|start.feature)
---

**TDD Domain Check: Tests Required for MUST Domains**

Before scoping this feature, check if it touches a TDD domain. If so, tests must be included in the implementation plan — not added as an afterthought.

**MUST TDD domains** (tests required alongside implementation):

| Domain | Path | Required test location |
|--------|------|----------------------|
| Source providers (parsers) | `cli/src/providers/` | `cli/src/providers/__tests__/*.test.ts` |
| Normalizers | `server/src/llm/*-normalize.ts` | Co-located `*-normalize.test.ts` |
| Migrations | `cli/src/db/migrate.ts` or `schema.ts` | `cli/src/db/__tests__/migrate.test.ts` |
| Shared utilities | `server/src/utils.ts`, `cli/src/utils/` | Co-located or `__tests__/*.test.ts` |

**PM/TA action:** If the feature touches any MUST TDD domain, ensure the implementation plan includes test tasks alongside (or before) implementation tasks. Dev agents must not merge code in these domains without corresponding tests.

**Safe to skip TDD:** Dashboard-only changes, CLI command wiring, docs, configuration.
