/**
 * Unit tests for analyzeSessionPipeline (Phase 1, step 6c).
 *
 * The end-to-end prompt/persistence goldens live in pipeline-characterization.test.ts; these
 * tests pin the pipeline's own contract: runner-metadata-driven behavior (chunking budget,
 * Anthropic content blocks, cost), the failure/skip result shapes, and persistence side effects.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadInput, loadResponse, seedSession } from './fixtures/pipeline/harness.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../runner-types.js';

let mockDb: Database.Database;
let architecture = '';

// Embedding-side stubs (recorded so tests can assert what was — and was not — touched).
const emb = vi.hoisted(() => ({
  related: [] as Array<{ id: string; distance: number }>,
  queries: [] as Array<{ topK: number }>,
  retrieved: null as null | string,
  retrievalCalls: 0,
  embedCalls: 0,
}));

vi.mock('../../db/client.js', () => ({ getDb: () => mockDb, closeDb: () => {} }));
vi.mock('../../utils/config.js', () => ({ loadConfig: () => null }));
vi.mock('../../embeddings/client.js', async (io) => ({
  ...(await io<object>()),
  embedOne: async () => ({ vector: new Float32Array(4) }),
}));
vi.mock('../../embeddings/store.js', async (io) => ({
  ...(await io<object>()),
  loadVectorExtension: () => {},
  querySimilarFiltered: (_db: unknown, _e: string, _v: unknown, topK: number) => {
    emb.queries.push({ topK });
    return emb.related;
  },
}));
vi.mock('../../embeddings/retrieval.js', async (io) => ({
  ...(await io<object>()),
  retrieveAnalysisChunks: async () => {
    emb.retrievalCalls++;
    return { usedRetrieval: emb.retrieved !== null, augmentedChunks: emb.retrieved ?? '', positionTags: [], estimatedTokens: 1, chunkCount: 1 };
  },
}));
vi.mock('../../embeddings/analysis-pipeline.js', () => ({
  checkEmbeddingReadiness: () => ({ ready: false, status: { total: 0 } }),
  chunkAndEmbedSession: async () => {
    emb.embedCalls++;
    return { embedded: true };
  },
}));
vi.mock('child_process', () => ({
  execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, out?: string) => void) => {
    queueMicrotask(() => (architecture ? cb(null, architecture) : cb(new Error('not installed'))));
    return { stdin: { on: () => {}, end: () => {} } };
  },
}));

const { runMigrations } = await import('../../db/schema.js');
const { analyzeSessionPipeline, chunkMessages, mergeAnalysisResponses } = await import('../pipeline.js');

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 10 };

interface RunnerOptions {
  provider?: string;
  maxInputTokens?: number;
  respond?: (params: RunAnalysisParams, call: number) => string | Error;
  timeoutMs?: number;
  costUsd?: number;
  delayMs?: number;
}

let inFlight = 0;
let maxInFlight = 0;

/** Sleep that rejects with the signal's reason when aborted (like fetch). */
function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });
}

/** Stub runner that records calls and answers by prompt kind (or via `respond`). */
function makeRunner(opts: RunnerOptions = {}) {
  const calls: RunAnalysisParams[] = [];
  const runner: AnalysisRunner = {
    name: 'stub',
    ...(opts.provider && { provider: opts.provider, model: 'claude-sonnet-4-20250514' }),
    ...(opts.maxInputTokens !== undefined && { maxInputTokens: opts.maxInputTokens }),
    ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
    async runAnalysis(params) {
      calls.push(params);
      const callIndex = calls.length - 1;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.delayMs) await waitAbortable(opts.delayMs, params.signal);
      } finally {
        inFlight--;
      }
      const answer = opts.respond?.(params, callIndex);
      if (answer instanceof Error) throw answer;
      const rawJson = answer
        ?? (params.userPrompt.includes("Analyze the user's input messages")
          ? loadResponse('pq-ok.json')
          : loadResponse('analysis-ok.json'));
      const result: RunAnalysisResult = {
        rawJson, durationMs: 5, ...USAGE,
        model: opts.provider ? 'claude-sonnet-4-20250514' : 'native-model',
        provider: opts.provider ?? 'native',
        ...(opts.costUsd !== undefined && { costUsd: opts.costUsd }),
      };
      return result;
    },
  };
  return { runner, calls };
}

