# Goal: FCA & Decision Attribution Remediation (#8-#14)

## Goal Description
Remediate the full suite of Formal Concept Analysis (FCA) and decision attribution issues ([#8](https://github.com/b08x/code-insights/issues/8)–[#14](https://github.com/b08x/code-insights/issues/14)) by bumping the analysis version to 3.1.0, enforcing step matrix schema cardinality (4–10 items), enriching step attributes for non-degenerate concept lattices, and promoting step data into a normalized SQLite `session_steps` table. In addition, harden export routes with deterministic summary ordering, unique FCA object keying, centralized attribute vectors, and a pooled cross-session FCA analytics endpoint.

## Shared Understanding
The testable specifications and requirements for this goal are documented in:
- [facts.md](file:///home/b08x/WorkspaceV3/code-insights/goals/fca-remediation/facts.md)
- [facts.meta.json](file:///home/b08x/WorkspaceV3/code-insights/goals/fca-remediation/facts.meta.json)
- [interview-result.json](file:///home/b08x/WorkspaceV3/code-insights/goals/fca-remediation/interview-result.json)

## Execution Plan
The step-by-step implementation order, verification checks, and risk mitigations are detailed in:
- [plan.md](file:///home/b08x/WorkspaceV3/code-insights/goals/fca-remediation/plan.md)

## Done Condition
1. All 9 accepted facts from `facts.md` are implemented and verified via automated test suites (`pnpm build`, `pnpm --filter cli test`, `pnpm --filter server test`).
2. `ANALYSIS_VERSION` is updated to `'3.1.0'` and `session-analysis.json` enforces `minItems: 4, maxItems: 10` on `step_matrix`.
3. SQLite migration v15 creates `session_steps` and the analysis persistence pipeline writes structured steps into this table.
4. Summary insight queries in `server/src/routes/export.ts` include `ORDER BY created_at DESC`, single-session FCA objects are keyed uniquely as `${turn_ref} [step ${idx}]`, and attribute vector generation is centralized into `attributeVector()` using `FCA_ATTRIBUTES`.
5. `GET /api/export/fca` returns pooled formal context `(G, M, I)` with filter support (`project`, `since`, `until`, `driver`, `state`) and contingency statistics in both JSON and CSV formats.
6. Target re-analysis documentation and process refreshed for v3.0.0 sessions.
