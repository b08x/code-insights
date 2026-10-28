/**
 * preanalyzeSessions (plan step 17) against the REAL pipeline with fake batch backends, so the
 * collect-phase prompt hashes are proven to match the replay-phase ones.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadInput, loadResponse, seedSession } from '../../analysis/__tests__/fixtures/pipeline/harness.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../../analysis/runner-types.js';
import type { BatchBackend, BatchPollResult, BatchRequest, BatchRow } from '../../llm-batch/index.js';
import { BatchJobError } from '../../llm-batch/index.js';
import { providerIdentity, type StudentIdentity } from '../identity.js';
import type { PipelineResult } from '../../analysis/pipeline.js';

let mockDb: Database.Database;

vi.mock('../../db/client.js', () => ({ getDb: () => mockDb, closeDb: () => {} }));
vi.mock('../../utils/config.js', () => ({ loadConfig: () => null }));
vi.mock('../../embeddings/client.js', async (io) => ({ ...(await io<object>()), embedOne: async () => ({ vector: new Float32Array(4) }) }));
vi.mock('../../embeddings/store.js', async (io) => ({
  ...(await io<object>()),
  loadVectorExtension: () => {},
  querySimilarFiltered: () => [],
}));
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
const { preanalyzeSessions, chooseMode, batchProviderOf, runnerTypeFor } = await import('../preanalyze.js');

const isPQ = (text: string) => text.includes("Analyze the user's input messages");
const mistral = providerIdentity('mistral', 'mistral-small-latest');

function syncRunner() {
  const calls: RunAnalysisParams[] = [];
  const runner: AnalysisRunner = {
    name: 'mistral',
    provider: 'mistral',
    model: 'mistral-small-latest',
    maxInputTokens: 80_000,
    async runAnalysis(params): Promise<RunAnalysisResult> {
      calls.push(params);
      return {
        rawJson: isPQ(params.userPrompt) ? loadResponse('pq-ok.json') : loadResponse('analysis-ok.json'),
        durationMs: 1, inputTokens: 100, outputTokens: 50, model: 'mistral-small-latest', provider: 'mistral',
      };
    },
  };
  return { runner, calls };
}

/** Backend answering every submitted request; `tweak` can replace a row. */
function fakeBackend(tweak?: (req: BatchRequest, row: BatchRow) => BatchRow | null, pollResult?: BatchPollResult) {
  const submitted: BatchRequest[] = [];
  const backend: BatchBackend = {
    provider: 'mistral',
    model: 'mistral-small-latest',
    maxRequestsPerJob: 1000,
    submit: async (reqs) => { submitted.push(...reqs); return 'job-1'; },
    poll: async () => {
      if (pollResult) return pollResult;
      const rows: BatchRow[] = [];
      for (const req of submitted) {
        const user = req.body.messages[1].content;
        const base: BatchRow = { customId: req.customId, ok: true, content: isPQ(user) ? loadResponse('pq-ok.json') : loadResponse('analysis-ok.json'), inputTokens: 1000, outputTokens: 200, costUsd: 0.001 };
        const row = tweak ? tweak(req, base) : base;
        if (row) rows.push(row);
      }
      return { state: 'done', rows };
    },
  };
  return { backend, submitted };
}

const common = { pollIntervalMs: 1, sleep: async () => {} };

beforeEach(() => {
  mockDb = new Database(':memory:');
  runMigrations(mockDb);
});
afterEach(() => mockDb.close());

describe('mode selection', () => {
  it('batch only for provider:mistral / provider:openrouter', () => {
    expect(chooseMode(providerIdentity('mistral', 'm'))).toBe('batch');
    expect(chooseMode(providerIdentity('openrouter', 'm'))).toBe('batch');
    expect(chooseMode(providerIdentity('openai', 'm'))).toBe('queue');
    expect(chooseMode(providerIdentity('anthropic', 'm'))).toBe('queue');
    expect(chooseMode({ runner: 'claude-code-native', model: null, variant: null })).toBe('queue');
    expect(batchProviderOf({ runner: 'provider:openrouter', model: null, variant: null })).toBeNull();
  });
});

