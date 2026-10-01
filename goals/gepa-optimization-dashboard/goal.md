# Goal — GEPA optimization dashboard + agent chat replacement

## Goal

Replace the broken RLM chat agent with a context-aware, tool-calling agent (side panel on every page plus `/chat`). Consolidate the two session-analysis pipelines and provider transports into one. Rebuild prompt optimization as a dashboard workflow: hand-label sessions in the UI, run GEPA through that single production pipeline with judge-backed metrics and persistent runs, promote versions for each (runner + model + variant) through a held-out test gate, and visualize what improved and how.

## Shared understanding

- `facts.md`: 70 accepted facts (52 require automated verification). This is the definition of the outcome.
- `decisions.md`: the resolved grilling decisions (Q1–Q13) and the pre-grill assessment evidence.

## Execution plan

- `plan.md` (approved via Plannotator gate, 2026-09-30): phases in the order 5 (agent) → 1 (foundations, including pipeline consolidation 6a–6d) → 2 (labeling) → 3 (optimization engine) → 4 (insight views), one PR per phase into `development`.

## Implementation skills

- `skills.md`: binding hookify rules, the per-phase workflow loop, and the skills and agents for each plan step. Follow it when executing each phase.

## Done condition

- Every fact in `facts.md` holds. Facts marked `[auto]` are backed by passing Vitest tests or scripted checks. Manual facts have been walked through in the running dashboard.
- `pnpm run test` and `pnpm run build` pass on `development` after the final phase merges.
- Migrations v17–v19 and the one-time manifest import have been run against a copy of the real database without data loss.
- One real optimization run (light budget), one test gate, and one promotion have completed end to end from the dashboard. Analyses made afterwards record the promoted `prompt_version_id`.
