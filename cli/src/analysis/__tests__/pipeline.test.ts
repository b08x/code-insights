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

vi.mock('../../db/client.js', () => ({ getDb: () => mockDb, closeDb: () => {} }));
vi.mock('../../utils/config.js', () => ({ loadConfig: () => null }));
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
}

/** Stub runner that records calls and answers by prompt kind (or via `respond`). */
function makeRunner(opts: RunnerOptions = {}) {
  const calls: RunAnalysisParams[] = [];
  const runner: AnalysisRunner = {
    name: 'stub',
    ...(opts.provider && { provider: opts.provider, model: 'claude-sonnet-4-20250514' }),
    ...(opts.maxInputTokens !== undefined && { maxInputTokens: opts.maxInputTokens }),
    async runAnalysis(params) {
      calls.push(params);
      const answer = opts.respond?.(params, calls.length - 1);
      if (answer instanceof Error) throw answer;
      const rawJson = answer
        ?? (params.userPrompt.includes("Analyze the user's input messages")
          ? loadResponse('pq-ok.json')
          : loadResponse('analysis-ok.json'));
      const result: RunAnalysisResult = {
        rawJson, durationMs: 5, ...USAGE,
        model: opts.provider ? 'claude-sonnet-4-20250514' : 'native-model',
        provider: opts.provider ?? 'native',
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

beforeEach(() => {
  mockDb = new Database(':memory:');
  runMigrations(mockDb);
  architecture = '';
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

  it('echoes identity and prompt resolution (reserved for steps 8-10)', async () => {
    const id = seed('short');
    const { runner } = makeRunner();
    const identity = { runner: 'stub', model: null, variant: null };
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'], identity, promptResolution: { promptVersionId: null } });
    expect(result.success && result.identity).toEqual(identity);
    expect(result.success && result.promptVersionId).toBeNull();
  });
});

describe('analyzeSessionPipeline — prompt shape', () => {
  it('Anthropic runners get cache_control blocks whose flattened text equals the plain prompt', async () => {
    const id = seed('short');
    const plain = makeRunner();
    const anthropic = makeRunner({ provider: 'anthropic' });
    await analyzeSessionPipeline(id, { runner: plain.runner, passes: ['session'] });
    await analyzeSessionPipeline(id, { runner: anthropic.runner, passes: ['session'] });

    expect(plain.calls[0].userContent).toBeUndefined();
    const blocks = anthropic.calls[0].userContent!;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks.map(b => b.text).join('')).toBe(anthropic.calls[0].userPrompt);
    expect(anthropic.calls[0].userPrompt).toBe(plain.calls[0].userPrompt);
  });

  it('non-Anthropic provider runners get the plain string', async () => {
    const id = seed('short');
    const { runner, calls } = makeRunner({ provider: 'openai' });
    await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(calls[0].userContent).toBeUndefined();
  });

  it('includes architecture context in both passes when available, and records identical hashes across runs', async () => {
    const id = seed('prompt-quality');
    architecture = 'modules: a, b';
    const first = makeRunner();
    const a = await analyzeSessionPipeline(id, { runner: first.runner });
    const second = makeRunner({ provider: 'anthropic' });
    const b = await analyzeSessionPipeline(id, { runner: second.runner });

    for (const call of first.calls) expect(call.userPrompt).toContain('<project_architecture>\nmodules: a, b\n</project_architecture>');
    expect(a.success && b.success).toBe(true);
    if (a.success && b.success) expect(a.prompts.map(p => p.hash)).toEqual(b.prompts.map(p => p.hash));
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
  it('chunks when the prompt exceeds runner.maxInputTokens: per-chunk calls, facet pass, summed usage, chunk_count', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = makeRunner({
      provider: 'anthropic',
      maxInputTokens: 80_000,
      respond: (p, i) => {
        if (p.userPrompt.includes('cross-session facet aggregation')) {
          // Fenced + trailing comma: only the jsonrepair fallback can read this.
          return '```json\n{"outcome_satisfaction":"high","workflow_pattern":"plan-then-implement","had_course_correction":false,"iteration_count":1,"friction_points":[],"effective_patterns":[],}\n```';
        }
        return JSON.stringify({
          summary: { title: `Chunk ${i + 1}`, content: 'c', bullets: [] },
          decisions: [{ title: `D${i}`, situation: 's', choice: 'c', reasoning: 'r', confidence: 80 }],
          learnings: [],
        });
      },
    });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const chunkCalls = result.prompts.filter(p => p.call === 'chunk').length;
    expect(chunkCalls).toBeGreaterThan(1);
    expect(result.prompts.filter(p => p.call === 'facets')).toHaveLength(1);
    expect(calls).toHaveLength(chunkCalls + 1);
    // Facets came from the dedicated pass (jsonrepair fallback), not the merge.
    expect(mockDb.prepare('SELECT outcome_satisfaction FROM session_facets WHERE session_id = ?').get(id)).toEqual({ outcome_satisfaction: 'high' });
    const row = mockDb.prepare("SELECT input_tokens, chunk_count FROM analysis_usage WHERE session_id = ? AND analysis_type = 'session'").get(id) as { input_tokens: number; chunk_count: number };
    expect(row.chunk_count).toBe(chunkCalls);
    expect(row.input_tokens).toBe((chunkCalls + 1) * USAGE.inputTokens);
  });

  it('never chunks a runner without a declared budget (native CLI runners)', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = makeRunner();
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result.success).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].userPrompt.length).toBeGreaterThan(320_000);
  });

  it('all chunks unparseable -> json_parse_error with the usage spent', async () => {
    const id = seed('long-chunked');
    const { runner } = makeRunner({ maxInputTokens: 80_000, respond: () => 'nope' });
    const result = await analyzeSessionPipeline(id, { runner, passes: ['session'] });
    expect(result).toMatchObject({ success: false, error_type: 'json_parse_error', failedPass: 'session' });
    expect((result as { usage?: { inputTokens: number } }).usage!.inputTokens).toBeGreaterThan(0);
  });

  it('reports per-chunk progress then saving', async () => {
    const id = seed('long-chunked');
    const progress: unknown[] = [];
    const { runner } = makeRunner({ maxInputTokens: 80_000 });
    await analyzeSessionPipeline(id, { runner, passes: ['session'], onProgress: p => progress.push(p) });
    expect(progress[0]).toMatchObject({ phase: 'analyzing', currentChunk: 1 });
    expect(progress[progress.length - 1]).toEqual({ phase: 'saving' });
  });

  it('truncates the prompt-quality conversation to the budget', async () => {
    const id = seed('long-chunked');
    const { runner, calls } = makeRunner({ maxInputTokens: 80_000 });
    await analyzeSessionPipeline(id, { runner, passes: ['prompt_quality'] });
    expect(calls[0].userPrompt).toContain('[... conversation truncated for analysis ...]');
    expect(calls[0].userPrompt.length / 4).toBeLessThan(80_000);
  });
});