function seed(name: 'short' | 'prompt-quality' | 'long-chunked', keep?: (n: number) => number) {
  const input = loadInput(name);
  const effective = keep ? { ...input, messages: input.messages.slice(0, keep(input.messages.length)) } : input;
  seedSession(mockDb, effective);
  return input.session.id;
}

/** Push a seeded session past the ~102k-token retrieval threshold. */
function padPastRetrievalThreshold(): void {
  mockDb.prepare("UPDATE messages SET content = content || ? WHERE id = 'g0'").run('y'.repeat(200_000));
}

beforeEach(() => {
  mockDb = new Database(':memory:');
  runMigrations(mockDb);
  architecture = '';
  emb.related = []; emb.queries = []; emb.retrieved = null; emb.retrievalCalls = 0; emb.embedCalls = 0;
  inFlight = 0; maxInFlight = 0;
});
afterEach(() => mockDb.close());

describe('analyzeSessionPipeline — persistence and usage', () => {
  it('runs both passes, persists rows, writes title, records usage with session_message_count', async () => {
    const id = seed('short');
    const { runner, calls } = makeRunner();
    const result = await analyzeSessionPipeline(id, { runner });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.passes).toEqual(['session', 'prompt_quality']);
    expect(calls).toHaveLength(2);
    // jsonSchema still reaches native runners (--json-schema).
    expect(Object.keys(calls[0].jsonSchema ?? {})).not.toHaveLength(0);
    expect(Object.keys(calls[1].jsonSchema ?? {})).not.toHaveLength(0);

    const types = (mockDb.prepare("SELECT DISTINCT type FROM insights WHERE session_id = ?").all(id) as Array<{ type: string }>).map(r => r.type);
    expect(types).toContain('prompt_quality');
    expect(types).toContain('summary');
    expect(mockDb.prepare('SELECT generated_title FROM sessions WHERE id = ?').get(id))
      .toEqual({ generated_title: 'Fix plus-sign email validation' });
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM session_facets WHERE session_id = ?').get(id)).toEqual({ n: 1 });

    const usage = mockDb.prepare(
      'SELECT analysis_type, provider, input_tokens, estimated_cost_usd, chunk_count, session_message_count FROM analysis_usage WHERE session_id = ? ORDER BY analysis_type',
    ).all(id);
    expect(usage).toEqual([
      { analysis_type: 'prompt_quality', provider: 'native', input_tokens: 1000, estimated_cost_usd: 0, chunk_count: 1, session_message_count: 6 },
      { analysis_type: 'session', provider: 'native', input_tokens: 1000, estimated_cost_usd: 0, chunk_count: 1, session_message_count: 6 },
    ]);
    expect(result.usage).toEqual({ inputTokens: 2000, outputTokens: 400, cacheCreationTokens: 100, cacheReadTokens: 20 });
  });

  it('prices calls from the runner provider/model; native runners cost 0', async () => {
    const id = seed('short');
    const { runner } = makeRunner({ provider: 'anthropic' });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result.success).toBe(true);
    const row = mockDb.prepare("SELECT estimated_cost_usd FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'").get(id) as { estimated_cost_usd: number };
    expect(row.estimated_cost_usd).toBeGreaterThan(0);
  });

  it('uses caller-supplied rows without reading messages from the DB', async () => {
    const id = seed('short');
    const input = loadInput('short');
    mockDb.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
    const { runner, calls } = makeRunner();
    const result = await analyzeSessionPipeline(id, {
      runner,
      passes: ['session'],
      input: { session: input.session, messages: input.messages },
    });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('built-in prompt: promptVersionId null; identity echoed', async () => {
    const id = seed('short');
    const { runner } = makeRunner();
    const identity = { runner: 'stub', model: null, variant: null };
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'], identity });
    expect(result.success && result.identity).toEqual(identity);
    expect(result.success && result.promptVersionId).toBeNull();
  });

  it('promptOverride injects guidance components and reports its version id', async () => {
    const id = seed('short');
    const { runner, calls } = makeRunner();
    const baseline = makeRunner();
    await analyzeSessionPipeline(id, { runner: baseline.runner, passes: ['session'] });
    const result = await analyzeSessionPipeline(id, {
      runner, passes: ['session'],
      promptOverride: { components: { frictionGuidance: 'CUSTOM-FRICTION-GUIDANCE' }, versionId: 'v7' },
    });
    expect(calls[0].userPrompt).toContain('CUSTOM-FRICTION-GUIDANCE');
    expect(baseline.calls[0].userPrompt).not.toContain('CUSTOM-FRICTION-GUIDANCE');
    expect(result.success && result.promptVersionId).toBe('v7');
  });
});

