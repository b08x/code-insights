/**
 * Pre-run estimate (engine-13, engine-19; plan carry-forward 2 and 3).
 *
 * `estimateRun` predicts calls, tokens, USD and wall time from the labeled sessions, the run
 * request and a few documented constants. It is deliberately a coarse planning number, not a
 * quote: GEPA's loop length depends on how often candidates are accepted, and the real prompt size
 * depends on the formatter. Two figures are returned: `expected` (assumes ACCEPT_RATE of the
 * children are accepted and the loop runs until the budget or numTrials) and `upperBound` (every
 * metric call of the budget spent), which is the one cap checks use.
 *
 * Counting rules:
 *   - `maxMetricCalls` counts one unit per example per evaluation, so it bounds *evaluations*;
 *     each evaluation costs `callsPerExample` student transport calls (1, or chunks + 1 when the
 *     session exceeds the runner's input budget).
 *   - Batch mode runs every evaluation as one or more waves (collect -> submit -> replay), each a
 *     separate provider job; wall time is waves x BATCH_WAVE_SECONDS.
 *   - A model without a price (every mistral/openrouter model today) makes `costUsd` null and is
 *     listed in `unpriced`; `checkRunCaps` then refuses batch mode unless a token cap is set.
 *
 * Reads only: labels (usable), message sizes. Writes nothing.
 */

import type Database from 'better-sqlite3';
import { listLabels } from '../db/labels.js';
import { batchPrice, listPrice } from '../llm-batch/index.js';
import type { ClaudeInsightConfig, OptimizationModelRef } from '../types.js';
import { resolveOptimizationConfig } from '../utils/config.js';
import type { EvalMode } from './adapter.js';
import { EngineError, resolveRequest, type OptimizationRequest, type ResolvedRequest } from './request.js';
import { isPromotableIdentity } from './identity.js';
import { TARGETS } from './targets.js';

// ── Documented constants (tune with real runs) ───────────────────────────────

/** System prompt + task instructions + guidance + schema: what every analysis call carries besides the transcript. */
export const PROMPT_OVERHEAD_TOKENS = 6000;
/** One analysis JSON. Matches WAVE_OUTPUT_TOKENS_GUESS in adapter.ts. */
export const OUTPUT_TOKENS_PER_CALL = 1500;
/** Student input budget when the runner does not say (provider runners use 80k). */
export const DEFAULT_MAX_INPUT_TOKENS = 80_000;
/** Share of GEPA children accepted (each acceptance costs one extra validation pass). */
export const ACCEPT_RATE = 0.3;
/** Judge call: rubric + compact analysis in, flags + rationale out. */
export const JUDGE_INPUT_TOKENS = 1200;
export const JUDGE_OUTPUT_TOKENS = 250;
/** Teacher reflection call: feedback dataset + current guidance in, new guidance out. */
export const TEACHER_INPUT_TOKENS = 4000;
export const TEACHER_OUTPUT_TOKENS = 1200;
/** Seconds per call. Sync students run `SYNC_CONCURRENCY` examples at once; CLI runs one at a time. */
export const SYNC_CALL_SECONDS = 25;
export const SYNC_CONCURRENCY = 4;
export const CLI_CALL_SECONDS = 60;
export const JUDGE_CALL_SECONDS = 8;
export const TEACHER_CALL_SECONDS = 30;
/** Typical provider batch turnaround per wave; the providers promise up to 24 h. */
export const BATCH_WAVE_SECONDS = 2 * 3600;

export interface EstimateOptions {
  /** Config for defaults (teacher, weights, caps, judge). */
  config?: ClaudeInsightConfig | null;
  /** Judge model, for pricing. Default: `optimization.judge`. */
  judge?: OptimizationModelRef | null;
  /** The student runner's input budget (`runner.maxInputTokens`); decides chunking. */
  maxInputTokens?: number;
}

