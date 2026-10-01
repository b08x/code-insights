/**
 * The optimization engine with a real AxGEPA, a mock teacher, a fake student and a fake judge.
 * Nothing here calls a model. See engine-fixtures.ts for the fakes.
 */
import type Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getRun, getVersion, listRounds, listSessionScores, createVersion,
} from '../../db/optimization.js';
import {
  runOptimization, estimateRun, candidateIdFor, EngineError, evalModeFor,
  type OptimizationDeps, type OptimizationEvent, type OptimizationRequest,
} from '../engine.js';
import { OptimizableProgram } from '../program.js';
import { scalarize } from '../metric.js';
import { TARGETS } from '../targets.js';
import {
  S, TEACHER, addLabel, fakeBackend, fakeJudgeFactory, fakeStudent, memoryDb, mockTeacher, nativeStudent,
  noSleep, seedLabels, student, type Splits,
} from './engine-fixtures.js';

let db: Database.Database;
let splits: Splits;

beforeEach(() => {
  db = memoryDb();
  splits = seedLabels(db);
});
afterEach(() => db.close());

function setup(over: { student?: ReturnType<typeof fakeStudent>; deps?: Partial<OptimizationDeps> } = {}) {
  const st = over.student ?? fakeStudent();
  const judge = fakeJudgeFactory();
  const teacher = mockTeacher();
  const events: OptimizationEvent[] = [];
  const deps: OptimizationDeps = {
    runner: st.runner,
    createJudge: judge.createJudge,
    teacherAI: teacher.ai,
    pipeline: st.pipeline as never,
    concurrency: 1,
    sleep: noSleep,
    retry: { baseDelayMs: 0, sleep: noSleep },
    onEvent: e => events.push(e),
    ...over.deps,
  };
  return { st, judge, teacher, events, deps };
}

const request = (over: Partial<OptimizationRequest> = {}): OptimizationRequest => ({
  identity: student,
  teacher: TEACHER,
  caps: { maxMetricCalls: 90 },
  numTrials: 6,
  minibatchSize: 2,
  seed: 7,
  ...over,
});

