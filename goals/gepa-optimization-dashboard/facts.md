# Facts — GEPA optimization dashboard + agent chat replacement

Accepted 2026-09-30. `[auto]` = automated verification required.

## Phase 5 (ships first) — Agent replacement

- **agent-1** [auto] The old RLM agent (AxJSRuntime, SFL reply template, full-transcript memory search) is removed from server/src/routes/agent.ts.
- **agent-2** [auto] The new chat agent answers session questions using typed tools that query SQLite directly: searchSessions, getSession (turn-range window), listInsights, getAnalytics.
- **agent-3** [auto] searchSessions returns ranked snippets with session IDs, never full transcripts.
- **agent-4** [auto] Codebase-graph tools are available to the agent only when the codebase-tools toggle is on; when off, they are absent from the agent's function list.
- **agent-5** Chat replies are free-form markdown with citations that link to the cited sessions.
- **agent-6** [auto] Conversations persist in SQLite; reloading the page restores the conversation.
- **agent-7** A chat side panel can be opened on every dashboard page, and a full-width /chat page shows the same conversations.
- **agent-8** [auto] The side panel sends the current page context (page type plus IDs such as sessionId, runId, versionId) with each message, and the agent can answer 'this session' / 'this run' without the user typing IDs.
- **agent-9** Each page type shows context-specific suggested prompts in the side panel.
- **agent-10** [auto] The agent has no tool that writes labels, promotes versions, or starts runs; draft outputs appear with a UI button the user must click to save.
- **agent-11** [auto] Optimization tools (listRuns, getRun, getRoundDiff, compareVersions, getLabel) are added to the agent when their server routes exist.

## Phase 1 — Foundations

- **found-1** [auto] Every CLI runner accepts a configured model: claude --model, codex -m, agy --model, vibe via VIBE_ACTIVE_MODEL, opencode -m provider/model.
- **found-2** [auto] The codex runner no longer hardcodes gpt-5.5.
- **found-3** [auto] A new OpenCode runner runs `opencode run -m <provider/model> --format json` and its output passes through the existing response parser.
- **found-4** [auto] Runners that support a reasoning-effort setting accept an optional variant.
- **found-5** [auto] A student identity is the triple runner + model + variant, and each analysis records the identity that produced it.
- **found-6** [auto] Each analysis row records the prompt_version_id that produced it (null = built-in prompt).
- **found-7** [auto] At analysis time, the pipeline uses the active prompt version for (target, current student identity); if none exists it uses the built-in prompt, never a version tuned for another identity.
- **found-8** Settings lets the user choose runner, model, and variant; model lists are filled from `agy models` / `opencode models` where available and free text otherwise.
- **found-9** [auto] A target registry defines session-analysis as the only enabled target; adding prompt-quality requires only a registry entry, no engine code changes.
- **found-10** [auto] Dashboard, CLI, queue worker, and GEPA all analyze sessions through one shared pipeline (analyzeSessionPipeline) and one provider transport; the server no longer has its own orchestration or provider clients. _(Added from plan-gate feedback 2026-09-30.)_
- **found-11** [auto] Analyzing the same session from the dashboard and from the CLI with the same student identity produces the same prompt text. _(Added from plan-gate feedback 2026-09-30.)_

## Phase 2 — Labeling

- **label-1** [auto] A schema migration to v19 adds label storage (labels are v19; migrations v17-v20 overall); existing databases migrate without data loss.
- **label-2** [auto] A label stores: outcome, friction categories, pattern categories, key points, forbidden claims, optional note, split, and timestamps.
- **label-3** The labeling page shows the current production analysis for a session; keeping an item adds it as a key point, rejecting it as wrong adds it as a forbidden claim.
- **label-4** The user can type additional key points that the analysis missed.
- **label-5** [auto] Outcome, friction categories, and pattern categories are chosen from the canonical category lists.
- **label-6** [auto] Each labeled session is assigned train, validation, or test (60/20/20, seeded, stratified by project) at label time, and the assignment never changes.
- **label-7** [auto] A suggested labeling queue ranks unlabeled sessions for coverage across project, session-length bucket, and source tool.
- **label-8** [auto] After at least one completed run, the queue also ranks sessions where candidates disagreed most or test-gate scores were lowest.
- **label-9** SessionDetail has a 'Label this session' action that opens the labeling page for that session.
- **label-10** [auto] Sessions without an analysis can be pre-analyzed in bulk through the batch API (Mistral or OpenRouter) when the provider supports it.
- **label-11** [auto] Embeddings are used only for labeling aids (duplicate key-point detection, item-to-key-point suggestions), never for scoring.
- **label-12** View 7 (label progress) shows label counts per split, per project, and per length bucket against coverage targets.