export interface UpperBound {
  studentCalls: number;
  totalTokens: number;
  /** null when the student is unpriced. */
  costUsd: number | null;
}

export interface RunEstimate {
  mode: EvalMode;
  trainLabels: number;
  validationLabels: number;
  maxMetricCalls: number;
  /** Example evaluations expected (bounded by maxMetricCalls). */
  evaluations: number;
  /** GEPA reflection rounds expected. */
  rounds: number;
  /** Student transport calls. */
  studentCalls: number;
  judgeCalls: number;
  teacherCalls: number;
  /** Student tokens; the figure the token cap is compared with. */
  inputTokens: number;
  outputTokens: number;
  judgeTokens: number;
  teacherTokens: number;
  totalTokens: number;
  /** Total USD over student, judge and teacher; null when any priced party is unpriced (see `unpriced`). */
  costUsd: number | null;
  /** Student USD only (what `caps.maxCostUsd` limits); 0 for CLI students, null when unpriced. */
  studentCostUsd: number | null;
  /** Models without a price, as `provider/model`. */
  unpriced: string[];
  /** Submit/replay waves (batch mode), else 0. */
  waves: number;
  wallTimeSeconds: number;
  upperBound: UpperBound;
  warnings: string[];
}

function studentModel(identity: ResolvedRequest['identity']): { provider: string; model: string } | null {
  if (!identity.runner.startsWith('provider:') || !identity.model) return null;
  return { provider: identity.runner.slice('provider:'.length), model: identity.model };
}

const round6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

