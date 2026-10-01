import { describe, it, expect } from 'vitest';
import {
  OBJECTIVES,
  DEFAULT_WEIGHTS,
  setF1,
  scoreVector,
  failedChecks,
  buildFeedback,
  scalarize,
  type LabelExpectation,
  type ObservedAnalysis,
} from '../metric.js';

const expected: LabelExpectation = {
  outcome: 'high',
  frictionCategories: ['wrong-approach', 'missing-dependency'],
  patternCategories: ['verification-workflow'],
  keyPoints: ['Relaxed the regex', 'Added tests'],
  forbiddenClaims: ['Rewrote the auth layer'],
};

const perfect: ObservedAnalysis = {
  schemaValid: true,
  outcome: 'high',
  frictionCategories: ['wrong-approach', 'missing-dependency'],
  patternCategories: ['verification-workflow'],
};

describe('setF1', () => {
  it.each([
    [[], [], 1],
    [['a'], [], 0],
    [[], ['a'], 0],
    [['a', 'b'], ['a', 'b'], 1],
    [['a', 'b'], ['a'], 2 / 3],
    [['a', 'b'], ['a', 'c'], 0.5],
    [['a', 'a', 'b'], ['b', 'a'], 1], // duplicates collapse: it is a set metric
  ])('setF1(%j, %j) = %d', (e, a, want) => {
    expect(setF1(e as string[], a as string[])).toBeCloseTo(want as number, 10);
  });
});

describe('scoreVector', () => {
  it('has exactly the six objectives', () => {
    expect([...OBJECTIVES].sort()).toEqual(['faithfulness', 'friction_f1', 'keypoint_recall', 'outcome', 'pattern_f1', 'schema_valid']);
    const v = scoreVector(expected, perfect, { covered: [true, true], violated: [false], rationale: '' });
    expect(Object.keys(v).sort()).toEqual([...OBJECTIVES].sort());
  });

  it('scores a perfect analysis as all ones', () => {
    const v = scoreVector(expected, perfect, { covered: [true, true], violated: [false], rationale: 'ok' });
    for (const o of OBJECTIVES) expect(v[o], o).toBe(1);
  });

  it('outcome is exact match', () => {
    expect(scoreVector(expected, { ...perfect, outcome: 'medium' }, null).outcome).toBe(0);
    expect(scoreVector(expected, { ...perfect, outcome: null }, null).outcome).toBe(0);
  });

  it('friction and pattern use set F1 over categories', () => {
    const v = scoreVector(expected, { ...perfect, frictionCategories: ['wrong-approach'], patternCategories: [] }, null);
    expect(v.friction_f1).toBeCloseTo(2 / 3, 10);
    expect(v.pattern_f1).toBe(0);
  });

  it('keypoint_recall = covered / key points; faithfulness = 1 - violated / forbidden', () => {
    const v = scoreVector(expected, perfect, { covered: [true, false], violated: [true], rationale: '' });
    expect(v.keypoint_recall).toBe(0.5);
    expect(v.faithfulness).toBe(0);
  });

  it('tolerates a judge verdict with the wrong array lengths (missing = not covered, not violated)', () => {
    const v = scoreVector(expected, perfect, { covered: [true], violated: [], rationale: '' });
    expect(v.keypoint_recall).toBe(0.5);
    expect(v.faithfulness).toBe(1);
  });

  it('empty key points / forbidden claims need no judge and score 1', () => {
    const bare = { ...expected, keyPoints: [], forbiddenClaims: [] };
    const v = scoreVector(bare, perfect, null);
    expect(v.keypoint_recall).toBe(1);
    expect(v.faithfulness).toBe(1);
  });

  it('missing verdict while a judged objective is required scores those objectives 0', () => {
    const v = scoreVector(expected, perfect, null);
    expect(v.keypoint_recall).toBe(0);
    expect(v.faithfulness).toBe(0);
    expect(v.outcome).toBe(1);
  });

  it('schema_valid=false short-circuits every objective to zero (engine-3), judge ignored', () => {
    const v = scoreVector(expected, { ...perfect, schemaValid: false }, { covered: [true, true], violated: [false], rationale: '' });
    for (const o of OBJECTIVES) expect(v[o], o).toBe(0);
  });

  it('clamps to [0, 1]', () => {
    const v = scoreVector(expected, perfect, { covered: [true, true, true, true], violated: [false], rationale: '' });
    expect(v.keypoint_recall).toBeLessThanOrEqual(1);
  });
});

describe('scalarize', () => {
  it('is the weight-normalized sum; the same function GEPA and version selection use', () => {
    const v = { outcome: 1, friction_f1: 0, pattern_f1: 0, keypoint_recall: 0, faithfulness: 0, schema_valid: 0 };
    const total = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(scalarize(v)).toBeCloseTo(DEFAULT_WEIGHTS.outcome / total, 10);
    expect(scalarize(v, { outcome: 1 })).toBe(1);
  });

  it('zero total weight scalarizes to 0, and unknown objectives are ignored', () => {
    expect(scalarize({ outcome: 1 }, { outcome: 0 })).toBe(0);
    expect(scalarize({ outcome: 1, bogus: 1 }, { outcome: 1 })).toBe(1);
  });
});

describe('failedChecks / buildFeedback (engine-5)', () => {
  it('lists failed deterministic checks with expected vs observed values', () => {
    const observed: ObservedAnalysis = { schemaValid: true, outcome: 'low', frictionCategories: ['wrong-approach', 'other'], patternCategories: [] };
    const checks = failedChecks(expected, observed);
    expect(checks.join('\n')).toMatch(/outcome: expected "high", got "low"/);
    expect(checks.join('\n')).toMatch(/missing friction categories: missing-dependency/);
    expect(checks.join('\n')).toMatch(/unexpected friction categories: other/);
    expect(checks.join('\n')).toMatch(/missing pattern categories: verification-workflow/);
  });

  it('reports an unparseable output as a single schema failure', () => {
    expect(failedChecks(expected, { ...perfect, schemaValid: false })).toEqual([expect.stringMatching(/did not parse/i)]);
  });

  it('a perfect analysis has no failed checks', () => {
    expect(failedChecks(expected, perfect)).toEqual([]);
  });

  it('feedback contains the judge rationale, the uncovered key points and the violated claims', () => {
    const text = buildFeedback(expected, perfect, { covered: [true, false], violated: [true], rationale: 'Never mentions the tests.' });
    expect(text).toContain('Never mentions the tests.');
    expect(text).toContain('Added tests');
    expect(text).toContain('Rewrote the auth layer');
  });

  it('feedback for a perfect analysis is undefined (nothing to learn from)', () => {
    expect(buildFeedback(expected, perfect, { covered: [true, true], violated: [false], rationale: 'fine' })).toBeUndefined();
  });
});
