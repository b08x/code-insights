/**
 * The GEPA adapter against the REAL analysis pipeline with a fake student backend (runner / batch
 * backend) and a fake judge. Nothing here calls a model.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadInput, loadResponse, seedSession } from '../../analysis/__tests__/fixtures/pipeline/harness.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../../analysis/runner-types.js';
import type { BatchBackend, BatchRequest, BatchRow } from '../../llm-batch/index.js';
import { providerIdentity } from '../identity.js';
import type { Judge } from '../judge.js';
import type { JudgeVerdict } from '../metric.js';
import type { EvalExample } from '../adapter.js';

let mockDb: Database.Database;

vi.mock('../../db/client.js', () => ({ getDb: () => mockDb, closeDb: () => {} }));
vi.mock('../../utils/config.js', () => ({ loadConfig: () => null }));
vi.mock('../../embeddings/client.js', async (io) => ({ ...(await io<object>()), embedOne: async () => ({ vector: new Float32Array(4) }) }));
vi.mock('../../embeddings/store.js', async (io) => ({ ...(await io<object>()), loadVectorExtension: () => {}, querySimilarFiltered: () => [] }));
vi.mock('../../embeddings/analysis-pipeline.js', () => ({
  checkEmbeddingReadiness: () => ({ ready: false, status: { total: 0 } }),
  chunkAndEmbedSession: async () => ({ embedded: true }),
}));
vi.mock('child_process', () => ({
  execFile: (_c: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => {
    queueMicrotask(() => cb(new Error('not installed')));
    return { stdin: { on: () => {}, end: () => {} } };
  },
}));

const { runMigrations } = await import('../../db/schema.js');
const { createAdapter, labelToExample } = await import('../adapter.js');
const { componentId } = await import('../program.js');
const { TARGETS } = await import('../targets.js');

const isPQ = (text: string) => text.includes("Analyze the user's input messages");
const FRICTION = componentId('session-analysis', 'frictionGuidance');
const PATTERN = componentId('session-analysis', 'patternGuidance');
const builtIn = (): Record<string, string> => ({
  [FRICTION]: TARGETS['session-analysis'].mutable[0].builtIn,
  [PATTERN]: TARGETS['session-analysis'].mutable[1].builtIn,
});

const mistral = providerIdentity('mistral', 'mistral-small-latest');
const noSleep = async () => {};

interface StudentOptions { respond?: (p: RunAnalysisParams, call: number) => string | Error; maxInputTokens?: number; native?: boolean }

function student(opts: StudentOptions = {}) {
  const calls: RunAnalysisParams[] = [];
  const runner: AnalysisRunner = opts.native
    ? { name: 'claude-code-native', model: 'claude-native', async runAnalysis(p) { return respond(p); } }
    : { name: 'mistral', provider: 'mistral', model: 'mistral-small-latest', maxInputTokens: opts.maxInputTokens ?? 80_000, async runAnalysis(p) { return respond(p); } };
  async function respond(p: RunAnalysisParams): Promise<RunAnalysisResult> {
    calls.push(p);
    const answer = opts.respond?.(p, calls.length - 1);
    if (answer instanceof Error) throw answer;
    return {
      rawJson: answer ?? (isPQ(p.userPrompt) ? loadResponse('pq-ok.json') : loadResponse('analysis-ok.json')),
      durationMs: 1, inputTokens: 1000, outputTokens: 200,
      model: runner.model!, provider: opts.native ? runner.name : 'mistral',
    };
  }
  return { runner, calls };
}

function fakeJudge(verdict: (i: Parameters<Judge['judge']>[0]) => JudgeVerdict | Error = i => ({ covered: i.keyPoints.map(() => true), violated: i.forbiddenClaims.map(() => false), rationale: 'fake' })) {
  const seen: Array<Parameters<Judge['judge']>[0]> = [];
  const judge: Judge = {
    model: 'fake-judge',
    stats: { calls: 0, cacheHits: 0 },
    async judge(input) {
      seen.push(input);
      judge.stats.calls++;
      const v = verdict(input);
      if (v instanceof Error) throw v;
      return v;
    },
  };
  return { judge, seen };
}

function fakeBackend(tweak?: (req: BatchRequest, row: BatchRow) => BatchRow | null, over: Partial<BatchBackend> = {}) {
  const submitted: BatchRequest[] = [];
  const byJob = new Map<string, BatchRequest[]>();
  let jobs = 0;
  const backend: BatchBackend = {
    provider: 'mistral',
    model: 'mistral-small-latest',
    maxRequestsPerJob: 1000,
    submit: async reqs => { const id = `job-${++jobs}`; byJob.set(id, [...reqs]); submitted.push(...reqs); return id; },
    poll: async jobId => {
      const rows: BatchRow[] = [];
      // Each job returns only its own requests, like a real provider.
      for (const req of byJob.get(jobId) ?? []) {
        const user = req.body.messages[1].content;
        const base: BatchRow = { customId: req.customId, ok: true, content: isPQ(user) ? loadResponse('pq-ok.json') : loadResponse('analysis-ok.json'), inputTokens: 1000, outputTokens: 200, costUsd: 0.001 };
        const row = tweak ? tweak(req, base) : base;
        if (row) rows.push(row);
      }
      return { state: 'done', rows };
    },
    ...over,
  };
  return { backend, submitted, jobs: () => jobs };
}

const example = (sessionId: string, over: Partial<EvalExample> = {}): EvalExample => ({
  sessionId,
  outcome: 'high',
  frictionCategories: ['wrong-approach'],
  patternCategories: ['verification-workflow'],
  keyPoints: ['Relaxed the regex', 'Added tests'],
  forbiddenClaims: ['Rewrote the auth layer'],
  ...over,
});

function seed(name: 'short' | 'prompt-quality' | 'long-chunked') {
  const input = loadInput(name);
  seedSession(mockDb, input);
  return input.session.id;
}

/** The prompt-quality fixture with message ids prefixed, so it can coexist with the 'short' session. */
function seedSecond() {
  const input = loadInput('prompt-quality');
  seedSession(mockDb, { ...input, messages: input.messages.map(m => ({ ...m, id: `pq-${m.id}` })) });
  return input;
}

