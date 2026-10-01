# Plan — GEPA optimization dashboard + agent chat replacement

Facts: `facts.md` (68 accepted, 50 `[auto]`). Decisions: `decisions.md`.

## Solution approach

- Replace the RLM chat agent with a plain tool-calling `agent()` whose tools are thin wrappers over new shared read functions (`cli/src/db/read.ts` family), exposed to the dashboard as a context-aware side panel plus `/chat`.
- **Consolidate the two analysis pipelines and two provider transports** (CLI `insights.ts` + `ProviderRunner` vs server `llm/analysis.ts` + `llm/providers`) into one `analyzeSessionPipeline` and one `cli/src/llm` transport, used by CLI, queue worker, server routes, and GEPA.
- Introduce **prompt resolution** as one shared function, `resolveAnalysisPrompt(target, identity)` in `cli/src/optimization/`, called only inside that pipeline. Everything else in the goal (labels, runs, gate, promotion, views) builds on that single seam.
- Rebuild the optimizer around a **target registry** and a single **`gepaAdapter`** (`evaluate(set, cfg)`) with three evaluation backends (sync API, batch API, CLI runner). The adapter runs the real formatter → runner → parser → normalizer path, then scores against labels with deterministic checks plus a cached typed-`AxGen` judge.
- Persist everything (labels, runs, rounds, versions, judge audits, conversations) in SQLite so the dashboard reads history, reconnects to live runs, and charts improvement.

## Integration facts discovered (drive the plan)

| Seam | Location | Consequence |
|---|---|---|
| Two production analysis paths | CLI: `cli/src/commands/insights.ts` → `AnalysisRunner`s; Server: `server/src/llm/analysis.ts:analyzeSession` → `server/src/llm/providers/*` | Prompt resolution + identity recording must be added to both. |
| Two analysis pipelines (parsers already shared) | `server/src/llm/{response-parsers,*-normalize,prompts,…}.ts` are re-export shims of `cli/src/analysis/*`. Divergence is in orchestration: server adds related insights, chunk+merge for long sessions, `jsonrepair`, different retrieval config; CLI adds `architectureContext`. Two provider transports: `server/src/llm/providers/*` vs `ProviderRunner.make*Chat`. | Consolidate into one pipeline + one transport (Phase 1, steps 6a–6d) before prompt resolution, so production, queue, dashboard, and GEPA evaluate the same code path. |
| Runner contract | `cli/src/analysis/runner-types.ts` (`RunAnalysisParams`, `RunAnalysisResult.model/provider`) | Add `model`/`variant` via runner constructor config; identity derived from runner name + config. |
| Queue worker | `cli/src/analysis/queue-worker.ts` → `runInsightsCommand` | Inherits CLI-path prompt resolution; no separate change. |
| Migrations | `cli/src/db/schema.ts` (`CURRENT_SCHEMA_VERSION` (17 after the chat tables, 18 after step 9)), `cli/src/db/migrate.ts` (`vNApplied` flags), `cli/src/db/schema.test.ts` | v17 (agent conversations), v18 (identity/prompt_version provenance columns), v19 (labels), v20 (optimization tables). Numbering shifted by one when v17 shipped with the chat tables alone; facts.md `label-1` / `cross-3` still say v17 for labels and should be read as v19. One migration per phase. |
| Routes | `server/src/index.ts:48-60` `app.route(...)` | New routers: `/api/chat`, `/api/labels`, `/api/optimization`. |
| Dashboard shell | `dashboard/src/App.tsx` (`<Layout>` outlet), `components/layout/Layout.tsx`, `components/chat/*`, `hooks/useAgentChat.ts` | Side panel mounts in `Layout.tsx`; page context via a React context provider set by each page. |
| Streaming | `server/src/routes/route-helpers.ts` (`streamSSE` + abort); dashboard uses fetch + ReadableStream | Reuse for chat streaming and live run monitor. |
| Charts / data | Recharts 3, TanStack Query 5 | Add `diff` (jsdiff) for view 2. |
| Config | `cli/src/utils/config.ts` (`dashboard.llm`, `dashboard.agent`, `dashboard.embedding`, `dashboard.analysis`) | Add `dashboard.analysis.runner {name, model, variant}`, `optimization {teacher, judge, weights, caps}`, `dashboard.agent.codebaseTools`. |

## Ordered steps

