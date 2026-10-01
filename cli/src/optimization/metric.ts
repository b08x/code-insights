/**
 * GEPA scoring (plan step 22; engine-1, 3, 5, 6, 7).
 *
 * Six objectives, all in [0, 1], scored against an output-independent gold label:
 *   outcome          exact match of the facet outcome
 *   friction_f1      set F1 over friction categories
 *   pattern_f1       set F1 over effective-pattern categories
 *   keypoint_recall  share of label key points the analysis covers (judge)
 *   faithfulness     1 - share of forbidden claims the analysis makes (judge)
 *   schema_valid     the output parsed (1) or not (0)
 *
 * An unparseable output scores 0 on every objective (engine-3): there is nothing to compare.
 * Fuzzy matching is the judge's job only; this module never matches text itself and, per label-11,
 * imports nothing from the embeddings layer. The regex heuristics of the previous metric are gone
 * (engine-6); that code survives in legacy-metric.ts until step 27 deletes it.
 *
 * `scalarize` is the single weighted collapse. The engine passes it to GEPA as `paretoScalarize`
 * and uses it again to pick the saved version, so the version that is saved is the version GEPA
 * selected (engine-7).
 */

export const OBJECTIVES = [
  'outcome',
  'friction_f1',
  'pattern_f1',
  'keypoint_recall',
  'faithfulness',
  'schema_valid',
] as const;

export type Objective = (typeof OBJECTIVES)[number];
export type ObjectiveScores = Record<Objective, number>;
export type Weights = Partial<Record<string, number>>;

/** Starting weights; `optimization.weights` in config overrides them (engine run settings). */
export const DEFAULT_WEIGHTS: Readonly<Record<Objective, number>> = {
  outcome: 0.2,
  friction_f1: 0.2,
  pattern_f1: 0.15,
  keypoint_recall: 0.2,
  faithfulness: 0.15,
  schema_valid: 0.1,
};

/** The gold label fields the metric reads. Structurally a subset of SessionLabel. */
export interface LabelExpectation {
  outcome: string;
  frictionCategories: readonly string[];
  patternCategories: readonly string[];
  keyPoints: readonly string[];
  forbiddenClaims: readonly string[];
}

/** What the pipeline produced, reduced to the fields scoring needs (categories already normalized). */
export interface ObservedAnalysis {
  /** The pass parsed and validated. False = unparseable output. */
  schemaValid: boolean;
  outcome: string | null;
  frictionCategories: readonly string[];
  patternCategories: readonly string[];
}

/** The typed judge's answer: one flag per key point and per forbidden claim. */
export interface JudgeVerdict {
  covered: boolean[];
  violated: boolean[];
  rationale: string;
}

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/** Set F1. Two empty sets agree perfectly (1); exactly one empty set is a total miss (0). */
export function setF1(expected: readonly string[], actual: readonly string[]): number {
  const e = new Set(expected);
  const a = new Set(actual);
  if (e.size === 0 && a.size === 0) return 1;
  if (e.size === 0 || a.size === 0) return 0;
  let hits = 0;
  for (const x of a) if (e.has(x)) hits++;
  if (hits === 0) return 0;
  const precision = hits / a.size;
  const recall = hits / e.size;
  return (2 * precision * recall) / (precision + recall);
}

/** True when the label has anything the judge must rule on. */
export function needsJudge(expected: Pick<LabelExpectation, 'keyPoints' | 'forbiddenClaims'>): boolean {
  return expected.keyPoints.length > 0 || expected.forbiddenClaims.length > 0;
}

const ZEROS = (): ObjectiveScores => ({ outcome: 0, friction_f1: 0, pattern_f1: 0, keypoint_recall: 0, faithfulness: 0, schema_valid: 0 });

/** Count `true` among the first `n` flags; a missing flag is `false`. */
const countFirst = (flags: readonly boolean[], n: number): number => {
  let c = 0;
  for (let i = 0; i < n; i++) if (flags[i] === true) c++;
  return c;
};

