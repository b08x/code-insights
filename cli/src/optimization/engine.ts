/**
 * Optimization engine (plan step 23; engine-7..14, 16, 17).
 *
 * `runOptimization(db, request, deps)` runs one GEPA optimization of a target's guidance text for
 * one student identity and persists everything the dashboard reads: the run row, one
 * `optimization_rounds` row per candidate with per-session scores, the judge cache, and the saved
 * `prompt_versions` row. It does no promotion; that is the test gate's job (gate.ts).
 *
 * Contract with the pieces it composes:
 *   - Labels: train examples come from the train split, validation examples ONLY from the
 *     validation split (engine-9). The test split is never read here (the gate owns it).
 *   - Evaluation: every score goes through the adapter (adapter.ts), i.e. the real analysis
 *     pipeline plus the cached judge. The adapter NEVER throws (AxGEPA swallows a throwing adapter
 *     and silently re-runs through program.forward), so a fatal condition shows up as
 *     `adapter.stopReason` ('aborted' | 'cap' | 'batch_failed'). This engine checks it after
 *     `compile()` and keeps the best candidate found so far.
 *   - Selection: one weights object drives `paretoScalarize` (GEPA's own pick) and this engine's
 *     tracking of validated candidates (engine-7). With no stop, the saved version is
 *     `result.optimizedProgram` applied through `program.applyOptimization` (engine-8); after a
 *     stop it is the validated candidate with the highest weighted score.
 *   - Rounds: GEPA exposes no per-round callback with lineage, so the engine derives rounds from
 *     the evaluation calls it routes to the adapter. One row per distinct candidate: the seed
 *     (round 0), each accepted child (validation scores, accepted = true) and each rejected child
 *     (minibatch scores, accepted = false). A rejected child's row is written when GEPA moves on
 *     (its next evaluation), accepted ones as soon as their validation pass finishes.
 *     `parent_candidate_id` is the candidate whose minibatch GEPA evaluated just before the child's
 *     (exact for reflective mutation; best effort for merges, which are off by default).
 *     `candidate_id` is a content hash of the component map, so the same text is the same id
 *     across runs.
 *
 * Failure contract: problems detected before any model call (invalid request, no teacher, too few
 * labels, a cap that cannot cover the first validation pass, identity/batch-backend mismatch)
 * throw EngineError; if a run row already exists (request.runId) it is marked failed first.
 * Once compile starts nothing throws: the result's `status` says completed / cancelled / failed
 * and the row is updated to match.
 *
 * Not done here (later steps): batch jobs are not yet persisted across a process restart (a
 * restart fails the run via markStaleRunsFailed, carry-forward 1 of phase 2), judge audit rows are
 * not sampled, and teacher/judge token usage is not counted against the caps (only the student's
 * is, which is what `caps` documents).
 */

import { createHash } from 'node:crypto';
import { AxGEPA, type AxAIService, type AxGEPAAdapter, type AxGEPAEvaluationBatch } from '@ax-llm/ax';
import type Database from 'better-sqlite3';
import type { AnalysisRunner } from '../analysis/runner-types.js';
import type { analyzeSessionPipeline } from '../analysis/pipeline.js';
import { listLabels } from '../db/labels.js';
import {
  appendRound, createRun, createVersion, getJudgeCache, getRun, getVersion, labelsHashes, putJudgeCache, updateRun,
  type OptimizationRound, type PromptVersion,
} from '../db/optimization.js';
import type { BatchBackend } from '../llm-batch/index.js';
import type { ClaudeInsightConfig } from '../types.js';
import {
  createAdapter, labelToExample, type AdapterUsage, type EvalExample, type EvalOutput, type EvaluatedExample, type StopReason,
} from './adapter.js';
import { checkRunCaps, estimateRun, type RunEstimate } from './estimate.js';
import { identityFromRunner, identityKey } from './identity.js';
import type { Judge, JudgeCache } from './judge.js';
import { adapterMetric, feedbackFn, scalarize, OBJECTIVES, type JudgeVerdict, type ObjectiveScores } from './metric.js';
import { OptimizableProgram, ProgramError } from './program.js';
import { EngineError, modelRefLabel, resolveRequest, type OptimizationRequest, type ResolvedRequest } from './request.js';
import type { RetryOptions } from './retry.js';
import { TARGETS, type TargetRegistry } from './targets.js';