Branch per phase from `development` (`feature/gepa-p5-agent`, `feature/gepa-p1-foundations`, …); one PR per phase into `development`. Each phase ends with `pnpm run test` green and `pnpm run build` green.

### Phase 5 — Agent replacement (ships first)

1. **Shared read functions for tools.** `cli/src/db/read.ts` (or `cli/src/agent/queries.ts`): `searchSessionSnippets(query, filters, limit)` (reuse RRF hybrid logic from `server/src/routes/agent.ts:46-160`, returning snippets ≤ N chars + session IDs), `getSessionWindow(id, fromTurn, toTurn)`, `listInsights(filters)`, `getAnalyticsSummary(range)`.
   - Verify: Vitest in `cli/src/db/__tests__/` against an in-memory DB — snippet length cap (agent-3), window bounds.
2. **Conversation store (v17 part A).** Tables `chat_conversations(id, title, created_at, updated_at)`, `chat_messages(id, conversation_id, role, content, context_json, tool_calls_json, created_at)`. Bump schema, add `v17Applied`.
   - Verify: `schema.test.ts` migration test from v16 fixture; agent-6.
3. **New agent.** Replace `server/src/routes/agent.ts` with `server/src/agent/` (`agent.ts` factory, `tools.ts`, `prompt.ts`) and `server/src/routes/chat.ts`:
   - `agent('userQuery:string, pageContext?:json, history?:json -> reply:string')` with plain function-calling (no `AxJSRuntime`, no `contextPolicy` RLM, no SFL template).
   - Tools: `searchSessions`, `getSession`, `listInsights`, `getAnalytics`; `codebase.*` tools appended only when `config.dashboard.agent.codebaseTools === true` (agent-4). Keep `execMcpCli` helper.
   - No write tools; "draft" results returned as a typed `draft` payload the UI renders with a Save button (agent-10).
   - Routes: `POST /api/chat/conversations`, `GET /api/chat/conversations`, `GET /api/chat/conversations/:id`, `POST /api/chat/conversations/:id/messages` (SSE via `route-helpers`), `DELETE …/:id`.
   - Delete old `/api/agent` route and its registration.
   - Verify: Vitest `server/src/routes/chat.test.ts` — tool list with toggle on/off (agent-4), no write tools registered (agent-10), pageContext passed into forward inputs (agent-8), messages persisted (agent-6); `grep -r AxJSRuntime server/src` returns nothing (agent-1).
4. **Dashboard chat UI.** `components/chat/panel/ChatPanel.tsx` mounted in `Layout.tsx` (toggle in `Header.tsx`); `PageContextProvider` + `usePageContext()` set by SessionDetail, (later) Label, Run, Gate pages; `/chat` route reuses the same store via rewritten `useAgentChat` (TanStack Query + SSE). Per-page suggested prompts map (agent-9). Citations render as links to `/sessions/:id` (agent-5).
   - Verify: manual — panel on every page, reload restores conversation, "summarize this session" on SessionDetail resolves without ID; `pnpm --filter @code-insights/dashboard build`.
5. **Optimization tools placeholder contract.** A `toolRegistry` that later phases append to (agent-11). Verify in phase 3/4 tests.

### Phase 1 — Foundations

6a. **Characterization fixtures first.** Record golden inputs for ≥6 sessions (short, long/retrieval, long/chunked, prompt-quality, provider + native runner) and capture the current prompt text and parsed output of *both* paths with a stubbed LLM transport. These pin current behavior so each difference is an explicit decision, not an accident.
   - Verify: fixtures committed under `cli/src/analysis/__tests__/fixtures/pipeline/`; snapshot tests pass on untouched code.
6b. **One transport.** Move `server/src/llm/{client,types,rate_limiter}.ts` and `providers/*` into `cli/src/llm/` (single `LLMClient` with `chat`, `estimateTokens`, usage); `ProviderRunner` becomes a thin `AnalysisRunner` over it (delete `make*Chat`). Server imports from `@code-insights/cli/llm/*`; keep server shims only where route imports need them, then remove.
   - Verify: existing provider tests move and pass; `grep -n "function make.*Chat" cli/src/analysis/provider-runner.ts` empty.