export function scoreVector(
  expected: LabelExpectation,
  observed: ObservedAnalysis,
  verdict: JudgeVerdict | null,
): ObjectiveScores {
  if (!observed.schemaValid) return ZEROS();

  const kp = expected.keyPoints.length;
  const fc = expected.forbiddenClaims.length;
  // No verdict while one is required means the judge failed: score those objectives 0 rather than
  // pretend the analysis is perfect.
  const keypointRecall = kp === 0 ? 1 : verdict ? countFirst(verdict.covered, kp) / kp : 0;
  const faithfulness = fc === 0 ? 1 : verdict ? 1 - countFirst(verdict.violated, fc) / fc : 0;

  return {
    outcome: observed.outcome !== null && observed.outcome === expected.outcome ? 1 : 0,
    friction_f1: clamp01(setF1(expected.frictionCategories, observed.frictionCategories)),
    pattern_f1: clamp01(setF1(expected.patternCategories, observed.patternCategories)),
    keypoint_recall: clamp01(keypointRecall),
    faithfulness: clamp01(faithfulness),
    schema_valid: 1,
  };
}

/** Weight-normalized sum. Objectives without a weight are ignored; zero total weight gives 0. */
export function scalarize(scores: Readonly<Record<string, number>>, weights: Weights = DEFAULT_WEIGHTS): number {
  let total = 0;
  let sum = 0;
  for (const [key, weight] of Object.entries(weights)) {
    if (typeof weight !== 'number' || !(weight > 0)) continue;
    total += weight;
    sum += weight * (scores[key] ?? 0);
  }
  return total > 0 ? sum / total : 0;
}

const diff = (a: readonly string[], b: readonly string[]): string[] => {
  const s = new Set(b);
  return [...new Set(a)].filter(x => !s.has(x));
};

/** Deterministic checks the analysis failed, phrased for the reflection prompt. */
export function failedChecks(expected: LabelExpectation, observed: ObservedAnalysis): string[] {
  if (!observed.schemaValid) return ['The output did not parse as a valid analysis (schema_valid = 0, every objective scored 0).'];
  const out: string[] = [];
  if (observed.outcome !== expected.outcome) {
    out.push(`outcome: expected "${expected.outcome}", got "${observed.outcome ?? 'none'}"`);
  }
  const list = (label: string, want: readonly string[], got: readonly string[]) => {
    const missing = diff(want, got);
    const extra = diff(got, want);
    if (missing.length) out.push(`missing ${label} categories: ${missing.join(', ')}`);
    if (extra.length) out.push(`unexpected ${label} categories: ${extra.join(', ')}`);
  };
  list('friction', expected.frictionCategories, observed.frictionCategories);
  list('pattern', expected.patternCategories, observed.patternCategories);
  return out;
}

/**
 * feedbackFn text for one example (engine-5): failed deterministic checks, the key points the
 * judge found uncovered, the forbidden claims it found made, and its rationale. Undefined when
 * nothing went wrong, so GEPA's reflection only sees informative rows.
 */
export function buildFeedback(
  expected: LabelExpectation,
  observed: ObservedAnalysis,
  verdict: JudgeVerdict | null,
): string | undefined {
  const lines = failedChecks(expected, observed);
  if (observed.schemaValid && verdict) {
    expected.keyPoints.forEach((kp, i) => { if (verdict.covered[i] !== true) lines.push(`key point not covered: ${kp}`); });
    expected.forbiddenClaims.forEach((fcl, i) => { if (verdict.violated[i] === true) lines.push(`forbidden claim made: ${fcl}`); });
    if (lines.length > 0 && verdict.rationale.trim()) lines.push(`judge rationale: ${verdict.rationale.trim()}`);
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

// ── GEPA glue ────────────────────────────────────────────────────────────────

/** What the adapter returns per example (GEPA's "prediction"); the glue below reads only these. */
export interface ScoredOutput {
  scores: ObjectiveScores;
  /** failedChecks + judge rationale for this example (engine-5). */
  feedback?: string;
}

/**
 * The `metric` argument of AxGEPA.compile. With an adapter GEPA scores through the adapter, but it
 * still calls the metric on adapter outputs when it re-scores a reflection minibatch, so this
 * returns the vector the adapter already computed (never an LLM call).
 */
export function adapterMetric({ prediction }: { prediction: unknown }): Record<string, number> {
  const scores = (prediction as Partial<ScoredOutput> | null | undefined)?.scores;
  return scores ? { ...scores } : { ...ZEROS() };
}

/** The `feedbackFn` option of AxGEPA.compile: rationale + failed checks, per example row (engine-5). */
export function feedbackFn({ prediction }: { prediction: unknown }): string | undefined {
  return (prediction as Partial<ScoredOutput> | null | undefined)?.feedback;
}