describe('analyzeSessionPipeline — persist and contexts', () => {
  it('persist:false writes nothing (insights, facets, steps, title, usage, embeddings) but still returns the result', async () => {
    const id = seed('short');
    const { runner } = makeRunner();
    const result = await analyzeSessionPipeline(id, { runner, persist: false });
    expect(result.success && result.insights.length).toBeGreaterThan(0);
    for (const table of ['insights', 'session_facets', 'session_steps', 'analysis_usage']) {
      expect(mockDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(mockDb.prepare('SELECT generated_title FROM sessions WHERE id = ?').get(id)).toEqual({ generated_title: null });
  });

  it('persist:false never embeds, even for a huge budget-less conversation', async () => {
    const id = seed('long-chunked');
    padPastRetrievalThreshold();
    emb.retrieved = 'RETRIEVED-SEGMENTS';
    const { runner } = makeRunner();
    await analyzeSessionPipeline(id, { runner, passes: ['session'], persist: false });
    expect(emb.embedCalls).toBe(0);
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(emb.embedCalls).toBe(1);
  });

  it("contexts:'none' disables architecture and related insights", async () => {
    const id = seed('short');
    architecture = 'modules: a';
    mockDb.exec('CREATE TABLE vec_insights (x INTEGER)');
    emb.related = [{ id: 'nope', distance: 0.1 }];
    const live = makeRunner();
    const none = makeRunner();
    await analyzeSessionPipeline(id, { runner: live.runner, passes: ['session'] });
    await analyzeSessionPipeline(id, { runner: none.runner, passes: ['session'], contexts: 'none' });
    expect(live.calls[0].userPrompt).toContain('<project_architecture>');
    expect(none.calls[0].userPrompt).not.toContain('<project_architecture>');
    expect(emb.queries).toHaveLength(1); // only the live run queried related insights
  });
});

describe('analyzeSessionPipeline — related insights', () => {
  it("excludes the session's own rows and over-fetches so topK still fills", async () => {
    const id = seed('short');
    mockDb.exec('CREATE TABLE vec_insights (x INTEGER)');
    const projectId = loadInput('short').session.project_id;
    mockDb.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count, source_tool)
                    VALUES ('old', ?, 'p', '/p', '2025-01-01T00:00:00Z', '2025-01-01T01:00:00Z', 2, 'claude-code')`).run(projectId);
    const ins = mockDb.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, timestamp)
                                VALUES (?, ?, ?, 'p', 'learning', ?, 'c', 's', 80, '2025-01-01T00:00:00Z')`);
    ins.run('own-1', id, projectId, 'OWN ROW');
    ins.run('old-1', 'old', projectId, 'OLD ROW ONE');
    ins.run('old-2', 'old', projectId, 'OLD ROW TWO');
    emb.related = [{ id: 'own-1', distance: 0.05 }, { id: 'old-1', distance: 0.1 }, { id: 'old-2', distance: 0.12 }];

    const { runner, calls } = makeRunner();
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(calls[0].userPrompt).not.toContain('OWN ROW');
    expect(calls[0].userPrompt).toContain('OLD ROW ONE');
    expect(calls[0].userPrompt).toContain('OLD ROW TWO');
    expect(emb.queries[0].topK).toBe(15); // topK 5 x over-fetch 3
  });
});