describe('preanalyzeSessions', () => {
  it('queue mode enqueues each unique id and never builds a backend', async () => {
    const enqueue = vi.fn();
    const createBackend = vi.fn();
    const out = await preanalyzeSessions(['a', 'b', 'a'], {
      identity: providerIdentity('openai', 'gpt'), runner: syncRunner().runner, enqueue, createBackend,
    });
    expect(out.mode).toBe('queue');
    expect(enqueue.mock.calls).toEqual([['a', 'provider'], ['b', 'provider']]);
    expect(out.sessions.map(s => s.status)).toEqual(['enqueued', 'enqueued']);
    expect(createBackend).not.toHaveBeenCalled();
  });

  it('batch identity without a usable backend (no key) falls back to the queue', async () => {
    const enqueue = vi.fn();
    const out = await preanalyzeSessions(['a'], { identity: mistral, runner: syncRunner().runner, enqueue, createBackend: () => null });
    expect(out.mode).toBe('queue');
    expect(enqueue).toHaveBeenCalledWith('a', 'provider');
  });

  it('batch mode: prompts go out in one job, results persist through the pipeline, cost is the discounted sum', async () => {
    const input = loadInput('prompt-quality');
    seedSession(mockDb, input);
    const { runner, calls } = syncRunner();
    const { backend, submitted } = fakeBackend();
    const enqueue = vi.fn();

    const out = await preanalyzeSessions([input.session.id], { identity: mistral, runner, enqueue, createBackend: () => backend, ...common });

    expect(out.mode).toBe('batch');
    expect(submitted).toHaveLength(2); // session + prompt quality
    expect(submitted.map(r => isPQ(r.body.messages[1].content)).sort()).toEqual([false, true]);
    expect(calls).toHaveLength(0); // nothing went through the sync transport
    expect(enqueue).not.toHaveBeenCalled();
    expect(out.sessions).toEqual([{ sessionId: input.session.id, status: 'analyzed', costUsd: 0.002 }]);
    expect(out.batch).toMatchObject({ submitted: 2, succeeded: 2, failedRows: 0, costUsd: 0.002 });

    const types = (mockDb.prepare('SELECT DISTINCT type FROM insights WHERE session_id = ?').all(input.session.id) as Array<{ type: string }>).map(r => r.type);
    expect(types).toContain('prompt_quality');
    expect(types).toContain('summary');
    const usage = mockDb.prepare('SELECT analysis_type, provider, model, input_tokens, estimated_cost_usd FROM analysis_usage WHERE session_id = ? ORDER BY analysis_type').all(input.session.id);
    expect(usage).toEqual([
      { analysis_type: 'prompt_quality', provider: 'mistral', model: 'mistral-small-latest', input_tokens: 1000, estimated_cost_usd: 0.001 },
      { analysis_type: 'session', provider: 'mistral', model: 'mistral-small-latest', input_tokens: 1000, estimated_cost_usd: 0.001 },
    ]);
    // Provenance records the configured identity.
    const prov = mockDb.prepare('SELECT DISTINCT student_identity FROM insights WHERE session_id = ?').all(input.session.id);
    expect(prov).toEqual([{ student_identity: 'provider:mistral|mistral-small-latest|' }]);
  });

  it('partial failure: the failed row is re-run synchronously and the session still completes', async () => {
    const input = loadInput('prompt-quality');
    seedSession(mockDb, input);
    const { runner, calls } = syncRunner();
    const { backend } = fakeBackend((req, row) => (isPQ(req.body.messages[1].content) ? { customId: row.customId, ok: false, error: 'boom' } : row));

    const out = await preanalyzeSessions([input.session.id], { identity: mistral, runner, enqueue: vi.fn(), createBackend: () => backend, ...common });

    expect(calls).toHaveLength(1);
    expect(isPQ(calls[0].userPrompt)).toBe(true);
    expect(out.sessions[0]).toMatchObject({ status: 'analyzed' });
    expect(out.batch).toMatchObject({ succeeded: 1, failedRows: 1, resynced: 1 });
  });

  it('a row missing from the output is re-run synchronously', async () => {
    const input = loadInput('prompt-quality');
    seedSession(mockDb, input);
    const { runner, calls } = syncRunner();
    const { backend } = fakeBackend((req, row) => (isPQ(req.body.messages[1].content) ? null : row));
    const out = await preanalyzeSessions([input.session.id], { identity: mistral, runner, enqueue: vi.fn(), createBackend: () => backend, ...common });
    expect(calls).toHaveLength(1);
    expect(out.sessions[0].status).toBe('analyzed');
  });

  it('an unparseable batch answer fails that session only, with the pipeline error type', async () => {
    const a = loadInput('prompt-quality');
    seedSession(mockDb, a);
    const { runner } = syncRunner();
    const { backend } = fakeBackend((req, row) => (row.ok && !isPQ(req.body.messages[1].content) ? { ...row, content: 'not json at all' } : row));
    const out = await preanalyzeSessions([a.session.id], { identity: mistral, runner, enqueue: vi.fn(), createBackend: () => backend, ...common });
    expect(out.sessions[0]).toMatchObject({ status: 'failed', errorType: expect.stringMatching(/json|structure/) });
  });

  it('a failed job enqueues every session instead of running them inline', async () => {
    const input = loadInput('prompt-quality');
    seedSession(mockDb, input);
    const { runner, calls } = syncRunner();
    const { backend } = fakeBackend();
    backend.poll = async () => { throw new BatchJobError('mistral', 'job-1', 'TIMEOUT_EXCEEDED', 'expired'); };
    const enqueue = vi.fn();

    const out = await preanalyzeSessions([input.session.id], { identity: mistral, runner, enqueue, createBackend: () => backend, ...common });

    expect(out.sessions).toEqual([{ sessionId: input.session.id, status: 'enqueued' }]);
    expect(out.batch?.fellBackToQueue).toMatch(/TIMEOUT_EXCEEDED/);
    expect(enqueue).toHaveBeenCalledWith(input.session.id, 'provider');
    expect(calls).toHaveLength(0);
  });

  it('unknown session ids fail individually without a batch request', async () => {
    const { runner } = syncRunner();
    const { backend, submitted } = fakeBackend();
    const out = await preanalyzeSessions(['nope'], { identity: mistral, runner, enqueue: vi.fn(), createBackend: () => backend, ...common });
    expect(submitted).toHaveLength(0);
    expect(out.sessions[0]).toMatchObject({ status: 'failed', errorType: 'session_not_found' });
  });
});