export { EngineError, evalModeFor, resolveRequest, type EngineErrorCode, type OptimizationRequest, type ResolvedRequest, type RunCaps } from './request.js';
export { checkRunCaps, estimateRun, type EstimateOptions, type RunEstimate } from './estimate.js';

// ── Public types ─────────────────────────────────────────────────────────────

/** Progress events for SSE. `round` fires after the row is persisted; the others are transient. */
export type OptimizationEvent =
  | { type: 'started'; runId: string; estimate: RunEstimate; trainLabels: number; validationLabels: number }
  | { type: 'round'; runId: string; round: OptimizationRound; usage: AdapterUsage }
  | { type: 'stopping'; runId: string; reason: StopReason }
  | { type: 'finished'; runId: string; result: OptimizationResult };

export interface OptimizationDeps {
  /** Student transport for `request.identity` (ProviderRunner, or a native CLI runner). Its identity must equal the request's. */
  runner: AnalysisRunner;
  /**
   * Builds the judge. The engine passes the database-backed cache (`dbJudgeCache`) so verdicts are
   * shared across runs; ignore it only in tests that do not care.
   */
  createJudge: (cache: JudgeCache) => Judge;
  /** Reflection model. Required: it is the "teacher" of the request. */
  teacherAI: AxAIService;
  /** Never called while the adapter is healthy (scoring goes through the adapter); defaults to teacherAI. */
  studentAI?: AxAIService;
  /** Required in batch (overnight) mode; must match the identity's provider and model. */
  batch?: BatchBackend;
  /** Source of `optimization` defaults (weights, caps, judge) for the request and the estimate. */
  config?: ClaudeInsightConfig | null;
  /** Cancel: aborting stops evaluation cleanly and keeps the best-so-far candidate. */
  signal?: AbortSignal;
  onEvent?: (event: OptimizationEvent) => void;
  log?: (message: string) => void;
  registry?: TargetRegistry;
  // Tuning and test seams, forwarded to the adapter.
  retry?: RetryOptions;
  concurrency?: number;
  pollIntervalMs?: number;
  batchTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pipeline?: typeof analyzeSessionPipeline;
}

export interface CandidateSummary {
  candidateId: string;
  /** Mean validation scores per objective. */
  scores: ObjectiveScores;
  /** scalarize(scores, weights). */
  scalar: number;
}

export interface OptimizationResult {
  runId: string;
  /** completed (including a cap stop), cancelled (abort signal) or failed (error, or batch job failure). */
  status: 'completed' | 'cancelled' | 'failed';
  stopReason: StopReason | null;
  error: string | null;
  /** The saved version, or null when no candidate beat the starting prompt (or none could be scored). */
  versionId: string | null;
  /** Candidate id of the selected candidate (the seed's id when nothing improved); null when none was scored. */
  bestCandidateId: string | null;
  /** Validated candidates with their weighted score, seed first. */
  candidates: CandidateSummary[];
  /** Number of `optimization_rounds` rows written. */
  rounds: number;
  /** Student usage, including every call the run paid for. */
  usage: AdapterUsage;
  judge: { calls: number; cacheHits: number };
  estimate: RunEstimate;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Judge cache over the v20 `judge_cache` table (engine-4). */
export function dbJudgeCache(db: Database.Database): JudgeCache {
  return {
    get: (outputHash, keyPointsHash, judgeModel) => getJudgeCache<JudgeVerdict>(db, outputHash, keyPointsHash, judgeModel),
    put: (outputHash, keyPointsHash, judgeModel, verdict) => putJudgeCache(db, outputHash, keyPointsHash, judgeModel, verdict),
  };
}

/** Stable id for a candidate: a hash of its component map, independent of key order. */
export function candidateIdFor(map: Readonly<Record<string, string>>): string {
  const canonical = JSON.stringify(Object.keys(map).sort().map(k => [k, map[k]]));
  return `cand_${createHash('sha1').update(canonical).digest('hex').slice(0, 12)}`;
}

const sameMap = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => a[k] === b[k]);
};

function meanVector(vectors: ReadonlyArray<Readonly<Record<string, number>>>): ObjectiveScores {
  const out = Object.fromEntries(OBJECTIVES.map(o => [o, 0])) as ObjectiveScores;
  if (vectors.length === 0) return out;
  for (const o of OBJECTIVES) out[o] = vectors.reduce((s, v) => s + (v[o] ?? 0), 0) / vectors.length;
  return out;
}

