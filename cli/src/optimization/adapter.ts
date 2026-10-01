/**
 * The GEPA evaluation adapter (plan step 21; engine-1, 16, 17).
 *
 * `evaluate(set, candidate)` scores one candidate prompt on a set of labeled sessions by running the
 * REAL analysis pipeline (same formatter -> runner -> parser path as production) in dry-run mode:
 * persist:false, contexts:'none' (the prompt depends only on the session, so scores are comparable
 * across candidates), `targets:[target]` (no unscored prompt-quality call) and a per-target
 * promptOverride carrying the candidate's guidance components. The output is then scored against the
 * label (metric.ts) with the cached typed judge (judge.ts).
 *
 * Three backends behind one adapter (engine-17):
 *   sync   a provider-backed runner (ProviderRunner), one call per example
 *   cli    a native CLI runner (claude/codex/opencode/...), synchronous and sequential
 *   batch  a provider batch backend: collect prompts -> submit -> replay (batch-replay.ts), in waves
 * Backend, runner and identity must agree; the factory throws otherwise, because a candidate scored
 * on one model but recorded for another is a silently wrong prompt version.
 *
 * Transient errors retry per call inside the runner wrapper (engine-16): one 429 costs one retry, not
 * a restart.
 *
 * Failure contract (important): AxGEPA swallows an exception thrown by `evaluate` and silently
 * re-runs the examples through `program.forward`. So `evaluate` NEVER throws. Per-example failures
 * score zeros with feedback; fatal conditions (cancel, cap reached, unusable batch job) set
 * `stopReason`, after which every evaluation returns zeros without spending a call. The engine
 * checks `stopReason` after `compile()` and keeps the best-so-far candidate.
 */

import { analyzeSessionPipeline, type PipelineResult } from '../analysis/pipeline.js';
import type { AnalysisResponse } from '../analysis/prompt-types.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../analysis/runner-types.js';
import { normalizeFrictionCategory } from '../analysis/friction-normalize.js';
import { normalizePatternCategory } from '../analysis/pattern-normalize.js';
import type { SessionLabel } from '../db/labels.js';
import { listPrice, type BatchBackend, type BatchRow } from '../llm-batch/index.js';
import type { AxGEPAAdapter, AxGEPAEvaluationBatch } from '@ax-llm/ax';
import { collectWaves, makeSyncCall, ReplayTable, submitCollected, wrapRunner, BatchUnusableError, type PromptCollector } from './batch-replay.js';
import { identityFromRunner, identityKey, type StudentIdentity } from './identity.js';
import { JudgeError, type Judge } from './judge.js';
import {
  buildFeedback,
  needsJudge,
  scalarize,
  scoreVector,
  OBJECTIVES,
  type JudgeVerdict,
  type LabelExpectation,
  type ObjectiveScores,
  type ObservedAnalysis,
  type ScoredOutput,
  type Weights,
} from './metric.js';
import { batchProviderOf } from './preanalyze.js';
import { toGuidanceComponents, validateComponentMap } from './program.js';
import { retryCall, defaultSleep, type RetryOptions } from './retry.js';
import { TARGETS, type AnalysisTarget, type TargetRegistry } from './targets.js';

export type EvalMode = 'sync' | 'cli' | 'batch';

/** One labeled session as GEPA's datum. Plain data: GEPA JSON-serializes examples to dedupe them. */
export interface EvalExample extends LabelExpectation {
  sessionId: string;
}

export function labelToExample(label: SessionLabel): EvalExample {
  return {
    sessionId: label.sessionId,
    outcome: label.outcome,
    frictionCategories: [...label.frictionCategories],
    patternCategories: [...label.patternCategories],
    keyPoints: [...label.keyPoints],
    forbiddenClaims: [...label.forbiddenClaims],
  };
}

/** Per-example result; GEPA's "prediction" (kept small: it is shown to the reflection model). */
export interface EvalOutput extends ScoredOutput {
  sessionId: string;
  observed: ObservedAnalysis;
  /** Pipeline failure type when the call or parse failed. */
  errorType?: string;
}