6c. **One pipeline.** `cli/src/analysis/pipeline.ts`: `analyzeSessionPipeline(sessionId, { runner, identity, promptResolution, onProgress, signal })` owning message formatting, retrieval (single retrieval config from `dashboard.analysis`), related insights, architecture context, chunk+merge when the runner's token budget is exceeded (CLI runners: budget from runner metadata), `jsonrepair` fallback, parsing, normalization, persistence, usage/cost recording, and prompt-quality. Union of today's features; each behavior difference from 6a resolved and noted in the PR.
6d. **Rewire callers.** `cli/src/commands/insights.ts`, `cli/src/analysis/queue-worker.ts`, `server/src/llm/analysis.ts` (`analyzeSession`, `analyzePromptQuality`) and `server/src/routes/analysis.ts` call `analyzeSessionPipeline`. Delete the orchestration bodies they replace and `server/src/llm/analysis.ts.bak`.
   - Verify: 6a fixtures now produce one identical prompt/output per session regardless of entry point (CLI vs server route vs queue); `pnpm run test`; manual analyze of one session from dashboard and from CLI shows same prompt hash.
6. **Runner model/variant.** Constructor config `{ model?, variant? }` on `ClaudeNativeRunner` (`--model`), `CodexNativeRunner` (`-m`, remove hardcoded `gpt-5.5`, reasoning effort via `-c model_reasoning_effort=…`), `AntigravityNativeRunner` (`--model`, add `--json-schema`/`--output-format json` if parity holds), `MistralVibeRunner` (`VIBE_ACTIVE_MODEL` env), `ProviderRunner` (existing config).
   - Verify: Vitest with mocked `execFileSync` asserting argv/env per runner (found-1, found-2, found-4).
7. **OpenCodeRunner.** `cli/src/analysis/opencode-runner.ts`: `opencode run -m <provider/model> [--variant v] --format json`, system+user prompt composed into the message; extract final assistant text from JSON events; pass through `response-parsers.ts`. Register in `insights.ts` runner selection and `queue-worker.ts`.
   - Verify: Vitest with recorded JSON-event fixture → parsed `AnalysisResponse` (found-3); manual one-session run.
8. **Student identity.** `cli/src/optimization/identity.ts`: `StudentIdentity {runner, model, variant}`, `identityKey()`, `currentIdentity(config)` for CLI path and server path (`provider:<llm.provider>` / `<llm.model>`).
9. **v18 — provenance columns.** Add `student_identity TEXT`, `prompt_version_id TEXT NULL` to `insights` (and facets/session analysis rows that record `analysis_version`). Written by the pipeline's persistence (`convertToInsightRows` / `convertPQToInsightRow` / `saveFacetsToDb` take an `AnalysisProvenance`); the server has no separate writer since 6d.
   - Verify: migration test; write-path tests (found-5, found-6).
10. **Target registry + prompt resolution.** `cli/src/optimization/targets.ts` (`session-analysis` enabled; `prompt-quality` defined but disabled) describing: mutable component keys (analyst guidance, instruction prose), frozen parts (schema, categories, format), builder, parser, normalizers, schema file. `resolveAnalysisPrompt(target, identity)` returns built-in or active version's components + `prompt_version_id`. Called in exactly one place: `analyzeSessionPipeline` (6c). Refactor `buildSessionAnalysisInstructions` to take injectable guidance components (frozen parts unchanged).
   - Verify: Vitest — no active version → built-in text byte-identical to today; active version for other identity ignored (found-7); registry-only enablement of prompt-quality in a test (found-9).
11. **Settings UI.** Runner/model/variant picker in `components/settings/`; `GET /api/config/models?runner=` shells `agy models` / `opencode models` with timeout, else empty → free text (found-8).
    - Verify: manual.
12. **Single-path guard.** Test that fails if `buildSessionAnalysisInstructions` / `parseAnalysisResponse` are called outside `analyzeSessionPipeline` and the GEPA adapter (static import check), so a second pipeline cannot reappear.

### Phase 2 — Labeling

13. **v19 labels.** `session_labels(session_id PK, target, outcome, friction_categories_json, pattern_categories_json, key_points_json, forbidden_claims_json, note, split, created_at, updated_at)`; `split` written once (trigger or write-path guard).
    - Verify: migration + immutability test (label-1, label-2, label-6).
14. **Split assignment.** `cli/src/optimization/splits.ts`: seeded, stratified by project, 60/20/20, deterministic for a given (seed, existing assignments).
    - Verify: Vitest distribution + determinism (label-6).