describe('analyzeSessionPipeline — prompt shape', () => {
  it('Anthropic runners get cache_control blocks only when the prompt-quality pass reuses the identical block', async () => {
    const id = seed('prompt-quality');
    const plain = makeRunner();
    const both = makeRunner({ provider: 'anthropic' });
    const sessionOnly = makeRunner({ provider: 'anthropic' });
    await analyzeSessionPipeline(id, { runner: plain.runner });
    await analyzeSessionPipeline(id, { runner: both.runner });
    await analyzeSessionPipeline(id, { runner: sessionOnly.runner, passes: ['session'] });

    expect(plain.calls[0].userContent).toBeUndefined();
    // session + prompt_quality: both calls carry the same cached block.
    for (const call of both.calls) {
      const blocks = call.userContent!;
      expect(blocks).toHaveLength(2);
      expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
      expect(blocks[1].cache_control).toBeUndefined();
      expect(blocks.map(b => b.text).join('')).toBe(call.userPrompt);
    }
    expect(both.calls[0].userContent![0].text).toBe(both.calls[1].userContent![0].text);
    expect(both.calls.map(c => c.userPrompt)).toEqual(plain.calls.map(c => c.userPrompt));
    // A single pass has nothing to reuse the cache: plain string, same text.
    expect(sessionOnly.calls[0].userContent).toBeUndefined();
    expect(sessionOnly.calls[0].userPrompt).toBe(plain.calls[0].userPrompt);
  });

  it('non-Anthropic provider runners get the plain string', async () => {
    const id = seed('short');
    const { runner, calls } = makeRunner({ provider: 'openai' });
    await analyzeSessionPipeline(id, { runner });
    expect(calls.every(c => c.userContent === undefined)).toBe(true);
  });

  it('architecture context goes into the single-call session prompt only (not prompt quality, not chunks)', async () => {
    const id = seed('prompt-quality');
    architecture = 'modules: a, b';
    const first = makeRunner();
    const a = await analyzeSessionPipeline(id, { runner: first.runner });
    expect(first.calls[0].userPrompt).toContain('<project_architecture>\nmodules: a, b\n</project_architecture>');
    expect(first.calls[1].userPrompt).not.toContain('<project_architecture>');

    const chunkedId = seed('long-chunked');
    const chunked = makeRunner({ maxInputTokens: 80_000 });
    await analyzeSessionPipeline(chunkedId, { runner: chunked.runner, passes: ['session'] });
    expect(chunked.calls.every(c => !c.userPrompt.includes('<project_architecture>'))).toBe(true);

    const second = makeRunner({ provider: 'anthropic' });
    const b = await analyzeSessionPipeline(id, { runner: second.runner });
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) expect(a.prompts.map(p => p.hash)).toEqual(b.prompts.map(p => p.hash));
  });

  it('caps architecture context at ~4k tokens with a truncation marker', async () => {
    const id = seed('short');
    architecture = 'x'.repeat(40_000);
    const { runner, calls } = makeRunner();
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(calls[0].userPrompt).toContain('[... architecture truncated ...]');
    expect(calls[0].userPrompt).not.toContain('x'.repeat(16_001));
  });

  it('injects the rage-loop signal into the session pass when detected', async () => {
    const id = seed('prompt-quality');
    const { runner, calls } = makeRunner();
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    // The fixture exercises the detector; the signal is either injected or absent, never partial.
    expect(calls[0].userPrompt.includes('<detected_signals>')).toBe(calls[0].userPrompt.includes('<rage_loop>'));
  });
});