beforeEach(() => {
  mockDb = new Database(':memory:');
  runMigrations(mockDb);
});
afterEach(() => mockDb.close());

describe('createAdapter: backend, runner and identity must match', () => {
  const base = () => ({ identity: mistral, judge: fakeJudge().judge });

  it('rejects a runner whose identity differs from the student identity', () => {
    expect(() => createAdapter({ ...base(), mode: 'sync', runner: student().runner, identity: providerIdentity('mistral', 'other-model') })).toThrow(/does not match the student identity/);
  });

  it('rejects a batch backend for another model or provider', () => {
    const { runner } = student();
    expect(() => createAdapter({ ...base(), mode: 'batch', runner, batch: fakeBackend(undefined, { model: 'mistral-large' }).backend })).toThrow(/do not match the student identity/);
    expect(() => createAdapter({ ...base(), mode: 'batch', runner, batch: fakeBackend(undefined, { provider: 'openrouter' }).backend })).toThrow(/do not match/);
    expect(() => createAdapter({ ...base(), mode: 'batch', runner })).toThrow(/needs a batch backend/);
  });

  it('rejects a backend in a non-batch mode and a mode that does not fit the runner kind', () => {
    expect(() => createAdapter({ ...base(), mode: 'sync', runner: student().runner, batch: fakeBackend().backend })).toThrow(/batch backend was supplied/);
    expect(() => createAdapter({ ...base(), mode: 'cli', runner: student().runner })).toThrow(/native CLI runner/);
    const native = student({ native: true }).runner;
    const nativeId = { runner: 'claude-code-native', model: 'claude-native', variant: null };
    expect(() => createAdapter({ identity: nativeId, judge: fakeJudge().judge, mode: 'sync', runner: native })).toThrow(/provider-backed/);
    expect(() => createAdapter({ identity: nativeId, judge: fakeJudge().judge, mode: 'cli', runner: native })).not.toThrow();
  });

  it('only session-analysis is scored against labels', () => {
    expect(() => createAdapter({ ...base(), mode: 'sync', runner: student().runner, target: 'prompt-quality' })).toThrow(/cannot be evaluated/);
  });
});