15. **Labeling queue.** `rankLabelQueue()` — coverage over project × length bucket × source tool; after ≥1 completed run, add disagreement/low-gate score term.
    - Verify: Vitest ranking fixtures (label-7, label-8).
16. **Batch client.** `cli/src/llm-batch/` with `mistral.ts` (inline requests < 10k, poll job, fetch output/error files) and `openrouter.ts` (`POST /api/v1/batches`, `custom_id`, results only on `completed`); common `submitAndAwait(requests)` with per-row reconciliation by `custom_id`, re-queue failed rows synchronously.
    - Verify: Vitest with mocked fetch covering success, partial failure, expired/cancelled (label-10).
17. **Bulk pre-analysis.** `POST /api/labels/preanalyze {sessionIds}` → batch when identity is `provider:mistral|openrouter`, else enqueue to `analysis_queue`.
18. **Label routes.** `/api/labels` CRUD, `/api/labels/queue`, `/api/labels/progress`; canonical category validation (label-5).
19. **Labeling UI.** `pages/LabelPage.tsx` (`/label/:sessionId`, `/label` = queue): current analysis items with Keep / Wrong / Trivial; add missed key points; outcome + category pickers from canonical lists; embeddings-based duplicate/match hints (label-11). "Label this session" on `SessionDetailPage` (label-9). View 7 progress component (label-12). Set page context for chat panel.
    - Verify: manual walkthrough labeling 3 sessions; Vitest that scoring code has no embedding import (label-11, static check).

### Phase 3 — Optimization engine

20. **v20 tables.** `prompt_versions(id, target, identity_key, components_json, parent_version_id, source_run_id, judge_model, weights_json, test_scores_json, created_at)`, `active_prompt_versions(target, identity_key, version_id)`, `optimization_runs(id, target, identity_key, teacher, judge_model, mode, status, caps_json, estimate_json, best_candidate_id, error, started_at, finished_at)`, `optimization_rounds(id, run_id, round, candidate_id, parent_candidate_id, components_json, scores_json, scalar, accepted, rationales_json, tokens, cost_usd, created_at)`, `judge_cache(output_hash, key_points_hash, result_json)`, `judge_audits(id, round_id, session_id, item, judge_decision, human_decision)`.
21. **Program + adapter.** `cli/src/optimization/program.ts`: optimizable wrapper exposing only registry-mutable components (engine-2) with `getOptimizableComponents`/`applyOptimizedComponents`/`applyOptimization`. `adapter.ts`: `evaluate(set, cfg)` → `analyzeSessionPipeline` in dry-run mode (no persistence) with `promptResolution` overridden by cfg → backend (`sync` via ProviderRunner, `batch` via `llm-batch`, `cli` via runner) → `scoreVector` (engine-1, engine-17). Batch mode splits the pipeline at the transport call (build all prompts → submit batch → parse/normalize results).
22. **Metric + judge.** `metric.ts` (new): outcome exact, friction/pattern set-F1, `schema_valid` short-circuit to zeros (engine-3); `judge.ts`: typed `ax()` signature `keyPoints, forbiddenClaims, analysis -> covered:boolean[], violated:boolean[], rationale:string`, cached in `judge_cache` (engine-4); `feedbackFn` returns rationale + failed deterministic checks (engine-5).
23. **Runner/orchestrator.** `engine.ts`: loads labels by split (validation = validation split only, engine-9), builds `AxGEPA` with `paretoScalarize` from `optimization.weights` (engine-7), per-call retry inside backends (engine-16), cost/token cap enforcement via adapter accounting with clean stop + best-so-far (engine-12), writes rounds (engine-11), `program.applyOptimization(result.optimizedProgram)` and saves `optimizedProgram.componentMap` (engine-8). Student = `currentIdentity()`; teacher from run request; judge from config (engine-14).
24. **Job runner.** `server/src/optimization/jobs.ts`: single in-process worker, `AbortController` cancel, crash recovery marks stale `running` rows failed on boot (engine-10). Routes `/api/optimization/{runs,runs/:id,runs/:id/rounds (SSE),runs/:id/cancel,estimate,versions,versions/:id/gate,versions/:id/promote,versions/:id/adopt}`.
25. **Test gate + promotion.** `gate.ts`: evaluate candidate and active/built-in on the test split (batch when available) (engine-20); promote endpoint rejects if weighted score ≤ baseline unless `override: true` (engine-21); promotion writes `active_prompt_versions` (engine-22); adopt = gate on new identity (engine-23); re-analysis endpoint separate (engine-24).
26. **Overnight mode + estimates.** `mode: 'sync'|'batch'|'cli'` chosen from identity + toggle; toggle rejected server-side for non-batch providers (engine-18); estimate endpoint (engine-13, engine-19).
27. **Legacy removal + migration.** One-time import of `~/.code-insights/optimization` manifest into `prompt_versions` (engine-25); rewrite `cli/src/commands/optimize.ts` as client of `engine.ts` (engine-26); delete `flow.ts`, old `metric.ts`, unused template builders, `scripts/debug-optimization.mjs`, `cli/scripts/debug-optimization.mjs`, old `runner.ts` (engine-27).
28. **Views 1 and 4.** `pages/OptimizationPage.tsx` (`/optimize`, runs list + run form), `pages/RunPage.tsx` (`/optimize/runs/:id`, view 1 live via SSE), `pages/GatePage.tsx` (`/optimize/versions/:id/gate`, view 4); judge-mismatch warning (engine-15).
29. **Agent tools.** Append `listRuns`, `getRun`, `getRoundDiff`, `compareVersions`, `getLabel` to the tool registry (agent-11).
   - Verify (phase 3): Vitest with a fake student backend + fake judge: validation never contains train rows; applied program equals `optimizedProgram.componentMap`; selected version equals `paretoScalarize` argmax; caps stop run and keep best; single 429 retried per call without restart; promote rejected without override; adopt path; manifest import idempotent; rounds rows written per round; frozen components absent from `getOptimizableComponents`. Manual: one real light run (≈60 calls) on the user's DB copy.