describe('analyzeSessionPipeline — prompt-quality gate', () => {
  it('skips prompt quality (session still succeeds) with fewer than 2 genuine human messages', async () => {
    const id = seed('short', () => 2); // 1 human + 1 assistant
    const { runner, calls } = makeRunner();
    const result = await analyzeSessionPipeline(id, { runner });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.passes).toEqual(['session']);
    expect(result.skipped.prompt_quality).toMatch(/at least 2/);
    expect(calls).toHaveLength(1);
  });

  it('prompt-quality-only request returns insufficient_messages', async () => {
    const id = seed('short', () => 2);
    const { runner, calls } = makeRunner();
    const result = await analyzeSessionPipeline(id, { runner, passes: ['prompt_quality'] });
    expect(result).toMatchObject({ success: false, error_type: 'insufficient_messages', failedPass: 'prompt_quality' });
    expect(calls).toHaveLength(0);
  });
});

describe('analyzeSessionPipeline — failures are returned, not thrown', () => {
  it('unknown session', async () => {
    const { runner } = makeRunner();
    expect(await analyzeSessionPipeline('nope', { runner })).toMatchObject({ success: false, error_type: 'session_not_found' });
  });

  it('unparseable session response', async () => {
    const id = seed('short');
    const { runner } = makeRunner({ respond: () => 'not json at all' });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result).toMatchObject({ success: false, error_type: 'no_json_found', failedPass: 'session' });
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
  });

  it('prompt-quality failure after a persisted session pass reports the completed pass', async () => {
    const id = seed('prompt-quality');
    const { runner } = makeRunner({ respond: p => (p.userPrompt.includes("Analyze the user's input messages") ? 'garbage' : loadResponse('analysis-ok.json')) });
    const result = await analyzeSessionPipeline(id, { runner });
    expect(result).toMatchObject({ success: false, failedPass: 'prompt_quality', completedPasses: ['session'] });
    expect((result as { insights: unknown[] }).insights.length).toBeGreaterThan(0);
  });

  it('AbortError -> error_type abort; other runner errors -> api_error', async () => {
    const id = seed('short');
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    expect(await analyzeSessionPipeline(id, { runner: makeRunner({ respond: () => abort }).runner }))
      .toMatchObject({ success: false, error_type: 'abort' });
    expect(await analyzeSessionPipeline(id, { runner: makeRunner({ respond: () => new Error('Rate limit') }).runner }))
      .toMatchObject({ success: false, error_type: 'api_error', error: 'Rate limit' });
  });

  it('forwards the abort signal to the runner', async () => {
    const id = seed('short');
    const { runner, calls } = makeRunner();
    const controller = new AbortController();
    await analyzeSessionPipeline(id, { runner, passes: ['session'], signal: controller.signal });
    expect(calls[0].signal).toBe(controller.signal);
  });
});