class EngineStop extends Error {
  constructor() {
    super('optimization stopped');
    this.name = 'EngineStop';
  }
}

/** Ends GEPA's reflection phase once the adapter has stopped, instead of paying the teacher for rounds that score zeros. */
function guardAI(ai: AxAIService, stopped: () => boolean): AxAIService {
  return new Proxy(ai, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== 'function') return value;
      if (prop === 'chat') return (...args: unknown[]) => { if (stopped()) throw new EngineStop(); return (value as (...a: unknown[]) => unknown).apply(target, args); };
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

// ── Round recorder ───────────────────────────────────────────────────────────

interface Candidate { id: string; map: Record<string, string>; parentId: string | null }
interface Pending { cand: Candidate; set: readonly EvalExample[]; batch: AxGEPAEvaluationBatch<unknown, EvalOutput>; evaluated: EvaluatedExample[] }

/**
 * Derives round rows from the evaluation calls GEPA makes (see the header). Bookkeeping errors
 * are captured in `persistError`, never thrown: this runs inside adapter.evaluate, where a throw
 * would make GEPA fall back to program.forward.
 */
class RoundRecorder {
  persistError: string | null = null;
  readonly validated = new Map<string, CandidateSummary & { map: Record<string, string> }>();
  seedId: string | null = null;
  roundsWritten = 0;

  private evaluated: EvaluatedExample[] = [];
  private readonly known = new Map<string, Candidate>();
  private pending: Pending | null = null;
  private lastParentId: string | null = null;
  private last = { tokens: 0, costUsd: 0, unpriced: 0 };
  private readonly validationIds: Set<string>;

  constructor(
    private readonly db: Database.Database,
    private readonly runId: string,
    private readonly validation: readonly EvalExample[],
    private readonly weights: Record<string, number>,
    private readonly usage: () => Readonly<AdapterUsage>,
    private readonly stopReason: () => StopReason | null,
    private readonly emit: (round: OptimizationRound) => void,
  ) {
    this.validationIds = new Set(validation.map(v => v.sessionId));
  }

  collect(e: EvaluatedExample): void { this.evaluated.push(e); }

  /** Called after each adapter evaluation with what GEPA asked for and what it got back. */
  observe(set: readonly EvalExample[], candidate: Readonly<Record<string, string>>, batch: AxGEPAEvaluationBatch<unknown, EvalOutput>): void {
    const evaluated = this.evaluated;
    this.evaluated = [];
    try {
      this.observeUnsafe(set, candidate, batch, evaluated);
    } catch (err) {
      this.persistError ??= `Could not record a round: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** Writes a child that was never validated (rejected, or the run ended). */
  finish(): void {
    try {
      this.flushPending();
    } catch (err) {
      this.persistError ??= `Could not record a round: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  best(): (CandidateSummary & { map: Record<string, string> }) | null {
    let best: (CandidateSummary & { map: Record<string, string> }) | null = null;
    for (const c of this.validated.values()) if (!best || c.scalar > best.scalar) best = c;
    return best;
  }

  private observeUnsafe(
    set: readonly EvalExample[],
    candidate: Readonly<Record<string, string>>,
    batch: AxGEPAEvaluationBatch<unknown, EvalOutput>,
    evaluated: EvaluatedExample[],
  ): void {
    const id = candidateIdFor(candidate);
    const isValidation = set.length === this.validation.length && set.every(e => this.validationIds.has(e.sessionId));
    const complete = batch.outputs.every(o => o.errorType !== 'not_evaluated');
    // An evaluation cut short by cancel/cap/batch failure says nothing about the candidate.
    if (!complete && this.stopReason() !== null) return;

    if (!this.known.has(id)) {
      this.flushPending();
      const cand: Candidate = { id, map: { ...candidate }, parentId: this.known.size === 0 ? null : this.lastParentId };
      this.known.set(id, cand);
      if (isValidation) {
        if (this.seedId === null) this.seedId = id;
        this.write({ cand, set, batch, evaluated }, true, complete);
      } else {
        this.pending = { cand, set, batch, evaluated };
      }
    } else if (this.pending?.cand.id === id && isValidation) {
      const { cand } = this.pending;
      this.pending = null;
      this.write({ cand, set, batch, evaluated }, true, complete);
    } else if (!isValidation) {
      // A known candidate on training examples is a parent minibatch: a new reflection round starts.
      this.flushPending();
      this.lastParentId = id;
    }
  }

  private flushPending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.write(p, false, true);
  }

  private write(p: Pending, accepted: boolean, complete: boolean): void {
    const { cand, set, batch, evaluated } = p;
    const onValidation = set.length === this.validation.length && set.every(e => this.validationIds.has(e.sessionId));
    const avg = meanVector(batch.scoreVectors ?? batch.outputs.map(o => o.scores));
    const scalar = scalarize(avg, this.weights);
    const verdictBySession = new Map(evaluated.map(e => [e.example.sessionId, e.verdict]));

    const u = this.usage();
    const tokens = u.inputTokens + u.outputTokens;
    const unpricedDelta = u.unpricedCalls - this.last.unpriced;
    const round = appendRound(this.db, {
      runId: this.runId,
      round: this.roundsWritten++,
      candidateId: cand.id,
      parentCandidateId: cand.parentId,
      components: cand.map,
      scores: avg,
      scalar,
      accepted,
      rationales: {
        evaluatedOn: onValidation ? 'validation' : 'minibatch',
        items: batch.outputs.flatMap(o => {
          const judge = verdictBySession.get(o.sessionId)?.rationale;
          return o.feedback || judge ? [{ sessionId: o.sessionId, ...(o.feedback && { feedback: o.feedback }), ...(judge && { judge }) }] : [];
        }),
      },
      tokens: tokens - this.last.tokens,
      costUsd: unpricedDelta > 0 ? null : u.costUsd - this.last.costUsd,
      sessionScores: batch.outputs.map(o => ({ sessionId: o.sessionId, scores: { ...o.scores }, scalar: scalarize(o.scores, this.weights) })),
    });
    this.last = { tokens, costUsd: u.costUsd, unpriced: u.unpricedCalls };

    if (onValidation && complete) {
      this.validated.set(cand.id, { candidateId: cand.id, scores: avg, scalar, map: cand.map });
    }
    this.emit(round);
  }
}

// ── The run ──────────────────────────────────────────────────────────────────

export async function runOptimization(
  db: Database.Database,
  requestInput: OptimizationRequest,
  deps: OptimizationDeps,
): Promise<OptimizationResult> {
  const config = deps.config ?? null;
  const req = resolveRequest(requestInput, config);
  const registry = deps.registry ?? TARGETS;
  const log = deps.log ?? (() => {});

  const existing = req.runId ? getRun(db, req.runId) : null;
  if (req.runId && !existing) throw new EngineError('invalid_request', `Optimization run not found: ${req.runId}`);
  if (existing && existing.status !== 'queued') throw new EngineError('invalid_request', `Run ${existing.id} is ${existing.status}, not queued.`);

  // ── Preflight: nothing here calls a model ────────────────────────────────
  let runId = existing?.id ?? null;
  const refuse = (err: unknown): never => {
    if (runId) updateRun(db, runId, { status: 'failed', error: err instanceof Error ? err.message : String(err) });
    throw err;
  };
  let preflight: { judge: Judge; train: EvalExample[]; validation: EvalExample[]; program: OptimizableProgram; estimate: RunEstimate; baseVersion: PromptVersion | null };
  try {
    preflight = prepare(db, req, deps, registry, config);
  } catch (err) {
    return refuse(err);
  }
  const { judge, train, validation, program, estimate, baseVersion } = preflight;
  const labelsHash = labelsHashes(db);

  const runRow = existing
    ? updateRun(db, existing.id, { status: 'running', estimate: estimate as never, labelsHash })
    : (() => {
        const created = createRun(db, {
          target: req.target, identityKey: req.identityKey, teacher: modelRefLabel(req.teacher), judgeModel: judge.model,
          mode: req.mode, caps: req.caps, estimate: estimate as never, labelsHash,
        });
        return updateRun(db, created.id, { status: 'running' });
      })();
  runId = runRow.id;
  const emit = (event: OptimizationEvent): void => { try { deps.onEvent?.(event); } catch { /* a listener must not break the run */ } };
  emit({ type: 'started', runId, estimate, trainLabels: train.length, validationLabels: validation.length });

  const finish = (result: Omit<OptimizationResult, 'runId' | 'estimate'>): OptimizationResult => {
    const full: OptimizationResult = { ...result, runId: runRow.id, estimate };
    updateRun(db, runRow.id, { status: full.status, bestCandidateId: full.bestCandidateId, error: full.error });
    emit({ type: 'finished', runId: runRow.id, result: full });
    return full;
  };

  if (deps.signal?.aborted) {
    return finish({ status: 'cancelled', stopReason: 'aborted', error: null, versionId: null, bestCandidateId: null, candidates: [], rounds: 0, usage: emptyUsage(), judge: { ...judge.stats } });
  }

  // ── Wire adapter, recorder and GEPA ──────────────────────────────────────
  let batchError: string | null = null;
  const adapterRef: { current: ReturnType<typeof createAdapter> | null } = { current: null };
  const recorder = new RoundRecorder(
    db, runRow.id, validation, req.weights,
    () => adapterRef.current!.usage,
    () => adapterRef.current!.stopReason,
    round => emit({ type: 'round', runId: runRow.id, round, usage: { ...adapterRef.current!.usage } }),
  );
  const adapter = createAdapter({
    target: req.target, mode: req.mode, identity: req.identity, runner: deps.runner, judge, batch: deps.batch,
    weights: req.weights, caps: { maxTokens: req.caps.maxTokens, maxCostUsd: req.caps.maxCostUsd }, registry,
    retry: deps.retry, concurrency: deps.concurrency, pollIntervalMs: deps.pollIntervalMs, batchTimeoutMs: deps.batchTimeoutMs,
    sleep: deps.sleep, signal: deps.signal, pipeline: deps.pipeline,
    onEvaluated: e => recorder.collect(e),
    log: message => { if (message.startsWith('Batch evaluation failed')) batchError = message; log(message); },
  });
  adapterRef.current = adapter;
  const onAbort = () => adapter.stop('aborted');
  deps.signal?.addEventListener('abort', onAbort, { once: true });
  let stopAnnounced = false;
  const stopped = (): boolean => {
    const reason = adapter.stopReason;
    if (reason && !stopAnnounced) { stopAnnounced = true; emit({ type: 'stopping', runId: runRow.id, reason }); }
    return reason !== null;
  };

  const tracked: AxGEPAAdapter<EvalExample, unknown, EvalOutput> = {
    async evaluate(set, candidate, captureTraces) {
      const batch = await adapter.evaluate(set, candidate, captureTraces);
      recorder.observe(set, candidate, batch);
      stopped();
      return batch;
    },
    make_reflective_dataset: (candidate, evalBatch, components) => adapter.make_reflective_dataset(candidate, evalBatch, components),
  };

  const seedMap = program.componentMap();
  const optimizer = new AxGEPA({
    studentAI: guardAI(deps.studentAI ?? deps.teacherAI, stopped),
    teacherAI: guardAI(deps.teacherAI, stopped),
    numTrials: req.numTrials,
    minibatch: true,
    minibatchSize: req.minibatchSize,
    earlyStoppingTrials: req.earlyStoppingTrials,
    sampleCount: 1,
    ...(req.seed !== undefined ? { seed: req.seed } : {}),
  } as never);

  let result: Awaited<ReturnType<AxGEPA['compile']>> | undefined;
  let compileError: unknown = null;
  try {
    result = await optimizer.compile(program as never, train as never, adapterMetric as never, {
      validationExamples: validation,
      maxMetricCalls: req.caps.maxMetricCalls,
      gepaAdapter: tracked,
      feedbackFn,
      // Untyped in the 22.0.2 typings, called with each (mean) score vector: the same weights that pick the saved version.
      paretoScalarize: (scores: Record<string, number>) => scalarize(scores, req.weights),
    } as never);
  } catch (err) {
    compileError = err;
  } finally {
    deps.signal?.removeEventListener('abort', onAbort);
  }
  recorder.finish();

  // ── Settle: stopReason first, then keep the best-so-far ───────────────────
  const stopReason = adapter.stopReason;
  const aborted = !!deps.signal?.aborted || stopReason === 'aborted';
  const realFailure = compileError !== null && stopReason === null && !(compileError instanceof EngineStop);

  let bestMap: Record<string, string> | null = null;
  if (!realFailure) {
    if (stopReason === null && result?.optimizedProgram?.componentMap) {
      // Normal end: GEPA's own selection (max weighted score on its Pareto front), applied as documented.
      program.applyOptimization(result.optimizedProgram as never);
      bestMap = program.componentMap();
    } else {
      const best = recorder.best();
      if (best) {
        program.applyOptimizedComponents(best.map);
        bestMap = program.componentMap();
      }
    }
  }

  let versionId: string | null = null;
  if (bestMap && !sameMap(bestMap, seedMap)) {
    const version = createVersion(db, {
      target: req.target,
      identityKey: req.identityKey,
      components: program.guidanceComponents(),
      parentVersionId: baseVersion?.id ?? null,
      sourceRunId: runRow.id,
      judgeModel: judge.model,
      weights: req.weights,
    });
    versionId = version.id;
  }

  const candidates = [...recorder.validated.values()].map(({ candidateId, scores, scalar }) => ({ candidateId, scores, scalar }));
  const status: OptimizationResult['status'] =
    realFailure || stopReason === 'batch_failed' || recorder.persistError ? 'failed' : aborted ? 'cancelled' : 'completed';
  const error =
    realFailure ? (compileError instanceof Error ? compileError.message : String(compileError))
    : stopReason === 'batch_failed' ? (batchError ?? 'The batch job failed; the best candidate found so far was kept.')
    : recorder.persistError;

  return finish({
    status,
    stopReason,
    error,
    versionId,
    bestCandidateId: bestMap ? candidateIdFor(bestMap) : recorder.seedId,
    candidates,
    rounds: recorder.roundsWritten,
    usage: { ...adapter.usage },
    judge: { ...judge.stats },
  });
}

const emptyUsage = (): AdapterUsage => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, syncFallbacks: 0, replayMisses: 0, waves: 0, failedExamples: 0 });