describe('evaluate (sync)', () => {
  it('runs the real pipeline dry: one session call per example, candidate text injected, nothing persisted', async () => {
    const id = seed('prompt-quality'); // has enough human messages that a PQ pass WOULD run
    const { runner, calls } = student();
    const { judge } = fakeJudge();
    const adapter = createAdapter({ identity: mistral, runner, judge, mode: 'sync', sleep: noSleep });
    const candidate = { ...builtIn(), [FRICTION]: 'CANDIDATE-FRICTION-GUIDANCE' };

    const out = await adapter.evaluate([example(id)], candidate);

    expect(calls).toHaveLength(1); // no unscored prompt-quality call
    expect(isPQ(calls[0].userPrompt)).toBe(false);
    expect(calls[0].userPrompt).toContain('CANDIDATE-FRICTION-GUIDANCE');
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM analysis_usage').get()).toEqual({ n: 0 });
    expect(out.outputs).toHaveLength(1);
  });

  it('scores against the label with set-F1, exact outcome and the judge verdict', async () => {
    const id = seed('short');
    const { runner } = student();
    const { judge, seen } = fakeJudge(() => ({ covered: [true, false], violated: [false], rationale: 'Tests are not mentioned.' }));
    const adapter = createAdapter({ identity: mistral, runner, judge, mode: 'sync' });

    const out = await adapter.evaluate([example(id)], builtIn(), true);

    const v = out.scoreVectors![0];
    expect(v.outcome).toBe(1);
    expect(v.friction_f1).toBeCloseTo(2 / 3, 10); // wrong-approach + one extra normalized category
    expect(v.pattern_f1).toBe(1);
    expect(v.keypoint_recall).toBe(0.5);
    expect(v.faithfulness).toBe(1);
    expect(v.schema_valid).toBe(1);
    expect(out.outputs[0].feedback).toContain('Tests are not mentioned.');
    expect(out.outputs[0].feedback).toContain('key point not covered: Added tests');
    expect(out.scores[0]).toBeGreaterThan(0);
    expect(out.trajectories).toHaveLength(1);
    // The judge saw the analysis content, not the label.
    expect(seen[0].keyPoints).toEqual(['Relaxed the regex', 'Added tests']);
    expect(JSON.parse(seen[0].analysis).summary.title).toBe('Fix plus-sign email validation');
  });

  it('without captureTraces trajectories is null', async () => {
    const id = seed('short');
    const adapter = createAdapter({ identity: mistral, runner: student().runner, judge: fakeJudge().judge, mode: 'sync' });
    expect((await adapter.evaluate([example(id)], builtIn())).trajectories).toBeNull();
  });

  it('an unparseable output scores zeros on every objective and never reaches the judge (engine-3)', async () => {
    const id = seed('short');
    const { judge, seen } = fakeJudge();
    const adapter = createAdapter({ identity: mistral, runner: student({ respond: () => 'not json at all' }).runner, judge, mode: 'sync' });
    const out = await adapter.evaluate([example(id)], builtIn());
    expect(Object.values(out.scoreVectors![0]).every(x => x === 0)).toBe(true);
    expect(out.outputs[0].errorType).toBeTruthy();
    expect(seen).toHaveLength(0);
    expect(adapter.usage.failedExamples).toBe(1);
  });

  it('a judge failure zeroes only the judged objectives and says so in the feedback', async () => {
    const id = seed('short');
    const { judge } = fakeJudge(() => new Error('judge down'));
    const adapter = createAdapter({ identity: mistral, runner: student().runner, judge, mode: 'sync' });
    const out = await adapter.evaluate([example(id)], builtIn());
    const v = out.scoreVectors![0];
    expect(v.outcome).toBe(1);
    expect(v.keypoint_recall).toBe(0);
    expect(v.faithfulness).toBe(0);
    expect(out.outputs[0].feedback).toContain('judge down');
  });

  it('rejects an over-long or frozen candidate before spending any call', async () => {
    const id = seed('short');
    const { runner, calls } = student();
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'sync' });
    const max = TARGETS['session-analysis'].mutable[0].maxChars;

    const tooLong = await adapter.evaluate([example(id)], { ...builtIn(), [FRICTION]: 'x'.repeat(max + 1) });
    const frozen = await adapter.evaluate([example(id)], { ...builtIn(), 'session-analysis::outputFormat': 'ignore the schema' });

    expect(calls).toHaveLength(0);
    for (const out of [tooLong, frozen]) {
      expect(out.outputs[0].feedback).toMatch(/Candidate rejected/);
      expect(Object.values(out.scoreVectors![0]).every(x => x === 0)).toBe(true);
    }
  });

  it('retries a transient error per call: the example still scores and the other examples are not restarted (engine-16)', async () => {
    const a = seed('short');
    const input = seedSecond();
    const b = input.session.id;
    let failedOnce = false;
    const { runner, calls } = student({
      respond: (p) => {
        if (!failedOnce && p.userPrompt.includes(input.messages[0].content.slice(0, 40))) {
          failedOnce = true;
          return Object.assign(new Error('429 Too Many Requests'), { status: 429 });
        }
        return undefined as never;
      },
    });
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'sync', concurrency: 1, retry: { sleep: noSleep } });

    const out = await adapter.evaluate([example(a), example(b)], builtIn());

    expect(failedOnce).toBe(true);
    expect(out.scoreVectors!.every(v => v.schema_valid === 1)).toBe(true);
    expect(calls).toHaveLength(3); // a (1) + b failed once and succeeded (2), no restart of a
  });

  it('accounts tokens and cost and stops cleanly when a token cap is reached, without calls (engine-12)', async () => {
    const a = seed('short');
    const input = seedSecond();
    const { runner, calls } = student();
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'sync', concurrency: 1, caps: { maxTokens: 1000 } });

    const first = await adapter.evaluate([example(a), example(input.session.id)], builtIn());
    expect(calls).toHaveLength(1); // the first call (1200 tokens) exhausted the cap; the second example never ran
    expect(first.outputs[1].feedback).toMatch(/stopped \(cap\)/);
    expect(adapter.stopReason).toBe('cap');
    expect(adapter.usage.inputTokens).toBe(1000);
    expect(adapter.usage.outputTokens).toBe(200);

    const second = await adapter.evaluate([example(a)], builtIn());
    expect(calls).toHaveLength(1);
    expect(second.scores).toEqual([0]);
  });

  it('a cancelled signal stops evaluation with zeros, never an exception (GEPA would swallow it and fall back)', async () => {
    const id = seed('short');
    const ac = new AbortController();
    ac.abort(new Error('cancelled'));
    const { runner, calls } = student();
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'sync', signal: ac.signal });
    const out = await adapter.evaluate([example(id)], builtIn());
    expect(calls).toHaveLength(0);
    expect(adapter.stopReason).toBe('aborted');
    expect(out.scores).toEqual([0]);
  });

  it('cli mode runs a native runner one example at a time', async () => {
    const a = seed('short');
    const input = seedSecond();
    let inFlight = 0;
    let max = 0;
    const native = student({ native: true });
    const orig = native.runner.runAnalysis.bind(native.runner);
    native.runner.runAnalysis = async p => { inFlight++; max = Math.max(max, inFlight); await new Promise(r => setTimeout(r, 5)); try { return await orig(p); } finally { inFlight--; } };
    const adapter = createAdapter({
      identity: { runner: 'claude-code-native', model: 'claude-native', variant: null },
      runner: native.runner, judge: fakeJudge().judge, mode: 'cli',
    });
    const out = await adapter.evaluate([example(a), example(input.session.id)], builtIn());
    expect(out.outputs).toHaveLength(2);
    expect(max).toBe(1);
  });

  it('labelToExample copies the gold fields only', () => {
    expect(labelToExample({
      sessionId: 's', target: 'session-analysis', split: 'train', createdAt: 'x', updatedAt: 'y', note: 'n',
      outcome: 'low', frictionCategories: ['a'], patternCategories: ['b'], keyPoints: ['k'], forbiddenClaims: ['f'],
    })).toEqual({ sessionId: 's', outcome: 'low', frictionCategories: ['a'], patternCategories: ['b'], keyPoints: ['k'], forbiddenClaims: ['f'] });
  });

  it('make_reflective_dataset gives every component the scored rows with their feedback', async () => {
    const id = seed('short');
    const adapter = createAdapter({ identity: mistral, runner: student().runner, judge: fakeJudge(() => ({ covered: [false, false], violated: [true], rationale: 'bad' })).judge, mode: 'sync' });
    const batch = await adapter.evaluate([example(id)], builtIn(), true);
    const ds = adapter.make_reflective_dataset(builtIn(), batch, [FRICTION, PATTERN]);
    expect(Object.keys(ds)).toEqual([FRICTION, PATTERN]);
    expect(ds[FRICTION][0].output.feedback).toContain('bad');
  });
});