function sessionTokens(db: Database.Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(LENGTH(content) + LENGTH(COALESCE(thinking, '')) + LENGTH(COALESCE(tool_calls, '')) + LENGTH(COALESCE(tool_results, ''))), 0) AS chars
     FROM messages WHERE session_id = ?`
  ).get(sessionId) as { chars: number };
  return Math.ceil(row.chars / 4);
}

/** Pure planning math; `estimateRun` feeds it from the database. Exported for the caps tests. */
export function estimateFromSizes(input: {
  request: ResolvedRequest;
  judge: OptimizationModelRef | null;
  /** Estimated transcript tokens of every labeled session in train + validation. */
  sessionTokens: number[];
  trainLabels: number;
  validationLabels: number;
  maxInputTokens: number;
}): RunEstimate {
  const { request, judge, trainLabels, validationLabels } = input;
  const warnings: string[] = [];
  const maxCalls = request.caps.maxMetricCalls;
  const V = validationLabels;
  const M = Math.min(request.minibatchSize, Math.max(trainLabels, 1));
  const mode = request.mode;

  // Student calls per evaluated example.
  const sizes = input.sessionTokens.length > 0 ? input.sessionTokens : [0];
  const chunkBudget = input.maxInputTokens * 0.8;
  const perExample = sizes.map(t => {
    const chunked = t + PROMPT_OVERHEAD_TOKENS > input.maxInputTokens;
    const calls = chunked ? Math.ceil(t / chunkBudget) + 1 : 1;
    return { calls, inputTokens: t + PROMPT_OVERHEAD_TOKENS * calls };
  });
  const avgCalls = perExample.reduce((s, e) => s + e.calls, 0) / perExample.length;
  const avgInput = perExample.reduce((s, e) => s + e.inputTokens, 0) / perExample.length;
  const anyChunked = perExample.some(e => e.calls > 1);

  // GEPA loop: one validation pass, then per round a parent and a child minibatch, plus a
  // validation pass for each accepted child.
  const perRound = 2 * M + ACCEPT_RATE * V;
  const loopEvaluations = V + request.numTrials * perRound;
  const evaluations = Math.min(maxCalls, Math.round(loopEvaluations));
  const rounds = perRound > 0 ? Math.max(0, Math.min(request.numTrials, (evaluations - V) / perRound)) : 0;
  if (V === 0) warnings.push('No validation labels: a run cannot start.');
  else if (maxCalls < V) warnings.push(`maxMetricCalls (${maxCalls}) is below the validation set (${V}): GEPA cannot finish its first pass.`);

  const student = studentModel(request.identity);
  const priceUnit = (inTok: number, outTok: number): number | undefined =>
    student ? (mode === 'batch' ? batchPrice : listPrice)(student.provider, student.model, inTok, outTok) : 0;
  const studentCalls = (n: number) => n * avgCalls;
  const studentIn = (n: number) => n * avgInput;
  const studentOut = (n: number) => n * avgCalls * OUTPUT_TOKENS_PER_CALL;

  const inputTokens = Math.round(studentIn(evaluations));
  const outputTokens = Math.round(studentOut(evaluations));
  const judgeCalls = evaluations;
  const teacherCalls = Math.round(rounds * (TARGETS[request.target].mutable.length));
  const judgeTokens = judgeCalls * (JUDGE_INPUT_TOKENS + JUDGE_OUTPUT_TOKENS);
  const teacherTokens = teacherCalls * (TEACHER_INPUT_TOKENS + TEACHER_OUTPUT_TOKENS);

  const unpriced: string[] = [];
  const studentCost = priceUnit(inputTokens, outputTokens);
  if (student && studentCost === undefined) unpriced.push(`${student.provider}/${student.model}`);
  const judgeCost = judge ? listPrice(judge.provider, judge.model, judgeCalls * JUDGE_INPUT_TOKENS, judgeCalls * JUDGE_OUTPUT_TOKENS) : undefined;
  if (!judge) warnings.push('No judge model configured (optimization.judge): judge cost is not included and a run cannot start.');
  else if (judgeCost === undefined) unpriced.push(`${judge.provider}/${judge.model}`);
  const teacherCost = listPrice(request.teacher.provider, request.teacher.model, teacherCalls * TEACHER_INPUT_TOKENS, teacherCalls * TEACHER_OUTPUT_TOKENS);
  if (teacherCost === undefined) unpriced.push(`${request.teacher.provider}/${request.teacher.model}`);

  const costUsd = studentCost !== undefined && judgeCost !== undefined && teacherCost !== undefined
    ? round6(studentCost + judgeCost + teacherCost)
    : null;

  // Wall time.
  const evalCalls = 1 + request.numTrials * (2 + ACCEPT_RATE) * (evaluations / Math.max(loopEvaluations, 1));
  const waves = mode === 'batch' ? Math.max(1, Math.round(evalCalls * (anyChunked ? 3 : 1))) : 0;
  const judgeSeconds = (judgeCalls * JUDGE_CALL_SECONDS) / SYNC_CONCURRENCY;
  const teacherSeconds = teacherCalls * TEACHER_CALL_SECONDS;
  const studentSeconds =
    mode === 'batch' ? waves * BATCH_WAVE_SECONDS
    : mode === 'cli' ? studentCalls(evaluations) * CLI_CALL_SECONDS
    : (studentCalls(evaluations) * SYNC_CALL_SECONDS) / SYNC_CONCURRENCY;
  const wallTimeSeconds = Math.round(studentSeconds + judgeSeconds + teacherSeconds);

  if (mode === 'cli') warnings.push('CLI students run one call at a time and use your CLI subscription quota; expect a long run.');
  if (mode === 'batch') warnings.push(`Batch mode: ${waves} waves at roughly ${BATCH_WAVE_SECONDS / 3600} h each; providers allow up to 24 h per job.`);
  if (!isPromotableIdentity(request.identity)) {
    warnings.push(`${request.identity.runner} uses "${request.identity.model}", a label for the CLI's own default model: the run can be optimized but its versions cannot be promoted. Pick an explicit model in Settings.`);
  }
  if (unpriced.length > 0) warnings.push(`No price for ${unpriced.join(', ')}: USD figures are incomplete.`);

  // Upper bound: every metric call of the budget spent.
  const ubIn = studentIn(maxCalls);
  const ubOut = studentOut(maxCalls);
  const ubStudentCost = priceUnit(ubIn, ubOut);
  const upperBound: UpperBound = {
    studentCalls: Math.round(studentCalls(maxCalls)),
    totalTokens: Math.round(ubIn + ubOut),
    costUsd: ubStudentCost === undefined ? null : round6(ubStudentCost),
  };

  return {
    mode, trainLabels, validationLabels, maxMetricCalls: maxCalls, evaluations, rounds: Math.round(rounds * 10) / 10,
    studentCalls: Math.round(studentCalls(evaluations)), judgeCalls, teacherCalls,
    inputTokens, outputTokens, judgeTokens, teacherTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    studentCostUsd: studentCost === undefined ? null : round6(studentCost),
    unpriced, waves, wallTimeSeconds, upperBound, warnings,
  };
}

