/**
 * Contract with @ax-llm/ax 22.0.x (plan risk "Ax internals").
 *
 * The engine relies on behaviors that are visible in the bundle but not all in the public docs:
 *   - compile(..., { gepaAdapter }) routes every evaluation through adapter.evaluate(batch, candidate)
 *     with the candidate as a { componentId: text } map (scoring never reaches program.forward);
 *   - compile options `paretoScalarize` (untyped) is called with each example's score vector;
 *   - compile option `feedbackFn` is called with the adapter's own outputs during reflection;
 *   - `program.applyOptimization(result.optimizedProgram)` applies optimizedProgram.componentMap.
 * This test drives a real AxGEPA with a mock model and a counting adapter, so an Ax upgrade that
 * stops calling the adapter (or drops one of those hooks) fails here instead of silently scoring
 * against nothing. Pin @ax-llm/ax at 22.0.x.
 */
import { describe, it, expect } from 'vitest';
import { AxGEPA, AxMockAIService } from '@ax-llm/ax';
import { OptimizableProgram, componentId } from '../program.js';
import { adapterMetric, feedbackFn, scalarize, OBJECTIVES, type ObjectiveScores } from '../metric.js';
import type { EvalExample, EvalOutput } from '../adapter.js';

const S = 'session-analysis' as const;
const FRICTION = componentId(S, 'frictionGuidance');
const PATTERN = componentId(S, 'patternGuidance');
const IMPROVED = 'IMPROVED friction guidance';

function mockAI(onChat?: () => void) {
  return new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async () => {
      onChat?.();
      return {
        results: [{
          index: 0,
          // One reply satisfies every typed reflection signature GEPA uses (summary + new value).
          content: `Feedback Summary: guidance needs to be more specific\nNew Value: ${IMPROVED}`,
          finishReason: 'stop' as const,
        }],
        modelUsage: { ai: 'mock', model: 'mock', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      };
    },
  } as never);
}

const ex = (id: string): EvalExample => ({
  sessionId: id, outcome: 'high', frictionCategories: [], patternCategories: [], keyPoints: [`kp-${id}`], forbiddenClaims: [],
});
const vec = (x: number): ObjectiveScores => Object.fromEntries(OBJECTIVES.map(o => [o, x])) as ObjectiveScores;