describe('runOptimization: a full run', () => {
  it('evaluates validation from the validation split only and never touches the test split', async () => {
    const { st, deps } = setup();
    await runOptimization(db, request(), deps);

    const seen = new Set(st.analyzed);
    for (const id of splits.test) expect(seen.has(id)).toBe(false);
    // The first evaluation is the initial validation pass over exactly the validation set.
    expect(st.analyzed.slice(0, splits.validation.length).sort()).toEqual([...splits.validation].sort());

    const rounds = listRounds(db, getOnlyRun().id);
    const seedScores = listSessionScores(db, { roundId: rounds[0].id });
    expect(seedScores.map(s => s.sessionId).sort()).toEqual([...splits.validation].sort());
    // Per-session rows only ever name train or validation sessions.
    for (const s of listSessionScores(db, { runId: rounds[0].runId })) {
      expect([...splits.train, ...splits.validation]).toContain(s.sessionId);
    }
  });

  it('saves a version equal to the selected candidate, applied from the optimized program', async () => {
    const { deps } = setup();
    const result = await runOptimization(db, request(), deps);

    expect(result.status).toBe('completed');
    expect(result.versionId).not.toBeNull();
    const version = getVersion(db, result.versionId!)!;
    expect(version.sourceRunId).toBe(result.runId);
    expect(version.parentVersionId).toBeNull();
    expect(version.judgeModel).toBe('fake-judge');
    expect(version.analysisVersion).not.toBeNull();

    // applyOptimization(componentMap) == what is stored: the candidate id (a hash of the map) matches.
    const map = Object.fromEntries(Object.entries(version.components).map(([k, v]) => [`${S}::${k}`, v as string]));
    expect(candidateIdFor(map)).toBe(result.bestCandidateId);
    const row = listRounds(db, result.runId).find(r => r.candidateId === result.bestCandidateId)!;
    expect(row.components).toEqual(map);
    expect(getRun(db, result.runId)!.bestCandidateId).toBe(result.bestCandidateId);
  });

  it('selects the validated candidate with the highest weighted score (paretoScalarize argmax)', async () => {
    for (const weights of [undefined, { friction_f1: 1 }, { pattern_f1: 3, outcome: 1 }]) {
      const fresh = setup();
      const result = await runOptimization(db, request({ weights }), fresh.deps);
      expect(result.candidates.length).toBeGreaterThan(1);
      const argmax = result.candidates.reduce((a, b) => (scalarize(b.scores, weights) > scalarize(a.scores, weights) ? b : a));
      expect(result.bestCandidateId).toBe(argmax.candidateId);
      // The seed is the weakest (it scores nothing on friction/pattern); an improved candidate won.
      expect(result.bestCandidateId).not.toBe(result.candidates[0].candidateId);
    }
  });

  it('writes one round row per candidate with lineage, per-session scores and cost accounting', async () => {
    const { deps, events } = setup();
    const result = await runOptimization(db, request(), deps);
    const rounds = listRounds(db, result.runId);

    expect(rounds.length).toBe(result.rounds);
    expect(rounds.length).toBeGreaterThan(2);
    expect(rounds.map(r => r.round)).toEqual(rounds.map((_, i) => i));
    expect(rounds[0].parentCandidateId).toBeNull();
    expect(rounds[0].accepted).toBe(true);
    const seen = new Set<string>();
    for (const r of rounds) {
      if (r.round > 0) expect(seen.has(r.parentCandidateId!)).toBe(true);
      seen.add(r.candidateId);
      expect(Object.keys(r.scores).sort()).toEqual(['faithfulness', 'friction_f1', 'keypoint_recall', 'outcome', 'pattern_f1', 'schema_valid']);
      expect(listSessionScores(db, { roundId: r.id }).length).toBeGreaterThan(0);
      expect(r.tokens).toBeGreaterThanOrEqual(0);
    }
    expect(rounds.some(r => r.accepted && r.round > 0)).toBe(true);
    // Accepted children carry validation scores, so their rationale says so.
    expect((rounds.find(r => r.accepted && r.round > 0)!.rationales as { evaluatedOn: string }).evaluatedOn).toBe('validation');

    const roundEvents = events.filter(e => e.type === 'round');
    expect(roundEvents.length).toBe(rounds.length);
    expect(events[0].type).toBe('started');
    expect(events.at(-1)!.type).toBe('finished');
  });

  it('only ever proposes mutable components: frozen parts never appear in any candidate', async () => {
    const { deps } = setup();
    const result = await runOptimization(db, request(), deps);
    const allowed = TARGETS[S].mutable.map(c => `${S}::${c.key}`).sort();
    for (const r of listRounds(db, result.runId)) expect(Object.keys(r.components).sort()).toEqual(allowed);
    expect(new OptimizableProgram().getOptimizableComponents().map(c => c.key).sort()).toEqual(allowed);
    const version = getVersion(db, result.versionId!)!;
    expect(Object.keys(version.components).sort()).toEqual(TARGETS[S].mutable.map(c => c.key).sort());
  });

  it('records labels_hash per split, the judge model and the teacher on the run row', async () => {
    const { deps } = setup();
    const result = await runOptimization(db, request(), deps);
    const run = getRun(db, result.runId)!;
    expect(Object.keys(run.labelsHash!).sort()).toEqual(['test', 'train', 'validation']);
    expect(run.judgeModel).toBe('fake-judge');
    expect(run.teacher).toBe('openai/gpt-4o');
    expect(run.mode).toBe('sync');
    expect(run.status).toBe('completed');
    expect(run.finishedAt).not.toBeNull();
    expect(run.estimate).toMatchObject({ mode: 'sync', validationLabels: 3 });
  });

  it('wires the judge cache to the database: a second identical run hits the cache', async () => {
    const first = setup();
    await runOptimization(db, request(), first.deps);
    expect(db.prepare('SELECT COUNT(*) AS n FROM judge_cache').get()).not.toEqual({ n: 0 });
    expect(first.judge.runs.length).toBeGreaterThan(0);

    const second = setup();
    await runOptimization(db, request(), second.deps);
    expect(second.judge.created[0].stats.cacheHits).toBeGreaterThan(0);
    expect(second.judge.runs.length).toBeLessThan(first.judge.runs.length);
  });

  it('seeds from a base version and records it as the parent', async () => {
    const base = createVersion(db, {
      target: S, identityKey: 'provider:mistral|mistral-small-latest|', components: { frictionGuidance: 'base friction text' },
    });
    const { st, deps } = setup();
    const result = await runOptimization(db, request({ baseVersionId: base.id }), deps);
    expect(st.calls[0].userPrompt).toContain('base friction text');
    expect(getVersion(db, result.versionId!)!.parentVersionId).toBe(base.id);
  });

  it('saves no version when nothing beat the starting prompt', async () => {
    // A student that is always bad: GOOD never helps.
    const bad = fakeStudent();
    const original = bad.pipeline;
    bad.pipeline = (id, o) => original(id, { ...o, promptOverride: { [S]: { components: {} } } });
    const { deps } = setup({ student: bad });
    const result = await runOptimization(db, request(), deps);
    expect(result.status).toBe('completed');
    expect(result.versionId).toBeNull();
    expect(result.bestCandidateId).toBe(result.candidates[0].candidateId);
  });

  it('writes rejected children as accepted = false rounds with minibatch scores and keeps no version', async () => {
    const weak = mockTeacher(n => `weaker guidance ${n}`);
    const { deps } = setup({ deps: { teacherAI: weak.ai } });
    const result = await runOptimization(db, request(), deps);
    const rounds = listRounds(db, result.runId);
    expect(rounds.length).toBeGreaterThan(1);
    expect(rounds[0].accepted).toBe(true);
    for (const r of rounds.slice(1)) {
      expect(r.accepted).toBe(false);
      expect((r.rationales as { evaluatedOn: string }).evaluatedOn).toBe('minibatch');
      expect(r.parentCandidateId).toBe(rounds[0].candidateId);
    }
    expect(result.versionId).toBeNull();
    expect(result.bestCandidateId).toBe(rounds[0].candidateId);
  });

  it('optimizes a native CLI student (cli mode)', async () => {
    const st = fakeStudent({ identity: nativeStudent });
    const { deps } = setup({ student: st });
    const result = await runOptimization(db, request({ identity: nativeStudent }), deps);
    expect(result.status).toBe('completed');
    expect(getRun(db, result.runId)!.mode).toBe('cli');
    expect(result.estimate.warnings.join(' ')).toMatch(/cannot be promoted/);
  });
});

