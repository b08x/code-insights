# Grill decisions — gepa-optimization-dashboard

Recorded 2026-09-30. Each line is the resolved answer to one grilling question.

| # | Question | Decision |
|---|---|---|
| Q1 | Role of the replacement chat | One agent for sessions Q&A and optimization workflow (typed tools over server read APIs). Codebase-graph tools optional (toggle). |
| Q2 | Prompt GEPA owns | Session-analysis prompt only; free-text guidance mutable, JSON schema/canonical categories/output format frozen; evaluation through the real pipeline. Target registry so prompt-quality is config-only. |
| Q3 | Label shape | Output-independent gold: outcome, friction categories, pattern categories, key points, forbidden claims, optional note. Captured via keep/reject review of the current analysis. |
| Q4 | Objectives and matching | outcome, friction_f1, pattern_f1, keypoint_recall, faithfulness, schema_valid. Fuzzy checks via typed AxGen judge only (no embedding filter). Regex heuristics removed from scoring. One weights config used for paretoScalarize and version selection. |
| Q5 | Run execution | Persistent in-process background jobs; optimization_runs / optimization_rounds / prompt_versions tables; CLI uses same engine; JSON manifest imported once then retired. |
| Q6 | Promotion | Manual promotion gated by held-out test comparison vs active/baseline; override with confirmation; prompt_version_id recorded per analysis; rollback = promote previous; no automatic re-analysis. 60/20/20 seeded stratified split. |
| Q7 | Labeling selection | Suggested queue (stratified coverage, later active learning) plus manual "Label this session" action. Split assigned at label time, immutable. |
| Q8 | Views | All seven, order: label progress → run monitor → promotion gate → prompt evolution → judge audit → Pareto front → version history/production impact. |
| Q9 | Chat UI | Page-context-aware side panel on every page plus full /chat page; shared persistent conversation store in SQLite. Agent drafts only; never writes labels, promotes, or starts runs. |
| Q10 | Models and budget | Student fixed to production student identity; teacher per run (default optimization.teacher); judge fixed config optimization.judge with change warnings. maxMetricCalls + per-run token/USD cap with pre-run estimate. Per-call retries replace whole-compile retry. |
| Q11 | Execution modes | Batch (Mistral / OpenRouter via ProviderRunner) for bulk jobs: pre-analysis, test gate, re-analysis, initial validation pass. Optional per-run "overnight" toggle batches GEPA loop evaluations. CLI runners always synchronous with duration/quota warning. Single gepaAdapter with sync / batch / CLI implementations. |
| Q11b | Runners | Model (and variant) configurable for all CLI runners (vibe via VIBE_ACTIVE_MODEL); remove codex hardcoded model; add OpenCodeRunner (`opencode run -m provider/model --format json`). |
| Q12 | Version scoping | Active version per (target, student identity = runner + model + variant). No version for identity → built-in prompt. "Adopt for this model" runs test gate only. |
| Q13 | Delivery | Phased PRs on development: 5 agent → 1 foundations → 2 labeling → 3 optimization engine → 4 insight views. Old code removed in the phase that replaces it. |

## Evidence from assessment (pre-grill)
- Optimized artifact never loaded (`loadArtifact` 0 callers).
- `applyOptimizedComponents(result.optimizedProgram)` no-op (`runner.ts:592`).
- GEPA internal selection = unweighted mean; weighted selection only recorded (`runner.ts:585`).
- Regex metrics self-referential; `humanQuality` never populated.
- Format component mutable (`flow.ts:151`); teacher/student templates unused.
- Validation = shortest 20% of sessions; no test set.