describe('AxGEPA contract (@ax-llm/ax 22.0.x)', () => {
  it('routes evaluation through gepaAdapter, honors paretoScalarize and feedbackFn, and applyOptimization applies the componentMap', async () => {
    const program = new OptimizableProgram(S);
    const evaluated: Array<{ size: number; candidate: Record<string, string>; captureTraces?: boolean }> = [];
    const scalarized: Array<Record<string, number>> = [];
    const feedbackSeen: unknown[] = [];

    const adapter = {
      async evaluate(batch: readonly EvalExample[], candidate: Readonly<Record<string, string>>, captureTraces?: boolean) {
        evaluated.push({ size: batch.length, candidate: { ...candidate }, captureTraces });
        const good = candidate[FRICTION] === IMPROVED;
        const outputs: EvalOutput[] = batch.map(b => ({
          sessionId: b.sessionId,
          scores: vec(good ? 1 : 0.2),
          observed: { schemaValid: true, outcome: 'high', frictionCategories: [], patternCategories: [] },
          feedback: `fix the guidance for ${b.sessionId}`,
        }));
        return {
          outputs,
          scores: outputs.map(o => scalarize(o.scores)),
          scoreVectors: outputs.map(o => ({ ...o.scores })),
          trajectories: captureTraces ? outputs.map(o => ({ calls: [], output: { scores: o.scores } })) : null,
        };
      },
      make_reflective_dataset(_c: unknown, evalBatch: { outputs: EvalOutput[]; scores: number[] }, ids: readonly string[]) {
        const rows = evalBatch.outputs.map((o, i) => ({ score: evalBatch.scores[i], calls: [], output: { feedback: o.feedback } }));
        return Object.fromEntries(ids.map(id => [id, rows]));
      },
    };

    const optimizer = new AxGEPA({
      studentAI: mockAI() as never,
      teacherAI: mockAI() as never,
      numTrials: 3,
      minibatch: true,
      minibatchSize: 2,
      seed: 7,
    });

    const train = [ex('t1'), ex('t2'), ex('t3')];
    const validation = [ex('v1'), ex('v2')];

    const result = await optimizer.compile(
      program as never,
      train as never,
      adapterMetric as never,
      {
        validationExamples: validation,
        maxMetricCalls: 60,
        gepaAdapter: adapter,
        feedbackFn: (args: { prediction: unknown; example: unknown; componentId?: string }) => {
          const text = feedbackFn(args);
          feedbackSeen.push(args.prediction);
          return text;
        },
        // Not in the public typings (verified in the 22.0.2 bundle): called with each score vector.
        paretoScalarize: (scores: Record<string, number>) => { scalarized.push(scores); return scalarize(scores); },
      } as never,
    );

    // 1. The adapter is the evaluation path, first on the validation set with the seed candidate.
    expect(evaluated.length).toBeGreaterThan(1);
    expect(evaluated[0].size).toBe(validation.length);
    expect(evaluated[0].candidate).toEqual(program.builtInMap());
    // 2. Candidates are { componentId: text } maps over exactly the mutable components.
    for (const e of evaluated) expect(Object.keys(e.candidate).sort()).toEqual([FRICTION, PATTERN].sort());
    // 3. paretoScalarize saw score vectors keyed by our objectives.
    expect(scalarized.length).toBeGreaterThan(0);
    expect(Object.keys(scalarized[0]).sort()).toEqual([...OBJECTIVES].sort());
    // 4. feedbackFn received the adapter's own outputs (not program.forward results).
    expect(feedbackSeen.length).toBeGreaterThan(0);
    expect(feedbackSeen.every(p => typeof (p as EvalOutput).feedback === 'string')).toBe(true);
    // 5. A better candidate was proposed, accepted, and applyOptimization applies exactly the componentMap.
    expect(result.optimizedProgram).toBeTruthy();
    const map = result.optimizedProgram!.componentMap!;
    expect(map[FRICTION]).toBe(IMPROVED);
    program.applyOptimization(result.optimizedProgram as never);
    expect(program.componentMap()).toEqual({ ...program.builtInMap(), ...map });
    expect(program.componentMap()[FRICTION]).toBe(IMPROVED);
  }, 30_000);

  it('validation examples are the ones given as validationExamples (train is never reused)', async () => {
    const program = new OptimizableProgram(S);
    const seen = new Set<string>();
    const initialIds: string[] = [];
    const adapter = {
      async evaluate(batch: readonly EvalExample[], _c: unknown) {
        if (initialIds.length === 0) initialIds.push(...batch.map(b => b.sessionId));
        batch.forEach(b => seen.add(b.sessionId));
        const outputs = batch.map(b => ({ sessionId: b.sessionId, scores: vec(0.5) }));
        return { outputs, scores: outputs.map(() => 0.5), scoreVectors: outputs.map(o => ({ ...o.scores })), trajectories: null };
      },
      make_reflective_dataset: (_c: unknown, _b: unknown, ids: readonly string[]) => Object.fromEntries(ids.map(i => [i, []])),
    };
    const optimizer = new AxGEPA({ studentAI: mockAI() as never, teacherAI: mockAI() as never, numTrials: 1, minibatch: true, minibatchSize: 1, seed: 1 });
    await optimizer.compile(program as never, [ex('t1'), ex('t2')] as never, adapterMetric as never, {
      validationExamples: [ex('v1'), ex('v2')], maxMetricCalls: 30, gepaAdapter: adapter,
    } as never);
    expect(initialIds.sort()).toEqual(['v1', 'v2']);
  }, 30_000);
});