describe('runOptimization: stops keep the best-so-far', () => {
  it('stops at a token cap, keeps the best validated candidate and reports stopReason', async () => {
    const { st, deps, teacher } = setup();
    // 1.2k tokens per call, 24k cap (above the estimated first pass, or preflight refuses): the run reaches
    // the cap after several rounds, mid-evaluation.
    const result = await runOptimization(db, request({ caps: { maxMetricCalls: 400, maxTokens: 24_000 }, numTrials: 20 }), deps);
    expect(result.stopReason).toBe('cap');
    expect(result.status).toBe('completed');
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeGreaterThanOrEqual(24_000);
    expect(result.usage.inputTokens + result.usage.outputTokens).toBeLessThan(24_000 + 2 * 1200);
    expect(result.versionId).not.toBeNull();
    const best = result.candidates.find(c => c.candidateId === result.bestCandidateId)!;
    expect(best.scalar).toBeGreaterThan(result.candidates[0].scalar);
    expect(getRun(db, result.runId)!.status).toBe('completed');
    // No student calls after the stop, and the teacher is not asked for rounds that would score zeros.
    const callsAtStop = st.calls.length;
    expect(callsAtStop).toBe(result.usage.calls);
    expect(teacher.chats()).toBeLessThan(40);
  });

  it('a cap that stops inside the first validation pass leaves no version and no candidate', async () => {
    // Real calls cost far more than estimated, so the first call alone passes the cap.
    const { deps } = setup({ student: fakeStudent({ inputTokens: 50_000 }) });
    const result = await runOptimization(db, request({ caps: { maxMetricCalls: 200, maxTokens: 24_000 } }), deps);
    expect(result.stopReason).toBe('cap');
    expect(result.versionId).toBeNull();
    expect(result.candidates).toEqual([]);
    expect(result.bestCandidateId).toBeNull();
    expect(listRounds(db, result.runId)).toHaveLength(0);
  });

  it('stops at maxMetricCalls without a stopReason (GEPA ends the run) and still saves the best', async () => {
    const { deps } = setup();
    const result = await runOptimization(db, request({ caps: { maxMetricCalls: 12 } }), deps);
    expect(result.stopReason).toBeNull();
    expect(result.status).toBe('completed');
    expect(result.usage.calls).toBeLessThanOrEqual(12 + 2);
    expect(result.rounds).toBeGreaterThanOrEqual(1);
  });

  it('cancels through the AbortSignal: status cancelled, row updated, no more student calls', async () => {
    const controller = new AbortController();
    const st = fakeStudent({ onAnalyze: n => { if (n === 8) controller.abort(); } });
    const { deps } = setup({ student: st, deps: { signal: controller.signal } });
    const result = await runOptimization(db, request({ caps: { maxMetricCalls: 200 } }), deps);
    expect(result.status).toBe('cancelled');
    expect(result.stopReason).toBe('aborted');
    expect(getRun(db, result.runId)!.status).toBe('cancelled');
    expect(getRun(db, result.runId)!.finishedAt).not.toBeNull();
    const analyzedAtAbort = st.analyzed.length;
    expect(analyzedAtAbort).toBeGreaterThanOrEqual(8);
    expect(analyzedAtAbort).toBeLessThan(12);
    // The seed was scored before the cancel and is kept.
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it('an already-aborted signal cancels before any call', async () => {
    const controller = new AbortController();
    controller.abort();
    const { st, deps } = setup({ deps: { signal: controller.signal } });
    const result = await runOptimization(db, request(), deps);
    expect(result.status).toBe('cancelled');
    expect(st.calls).toHaveLength(0);
  });

  it('a failed batch job (batch_failed) fails the run but keeps what was scored', async () => {
    let polls = 0;
    const fb = fakeBackend(() => ++polls > 1);
    const st = fakeStudent();
    const { deps } = setup({ student: st, deps: { batch: fb.backend, pollIntervalMs: 1, concurrency: 2 } });
    const result = await runOptimization(db, request({ overnight: true, caps: { maxMetricCalls: 100, maxTokens: 10_000_000 } }), deps);
    expect(result.stopReason).toBe('batch_failed');
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/provider outage/);
    expect(getRun(db, result.runId)!.status).toBe('failed');
    expect(result.candidates.length).toBeGreaterThanOrEqual(1);
  });
});

describe('runOptimization: transient errors', () => {
  it('retries a single 429 on that call; the run is not restarted', async () => {
    let failed = 0;
    const st = fakeStudent({ failCall: n => (n === 4 && failed++ === 0 ? Object.assign(new Error('rate limit exceeded'), { status: 429 }) : null) });
    const { deps } = setup({ student: st });
    const result = await runOptimization(db, request(), deps);
    expect(failed).toBe(1);
    expect(result.status).toBe('completed');
    expect(result.usage.failedExamples).toBe(0);
    // One extra transport attempt, and nothing was re-evaluated because of it.
    expect(st.calls.length).toBe(st.analyzed.length + 1);
    expect(listRounds(db, result.runId)[0].scores.schema_valid).toBe(1);
  });
});

describe('runOptimization: preflight refusals', () => {
  it('needs a teacher', async () => {
    const { deps } = setup();
    await expect(runOptimization(db, request({ teacher: undefined }), deps)).rejects.toMatchObject({ code: 'no_teacher' });
  });

  it('needs train and validation labels', async () => {
    const empty = memoryDb();
    addLabel(empty, 'only-train', 'train');
    const { deps } = setup();
    await expect(runOptimization(empty, request(), deps)).rejects.toMatchObject({ code: 'insufficient_labels' });
    empty.close();
  });

  it('refuses a runner whose identity differs from the request', async () => {
    const { deps } = setup({ student: fakeStudent({ identity: nativeStudent }) });
    await expect(runOptimization(db, request(), deps)).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it('refuses overnight mode without a batch backend, and for CLI or non-batch providers', async () => {
    const { deps } = setup();
    await expect(runOptimization(db, request({ overnight: true, caps: { maxMetricCalls: 50, maxTokens: 1e7 } }), deps)).rejects.toMatchObject({ code: 'batch_unavailable' });
    expect(() => evalModeFor(nativeStudent, true)).toThrow(/CLI runners always run synchronously/);
    expect(() => evalModeFor({ runner: 'provider:openai', model: 'gpt-4o', variant: null }, true)).toThrow(/mistral or provider:openrouter/);
    expect(evalModeFor({ runner: 'provider:openai', model: 'gpt-4o', variant: null })).toBe('sync');
    expect(evalModeFor(student, true)).toBe('batch');
  });

  it('refuses batch mode for an unpriced model unless a token cap is set', async () => {
    const fb = fakeBackend();
    const { deps } = setup({ deps: { batch: fb.backend } });
    await expect(runOptimization(db, request({ overnight: true }), deps)).rejects.toMatchObject({ code: 'unpriced_batch' });
    const ok = await runOptimization(db, request({ overnight: true, caps: { maxMetricCalls: 40, maxTokens: 10_000_000 } }), { ...deps, pollIntervalMs: 1 });
    expect(ok.status).toBe('completed');
    expect(getRun(db, ok.runId)!.mode).toBe('batch');
  });

  it('refuses a budget below the validation pass', async () => {
    const { deps } = setup();
    await expect(runOptimization(db, request({ caps: { maxMetricCalls: 2 } }), deps)).rejects.toMatchObject({ code: 'cap_too_small' });
  });

  it('refuses a token cap below the first validation pass', async () => {
    const { deps } = setup();
    await expect(runOptimization(db, request({ caps: { maxMetricCalls: 100, maxTokens: 100 } }), deps)).rejects.toMatchObject({ code: 'cap_too_small' });
  });

  it('marks a pre-created queued run failed when preflight refuses, and rejects a run that already started', async () => {
    const { createRun } = await import('../../db/optimization.js');
    const row = createRun(db, { target: S, identityKey: 'k', teacher: 't', judgeModel: 'j', mode: 'sync' });
    const { deps } = setup();
    await expect(runOptimization(db, request({ runId: row.id, caps: { maxMetricCalls: 1 } }), deps)).rejects.toBeInstanceOf(EngineError);
    expect(getRun(db, row.id)!.status).toBe('failed');
    await expect(runOptimization(db, request({ runId: row.id }), deps)).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('runs a pre-created queued row and updates it in place', async () => {
    const { createRun } = await import('../../db/optimization.js');
    const row = createRun(db, { target: S, identityKey: 'provider:mistral|mistral-small-latest|', teacher: 'openai/gpt-4o', judgeModel: 'fake-judge', mode: 'sync' });
    const { deps } = setup();
    const result = await runOptimization(db, request({ runId: row.id }), deps);
    expect(result.runId).toBe(row.id);
    expect(getRun(db, row.id)!.status).toBe('completed');
    expect(getRun(db, row.id)!.estimate).not.toBeNull();
  });
});

describe('estimateRun', () => {
  it('counts calls, tokens, waves and wall time from the labels', () => {
    const sync = estimateRun(db, request({ caps: { maxMetricCalls: 60 } }));
    expect(sync).toMatchObject({ mode: 'sync', trainLabels: 4, validationLabels: 3, maxMetricCalls: 60, waves: 0 });
    expect(sync.evaluations).toBeLessThanOrEqual(60);
    expect(sync.studentCalls).toBeGreaterThan(0);
    expect(sync.totalTokens).toBeGreaterThan(0);
    expect(sync.wallTimeSeconds).toBeGreaterThan(0);
    expect(sync.upperBound.studentCalls).toBeGreaterThanOrEqual(sync.studentCalls);
    // mistral-small-latest has no price: USD is unknown, not zero.
    expect(sync.studentCostUsd).toBeNull();
    expect(sync.costUsd).toBeNull();
    expect(sync.unpriced).toContain('mistral/mistral-small-latest');

    const batch = estimateRun(db, request({ overnight: true, caps: { maxMetricCalls: 60, maxTokens: 1e7 } }));
    expect(batch.mode).toBe('batch');
    expect(batch.waves).toBeGreaterThan(1);
    expect(batch.wallTimeSeconds).toBeGreaterThan(sync.wallTimeSeconds);

    const cli = estimateRun(db, request({ identity: nativeStudent }));
    expect(cli.mode).toBe('cli');
    expect(cli.studentCostUsd).toBe(0);
    expect(cli.warnings.join(' ')).toMatch(/quota/);
  });

  it('counts more waves and calls for sessions that exceed the input budget (chunking)', () => {
    db.prepare(`INSERT INTO messages (id, session_id, type, content, timestamp) VALUES ('m1', 'tr0', 'user', ?, '2026-01-01')`).run('x'.repeat(4 * 200_000));
    const small = estimateRun(db, request({ overnight: true, caps: { maxMetricCalls: 60, maxTokens: 1e7 } }), { maxInputTokens: 10_000_000 });
    const chunked = estimateRun(db, request({ overnight: true, caps: { maxMetricCalls: 60, maxTokens: 1e7 } }), { maxInputTokens: 80_000 });
    expect(chunked.studentCalls).toBeGreaterThan(small.studentCalls);
    expect(chunked.waves).toBeGreaterThan(small.waves);
  });

  it('prices a priced student and sums judge and teacher', () => {
    const priced = estimateRun(db, request({ identity: { runner: 'provider:openai', model: 'gpt-4o', variant: null } }), {
      judge: { provider: 'openai', model: 'gpt-4o-mini' },
    });
    expect(priced.studentCostUsd).toBeGreaterThan(0);
    expect(priced.costUsd).toBeGreaterThan(priced.studentCostUsd!);
    expect(priced.unpriced).toEqual([]);
  });

  it('applies the same validation as the run', () => {
    expect(() => estimateRun(db, request({ teacher: undefined }))).toThrow(EngineError);
    expect(() => estimateRun(db, request({ numTrials: 0 }))).toThrow(/numTrials/);
  });
});

function getOnlyRun() {
  const row = db.prepare('SELECT id FROM optimization_runs').get() as { id: string };
  return getRun(db, row.id)!;
}