/** Everything that can be refused before a model is called. */
function prepare(
  db: Database.Database,
  req: ResolvedRequest,
  deps: OptimizationDeps,
  registry: TargetRegistry,
  config: ClaudeInsightConfig | null,
): { judge: Judge; train: EvalExample[]; validation: EvalExample[]; program: OptimizableProgram; estimate: RunEstimate; baseVersion: PromptVersion | null } {
  const runnerKey = identityKey(identityFromRunner(deps.runner));
  if (runnerKey !== req.identityKey) {
    throw new EngineError('identity_mismatch', `The student runner is ${runnerKey} but the request is for ${req.identityKey}.`);
  }
  if (req.mode === 'batch' && !deps.batch) {
    throw new EngineError('batch_unavailable', 'Overnight (batch) mode needs a batch backend for this provider; none is configured.');
  }

  const judge = deps.createJudge(dbJudgeCache(db));
  if (!judge?.model) throw new EngineError('no_judge', 'No judge model: set optimization.judge in Settings.');

  // Train from the train split, validation from the validation split ONLY (engine-9). Test is never read.
  const train = listLabels(db, { split: 'train', usableOnly: true }).map(labelToExample);
  const validation = listLabels(db, { split: 'validation', usableOnly: true }).map(labelToExample);
  if (train.length === 0 || validation.length === 0) {
    throw new EngineError(
      'insufficient_labels',
      `An optimization run needs labeled sessions in both the train split (${train.length}) and the validation split (${validation.length}).`,
    );
  }

  let baseVersion: PromptVersion | null = null;
  if (req.baseVersionId) {
    baseVersion = getVersion(db, req.baseVersionId);
    if (!baseVersion) throw new EngineError('unknown_version', `Base prompt version not found: ${req.baseVersionId}`);
    if (baseVersion.target !== req.target) throw new EngineError('invalid_request', `Base version ${baseVersion.id} is for ${baseVersion.target}, not ${req.target}.`);
  }
  let program: OptimizableProgram;
  try {
    program = new OptimizableProgram(req.target, registry, baseVersion?.components ?? {});
  } catch (err) {
    if (err instanceof ProgramError) throw new EngineError('invalid_request', `Base version cannot seed a run: ${err.message}`);
    throw err;
  }

  const estimate = estimateRun(db, { ...requestFrom(req) }, { config, judge: config?.optimization?.judge ?? null, maxInputTokens: deps.runner.maxInputTokens });
  checkRunCaps(estimate, req);
  return { judge, train, validation, program, estimate, baseVersion };
}

/** A resolved request is a valid request: estimateRun re-resolves it to the same values. */
function requestFrom(req: ResolvedRequest): OptimizationRequest {
  return {
    target: req.target,
    identity: req.identity,
    teacher: req.teacher,
    overnight: req.mode === 'batch',
    baseVersionId: req.baseVersionId,
    caps: req.caps,
    weights: req.weights,
    numTrials: req.numTrials,
    minibatchSize: req.minibatchSize,
    earlyStoppingTrials: req.earlyStoppingTrials,
    seed: req.seed,
  };
}