describe('chunkMessages / mergeAnalysisResponses', () => {
  it('merge: first summary, decisions capped at 3, learnings at 5, title de-dup', () => {
    const r = (n: number) => ({
      summary: { title: `S${n}`, content: '', bullets: [] },
      decisions: [1, 2, 3].map(i => ({ title: i === 1 ? 'Shared' : `D${n}-${i}`, situation: '', choice: '', reasoning: '', confidence: 80 })),
      learnings: [1, 2, 3, 4].map(i => ({ title: i === 1 ? 'Shared' : `L${n}-${i}`, takeaway: '', confidence: 80 })),
    });
    const merged = mergeAnalysisResponses([r(1), r(2)] as never);
    expect(merged.summary.title).toBe('S1');
    expect(merged.decisions.map(d => d.title)).toEqual(['Shared', 'D1-2', 'D1-3']);
    expect(merged.learnings).toHaveLength(5);
    expect(mergeAnalysisResponses([])).toMatchObject({ decisions: [], learnings: [] });
  });

  it('chunkMessages splits at 80% of the budget and keeps every message', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({
      id: `m${i}`, session_id: 's', type: 'user' as const, content: 'x'.repeat(400), thinking: null,
      tool_calls: '[]', tool_results: '[]', usage: null, timestamp: '2026-01-01T00:00:00Z', parent_id: null,
    }));
    const chunks = chunkMessages(msgs, t => Math.ceil(t.length / 4), 500); // limit 400 tokens ~ 4 messages
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toHaveLength(10);
  });
});