/** Estimate a run before it starts. Throws EngineError for an invalid request (same rules as the run itself). */
export function estimateRun(db: Database.Database, request: OptimizationRequest, opts: EstimateOptions = {}): RunEstimate {
  const resolved = resolveRequest(request, opts.config);
  const judge = opts.judge !== undefined ? opts.judge : resolveOptimizationConfig(opts.config).judge;
  const train = listLabels(db, { split: 'train', usableOnly: true });
  const validation = listLabels(db, { split: 'validation', usableOnly: true });
  return estimateFromSizes({
    request: resolved,
    judge,
    sessionTokens: [...train, ...validation].map(l => sessionTokens(db, l.sessionId)),
    trainLabels: train.length,
    validationLabels: validation.length,
    maxInputTokens: opts.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
  });
}

/**
 * Refuse a run that cannot honor its caps (engine-12, carry-forward 3). Throws EngineError:
 *   unpriced_batch   batch mode with an unpriced student and no token cap (USD cannot be enforced)
 *   cap_too_small    the budget cannot cover even the first validation pass
 * Exceeding a cap *during* the run is not an error: the adapter stops cleanly and the best-so-far
 * candidate is kept.
 */
export function checkRunCaps(estimate: RunEstimate, request: ResolvedRequest): void {
  const { caps } = request;
  if (estimate.validationLabels > 0 && caps.maxMetricCalls < estimate.validationLabels) {
    throw new EngineError(
      'cap_too_small',
      `maxMetricCalls (${caps.maxMetricCalls}) must cover the validation pass of ${estimate.validationLabels} labeled sessions.`,
    );
  }
  if (request.mode === 'batch' && estimate.studentCostUsd === null && caps.maxTokens === undefined) {
    throw new EngineError(
      'unpriced_batch',
      `Overnight (batch) mode needs a token cap for ${request.identity.runner}/${request.identity.model}: the model has no known price, so a USD cap cannot be enforced. Set caps.maxTokens.`,
    );
  }
  // The first validation pass is unavoidable: if it alone exceeds a cap the run could never score a candidate.
  const firstPass = estimate.validationLabels > 0 ? (estimate.upperBound.totalTokens * estimate.validationLabels) / caps.maxMetricCalls : 0;
  if (caps.maxTokens !== undefined && firstPass > caps.maxTokens) {
    throw new EngineError('cap_too_small', `The token cap (${caps.maxTokens}) is below the estimated cost of the first validation pass (~${Math.round(firstPass)} tokens).`);
  }
  if (caps.maxCostUsd !== undefined && estimate.upperBound.costUsd !== null) {
    const firstPassCost = (estimate.upperBound.costUsd * estimate.validationLabels) / caps.maxMetricCalls;
    if (firstPassCost > caps.maxCostUsd) {
      throw new EngineError('cap_too_small', `The USD cap ($${caps.maxCostUsd}) is below the estimated cost of the first validation pass (~$${firstPassCost.toFixed(4)}).`);
    }
  }
}