## Phase 3 — Optimization engine

- **engine-1** [auto] GEPA evaluates candidates through the real session-analysis pipeline: same message formatter, response parser, and normalizers as production.
- **engine-2** [auto] Only free-text guidance is optimizable; the JSON schema, canonical category lists, and output format are never exposed as GEPA components.
- **engine-3** [auto] Scoring objectives are outcome, friction_f1, pattern_f1, keypoint_recall, faithfulness, and schema_valid; an unparseable output scores 0 on all objectives.
- **engine-4** [auto] keypoint_recall and faithfulness come from a typed AxGen judge on the fixed judge model; judge results are cached by output hash.
- **engine-5** [auto] The judge's rationales are passed to GEPA as feedbackFn text.
- **engine-6** [auto] The regex heuristic metrics are removed from scoring.
- **engine-7** [auto] One weights config drives both GEPA's paretoScalarize and version selection, so the saved version is the one selected.
- **engine-8** [auto] The optimized result is applied with applyOptimization(result.optimizedProgram); the saved version equals the best candidate, not the last evaluated.
- **engine-9** [auto] Validation examples are always the held-out validation split; the train set is never reused as validation.
- **engine-10** [auto] Starting a run creates an optimization_runs row; the server runs one job at a time in-process; the user can cancel a running job.
- **engine-11** [auto] Each round writes an optimization_rounds row with candidate component text, parent candidate, per-objective scores, judge rationales, and token cost.
- **engine-12** [auto] A run stops cleanly when it reaches maxMetricCalls or its token/USD cap and keeps its best-so-far candidate.
- **engine-13** The run form shows a pre-run estimate of calls, tokens, cost, and duration before starting.
- **engine-14** [auto] The student is always the production student identity and cannot be changed per run; the teacher is selectable per run; the judge is fixed config.
- **engine-15** Versions scored by different judge models show a warning when compared.
- **engine-16** [auto] Transient API errors retry per call; a single rate-limit error does not restart the whole run.
- **engine-17** [auto] Evaluation goes through one gepaAdapter with three modes: sync API, batch API, and CLI runner.
- **engine-18** [auto] The run form has an 'overnight' toggle that batches GEPA loop evaluations; it is enabled only for provider:mistral or provider:openrouter students.
- **engine-19** CLI-runner students always run synchronously, and the run form shows estimated duration and a quota warning.
- **engine-20** [auto] The test gate scores the candidate and the currently active prompt (or built-in) on the test split, using the batch API when available.
- **engine-21** [auto] Promote is disabled when the candidate's weighted test score does not beat the baseline, unless the user confirms an override.
- **engine-22** [auto] Promoting sets the active version for (target, student identity); promoting a previous version is the rollback.
- **engine-23** [auto] 'Adopt for this model' runs only the test gate for an existing version on a new student identity and allows promotion without a GEPA run.
- **engine-24** [auto] Existing analyses are not re-run on promotion; re-analysis is a separate optional action that uses the batch API when available.
- **engine-25** [auto] The existing ~/.code-insights/optimization JSON manifest is imported into prompt_versions once, then no longer read.
- **engine-26** [auto] `code-insights optimize` uses the same engine and tables, so CLI-started runs appear in the dashboard.
- **engine-27** [auto] flow.ts, metric.ts, the unused template builders, and scripts/debug-optimization.mjs are deleted.
- **engine-28** View 1 (run monitor) shows per-objective and weighted score lines by round, accepted/rejected candidates, cumulative tokens/cost, and a Cancel button, updating while the run is live.
- **engine-29** View 4 (promotion gate) shows baseline vs candidate per objective, a per-test-session delta table, and side-by-side analysis outputs for any test session.

## Phase 4 — Insight views

- **view-1** View 2 (prompt evolution) shows the candidate lineage tree; selecting a candidate shows a word-level diff against its parent plus the reflection and judge rationales behind it.
- **view-2** [auto] View 6 (judge audit) samples judge covered/violated decisions for the user to confirm or override and shows the judge-vs-human agreement rate.
- **view-3** View 3 (Pareto front) is a scatter plot with selectable objective axes; points are clickable and the selected version is highlighted.
- **view-4** View 5 (version history) shows each promoted version's test score over time and how friction/pattern category distributions in production analyses changed between prompt versions.

## Cross-cutting

- **cross-1** Each phase ships as its own PR to development in the order: agent, foundations, labeling, engine, insight views.
- **cross-2** [auto] Server routes and DB functions for each phase have Vitest tests, and `pnpm run test` passes at the end of each phase.
- **cross-3** The v17-v20 migrations (v17 chat, v18 provenance, v19 labels, v20 optimization) and the manifest import are verified against a copy of the user's real database before merge.