describe('analyzeSessionPipeline — chunk + merge driven by runner budget', () => {
  const chunkJson = (i: number) => JSON.stringify({
    summary: { title: `Chunk ${i + 1}`, content: 'c', bullets: [] },
    decisions: [{ title: `D${i}`, situation: 's', choice: 'c', reasoning: 'r', confidence: 80 }],
    learnings: [],
    step_matrix: [{ step: `step ${i}`, turn_ref: 'User#1', driver: 'User_Decide', target: 'Target_Test', state: 'State_Success', targets: [], has_course_correction: false, ran_tests: false, used_tools: false }],
  });

  it('chunks when the prompt exceeds runner.maxInputTokens: per-chunk calls, facet pass, summed usage, chunk_count, steps saved', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = makeRunner({
      provider: 'anthropic',
      maxInputTokens: 80_000,
      respond: (p, i) => {
        if (p.userPrompt.includes('cross-session facet aggregation')) {
          // Fenced + trailing comma: only the jsonrepair fallback can read this.
          return '```json\n{"outcome_satisfaction":"high","workflow_pattern":"plan-then-implement","had_course_correction":false,"iteration_count":1,"friction_points":[],"effective_patterns":[],}\n```';
        }
        return chunkJson(i);
      },
    });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const chunkCalls = result.prompts.filter(p => p.call === 'chunk').length;
    expect(chunkCalls).toBeGreaterThan(1);
    expect(result.prompts.filter(p => p.call === 'facets')).toHaveLength(1);
    expect(calls).toHaveLength(chunkCalls + 1);
    expect(mockDb.prepare('SELECT outcome_satisfaction FROM session_facets WHERE session_id = ?').get(id)).toEqual({ outcome_satisfaction: 'high' });
    const row = mockDb.prepare("SELECT input_tokens, chunk_count FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'").get(id) as { input_tokens: number; chunk_count: number };
    expect(row.chunk_count).toBe(chunkCalls);
    expect(row.input_tokens).toBe((chunkCalls + 1) * USAGE.inputTokens);
    // Step matrices of all chunks are concatenated and saved.
    expect((mockDb.prepare('SELECT COUNT(*) AS n FROM session_steps WHERE session_id = ?').get(id) as { n: number }).n).toBe(chunkCalls);
  });

  it('runs chunk calls with bounded concurrency (3) and merges in chunk order', async () => {
    const id = seed('long-chunked');
    const { runner } = makeRunner({ maxInputTokens: 30_000, delayMs: 5, respond: (p, i) => (p.userPrompt.includes('cross-session facet') ? 'nope' : chunkJson(i)) });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(maxInFlight).toBe(3);
    expect(result.success && result.session?.summary.title).toBe('Chunk 1');
    // Round-robin merge: first decision of each chunk comes first, in chunk order.
    expect(result.success && result.session?.decisions.map(d => d.title)).toEqual(['D0', 'D1', 'D2', 'D3', 'D4'].slice(0, result.success ? result.session!.decisions.length : 0));
  });

  it('gives chunks global turn labels and keeps the first timestamp delta', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = makeRunner({ maxInputTokens: 80_000, respond: (p, i) => (p.userPrompt.includes('cross-session facet') ? 'nope' : chunkJson(i)) });
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    const chunkPrompts = calls.filter(c => !c.userPrompt.includes('cross-session facet')).map(c => c.userPrompt);
    expect(chunkPrompts.length).toBeGreaterThan(1);
    expect(chunkPrompts[0]).toContain('### User#0');
    // Chunk 2 continues the numbering (and does not restart at User#0 / Assistant#0).
    expect(chunkPrompts[1]).not.toContain('### User#0');
    expect(chunkPrompts[1]).not.toContain('### Assistant#0');
    // First message of chunk 2 carries a delta from the last message of chunk 1.
    expect(chunkPrompts[1]).toMatch(/--- CONVERSATION ---\n### (User|Assistant)#\d+ \| \+90s/);
  });

  it('never chunks a runner without a declared budget and sends the full conversation (native CLI runners)', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = makeRunner();
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].userPrompt.length).toBeGreaterThan(300_000);
  });

  it('budgeted runners never touch retrieval/embeddings, even for huge conversations', async () => {
    const id = seed('long-chunked');
    padPastRetrievalThreshold();
    emb.retrieved = 'RETRIEVED-SEGMENTS';
    const budgeted = makeRunner({ maxInputTokens: 80_000 });
    await analyzeSessionPipeline(id, { runner: budgeted.runner, passes: ['session'] });
    expect(emb.retrievalCalls).toBe(0);
    expect(emb.embedCalls).toBe(0);
    expect(budgeted.calls.every(c => !c.userPrompt.includes('RETRIEVED-SEGMENTS'))).toBe(true);
  });

  it('budget-less runners below the retrieval threshold keep the full conversation', async () => {
    const id = seed('long-chunked'); // 80k-102k tokens
    emb.retrieved = 'RETRIEVED-SEGMENTS';
    const native = makeRunner();
    await analyzeSessionPipeline(id, { runner: native.runner, passes: ['session'] });
    expect(native.calls[0].userPrompt).not.toContain('RETRIEVED-SEGMENTS');
    expect(emb.embedCalls).toBe(0);
  });

  it('above the threshold, retrieved segments replace the conversation for budget-less runners', async () => {
    const id = seed('long-chunked');
    emb.retrieved = 'RETRIEVED-SEGMENTS';
    padPastRetrievalThreshold();
    const { runner, calls } = makeRunner();
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(calls[0].userPrompt).toContain('--- CONVERSATION ---\nRETRIEVED-SEGMENTS\n--- END CONVERSATION ---');
    expect(calls[0].userPrompt.length).toBeLessThan(20_000);
  });

  it('all chunks unparseable -> json_parse_error, usage row still recorded with 0 parsed chunks', async () => {
    const id = seed('long-chunked');
    const { runner } = makeRunner({ maxInputTokens: 80_000, respond: () => 'nope' });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result).toMatchObject({ success: false, error_type: 'json_parse_error', failedPass: 'session' });
    expect((result as { usage?: { inputTokens: number } }).usage!.inputTokens).toBeGreaterThan(0);
    expect(mockDb.prepare("SELECT chunk_count, input_tokens FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'").get(id))
      .toMatchObject({ chunk_count: 0 });
  });

  it('records usage even when a single-call response fails to parse', async () => {
    const id = seed('short');
    const { runner } = makeRunner({ respond: () => 'garbage' });
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(mockDb.prepare("SELECT input_tokens FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'").get(id)).toEqual({ input_tokens: 1000 });
  });

  it('reports per-chunk progress then saving', async () => {
    const id = seed('long-chunked');
    const progress: Array<{ phase: string; currentChunk?: number }> = [];
    const { runner } = makeRunner({ maxInputTokens: 30_000 });
    await analyzeSessionPipeline(id, { runner, passes: ['session'], onProgress: p => progress.push(p) });
    expect(progress[0]).toMatchObject({ phase: 'analyzing', currentChunk: 1 });
    expect(progress.slice(0, 3).map(p => p.currentChunk)).toEqual([1, 2, 3]);
    expect(progress[progress.length - 1]).toEqual({ phase: 'saving' });
  });

  it('prompt quality: head+tail truncation for budgeted runners, full conversation for budget-less runners', async () => {
    const id = seed('long-chunked');
    const budgeted = makeRunner({ maxInputTokens: 80_000 });
    await analyzeSessionPipeline(id, { runner: budgeted.runner, passes: ['prompt_quality'] });
    const prompt = budgeted.calls[0].userPrompt;
    expect(prompt).toContain('[... middle of conversation truncated for analysis ...]');
    expect(prompt.length / 4).toBeLessThan(80_000);
    expect(prompt).toContain('### User#0'); // head kept
    expect(prompt).toMatch(/### Assistant#19\d/); // tail kept (400 messages -> assistants up to #199)

    const native = makeRunner();
    await analyzeSessionPipeline(id, { runner: native.runner, passes: ['prompt_quality'] });
    expect(native.calls[0].userPrompt).not.toContain('truncated for analysis');
  });
});

