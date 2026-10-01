# Phase 3 handoff: engine, estimates, test gate (steps 23 and 25)

Branch `feature/gepa-p3-engine`. Steps 23 and 25 are implemented and tested. `pnpm run build` and `pnpm run test` pass (116 files, 1948 tests, 2 skipped that were already skipped). Nothing was pushed. No real model was called by any test; everything runs on fakes.

## Done

- `cli/src/optimization/request.ts`: request type, defaults, mode choice, `EngineError`.
- `cli/src/optimization/estimate.ts`: `estimateRun`, `checkRunCaps`.
- `cli/src/optimization/engine.ts`: `runOptimization`, `dbJudgeCache`, `candidateIdFor`.
- `cli/src/optimization/gate.ts`: `runGate`, `readGate`, `checkPromotion`, `promoteVersion`, `adoptForIdentity`.
- Config key `optimization {teacher, judge, weights, caps}`: `cli/src/types.ts` (`OptimizationConfig`, `OptimizationModelRef`), `cli/src/utils/config.ts` (`saveConfig` preserves it; `resolveOptimizationConfig` applies defaults).
- v20 migration edited in place: new table `gate_session_scores` plus `repairV20` (runs when the database is already at v20). Tests in `cli/src/db/__tests__/migrate-v20.test.ts`.
- `cli/src/db/optimization.ts`: `setVersionTestScores`, `replaceGateScores`, `listGateScores`.
- `cli/src/optimization/adapter.ts`: pre-submit cap check for batch waves (estimated tokens x discounted price).
- `cli/src/optimization/identity.ts`: `isPromotableIdentity` (false for `*-native` / `*-default` model labels).
- Embeddings static test now covers `gate.ts`, `engine.ts`, `estimate.ts` with no skip.
- Tests: `engine.test.ts` (31), `gate.test.ts` (14), fakes in `engine-fixtures.ts`.

## Partial or untested (be specific)