describe('review fixes', () => {
  it('queue runner type follows the identity: native/CLI never run as provider', async () => {
    expect(runnerTypeFor(providerIdentity('openai', 'gpt'))).toBe('provider');
    const native: StudentIdentity = { runner: 'claude-code-native', model: null, variant: null };
    expect(runnerTypeFor(native)).toBe('native');
    const enqueue = vi.fn();
    await preanalyzeSessions(['a'], { identity: native, runner: syncRunner().runner, enqueue });
    expect(enqueue).toHaveBeenCalledWith('a', 'native');
  });

  it.each([
    ['backend provider', (b: BatchBackend) => { (b as { provider: string }).provider = 'openrouter'; }],
    ['backend model', (b: BatchBackend) => { (b as { model: string }).model = 'other-model'; }],
  ])('throws when the %s does not match the identity', async (_n, mutate) => {
    const { backend } = fakeBackend();
    mutate(backend);
    await expect(preanalyzeSessions(['a'], { identity: mistral, runner: syncRunner().runner, enqueue: vi.fn(), createBackend: () => backend, ...common }))
      .rejects.toThrow(/do not match the configured identity/);
  });

  it('throws when the runner model does not match the identity', async () => {
    const { runner } = syncRunner();
    const wrong = { ...runner, model: 'mistral-large-latest' } as AnalysisRunner;
    await expect(preanalyzeSessions(['a'], { identity: mistral, runner: wrong, enqueue: vi.fn(), createBackend: () => fakeBackend().backend, ...common }))
      .rejects.toThrow(/do not match/);
  });

  it('failed job with partial output: delivered rows are kept, only the rest runs synchronously', async () => {
    const input = loadInput('prompt-quality');
    seedSession(mockDb, input);
    const { runner, calls } = syncRunner();
    const { backend, submitted } = fakeBackend();
    backend.poll = async () => {
      const keep = submitted.find(r => !isPQ(r.body.messages[1].content))!;
      throw new BatchJobError('mistral', 'job-1', 'TIMEOUT_EXCEEDED', 'expired', [
        { customId: keep.customId, ok: true, content: loadResponse('analysis-ok.json'), inputTokens: 1000, outputTokens: 200, costUsd: 0.001 },
      ]);
    };
    const enqueue = vi.fn();
    const out = await preanalyzeSessions([input.session.id], { identity: mistral, runner, enqueue, createBackend: () => backend, ...common });

    expect(enqueue).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1); // only the prompt-quality row
    expect(isPQ(calls[0].userPrompt)).toBe(true);
    expect(out.sessions[0]).toMatchObject({ status: 'analyzed' });
    expect(out.batch).toMatchObject({ succeeded: 1, jobFailureResyncs: 1, replayMisses: 0 });
  });

  describe('replay accounting (fake pipeline)', () => {
    /** Each session makes one call whose prompt is `promptFor(id)`; the pipeline "succeeds" with the call's cost. */
    function fakePipeline(promptFor: (id: string) => string, extraCalls: string[] = []) {
      const seen: Array<{ id: string; costUsd: number | undefined }> = [];
      const pipeline = (async (id: string, opts: { runner: AnalysisRunner; persist?: boolean }): Promise<PipelineResult> => {
        const r = await opts.runner.runAnalysis({ systemPrompt: 's', userPrompt: promptFor(id) });
        for (const extra of opts.persist === false ? [] : extraCalls) await opts.runner.runAnalysis({ systemPrompt: 's', userPrompt: extra });
        if (opts.persist !== false) seen.push({ id, costUsd: r.costUsd });
        return { success: true, sessionId: id, reports: { session: { costUsd: r.costUsd ?? 0 } } } as unknown as PipelineResult;
      }) as never;
      return { pipeline, seen };
    }
    const rowsFor = (submitted: BatchRequest[], costUsd?: number): BatchPollResult => ({
      state: 'done',
      rows: submitted.map(r => ({ customId: r.customId, ok: true, content: '{}', inputTokens: 10, outputTokens: 5, ...(costUsd !== undefined && { costUsd }) })),
    });

    it('identical prompts across sessions: one billed row, cost split per session', async () => {
      const { backend, submitted } = fakeBackend();
      backend.poll = async () => rowsFor(submitted, 0.01);
      const { pipeline, seen } = fakePipeline(() => 'shared prompt');
      const out = await preanalyzeSessions(['s1', 's2'], { identity: mistral, runner: syncRunner().runner, enqueue: vi.fn(), createBackend: () => backend, pipeline, ...common });
      expect(submitted).toHaveLength(1);
      expect(seen.map(x => x.costUsd)).toEqual([0.005, 0.005]);
      expect(out.batch?.costUsd).toBeCloseTo(0.01, 6);
    });

    it('unpriced model: costUsd stays undefined through replay (not a costed zero)', async () => {
      const { backend, submitted } = fakeBackend();
      backend.poll = async () => rowsFor(submitted); // no costUsd
      const { pipeline, seen } = fakePipeline(id => `p-${id}`);
      await preanalyzeSessions(['s1'], { identity: mistral, runner: syncRunner().runner, enqueue: vi.fn(), createBackend: () => backend, pipeline, ...common });
      expect(seen).toEqual([{ id: 's1', costUsd: undefined }]);
    });

    it('unpriced sync fallback also leaves costUsd undefined', async () => {
      const { backend, submitted } = fakeBackend();
      backend.poll = async () => rowsFor(submitted);
      const { pipeline } = fakePipeline(id => `p-${id}`, ['unforeseen']);
      const { runner } = syncRunner();
      const spy = vi.spyOn(runner, 'runAnalysis');
      await preanalyzeSessions(['s1'], { identity: mistral, runner, enqueue: vi.fn(), createBackend: () => backend, pipeline, ...common });
      expect(spy).toHaveBeenCalledTimes(1);
      const res = await spy.mock.results[0].value;
      expect(res.costUsd).toBeUndefined();
    });

    it('counts calls the collect phase did not foresee as replayMisses', async () => {
      const { backend, submitted } = fakeBackend();
      backend.poll = async () => rowsFor(submitted, 0.01);
      const { pipeline } = fakePipeline(id => `p-${id}`, ['unforeseen-1', 'unforeseen-2']);
      const { runner, calls } = syncRunner();
      const out = await preanalyzeSessions(['s1'], { identity: mistral, runner, enqueue: vi.fn(), createBackend: () => backend, pipeline, ...common });
      expect(out.batch?.replayMisses).toBe(2);
      expect(calls).toHaveLength(2);
    });
  });
});
