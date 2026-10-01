/**
 * Run request shape shared by the engine (engine.ts) and the estimate (estimate.ts).
 *
 * A request says what to optimize and how much it may spend; everything optional is filled from
 * `optimization` config by `resolveRequest`, so the dashboard form, the CLI and the estimate all
 * start from the same defaults. The student is always the production student identity and is not
 * chosen per run (engine-14); only the teacher is.
 */

import type { ClaudeInsightConfig, OptimizationModelRef } from '../types.js';
import { resolveOptimizationConfig, type ResolvedOptimizationConfig } from '../utils/config.js';
import type { EvalMode } from './adapter.js';
import { identityKey, type StudentIdentity } from './identity.js';
import type { Weights } from './metric.js';
import { batchProviderOf } from './preanalyze.js';
import { TARGETS, type AnalysisTarget } from './targets.js';

export type EngineErrorCode =
  | 'invalid_request'
  | 'no_teacher'
  | 'no_judge'
  | 'unknown_version'
  | 'overnight_unsupported'
  | 'batch_unavailable'
  | 'unpriced_batch'
  | 'insufficient_labels'
  | 'cap_too_small'
  | 'identity_mismatch';

/** A refusal the caller can show as-is: nothing was spent and (before a run row exists) nothing was written. */
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string) {
    super(message);
    this.name = 'EngineError';
  }
}

export interface RunCaps {
  /** GEPA budget; one unit per example per evaluation (counted by GEPA, not by transport calls). */
  maxMetricCalls?: number;
  /** Student tokens (input + output) the run may spend. */
  maxTokens?: number;
  /** Student USD the run may spend. Unpriced models are not counted, so pair batch runs with maxTokens. */
  maxCostUsd?: number;
}

export interface OptimizationRequest {
  /** Id of an existing queued `optimization_runs` row (the server creates it first so it can answer 202). Default: create one. */
  runId?: string;
  /** Default 'session-analysis'. Only enabled targets run. */
  target?: AnalysisTarget;
  /** The student: the production identity the prompt is tuned for. */
  identity: StudentIdentity;
  /** Reflection model. Default: `optimization.teacher` from config. */
  teacher?: OptimizationModelRef;
  /** Batch the GEPA loop's evaluations (provider:mistral / provider:openrouter only; engine-18). */
  overnight?: boolean;
  /** Start from this version's components instead of the built-in prompt; it becomes the parent of the saved version. */
  baseVersionId?: string | null;
  /** Per-field overrides of `optimization.caps`. */
  caps?: RunCaps;
  /** Objective weights; default `optimization.weights`. Drives paretoScalarize AND version selection (engine-7). */
  weights?: Weights;
  /** Reflection rounds GEPA may run. Default 20 (the budget normally stops it first). */
  numTrials?: number;
  /** Training examples per reflection minibatch. Default 3. */
  minibatchSize?: number;
  /** Rounds without improvement before GEPA stops. Default 4. */
  earlyStoppingTrials?: number;
  /** Seeds GEPA's sampling. */
  seed?: number;
}

export interface ResolvedRequest {
  runId: string | undefined;
  target: AnalysisTarget;
  identity: StudentIdentity;
  identityKey: string;
  teacher: OptimizationModelRef;
  mode: EvalMode;
  baseVersionId: string | null;
  caps: Required<Pick<RunCaps, 'maxMetricCalls'>> & Pick<RunCaps, 'maxTokens' | 'maxCostUsd'>;
  weights: Record<string, number>;
  numTrials: number;
  minibatchSize: number;
  earlyStoppingTrials: number;
  seed: number | undefined;
}

export const DEFAULT_NUM_TRIALS = 20;
export const DEFAULT_MINIBATCH_SIZE = 3;
export const DEFAULT_EARLY_STOPPING_TRIALS = 4;

/**
 * Evaluation mode for a student (engine-17/18/19). Provider students run synchronously; with
 * `overnight` and a batch-capable provider the loop is batched. Native CLI students always run
 * synchronously through the CLI, and `overnight` is refused for them.
 */
export function evalModeFor(identity: StudentIdentity, overnight = false): EvalMode {
  const providerBacked = identity.runner.startsWith('provider:');
  if (!providerBacked) {
    if (overnight) throw new EngineError('overnight_unsupported', `Overnight (batch) mode is not available for ${identity.runner}: CLI runners always run synchronously.`);
    return 'cli';
  }
  if (!overnight) return 'sync';
  if (!batchProviderOf(identity)) {
    throw new EngineError('overnight_unsupported', `Overnight (batch) mode needs provider:mistral or provider:openrouter, not ${identity.runner}.`);
  }
  return 'batch';
}

/** Validate and fill defaults. Throws EngineError; never touches the database. */
export function resolveRequest(request: OptimizationRequest, config: ClaudeInsightConfig | null | undefined): ResolvedRequest {
  const defaults: ResolvedOptimizationConfig = resolveOptimizationConfig(config);
  const target = request.target ?? 'session-analysis';
  if (!TARGETS[target]?.enabled) throw new EngineError('invalid_request', `Target "${target}" is not enabled for optimization.`);
  if (!request.identity?.runner) throw new EngineError('invalid_request', 'A student identity is required.');
  let key: string;
  try {
    key = identityKey(request.identity);
  } catch (err) {
    throw new EngineError('invalid_request', err instanceof Error ? err.message : String(err));
  }
  const teacher = request.teacher ?? defaults.teacher;
  if (!teacher) throw new EngineError('no_teacher', 'No teacher model: choose one for this run or set optimization.teacher in Settings.');

  const int = (v: number | undefined, fallback: number, name: string, min = 1): number => {
    if (v === undefined) return fallback;
    if (!Number.isInteger(v) || v < min) throw new EngineError('invalid_request', `${name} must be an integer >= ${min}.`);
    return v;
  };
  const positive = (v: number | undefined, name: string): number | undefined => {
    if (v === undefined) return undefined;
    if (!(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new EngineError('invalid_request', `${name} must be a positive number.`);
    return v;
  };
  const weights = request.weights ?? defaults.weights;
  if (!Object.values(weights).some(w => typeof w === 'number' && w > 0)) {
    throw new EngineError('invalid_request', 'At least one objective weight must be positive.');
  }
  const maxTokens = positive(request.caps?.maxTokens, 'caps.maxTokens') ?? defaults.caps.maxTokens;
  const maxCostUsd = positive(request.caps?.maxCostUsd, 'caps.maxCostUsd') ?? defaults.caps.maxCostUsd;
  return {
    runId: request.runId,
    target,
    identity: request.identity,
    identityKey: key,
    teacher,
    mode: evalModeFor(request.identity, request.overnight),
    baseVersionId: request.baseVersionId ?? null,
    caps: {
      maxMetricCalls: int(request.caps?.maxMetricCalls, defaults.caps.maxMetricCalls, 'caps.maxMetricCalls'),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    },
    weights: { ...weights } as Record<string, number>,
    numTrials: int(request.numTrials, DEFAULT_NUM_TRIALS, 'numTrials'),
    minibatchSize: int(request.minibatchSize, DEFAULT_MINIBATCH_SIZE, 'minibatchSize'),
    earlyStoppingTrials: int(request.earlyStoppingTrials, DEFAULT_EARLY_STOPPING_TRIALS, 'earlyStoppingTrials'),
    seed: request.seed,
  };
}

export const modelRefLabel = (ref: OptimizationModelRef): string => `${ref.provider}/${ref.model}`;