describe('analyzeSessionPipeline — timeouts, aborts, cost, facets pass', () => {
  it('prompt-quality timeout comes from the runner (or option) and reports error_type timeout; session pass is not timed', async () => {
    const id = seed('prompt-quality');
    const slow = makeRunner({ timeoutMs: 20, delayMs: 100 });
    const result = await analyzeSessionPipeline(id, { runner: slow.runner, passes: ['prompt_quality'] });
    expect(result).toMatchObject({ success: false, error_type: 'timeout' });
    // The session pass has no timeout: same slow runner completes it.
    const session = await analyzeSessionPipeline(id, { runner: makeRunner({ timeoutMs: 20, delayMs: 60 }).runner, passes: ['session'] });
    expect(session.success).toBe(true);
    // Option overrides the runner property; null disables it.
    const off = await analyzeSessionPipeline(id, { runner: makeRunner({ timeoutMs: 20, delayMs: 60 }).runner, passes: ['prompt_quality'], promptQualityTimeoutMs: null });
    expect(off.success).toBe(true);
  });

  it('a caller abort during the prompt-quality call is an abort, not a timeout', async () => {
    const id = seed('prompt-quality');
    const controller = new AbortController();
    const { runner } = makeRunner({ timeoutMs: 5_000, delayMs: 200 });
    const pending = analyzeSessionPipeline(id, { runner, passes: ['prompt_quality'], signal: controller.signal });
    setTimeout(() => controller.abort(Object.assign(new Error('user'), { name: 'AbortError' })), 20);
    expect(await pending).toMatchObject({ success: false, error_type: 'abort' });
  });

  it('records runner-reported costUsd when every call reports it', async () => {
    const id = seed('short');
    const { runner } = makeRunner({ provider: 'anthropic', costUsd: 0.5 });
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(mockDb.prepare("SELECT estimated_cost_usd FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'").get(id)).toEqual({ estimated_cost_usd: 0.5 });
  });

  it("'facets' pass: saves facets, records a 'facet' usage row, no insights or title", async () => {
    const id = seed('short');
    const facets = '{"outcome_satisfaction":"medium","workflow_pattern":"iterative","had_course_correction":false,"iteration_count":2,"friction_points":[],"effective_patterns":[],}';
    const { runner, calls } = makeRunner({ respond: () => facets });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['facets'] });
    expect(result.success && result.passes).toEqual(['facets']);
    expect(calls).toHaveLength(1);
    expect(mockDb.prepare('SELECT outcome_satisfaction FROM session_facets WHERE session_id = ?').get(id)).toEqual({ outcome_satisfaction: 'medium' });
    expect(mockDb.prepare('SELECT analysis_type FROM analysis_usage WHERE session_id = ?').all(id)).toEqual([{ analysis_type: 'facet' }]);
    expect(mockDb.prepare('SELECT COUNT(*) AS n FROM insights').get()).toEqual({ n: 0 });
    const bad = await analyzeSessionPipeline(id, { runner: makeRunner({ respond: () => 'nothing here' }).runner, passes: ['facets'] });
    expect(bad).toMatchObject({ success: false, error_type: 'no_json_found', failedPass: 'facets' });
  });
});

