/**
 * Typed LLM judge for the two fuzzy objectives (plan step 22; engine-4, label-11).
 *
 * One call rules on every key point and forbidden claim of a label against one analysis:
 *   keyPoints, forbiddenClaims, analysis -> covered:boolean[], violated:boolean[], rationale:string
 *
 * Results are cached by (analysis hash, rubric hash, judge model) through an injected JudgeCache.
 * The shape matches getJudgeCache/putJudgeCache in db/optimization.ts, which wires in later via
 * `dbJudgeCache`-style glue; this module never touches the database. The judge model is part of
 * the key so switching the judge never serves another model's verdicts. Scoring modules must not
 * import embeddings (static test), so matching here is the model's judgement only.
 *
 * Failures: transient errors retry per call (engine-16). A malformed or exhausted answer throws
 * JudgeError and is never cached; the adapter then scores the judged objectives 0 for that row.
 */

import { createHash } from 'node:crypto';
import { ax, type AxAIService } from '@ax-llm/ax';
import { needsJudge, type JudgeVerdict } from './metric.js';
import { retryCall, type RetryOptions } from './retry.js';

export interface JudgeInput {
  keyPoints: readonly string[];
  forbiddenClaims: readonly string[];
  /** The analysis to rule on, serialized (see analysisForJudge in adapter.ts). */
  analysis: string;
}

/** Storage seam for cached verdicts. Implemented over judge_cache by the engine. */
export interface JudgeCache {
  get(outputHash: string, keyPointsHash: string, judgeModel: string): JudgeVerdict | null;
  put(outputHash: string, keyPointsHash: string, judgeModel: string, verdict: JudgeVerdict): void;
}

/** Raw model answer before normalization. */
export interface RawVerdict {
  covered: unknown;
  violated: unknown;
  rationale: unknown;
}

export type JudgeRun = (input: JudgeInput, signal?: AbortSignal) => Promise<RawVerdict>;

export interface Judge {
  /** Identifier recorded with scores and used as the cache namespace (the judge model). */
  readonly model: string;
  judge(input: JudgeInput, signal?: AbortSignal): Promise<JudgeVerdict>;
  readonly stats: { calls: number; cacheHits: number };
}

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeError';
  }
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** JSON with sorted object keys, so equal analyses hash equally whatever their key order. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export const outputHash = (analysis: unknown): string => sha256(stableStringify(analysis));

/** Hash of the whole rubric: key points and forbidden claims are different lists, so keep them apart. */
export const keyPointsHash = (keyPoints: readonly string[], forbiddenClaims: readonly string[]): string =>
  sha256(stableStringify({ keyPoints, forbiddenClaims }));

function flags(raw: unknown, length: number, field: string): boolean[] {
  if (!Array.isArray(raw)) throw new JudgeError(`Judge returned a non-array "${field}".`);
  // The model may drop or add entries; the rubric length is authoritative.
  return Array.from({ length }, (_, i) => raw[i] === true);
}

function normalize(raw: RawVerdict, input: JudgeInput): JudgeVerdict {
  if (!raw || typeof raw.rationale !== 'string') throw new JudgeError('Judge returned no rationale.');
  return {
    covered: flags(raw.covered, input.keyPoints.length, 'covered'),
    violated: flags(raw.violated, input.forbiddenClaims.length, 'violated'),
    rationale: raw.rationale,
  };
}

export interface CreateJudgeOptions {
  model: string;
  run: JudgeRun;
  cache?: JudgeCache;
  retry?: RetryOptions;
}

export function createJudge(opts: CreateJudgeOptions): Judge {
  const stats = { calls: 0, cacheHits: 0 };
  return {
    model: opts.model,
    stats,
    async judge(input, signal) {
      // An empty rubric has nothing to rule on: no call, no cache row.
      if (!needsJudge(input)) return { covered: [], violated: [], rationale: '' };

      const oh = outputHash(input.analysis);
      const kh = keyPointsHash(input.keyPoints, input.forbiddenClaims);
      const hit = opts.cache?.get(oh, kh, opts.model);
      if (hit) {
        stats.cacheHits++;
        return hit;
      }

      stats.calls++;
      try {
        const raw = await retryCall(() => opts.run(input, signal), { ...opts.retry, signal });
        const verdict = normalize(raw, input);
        opts.cache?.put(oh, kh, opts.model, verdict);
        return verdict;
      } catch (err) {
        if (err instanceof JudgeError || signal?.aborted) throw err;
        throw new JudgeError(`Judge call failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

const JUDGE_SIGNATURE =
  'keyPoints:string[] "Facts the analysis must convey, in order", ' +
  'forbiddenClaims:string[] "Statements the analysis must not make, in order", ' +
  'analysis:string "The analysis under review (JSON)" ' +
  '-> covered:boolean[] "One flag per key point, same order: true if the analysis conveys it", ' +
  'violated:boolean[] "One flag per forbidden claim, same order: true if the analysis asserts it", ' +
  'rationale:string "One short paragraph naming each key point missed and each claim made"';

const JUDGE_INSTRUCTIONS =
  'Judge an analysis of an AI coding session against a rubric. A key point is covered when the ' +
  'analysis states it, in any wording. A forbidden claim is violated only when the analysis asserts it. ' +
  'Return exactly one flag per rubric item, in the order given.';

export interface CreateAxJudgeOptions {
  /** Judge model's service; the engine builds it from `optimization.judge`. */
  ai: AxAIService;
  /** Model id, recorded and used as the cache namespace. */
  model: string;
  cache?: JudgeCache;
  retry?: RetryOptions;
}

export function createAxJudge(opts: CreateAxJudgeOptions): Judge {
  const gen = ax(JUDGE_SIGNATURE, { description: JUDGE_INSTRUCTIONS });
  return createJudge({
    model: opts.model,
    cache: opts.cache,
    retry: opts.retry,
    run: async (input, signal) => {
      const out = await gen.forward(
        opts.ai,
        { keyPoints: [...input.keyPoints], forbiddenClaims: [...input.forbiddenClaims], analysis: input.analysis },
        signal ? { abortSignal: signal } : undefined,
      );
      return out as unknown as RawVerdict;
    },
  });
}