describe('evaluate (batch)', () => {
  it('collects every prompt, submits once, replays from the batch rows and scores like sync', async () => {
    const a = seed('short');
    const input = seedSecond();
    const { runner, calls } = student();
    const { backend, submitted, jobs } = fakeBackend();
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'batch', batch: backend, pollIntervalMs: 1, sleep: noSleep });
    const candidate = { ...builtIn(), [PATTERN]: 'CANDIDATE-PATTERN-GUIDANCE' };

    const out = await adapter.evaluate([example(a), example(input.session.id)], candidate);

    expect(jobs()).toBe(1);
    expect(submitted).toHaveLength(2); // session prompts only: no prompt-quality calls
    expect(submitted.every(r => !isPQ(r.body.messages[1].content) && r.body.messages[1].content.includes('CANDIDATE-PATTERN-GUIDANCE'))).toBe(true);
    expect(calls).toHaveLength(0); // nothing went through the sync transport
    expect(out.scoreVectors!.every(v => v.schema_valid === 1 && v.outcome === 1)).toBe(true);
    expect(adapter.usage).toMatchObject({ calls: 2, costUsd: 0.002, syncFallbacks: 0, replayMisses: 0, waves: 1 });
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
  });

  it('identical prompts are billed once (one request for the same session evaluated twice)', async () => {
    const a = seed('short');
    const { runner } = student();
    const { backend, submitted } = fakeBackend();
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'batch', batch: backend, pollIntervalMs: 1, sleep: noSleep });
    await adapter.evaluate([example(a), example(a, { keyPoints: ['other point'] })], builtIn());
    expect(submitted).toHaveLength(1);
  });

  it('chunked sessions need a second wave for the facet call; no sync fallback, no miss', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = student({ maxInputTokens: 80_000 });
    const { backend, submitted, jobs } = fakeBackend((req, row) => {
      // Chunk answers carry no facets, so the pipeline must ask for them in a later wave.
      if (req.body.messages[1].content.includes('cross-session facet aggregation')) return row;
      const parsed = JSON.parse(row.ok ? row.content : '{}');
      delete parsed.facets;
      return row.ok ? { ...row, content: JSON.stringify(parsed) } : row;
    });
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'batch', batch: backend, pollIntervalMs: 1, sleep: noSleep });

    const out = await adapter.evaluate([example(id)], builtIn());

    expect(adapter.usage.waves).toBeGreaterThanOrEqual(2);
    expect(jobs()).toBe(adapter.usage.waves);
    expect(submitted.some(r => r.body.messages[1].content.includes('cross-session facet aggregation'))).toBe(true);
    expect(calls).toHaveLength(0);
    expect(adapter.usage.syncFallbacks).toBe(0);
    expect(adapter.usage.replayMisses).toBe(0);
    expect(out.scoreVectors![0].schema_valid).toBe(1);
  });

  it('a failed row is resynced through the retrying sync transport and accounted once', async () => {
    const a = seed('short');
    const { runner, calls } = student();
    const { backend } = fakeBackend((req): BatchRow => ({ customId: req.customId, ok: false, error: 'row failed' }));
    const adapter = createAdapter({ identity: mistral, runner, judge: fakeJudge().judge, mode: 'batch', batch: backend, pollIntervalMs: 1, sleep: noSleep });
    const out = await adapter.evaluate([example(a)], builtIn());
    expect(calls).toHaveLength(1);
    expect(out.scoreVectors![0].schema_valid).toBe(1);
    expect(adapter.usage.calls).toBe(1);
  });

  it('an unusable batch job stops the adapter (batch_failed) and scores zeros instead of throwing', async () => {
    const a = seed('short');
    const { backend } = fakeBackend(undefined, { poll: async () => ({ state: 'failed', status: 'failed', message: 'provider outage' }) });
    const adapter = createAdapter({ identity: mistral, runner: student().runner, judge: fakeJudge().judge, mode: 'batch', batch: backend, pollIntervalMs: 1, sleep: noSleep });
    const out = await adapter.evaluate([example(a)], builtIn());
    expect(adapter.stopReason).toBe('batch_failed');
    expect(out.outputs[0].feedback).toContain('provider outage');
    expect(out.scores).toEqual([0]);
  });
});