### Phase 4 — Insight views

30. **View 2** prompt evolution: lineage tree from `optimization_rounds.parent_candidate_id`, jsdiff word diff, rationales panel (view-1).
31. **View 6** judge audit: sample endpoint + confirm/override writes `judge_audits`; agreement rate computed server-side (view-2, Vitest for rate).
32. **View 3** Pareto scatter with axis selectors (view-3).
33. **View 5** version history: promoted versions' test scores over time; category distribution by `prompt_version_id` from production analyses (view-4).
   - Verify: manual per view; `pnpm --filter @code-insights/dashboard build`.

## Verification summary

| Scope | Command / check |
|---|---|
| Unit + route tests | `pnpm run test` (Vitest) green at end of every phase (cross-2) |
| Builds | `pnpm run build` |
| Migrations v17–v20 | `schema.test.ts` fixtures + manual run against a copy of `~/.code-insights/*.db` (cross-3) |
| Old agent removed | `grep -rn "AxJSRuntime\|SFL" server/src` empty |
| Legacy optimizer removed | `test ! -e cli/src/optimization/flow.ts` etc. |
| Real run smoke | One ≈60-call light run + gate on DB copy before merging phase 3 |

## Risks and open questions

- **Pipeline consolidation changes analysis output** (in scope per plan-gate feedback): unifying retrieval config, related insights, chunk+merge, and `jsonrepair` changes what one of the two entry points produced before. Mitigation: 6a characterization fixtures make every difference explicit and reviewed; consolidation lands before any prompt versioning so the built-in baseline GEPA starts from is the unified one. Phase 1 grows by ~4 steps and becomes the largest-risk PR; split into 1a (6a–6d) and 1b (6–12) if review size warrants.
- **CLI runner harness drift**: a CLI upgrade (claude/codex/opencode) changes the harness under a fixed identity. Mitigation: record CLI `--version` in identity metadata and warn on change; not a new identity by default.
- **OpenCode without schema enforcement**: expect lower `schema_valid`; GEPA will optimize for it, which is correct behavior for that identity.
- **Small test split** (4–6 sessions at 20–30 labels): gate labeled "indicative"; promotion decisions are low-confidence until labels grow.
- **Ax internals**: `gepaAdapter`, `paretoScalarize`, `feedbackFn` verified in the 22.0.2 bundle, not in public typings; pin `@ax-llm/ax` at 22.0.x and add a contract test that fails if the adapter hook stops being called.
- **Batch API rate of change**: OpenRouter Batch launched 2026-09-22; response shapes may shift. Batch client isolated behind `submitAndAwait` with fixture tests.
- **Cost of judge**: one judge call per evaluation, cached; monitor via round `cost_usd`.
- **Open**: default `optimization.teacher` and `optimization.judge` model choices — set during phase 3 in Settings; no code dependency.

