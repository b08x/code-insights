import { describe, it, expect, vi } from 'vitest';
import { createMistralBatchBackend } from '../mistral.js';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const text = (s: string) => new Response(s, { status: 200 });

const okRow = (id: string, content = '{"a":1}') => ({
  id: `batch-x-${id}`,
  custom_id: id,
  response: { status_code: 200, body: { object: 'chat.completion', usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [{ index: 0, message: { role: 'assistant', content } }] } },
  error: null,
});

function backendWith(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {}));
  const backend = createMistralBatchBackend({ apiKey: 'test-key', model: 'mistral-small-latest', fetch: fetchMock as unknown as typeof fetch });
  return { backend, fetchMock };
}

describe('mistral batch backend', () => {
  it('submits inline requests to /v1/batch/jobs', async () => {
    const { backend, fetchMock } = backendWith(() => json({ id: 'job-1', status: 'QUEUED' }));
    const id = await backend.submit([{ customId: 'c1', body: { messages: [{ role: 'user', content: 'hi' }], temperature: 0.7 } }]);
    expect(id).toBe('job-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.mistral.ai/v1/batch/jobs');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
    expect(JSON.parse(init.body as string)).toMatchObject({
      endpoint: '/v1/chat/completions',
      model: 'mistral-small-latest',
      timeout_hours: 24,
      requests: [{ custom_id: 'c1', body: { messages: [{ role: 'user', content: 'hi' }] } }],
    });
  });

  it.each(['QUEUED', 'RUNNING', 'CANCELLATION_REQUESTED'])('%s is pending', async (status) => {
    const { backend } = backendWith(() => json({ id: 'j', status }));
    expect(await backend.poll('j')).toEqual({ state: 'pending' });
  });

  it('SUCCESS downloads output and error files and parses rows', async () => {
    const { backend, fetchMock } = backendWith((url) => {
      if (url.includes('/v1/batch/jobs/j')) return json({ id: 'j', status: 'SUCCESS', output_file: 'out-1', error_file: 'err-1', outputs: null });
      if (url.endsWith('/v1/files/out-1/content')) return text(`${JSON.stringify(okRow('a'))}\n${JSON.stringify(okRow('b', 'hello'))}\n`);
      if (url.endsWith('/v1/files/err-1/content')) return text(`${JSON.stringify({ id: 'e', custom_id: 'c', response: null, error: { message: 'bad request' } })}\n`);
      throw new Error(`unexpected ${url}`);
    });
    const result = await backend.poll('j');
    expect(result.state).toBe('done');
    if (result.state !== 'done') return;
    expect(result.rows).toEqual([
      { customId: 'a', ok: true, content: '{"a":1}', inputTokens: 10, outputTokens: 5 },
      { customId: 'b', ok: true, content: 'hello', inputTokens: 10, outputTokens: 5, costUsd: undefined },
      { customId: 'c', ok: false, error: 'bad request' },
    ]);
    expect(String(fetchMock.mock.calls[0][0])).toContain('?inline=true');
  });

  it('SUCCESS prefers inline outputs when present', async () => {
    const { backend, fetchMock } = backendWith(() => json({ id: 'j', status: 'SUCCESS', outputs: [okRow('a')], output_file: 'out-1' }));
    const result = await backend.poll('j');
    expect(result.state === 'done' && result.rows.map(r => r.customId)).toEqual(['a']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips malformed lines and rows without custom_id', async () => {
    const { backend } = backendWith((url) =>
      url.includes('/content') ? text(`not json\n${JSON.stringify({ response: {} })}\n${JSON.stringify(okRow('a'))}\n`) : json({ id: 'j', status: 'SUCCESS', output_file: 'o' }));
    const result = await backend.poll('j');
    expect(result.state === 'done' && result.rows.map(r => r.customId)).toEqual(['a']);
  });

  it.each(['FAILED', 'TIMEOUT_EXCEEDED', 'CANCELLED'])('%s is a failed job and keeps partial output', async (status) => {
    const { backend } = backendWith((url) =>
      url.includes('/content') ? text(`${JSON.stringify(okRow('a'))}\n`) : json({ id: 'j', status, output_file: 'o', errors: [{ message: 'boom', count: 1 }] }));
    const result = await backend.poll('j');
    expect(result).toMatchObject({ state: 'failed', status, message: 'boom' });
    expect(result.state === 'failed' && result.rows?.map(r => r.customId)).toEqual(['a']);
  });

  it('failed job without output files still reports failed', async () => {
    const { backend } = backendWith(() => json({ id: 'j', status: 'TIMEOUT_EXCEEDED', errors: [] }));
    expect(await backend.poll('j')).toMatchObject({ state: 'failed', status: 'TIMEOUT_EXCEEDED', message: 'TIMEOUT_EXCEEDED' });
  });

  it('maps 401 to an invalid-key error and 500 to a status error', async () => {
    const bad = backendWith(() => json({ message: 'Unauthorized' }, 401));
    await expect(bad.backend.submit([])).rejects.toThrow(/Invalid API key for Mistral/);
    const down = backendWith(() => json({ message: 'oops' }, 500));
    await expect(down.backend.poll('j')).rejects.toMatchObject({ status: 500 });
  });

  it('handles array content chunks', async () => {
    const row = okRow('a');
    (row.response.body.choices[0].message as { content: unknown }).content = [{ type: 'text', text: 'x' }, { type: 'text', text: 'y' }];
    const { backend } = backendWith(() => json({ id: 'j', status: 'SUCCESS', outputs: [row] }));
    const result = await backend.poll('j');
    expect(result.state === 'done' && result.rows[0]).toMatchObject({ ok: true, content: 'xy' });
  });
});