- `engine.ts`: batch (overnight) is tested only against a fake backend. Batch jobs are NOT persisted across restarts (phase 2 carry-forward 1 still open); a restart marks the run failed via `markStaleRunsFailed`. Status `awaiting_batch` is never set.
- `engine.ts`: judge audit rows (`judge_audits`) are not written. Teacher and judge tokens are not counted against caps; only the student's are.
- `engine.ts`: round lineage is derived from the evaluation calls GEPA makes (no per-round hook exists). Exact for reflective mutation; a merge candidate gets the last parent as its parent (merges are off by default in AxGEPA). Rejected children are written when GEPA starts its next evaluation, not immediately.
- `engine.ts`: when `stopReason` is null the saved version is `result.optimizedProgram` applied through `program.applyOptimization`; after a stop it is the validated candidate with the highest weighted score. A run that stops inside the first validation pass saves nothing (`versionId` null, `bestCandidateId` null).
- `estimate.ts`: numbers are planning estimates built from documented constants (`PROMPT_OVERHEAD_TOKENS`, `OUTPUT_TOKENS_PER_CALL`, `ACCEPT_RATE`, per-call seconds, `BATCH_WAVE_SECONDS`). Not calibrated against a real run. Manual check from the plan (one real light run, about 60 calls on a copy of the user's DB) has NOT been done.
- Pricing: no mistral or openrouter model is in the price table, so batch-capable students are always "unpriced". `checkRunCaps` therefore requires `caps.maxTokens` for every overnight run today. The USD branch of the pre-submit cap check is untested for that reason (no priced batch model exists).
- No factory exists for the teacher/judge `AxAIService` or for the student runner. Callers must build `teacherAI`, `createJudge` (use `createAxJudge` from `judge.ts`) and `runner` themselves. The legacy `createAIService` in `runner.ts` is the only existing example and is slated for deletion in step 27.
- `gate.ts`: `runGate` runs candidate then baseline sequentially (two batch jobs in batch mode, not one). Baseline = the identity's active version, or the built-in prompt when none is active or when the candidate is itself active.
- Nothing is wired to a server route, the CLI `optimize` command, or the dashboard.

## Exported API

### request.ts

```ts
type EngineErrorCode = 'invalid_request' | 'no_teacher' | 'no_judge' | 'unknown_version' | 'overnight_unsupported'
  | 'batch_unavailable' | 'unpriced_batch' | 'insufficient_labels' | 'cap_too_small' | 'identity_mismatch';
class EngineError extends Error { code: EngineErrorCode }

interface RunCaps { maxMetricCalls?: number; maxTokens?: number; maxCostUsd?: number }
interface OptimizationRequest {
  runId?: string;              // pre-created queued row; default: engine creates one
  target?: AnalysisTarget;     // default 'session-analysis'
  identity: StudentIdentity;
  teacher?: OptimizationModelRef;   // default optimization.teacher
  overnight?: boolean;         // batch the loop (provider:mistral / provider:openrouter only)
  baseVersionId?: string | null;    // seed from this version; becomes parent of the saved one
  caps?: RunCaps;              // overrides optimization.caps
  weights?: Weights;           // overrides optimization.weights
  numTrials?: number;          // default 20
  minibatchSize?: number;      // default 3
  earlyStoppingTrials?: number;// default 4
  seed?: number;
}
interface ResolvedRequest { /* every field filled: identityKey, mode: EvalMode, caps.maxMetricCalls, weights, ... */ }

function evalModeFor(identity: StudentIdentity, overnight?: boolean): 'sync' | 'cli' | 'batch'; // throws EngineError('overnight_unsupported')
function resolveRequest(request: OptimizationRequest, config: ClaudeInsightConfig | null | undefined): ResolvedRequest;
function modelRefLabel(ref: OptimizationModelRef): string; // 'provider/model'
```

### estimate.ts

```ts
interface EstimateOptions { config?: ClaudeInsightConfig | null; judge?: OptimizationModelRef | null; maxInputTokens?: number }
interface RunEstimate {
  mode: EvalMode; trainLabels: number; validationLabels: number; maxMetricCalls: number;
  evaluations: number; rounds: number; studentCalls: number; judgeCalls: number; teacherCalls: number;
  inputTokens: number; outputTokens: number; judgeTokens: number; teacherTokens: number; totalTokens: number;
  costUsd: number | null; studentCostUsd: number | null; unpriced: string[];
  waves: number;               // batch mode only, else 0
  wallTimeSeconds: number;
  upperBound: { studentCalls: number; totalTokens: number; costUsd: number | null };
  warnings: string[];
}
function estimateRun(db: Database, request: OptimizationRequest, opts?: EstimateOptions): RunEstimate;
function checkRunCaps(estimate: RunEstimate, request: ResolvedRequest): void; // throws EngineError unpriced_batch | cap_too_small
function estimateFromSizes(input): RunEstimate; // pure math, used by estimateRun
```

### engine.ts (re-exports the request.ts and estimate.ts API above)

```ts
type OptimizationEvent =
  | { type: 'started'; runId: string; estimate: RunEstimate; trainLabels: number; validationLabels: number }
  | { type: 'round'; runId: string; round: OptimizationRound; usage: AdapterUsage }
  | { type: 'stopping'; runId: string; reason: StopReason }
  | { type: 'finished'; runId: string; result: OptimizationResult };

interface OptimizationDeps {
  runner: AnalysisRunner;                       // student; identity must equal request.identity
  createJudge: (cache: JudgeCache) => Judge;    // engine passes dbJudgeCache(db)
  teacherAI: AxAIService;
  studentAI?: AxAIService;                      // never called while the adapter is healthy
  batch?: BatchBackend;                         // required for overnight
  config?: ClaudeInsightConfig | null;
  signal?: AbortSignal;                         // cancel
  onEvent?: (e: OptimizationEvent) => void;     // feed SSE
  log?, registry?, retry?, concurrency?, pollIntervalMs?, batchTimeoutMs?, sleep?, pipeline?
}
interface OptimizationResult {
  runId: string; status: 'completed' | 'cancelled' | 'failed'; stopReason: StopReason | null; error: string | null;
  versionId: string | null; bestCandidateId: string | null;
  candidates: Array<{ candidateId: string; scores: ObjectiveScores; scalar: number }>; // seed first
  rounds: number; usage: AdapterUsage; judge: { calls: number; cacheHits: number }; estimate: RunEstimate;
}
function runOptimization(db: Database, request: OptimizationRequest, deps: OptimizationDeps): Promise<OptimizationResult>;
function dbJudgeCache(db: Database): JudgeCache;
function candidateIdFor(map: Record<string, string>): string; // 'cand_' + sha1 of the sorted map, 12 hex chars
```

Behavior: preflight problems throw `EngineError` (a pre-created row is marked failed first). After compile starts nothing throws; `status` is `completed` (includes a cap stop), `cancelled` (abort), or `failed` (error, batch job failure, or a round could not be persisted). Best-so-far is saved as a version whenever a validated candidate differs from the seed.

### gate.ts

```ts
const GATE_CONFIDENT_SESSIONS = 10;
type GateErrorCode = 'not_found' | 'invalid_version' | 'no_test_labels' | 'identity_mismatch' | 'same_identity'
  | 'aborted' | 'incomplete' | 'not_gated' | 'not_better' | 'stale_gate' | 'unstable_identity';
class GateError extends Error { code: GateErrorCode }

interface GateDeps { runner: AnalysisRunner; judge: Judge; batch?: BatchBackend; mode?: EvalMode; weights?: Weights;
  caps?: AdapterCaps; signal?: AbortSignal; log?; registry?; retry?; concurrency?; pollIntervalMs?; batchTimeoutMs?; sleep?; pipeline? }
interface GateSummary { gatedAt; mode; judgeModel; weights; labelsHash; sessions; indicative: boolean;
  candidate: GateSide; baseline: GateSide & { versionId: string | null }; delta: number; beatsBaseline: boolean;
  usage: { candidate: AdapterUsage; baseline: AdapterUsage } }   // stored in prompt_versions.test_scores_json
interface GateResult { versionId: string; summary: GateSummary; sessions: GateSessionResult[] } // per-session delta table + analyses

function runGate(db, versionId, deps: GateDeps): Promise<GateResult>;     // stores nothing on abort/cap/batch failure
function readGate(db, versionId): GateResult | null;
function checkPromotion(db, versionId): { ok; overridable; blockers: PromotionBlocker[]; activeVersionId: string | null }; // UI disables Promote on !ok
function promoteVersion(db, versionId, opts?: { override?: boolean }): PromoteResult; // throws GateError; override bypasses only not_better and stale_gate
function adoptForIdentity(db, versionId, newIdentity: StudentIdentity, deps: GateDeps): Promise<AdoptResult>; // child version + gate; reuses an earlier child
function componentMapFor(target, components, registry?): Record<string, string>;
```

Rollback is `promoteVersion` on an earlier version; it normally needs `override: true`. `unstable_identity` (`*-native` / `*-default` model label) can never be overridden, and `adoptForIdentity` refuses such a target identity.

## Known risks

- Ax 22.0.2 internals: relies on `paretoScalarize` passed through compile options, `gepaAdapter` being called, and `maxMetricCalls` counting per example per evaluation. `gepa-contract.test.ts` guards the first two; keep `@ax-llm/ax` pinned at 22.0.x.
- Round recording depends on GEPA's call order (parent minibatch, child minibatch, validation). An Ax change to that order would mislabel lineage but not break scoring or version selection.
- `guardAI` wraps `teacherAI.chat` in a Proxy to end the reflection phase after a stop. If Ax calls the service through another method, the guard is bypassed (cost: up to `earlyStoppingTrials` extra teacher calls; correctness is unaffected).
- The v20 migration was edited in place. Verify against a copy of the user's real database before merge (cross-3).

## Next steps

1. Step 24, `server/src/optimization/jobs.ts` and routes. Single in-process worker, `AbortController` per run, call `markStaleRunsFailed` on boot. Create the `queued` row first (`createRun`), pass `runId`, return 202, stream `onEvent` as SSE. Routes: `runs`, `runs/:id`, `runs/:id/rounds` (SSE), `runs/:id/cancel`, `estimate` (call `estimateRun`), `versions`, `versions/:id/gate` (`runGate`, `readGate`), `versions/:id/promote` (`checkPromotion`, `promoteVersion`), `versions/:id/adopt` (`adoptForIdentity`). Map `EngineError` / `GateError` codes to 4xx. Build the teacher and judge `AxAIService`, the student runner, and the batch backend there (`createMistralBatchBackend` / `createOpenRouterBatchBackend`). Persist batch jobs (`createBatchJob`) and resume polling on boot (phase 2 carry-forward 1).
2. Step 26, overnight mode: the engine already refuses unsupported identities and unpriced batch models without a token cap; the server only needs the toggle and the backend. Expose the estimate warnings in the run form.
3. Step 27, legacy removal and manifest import: import the `~/.code-insights/optimization` manifest into `prompt_versions` once (idempotent), rewrite `cli/src/commands/optimize.ts` as a client of `runOptimization`, delete `flow.ts`, `legacy-metric.ts`, `runner.ts`, `templates.ts`, `prompts.ts` (legacy), `scripts/debug-optimization.mjs`, `cli/scripts/debug-optimization.mjs`, and trim `optimization/index.ts`. Move `createAIService` into a new module first.
4. Steps 28 and 29: dashboard pages (`OptimizationPage`, `RunPage`, `GatePage`) read `optimization_rounds`, `candidate_session_scores`, `readGate`; judge-mismatch warning compares `judgeModel` across versions; agent tools `listRuns`, `getRun`, `getRoundDiff`, `compareVersions`, `getLabel`.
5. Run the manual light run (about 60 calls) on a copy of the user's DB and calibrate the constants in `estimate.ts`.