## Carry-forward from phase 1b review (technical-architect, 2026-09-30)

Resolve before or during phase 3 (v20 / step 21+):

1. `currentIdentity(config)` ignores the saved runner (`dashboard.analysis.runner`). Add `identityForSetting(setting, config)` using constants exported by each runner class (`RUNNER_ID`, `DEFAULT_MODEL_LABEL`). Decide which identity or identities the gate/adopt UI shows: dashboard analysis is always `provider:*`; CLI/queue uses the saved runner, so one user has two students.
2. Identity keys for a CLI default model use legacy labels (`claude-native`, `opencode-default`, ...) and aliases (`sonnet` vs full id) split identities. Default chosen: gate/promote reject, or require `override`, for identities whose model is a `*-native` / `*-default` label. Revisit if "whatever the CLI default is" must be supported.
3. `promptOverride` applies to both targets. Change to a per-target map (`Partial<Record<AnalysisTarget, PromptOverride>>`) and add a dry-run option that skips non-target calls so the adapter does not pay for unscored PQ calls.
4. Target registry: drop the untyped `builder`/`parser` fields or type them generically; add `maxChars` per mutable component (reject or clip in `resolveAnalysisPrompt` and the adapter).
5. Replace the global `setActivePromptLookup` with a DB-backed lookup in `cli/src/optimization/` reading `active_prompt_versions` via `getDb()` (CLI path never loads the engine). Keep `deps.lookup` for tests.
6. v20: `prompt_versions` records `ANALYSIS_VERSION` (or a hash of the frozen parts) it was tuned against; view 5 filters by it. Indexes: `active_prompt_versions PRIMARY KEY(target, identity_key)`, `prompt_versions(target, identity_key, created_at)`, `idx_insights_prompt_version ON insights(prompt_version_id) WHERE prompt_version_id IS NOT NULL`.
7. `facts.md` label-1 and cross-3 still say v17; migrations are v18 (provenance), v19 (labels), v20 (optimization).

## Carry-forward from phase 2 review (technical-architect + code-reviewer, 2026-10-01)

Fixed in the phase 2 PR: split durability (soft delete keeps split), `listLabels({usableOnly})` and consistent progress counts, backend/runner/identity guard + queue runner type, unpriced model cost = undefined, batch cancel on abort/sibling failure, reuse of paid partial rows, form keeps unmatched forbidden claims, in-app navigation guard.

Resolve in phase 3 (v20 / step 21+):

1. Persist batch jobs: split `submitAndAwait` into `submitJobs()` + `awaitJobs()`; table `batch_jobs(job_id, provider, model, owner_kind, owner_id, custom_ids_json, status, submitted_at)`; resume polling on boot instead of failing the run (batches can run up to 25h; also applies to preanalyze).
2. Shared `cli/src/optimization/batch-replay.ts` (collectPrompts, ReplayTable, replayMisses counter) used by preanalyze and the GEPA adapter. Add a pipeline option that injects precomputed contexts (related insights, architecture) captured during collect, so replay does not re-embed and prompts stay stable. Count sync fallbacks against the cap. Use waves (collect -> submit -> replay until no new prompts) for chunked sessions; estimates must count waves.
3. Cost caps: engine refuses batch/overnight mode for unpriced models unless a token cap is set; check the cap before each submit using estimated tokens x discounted price.
4. label-8 active learning: signals only apply to unlabeled candidates but the engine only evaluates labeled sessions, so the term is always zero. Chosen default: spread low gate scores / candidate disagreement to project x length-bucket cells so unlabeled sessions in those cells rank higher (no extra LLM calls). v20 must store per-session, per-candidate scores (not only `scores_json` per candidate).
5. Record `labels_hash` per split on `optimization_runs` and on gate results (labels are edited in place).
6. Label PK stays `session_id`; prompt-quality is never scored against labels in this goal, so the adapter skips PQ calls in dry-run.
7. Batch eval temperature: take it from a shared constant/transport, not a literal 0.7 (llm-expert to decide for eval noise). Any result cache that outlives one submitAndAwait call keys on provider+model+params, not only the prompt.