/** Everything the engine persists per (candidate, session): scores, judge verdict, the analysis. */
export interface EvaluatedExample {
  example: EvalExample;
  candidate: Readonly<Record<string, string>>;
  output: EvalOutput;
  verdict: JudgeVerdict | null;
  /** The compact analysis the judge saw; undefined when the pipeline failed. */
  analysis?: unknown;
}

export interface AdapterUsage {
  /** Student transport calls (batch rows count as calls). */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Calls whose model has no price; costUsd then undercounts. */
  unpricedCalls: number;
  /** Replay calls that fell back to the synchronous transport. */
  syncFallbacks: number;
  /** Replay calls whose prompt the collect phase never saw (batch mode). */
  replayMisses: number;
  /** Submit/replay waves run (batch mode). */
  waves: number;
  /** Examples whose pipeline run failed (api error, parse failure). */
  failedExamples: number;
}

export type StopReason = 'aborted' | 'cap' | 'batch_failed';

export interface AdapterCaps {
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface AdapterConfig {
  target?: AnalysisTarget;
  mode: EvalMode;
  /** The student: must equal the runner's identity (and the batch backend's, in batch mode). */
  identity: StudentIdentity;
  runner: AnalysisRunner;
  judge: Judge;
  /** Required for mode 'batch'. */
  batch?: BatchBackend;
  weights?: Weights;
  caps?: AdapterCaps;
  registry?: TargetRegistry;
  retry?: RetryOptions;
  /** Examples evaluated in parallel (sync). cli mode always runs one at a time. Default 4. */
  concurrency?: number;
  pollIntervalMs?: number;
  batchTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Test seam; default analyzeSessionPipeline. */
  pipeline?: typeof analyzeSessionPipeline;
  /** Called once per scored example (engine: write per-session scores, judge audits). */
  onEvaluated?: (e: EvaluatedExample) => void;
  log?: (message: string) => void;
}

export interface EvalAdapter extends AxGEPAAdapter<EvalExample, unknown, EvalOutput> {
  evaluate(
    set: readonly EvalExample[],
    candidate: Readonly<Record<string, string>>,
    captureTraces?: boolean,
  ): Promise<AxGEPAEvaluationBatch<unknown, EvalOutput>>;
  readonly usage: Readonly<AdapterUsage>;
  readonly stopReason: StopReason | null;
  /** Stop all further evaluation (engine cancel / cap). Idempotent. */
  stop(reason: StopReason): void;
}

const zeroScores = (): ObjectiveScores => Object.fromEntries(OBJECTIVES.map(o => [o, 0])) as ObjectiveScores;

/** The slice of an analysis the judge rules on: what the analysis claims, minus step matrices and ids. */
export function analysisForJudge(response: AnalysisResponse): unknown {
  return {
    summary: { title: response.summary?.title, content: response.summary?.content, bullets: response.summary?.bullets },
    decisions: (response.decisions ?? []).map(d => ({ title: d.title, choice: d.choice, reasoning: d.reasoning })),
    learnings: (response.learnings ?? []).map(l => ({ title: l.title, takeaway: l.takeaway, root_cause: l.root_cause })),
    friction_points: (response.facets?.friction_points ?? []).map(f => ({ category: f.category, description: f.description, resolution: f.resolution })),
    effective_patterns: (response.facets?.effective_patterns ?? []).map(p => ({ category: p.category, description: p.description })),
  };
}

function observedFrom(result: PipelineResult): { observed: ObservedAnalysis; errorType?: string; response?: AnalysisResponse } {
  if (!result.success || !result.session) {
    // Unparseable output is a schema failure (engine-3). Transport failures also score zero but keep their type.
    return {
      observed: { schemaValid: false, outcome: null, frictionCategories: [], patternCategories: [] },
      errorType: result.success ? 'invalid_structure' : result.error_type,
    };
  }
  const facets = result.session.facets;
  return {
    response: result.session,
    observed: {
      schemaValid: true,
      outcome: facets?.outcome_satisfaction ?? null,
      frictionCategories: (facets?.friction_points ?? []).map(f => normalizeFrictionCategory(f.category)),
      patternCategories: (facets?.effective_patterns ?? []).map(p => normalizePatternCategory(p.category)),
    },
  };
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function pool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export function createAdapter(config: AdapterConfig): EvalAdapter {
  const target = config.target ?? 'session-analysis';
  const registry = config.registry ?? TARGETS;
  const { runner, identity, mode } = config;
  const pipeline = config.pipeline ?? analyzeSessionPipeline;

  if (target !== 'session-analysis') {
    // Prompt-quality is never scored against labels in this goal (carry-forward 6).
    throw new Error(`Target "${target}" cannot be evaluated: only session-analysis is scored against labels.`);
  }

  // ── Backend / runner / identity must agree ─────────────────────────────────
  const runnerKey = identityKey(identityFromRunner(runner));
  if (runnerKey !== identityKey(identity)) {
    throw new Error(`Runner identity (${runnerKey}) does not match the student identity (${identityKey(identity)}).`);
  }
  const providerBacked = runner.provider !== undefined;
  if (mode === 'cli' && providerBacked) throw new Error(`Mode "cli" needs a native CLI runner; "${runner.name}" is provider-backed. Use mode "sync".`);
  if ((mode === 'sync' || mode === 'batch') && !providerBacked) throw new Error(`Mode "${mode}" needs a provider-backed runner; "${runner.name}" is a native CLI runner. Use mode "cli".`);
  if (mode === 'batch') {
    const backend = config.batch;
    if (!backend) throw new Error('Mode "batch" needs a batch backend.');
    const expected = batchProviderOf(identity);
    if (backend.provider !== expected || backend.model !== identity.model) {
      throw new Error(
        `Batch backend (${backend.provider}/${backend.model}) and runner (${runner.provider}/${runner.model}) ` +
        `do not match the student identity ${identity.runner}/${identity.model}.`,
      );
    }
  } else if (config.batch) {
    throw new Error(`A batch backend was supplied but the mode is "${mode}".`);
  }

  const usage: AdapterUsage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, syncFallbacks: 0, replayMisses: 0, waves: 0, failedExamples: 0 };
  let stopReason: StopReason | null = null;
  const stop = (reason: StopReason) => { stopReason ??= reason; };
  const log = config.log ?? (() => {});

  const capReached = (): boolean => {
    const caps = config.caps;
    if (!caps) return false;
    return (caps.maxTokens !== undefined && usage.inputTokens + usage.outputTokens >= caps.maxTokens)
      || (caps.maxCostUsd !== undefined && usage.costUsd >= caps.maxCostUsd);
  };
  /** Checked before every example and every submit: a clean stop, never a mid-call throw. */
  const shouldStop = (): boolean => {
    if (config.signal?.aborted) stop('aborted');
    if (capReached()) stop('cap');
    return stopReason !== null;
  };

  const account = (r: RunAnalysisResult): void => {
    usage.calls++;
    usage.inputTokens += r.inputTokens;
    usage.outputTokens += r.outputTokens;
    const cost = r.costUsd ?? listPrice(runner.provider ?? r.provider, r.model, r.inputTokens, r.outputTokens);
    if (cost === undefined) { if (runner.provider) usage.unpricedCalls++; } else usage.costUsd += cost;
  };

  /** Student transport with per-call retry (engine-16), not yet accounted. */
  const transport: AnalysisRunner = wrapRunner(runner, (params: RunAnalysisParams) =>
    retryCall(() => runner.runAnalysis(params), {
      ...config.retry,
      signal: config.signal,
      onRetry: (attempt, err, delay) => log(`Transient error (attempt ${attempt}), retrying in ${delay} ms: ${err instanceof Error ? err.message : String(err)}`),
    }));
  /** The same transport with usage accounting: what sync evaluation and replay fallbacks call. */
  const retrying: AnalysisRunner = wrapRunner(runner, async (params: RunAnalysisParams) => {
    const result = await transport.runAnalysis(params);
    account(result);
    return result;
  });

  const pipelineOptions = (candidate: Readonly<Record<string, string>>, runnerToUse: AnalysisRunner) => ({
    runner: runnerToUse,
    identity,
    persist: false as const,
    contexts: 'none' as const,
    targets: [target],
    promptOverride: { [target]: { components: toGuidanceComponents(target, candidate, registry), versionId: null } },
    signal: config.signal,
  });

  /** Judge + score one example's pipeline result. Never throws. */
  const scoreExample = async (
    example: EvalExample,
    candidate: Readonly<Record<string, string>>,
    result: PipelineResult,
  ): Promise<EvalOutput> => {
    const { observed, errorType, response } = observedFrom(result);
    let verdict: JudgeVerdict | null = null;
    let judgeError: string | undefined;
    const analysis = response ? analysisForJudge(response) : undefined;
    if (observed.schemaValid && needsJudge(example)) {
      try {
        verdict = await config.judge.judge(
          { keyPoints: example.keyPoints, forbiddenClaims: example.forbiddenClaims, analysis: JSON.stringify(analysis) },
          config.signal,
        );
      } catch (err) {
        if (config.signal?.aborted) stop('aborted');
        judgeError = err instanceof JudgeError ? err.message : `Judge failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (!observed.schemaValid) usage.failedExamples++;
    const scores = scoreVector(example, observed, verdict);
    let feedback = buildFeedback(example, observed, verdict);
    if (judgeError) feedback = [feedback, judgeError].filter(Boolean).join('\n');
    const output: EvalOutput = { sessionId: example.sessionId, scores, observed, ...(feedback && { feedback }), ...(errorType && { errorType }) };
    config.onEvaluated?.({ example, candidate, output, verdict, analysis });
    return output;
  };

  const failedRow = (example: EvalExample, reason: string): EvalOutput => ({
    sessionId: example.sessionId,
    scores: zeroScores(),
    observed: { schemaValid: false, outcome: null, frictionCategories: [], patternCategories: [] },
    feedback: reason,
    errorType: 'not_evaluated',
  });

  // ── backends ───────────────────────────────────────────────────────────────

  const evaluateSync = async (set: readonly EvalExample[], candidate: Readonly<Record<string, string>>): Promise<EvalOutput[]> =>
    pool(set, mode === 'cli' ? 1 : config.concurrency ?? 4, async example => {
      if (shouldStop()) return failedRow(example, `Evaluation stopped (${stopReason}).`);
      const result = await pipeline(example.sessionId, pipelineOptions(candidate, retrying));
      return scoreExample(example, candidate, result);
    });

  const evaluateBatch = async (set: readonly EvalExample[], candidate: Readonly<Record<string, string>>): Promise<EvalOutput[]> => {
    const backend = config.batch!;
    // Resyncs of failed batch rows come back as rows and are accounted with the batch (accountRow);
    // replay fallbacks are accounted as they run.
    const resyncCall = makeSyncCall(transport);
    const syncCall = makeSyncCall(retrying);
    const table = new ReplayTable();
    let collected: PromptCollector;
    try {
      ({ collected } = await collectWaves({
        base: runner,
        table,
        collectPass: async (collector, setOwner) => {
          for (const example of set) {
            setOwner(example.sessionId);
            // Failure is expected (empty answers); the pass only has to emit its prompts.
            await pipeline(example.sessionId, pipelineOptions(candidate, collector));
          }
        },
        submit: async requests => {
          if (shouldStop()) throw new StopSignal();
          usage.waves++;
          const out = await submitCollected({
            backend, requests, syncCall: resyncCall,
            pollIntervalMs: config.pollIntervalMs, timeoutMs: config.batchTimeoutMs, sleep: config.sleep ?? defaultSleep, signal: config.signal, log,
          });
          for (const row of out.rows.values()) accountRow(row);
          return out.rows.values();
        },
      }));
    } catch (err) {
      if (err instanceof StopSignal) return set.map(e => failedRow(e, `Evaluation stopped (${stopReason}).`));
      if (config.signal?.aborted) { stop('aborted'); return set.map(e => failedRow(e, 'Evaluation cancelled.')); }
      if (err instanceof BatchUnusableError) {
        stop('batch_failed');
        log(`Batch evaluation failed: ${err.message}`);
        return set.map(e => failedRow(e, `Batch job failed: ${err.message}`));
      }
      throw err;
    }

    const replay = table.runner(runner, {
      collected,
      syncCall,
      // Sync fallbacks pay full price: refuse them once a cap is hit instead of overshooting.
      onSyncFallback: () => { if (shouldStop()) throw new StopSignal(); },
    });
    const outputs = await pool(set, config.concurrency ?? 4, async example => {
      const result = await pipeline(example.sessionId, pipelineOptions(candidate, replay));
      return scoreExample(example, candidate, result);
    });
    usage.syncFallbacks += table.syncFallbacks;
    usage.replayMisses += table.replayMisses;
    return outputs;
  };

  const accountRow = (row: BatchRow): void => {
    if (!row.ok) return;
    usage.calls++;
    usage.inputTokens += row.inputTokens;
    usage.outputTokens += row.outputTokens;
    if (row.costUsd !== undefined) usage.costUsd += row.costUsd;
    else usage.unpricedCalls++;
  };

  const weights = config.weights;

  return {
    get usage() { return usage; },
    get stopReason() { return stopReason; },
    stop,

    async evaluate(set, candidate, captureTraces) {
      const check = validateComponentMap(target, candidate, registry);
      let outputs: EvalOutput[];
      if (!check.ok) {
        // Reject before spending a call: an over-long or frozen-part candidate can never be saved.
        outputs = set.map(e => failedRow(e, `Candidate rejected: ${check.errors.join(' ')}`));
      } else if (shouldStop()) {
        outputs = set.map(e => failedRow(e, `Evaluation stopped (${stopReason}).`));
      } else {
        try {
          outputs = mode === 'batch' ? await evaluateBatch(set, candidate) : await evaluateSync(set, candidate);
        } catch (err) {
          // A StopSignal from a refused fallback, or anything unforeseen: zeros, never a throw (see header).
          if (!(err instanceof StopSignal)) log(`Evaluation error: ${err instanceof Error ? err.message : String(err)}`);
          outputs = set.map(e => failedRow(e, err instanceof StopSignal ? `Evaluation stopped (${stopReason}).` : 'Evaluation error.'));
        }
      }
      return {
        outputs,
        scores: outputs.map(o => scalarize(o.scores, weights)),
        scoreVectors: outputs.map(o => ({ ...o.scores })),
        trajectories: captureTraces ? outputs.map(o => ({ calls: [], output: { scores: o.scores, feedback: o.feedback }, ...(o.errorType && { error: o.errorType }) })) : null,
      };
    },

    make_reflective_dataset(_candidate, evalBatch, componentsToUpdate) {
      // One row per example, shared by every component being updated: all guidance text influences
      // the same analysis, so each reflection sees the same scored outputs with their feedback.
      const rows = evalBatch.outputs.map((o, i) => ({
        score: evalBatch.scores[i] ?? 0,
        calls: [],
        output: { sessionId: o.sessionId, scores: o.scores, feedback: o.feedback },
        ...(o.errorType && { error: o.errorType }),
      }));
      return Object.fromEntries(componentsToUpdate.map(id => [id, rows]));
    },
  };
}

class StopSignal extends Error {
  constructor() {
    super('stopped');
    this.name = 'StopSignal';
  }
}
