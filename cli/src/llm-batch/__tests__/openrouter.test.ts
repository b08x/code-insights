import { describe, it, expect, vi } from 'vitest';
import { createOpenRouterBatchBackend } from '../openrouter.js';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

const okResult = (id: string, prompt: number, completion: number, content = '{"a":1}') => ({
  id: `batch_req_${id}`,
  custom_id: id,
  response: { status_code: 200, request_id: 'r', body: { object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: prompt, completion_tokens: completion } } },
  error: null,
});

function backendWith(handler: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const backend = createOpenRouterBatchBackend({ apiKey: 'or-key', model: 'mistralai/mistral-small', fetch: fetchMock as unknown as typeof fetch });
  return { backend, fetchMock };
}

describe('openrouter batch backend', () => {
  it('POSTs /api/v1/batches with `requests` serialized last', async () => {
    const { backend, fetchMock } = backendWith(() => json({ id: 'batch_1', status: 'validating' }, 202));
    const id = await backend.submit([{ customId: 'c1', body: { messages: [{ role: 'user', content: 'hi' }] } }]);
    expect(id).toBe('batch_1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/batches');
    const raw = init.body as string;
    expect(Object.keys(JSON.parse(raw))).toEqual(['endpoint', 'model', 'completion_window', 'requests']);
    expect(JSON.parse(raw)).toMatchObject({ endpoint: '/v1/chat/completions', completion_window: '24h', requests: [{ custom_id: 'c1' }] });
  });

  it.each(['validating', 'in_progress', 'finalizing', 'cancelling'])('%s is pending', async (status) => {
    const { backend } = backendWith(() => json({ id: 'b', status, results: null }));
    expect(await backend.poll('b')).toEqual({ state: 'pending' });
  });

  it('completed: returns rows, apportions usage.cost by token share, keeps per-row failures', async () => {
    const { backend } = backendWith(() => json({
      id: 'b',
      status: 'completed',
      request_counts: { total: 3, completed: 2, failed: 1 },
      usage: { cost: 0.0012, is_byok: false },
      results: [
        okResult('a', 100, 100),
        okResult('b', 200, 200),
        { id: 'x', custom_id: 'c', response: null, error: { code: 400, message: 'invalid request' } },
      ],
      error: null,
    }));
    const result = await backend.poll('b');
    expect(result.state).toBe('done');
    if (result.state !== 'done') return;
    const [a, b, c] = result.rows;
    expect(a).toMatchObject({ customId: 'a', ok: true, costUsd: 0.0004 });
    expect(b).toMatchObject({ customId: 'b', ok: true, costUsd: 0.0008 });
    expect(c).toEqual({ customId: 'c', ok: false, error: 'invalid request' });
  });

  it('unpriced model without usage.cost yields rows with no costUsd (not 0)', async () => {
    const { backend } = backendWith(() => json({ id: 'b', status: 'completed', results: [okResult('a', 5, 5)] }));
    const result = await backend.poll('b');
    expect(result.state === 'done' && 'costUsd' in result.rows[0]).toBe(false);
  });

  it('counts result objects without custom_id as unparsed', async () => {
    const { backend } = backendWith(() => json({ id: 'b', status: 'completed', results: [okResult('a', 1, 1), { foo: 1 }] }));
    const result = await backend.poll('b');
    expect(result).toMatchObject({ state: 'done', unparsed: 1 });
  });

  it.each(['failed', 'expired', 'cancelled'])('%s is a failed job with no rows', async (status) => {
    const { backend } = backendWith(() => json({ id: 'b', status, results: null, error: { code: 422, message: 'stream is not supported' } }));
    expect(await backend.poll('b')).toEqual({ state: 'failed', status, message: 'stream is not supported' });
  });

  it('maps 401, 410 and 429 to errors (429 is transient via status)', async () => {
    await expect(backendWith(() => json({ error: { code: 401, message: 'No auth credentials found.' } }, 401)).backend.poll('b')).rejects.toThrow(/Invalid API key for OpenRouter/);
    await expect(backendWith(() => json({ error: { code: 410, message: 'Batch results have expired.' } }, 410)).backend.poll('b')).rejects.toThrow(/expired/);
    await expect(backendWith(() => json({ error: { code: 429, message: 'Rate limit exceeded.' } }, 429)).backend.poll('b')).rejects.toMatchObject({ status: 429 });
  });
});
