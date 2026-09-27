# Goal: Distinguish Agent vs User Decisions & FCA Step Matrix

## Goal Description
Distinguish coding agent decisions from user decisions within Code Insights by extracting decision driver attribution (`user`, `agent`, `collaborative`), initiating intent, and branching points, alongside a compact semantic step matrix for Formal Concept Analysis (FCA). This bridges current SQLite session analytics with future Rails/Postgres/pgvector/Redis rewrites and provides structured incidence data for agent pipeline configuration and optimization.

## Shared Understanding
The requirements and testable specifications for this goal are documented in:
- [facts.md](file:///home/b08x/WorkspaceV3/code-insights/goals/distinguish-agent-vs-user-decisions/facts.md)
- [facts.meta.json](file:///home/b08x/WorkspaceV3/code-insights/goals/distinguish-agent-vs-user-decisions/facts.meta.json)
- [interview-result.json](file:///home/b08x/WorkspaceV3/code-insights/goals/distinguish-agent-vs-user-decisions/interview-result.json)

## Execution Plan
The step-by-step implementation order, verification checks, and risks are detailed in:
- [plan.md](file:///home/b08x/WorkspaceV3/code-insights/goals/distinguish-agent-vs-user-decisions/plan.md)

## Done Condition
1. All 7 accepted facts from `facts.md` are implemented and verified via automated checks (`pnpm build`, `cli` test suite, `server` test suite, `dashboard` test suite).
2. The session analysis prompt schema extracts `decided_by`, `intent`, `branch_point`, and the 4–10 semantic `step_matrix` with turn grounding and low token overhead.
3. Decision cards in the dashboard display distinct `Decided By` badges, intent, and branch points.
4. The session detail view renders an interactive Formal Concept Analysis (FCA) Incidence Matrix table matching the step-to-attribute specification.
5. Sessions export clean Rails-ready JSON and FCA incidence data via dedicated API endpoints and dashboard actions.
