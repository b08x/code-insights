import { describe, it, expect, vi } from 'vitest';
import { createJudge, createAxJudge, outputHash, keyPointsHash, JudgeError, type JudgeCache, type JudgeInput } from '../judge.js';
import type { JudgeVerdict } from '../metric.js';
import { retryCall, isTransientError } from '../retry.js';

const input: JudgeInput = { keyPoints: ['a', 'b'], forbiddenClaims: ['x'], analysis: '{"summary":"s"}' };

/** In-memory cache with the same shape db/optimization.ts judge_cache will provide. */
function memoryCache(): JudgeCache & { rows: Map<string, JudgeVerdict> } {
  const rows = new Map<string, JudgeVerdict>();
  const k = (o: string, p: string, m: string) => `${o}|${p}|${m}`;
  return {
    rows,
    get: (o, p, m) => rows.get(k(o, p, m)) ?? null,
    put: (o, p, m, v) => { rows.set(k(o, p, m), v); },
  };
}

const noSleep = async () => {};

describe('hashes', () => {
  it('outputHash is stable under key order and key point hash covers claims too', () => {
    expect(outputHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(outputHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
    expect(outputHash({ a: 1 })).not.toBe(outputHash({ a: 2 }));
    expect(keyPointsHash(['a'], ['x'])).not.toBe(keyPointsHash(['a'], ['y']));
    expect(keyPointsHash(['a'], [])).not.toBe(keyPointsHash([], ['a']));
  });
});

describe('createJudge', () => {
  it('normalizes the raw answer to one flag per key point and claim', async () => {
    const judge = createJudge({ model: 'judge-1', run: async () => ({ covered: [true], violated: [], rationale: 'r' }), retry: { sleep: noSleep } });
    expect(await judge.judge(input)).toEqual({ covered: [true, false], violated: [false], rationale: 'r' });
  });

  it('serves repeated identical inputs from the cache (engine-4) and counts calls', async () => {
    const run = vi.fn(async () => ({ covered: [true, true], violated: [false], rationale: 'ok' }));
    const cache = memoryCache();
    const judge = createJudge({ model: 'judge-1', run, cache });
    const first = await judge.judge(input);
    const second = await judge.judge(input);
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    expect(judge.stats).toEqual({ calls: 1, cacheHits: 1 });
    expect(cache.rows.size).toBe(1);
  });

  it('keys the cache by judge model: another model never gets this model\'s verdict', async () => {
    const cache = memoryCache();
    const a = createJudge({ model: 'judge-1', run: async () => ({ covered: [true, true], violated: [false], rationale: 'A' }), cache });
    const b = createJudge({ model: 'judge-2', run: async () => ({ covered: [false, false], violated: [true], rationale: 'B' }), cache });
    expect((await a.judge(input)).rationale).toBe('A');
    expect((await b.judge(input)).rationale).toBe('B');
  });

  it('a different analysis or different key points is a cache miss', async () => {
    const run = vi.fn(async () => ({ covered: [true, true], violated: [false], rationale: '' }));
    const judge = createJudge({ model: 'm', run, cache: memoryCache() });
    await judge.judge(input);
    await judge.judge({ ...input, analysis: '{"summary":"other"}' });
    await judge.judge({ ...input, keyPoints: ['a', 'c'] });
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('retries a transient failure per call and succeeds without surfacing it', async () => {
    let n = 0;
    const run = async () => {
      if (++n === 1) throw Object.assign(new Error('429 rate limit'), { status: 429 });
      return { covered: [true, true], violated: [false], rationale: 'ok' };
    };
    const judge = createJudge({ model: 'm', run, retry: { sleep: noSleep } });
    expect((await judge.judge(input)).rationale).toBe('ok');
    expect(n).toBe(2);
  });

  it('wraps an exhausted or malformed answer in JudgeError and never caches it', async () => {
    const cache = memoryCache();
    const bad = createJudge({ model: 'm', run: async () => ({ covered: 'yes', violated: null, rationale: 3 }) as never, cache, retry: { sleep: noSleep } });
    await expect(bad.judge(input)).rejects.toBeInstanceOf(JudgeError);
    expect(cache.rows.size).toBe(0);
  });

  it('runs no call for an empty rubric', async () => {
    const run = vi.fn();
    const judge = createJudge({ model: 'm', run: run as never });
    expect(await judge.judge({ keyPoints: [], forbiddenClaims: [], analysis: 'x' })).toEqual({ covered: [], violated: [], rationale: '' });
    expect(run).not.toHaveBeenCalled();
  });
});

describe('createAxJudge', () => {
  it('drives a typed ax() signature keyPoints, forbiddenClaims, analysis -> covered, violated, rationale', async () => {
    const { AxMockAIService } = await import('@ax-llm/ax');
    const prompts: string[] = [];
    const ai = new AxMockAIService({
      features: { functions: false, streaming: false },
      chatResponse: async (req: { chatPrompt: Array<{ content?: unknown }> }) => {
        prompts.push(JSON.stringify(req.chatPrompt));
        return {
          results: [{ index: 0, content: 'Covered: [true, false]\nViolated: [true]\nRationale: second point missing', finishReason: 'stop' }],
          modelUsage: { ai: 'mock', model: 'mock', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
        };
      },
    } as never);
    const judge = createAxJudge({ ai: ai as never, model: 'mock' });
    expect(await judge.judge(input)).toEqual({ covered: [true, false], violated: [true], rationale: 'second point missing' });
    expect(prompts[0]).toContain('Key Points');
    expect(prompts[0]).toContain('Forbidden Claims');
  });
});

describe('retryCall', () => {
  it('does not retry non-transient errors or aborted calls', async () => {
    const fn = vi.fn(async () => { throw Object.assign(new Error('400 bad request'), { status: 400 }); });
    await expect(retryCall(fn, { sleep: noSleep })).rejects.toThrow('400');
    expect(fn).toHaveBeenCalledTimes(1);

    const ac = new AbortController();
    ac.abort(new Error('stop'));
    const fn2 = vi.fn(async () => { throw new Error('rate limit'); });
    await expect(retryCall(fn2, { sleep: noSleep, signal: ac.signal })).rejects.toThrow('rate limit');
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt limit with exponential backoff', async () => {
    const delays: number[] = [];
    const fn = vi.fn(async () => { throw new Error('503 overloaded'); });
    await expect(retryCall(fn, { attempts: 3, baseDelayMs: 10, sleep: async ms => { delays.push(ms); } })).rejects.toThrow('503');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([10, 20]);
  });

  it('classifies transient errors', () => {
    expect(isTransientError(Object.assign(new Error('x'), { status: 429 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { status: 502 }))).toBe(true);
    expect(isTransientError(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
    expect(isTransientError('nope')).toBe(false);
  });
});