describe('chunkMessages / mergeAnalysisResponses', () => {
  it('merge: first summary, round-robin decisions (cap 5) and learnings (cap 8), title de-dup, steps concatenated', () => {
    const r = (n: number) => ({
      summary: { title: `S${n}`, content: '', bullets: [] },
      decisions: [1, 2, 3].map(i => ({ title: i === 1 ? 'Shared' : `D${n}-${i}`, situation: '', choice: '', reasoning: '', confidence: 80 })),
      learnings: [1, 2, 3, 4].map(i => ({ title: i === 1 ? 'Shared' : `L${n}-${i}`, takeaway: '', confidence: 80 })),
      step_matrix: [{ step: `s${n}` }],
    });
    const merged = mergeAnalysisResponses([r(1), r(2), r(3)] as never);
    expect(merged.summary.title).toBe('S1');
    // Late chunks are represented: not just the first chunk's three decisions.
    expect(merged.decisions.map(d => d.title)).toEqual(['Shared', 'D1-2', 'D2-2', 'D3-2', 'D1-3']);
    expect(merged.learnings).toHaveLength(8);
    expect(merged.step_matrix).toHaveLength(3);
    expect(mergeAnalysisResponses([])).toMatchObject({ decisions: [], learnings: [] });
  });

  it('chunkMessages splits at 80% of the budget and keeps every message', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, session_id: 's', type: 'user' as const, content: 'x'.repeat(400), thinking: null,
      tool_calls: '[]', tool_results: '[]', usage: null, timestamp: '2026-01-01T00:00:00Z', parent_id: null,
    }));
    const chunks = chunkMessages(msgs, t => Math.ceil(t.length / 4), 500); // limit 400 tokens; header overhead counts
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(10);
  });
});
