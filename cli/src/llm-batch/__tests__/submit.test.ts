import { describe, it, expect, vi } from 'vitest';
import { submitAndAwait } from '../submit.js';
import { BatchHttpError } from '../http.js';
import { BatchJobError, BatchTimeoutError, type BatchBackend, type BatchPollResult, type BatchRequest, type BatchRow, type BatchRowSuccess } from '../types.js';

const req = (id: string): BatchRequest => ({ customId: id, body: { messages: [{ role: 'user', content: id }] } });
const ok = (id: string): BatchRowSuccess => ({ customId: id, ok: true, content: `out-${id}`, inputTokens: 1, outputTokens: 1, costUsd: 0.001 });
const bad = (id: string): BatchRow => ({ customId: id, ok: false, error: 'provider said no' });

function fakeBackend(polls: Array<BatchPollResult | Error>, extra: Partial<BatchBackend> = {}) {
  const queue = [...polls];
  const backend: BatchBackend = {
    provider: 'mistral',
    model: 'm',
    maxRequestsPerJob: 1000,
    submit: vi.fn(async () => `job-${(backend.submit as ReturnType<typeof vi.fn>).mock.calls.length}`),
    poll: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift()! : queue[0];
      if (next instanceof Error) throw next;
      return next;
    }),
    cancel: vi.fn(async () => {}),
    ...extra,
  };
  return backend;
}
const instant = { sleep: async () => {}, pollIntervalMs: 1 };

describe('submitAndAwait', () => {
  it('success: polls until done and keys results by custom_id (order not trusted)', async () => {
    const backend = fakeBackend([{ state: 'pending' }, { state: 'done', rows: [ok('b'), ok('a')] }]);
    const { rows, summary } = await submitAndAwait(backend, [req('a'), req('b')], instant);
    expect([...rows.keys()]).toEqual(['a', 'b']);
    expect(rows.get('a')).toMatchObject({ ok: true, content: 'out-a' });
    expect(summary).toMatchObject({ submitted: 2, succeeded: 2, failedRows: 0, resynced: 0, jobs: 1 });
    expect(backend.poll).toHaveBeenCalledTimes(2);
  });

  it('partial failure: failed and missing rows are re-run synchronously and reconciled', async () => {
    const backend = fakeBackend([{ state: 'done', rows: [ok('a'), bad('b')] }]); // c is missing
    const resync = vi.fn(async (r: BatchRequest): Promise<BatchRowSuccess> => ({ ...ok(r.customId), content: 'sync', costUsd: 0.002 }));
    const { rows, summary } = await submitAndAwait(backend, [req('a'), req('b'), req('c')], { ...instant, resync });
    expect(resync.mock.calls.map(c => c[0].customId)).toEqual(['b', 'c']);
    expect(rows.get('a')).toMatchObject({ content: 'out-a' });
    expect(rows.get('b')).toMatchObject({ ok: true, content: 'sync' });
    expect(rows.get('c')).toMatchObject({ ok: true, content: 'sync' });
    expect(summary).toMatchObject({ succeeded: 1, failedRows: 2, resynced: 2, resyncFailed: 0 });
  });

  it('a failing resync leaves the row failed without throwing', async () => {
    const backend = fakeBackend([{ state: 'done', rows: [bad('a')] }]);
    const { rows, summary } = await submitAndAwait(backend, [req('a')], { ...instant, resync: async () => { throw new Error('rate limited'); } });
    expect(rows.get('a')).toEqual({ customId: 'a', ok: false, error: 'rate limited' });
    expect(summary.resyncFailed).toBe(1);
  });

  it('without resync, failed rows stay failed', async () => {
    const backend = fakeBackend([{ state: 'done', rows: [bad('a')] }]);
    const { rows } = await submitAndAwait(backend, [req('a')], instant);
    expect(rows.get('a')).toMatchObject({ ok: false, error: 'provider said no' });
  });

  it('unknown custom_id in the output is ignored and reported', async () => {
    const backend = fakeBackend([{ state: 'done', rows: [ok('a'), ok('ghost')] }]);
    const { rows, summary } = await submitAndAwait(backend, [req('a')], instant);
    expect(rows.has('ghost')).toBe(false);
    expect(summary.unknownIds).toEqual(['ghost']);
    expect(summary.succeeded).toBe(1);
  });

  it.each(['FAILED', 'expired', 'cancelled', 'TIMEOUT_EXCEEDED'])('terminal %s job throws BatchJobError with partial rows', async (status) => {
    const backend = fakeBackend([{ state: 'pending' }, { state: 'failed', status, message: 'nope', rows: [ok('a')] }]);
    const err = await submitAndAwait(backend, [req('a'), req('b')], instant).catch(e => e);
    expect(err).toBeInstanceOf(BatchJobError);
    expect(err).toMatchObject({ status, jobId: 'job-1', provider: 'mistral' });
    expect(err.partialRows).toHaveLength(1);
  });

  it('deadline: throws BatchTimeoutError and cancels the job', async () => {
    let t = 0;
    const backend = fakeBackend([{ state: 'pending' }]);
    const err = await submitAndAwait(backend, [req('a')], { ...instant, timeoutMs: 100, now: () => (t += 40) }).catch(e => e);
    expect(err).toBeInstanceOf(BatchTimeoutError);
    expect(backend.cancel).toHaveBeenCalledWith('job-1');
  });

  it('tolerates transient poll errors but not persistent or fatal ones', async () => {
    const transient = new BatchHttpError('mistral', 503, 'unavailable');
    const recovering = fakeBackend([transient, transient, { state: 'done', rows: [ok('a')] }]);
    await expect(submitAndAwait(recovering, [req('a')], instant)).resolves.toBeDefined();

    const persistent = fakeBackend([transient]);
    await expect(submitAndAwait(persistent, [req('a')], instant)).rejects.toBe(transient);

    const fatal = fakeBackend([new BatchHttpError('mistral', 401, 'Invalid API key')]);
    await expect(submitAndAwait(fatal, [req('a')], instant)).rejects.toThrow(/Invalid API key/);
    expect(fatal.poll).toHaveBeenCalledTimes(1);
  });

  it('splits into jobs at maxRequestsPerJob and merges results', async () => {
    const backend = fakeBackend([{ state: 'done', rows: [ok('a'), ok('b'), ok('c')] }], { maxRequestsPerJob: 2 });
    const { rows, summary } = await submitAndAwait(backend, [req('a'), req('b'), req('c')], instant);
    expect(summary.jobs).toBe(2);
    expect(backend.submit).toHaveBeenCalledTimes(2);
    expect(rows.size).toBe(3);
    expect(summary.succeeded).toBe(3); // each job's poll returns all rows; ids outside the slice are not double counted
  });

  it('rejects duplicate custom_ids and handles an empty request list', async () => {
    const backend = fakeBackend([{ state: 'pending' }]);
    await expect(submitAndAwait(backend, [req('a'), req('a')], instant)).rejects.toThrow(/Duplicate/);
    const empty = await submitAndAwait(backend, [], instant);
    expect(empty.rows.size).toBe(0);
    expect(backend.submit).not.toHaveBeenCalled();
  });

  it('a caller abort stops polling', async () => {
    const controller = new AbortController();
    const backend = fakeBackend([{ state: 'pending' }]);
    const sleep = async () => { controller.abort(new Error('stop')); };
    await expect(submitAndAwait(backend, [req('a')], { sleep, pollIntervalMs: 1, signal: controller.signal })).rejects.toThrow('stop');
  });

  describe('cancellation', () => {
    it('cancels the provider job when the caller aborts', async () => {
      const controller = new AbortController();
      const backend = fakeBackend([{ state: 'pending' }]);
      const sleep = async () => { controller.abort(new Error('stop')); };
      await expect(submitAndAwait(backend, [req('a')], { sleep, pollIntervalMs: 1, signal: controller.signal })).rejects.toThrow('stop');
      expect(backend.cancel).toHaveBeenCalledWith('job-1');
    });

    it('cancels on a fatal poll error and on timeout (once)', async () => {
      const fatal = fakeBackend([new BatchHttpError('mistral', 401, 'Invalid API key')]);
      await expect(submitAndAwait(fatal, [req('a')], instant)).rejects.toThrow();
      expect(fatal.cancel).toHaveBeenCalledTimes(1);

      let t = 0;
      const slow = fakeBackend([{ state: 'pending' }]);
      await expect(submitAndAwait(slow, [req('a')], { ...instant, timeoutMs: 10, now: () => (t += 20) })).rejects.toBeInstanceOf(BatchTimeoutError);
      expect(slow.cancel).toHaveBeenCalledTimes(1);
    });

    it('does not cancel a job the provider already reported terminal, nor a finished one', async () => {
      const failed = fakeBackend([{ state: 'failed', status: 'FAILED', message: 'x' }]);
      await expect(submitAndAwait(failed, [req('a')], instant)).rejects.toBeInstanceOf(BatchJobError);
      const done = fakeBackend([{ state: 'done', rows: [ok('a')] }]);
      await submitAndAwait(done, [req('a')], instant);
      expect(failed.cancel).not.toHaveBeenCalled();
      expect(done.cancel).not.toHaveBeenCalled();
    });

    it('a failing slice aborts and cancels its siblings, then rethrows the real failure', async () => {
      const fatal = new BatchHttpError('mistral', 401, 'Invalid API key');
      const cancel = vi.fn(async () => {});
      const backend = fakeBackend([{ state: 'pending' }], {
        maxRequestsPerJob: 1,
        cancel,
        // job-1 fails fast; job-2 keeps pending until aborted
        poll: vi.fn(async (jobId: string, signal?: AbortSignal) => {
          if (jobId === 'job-1') throw fatal;
          await new Promise<void>((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
          return { state: 'pending' as const };
        }),
      });
      await expect(submitAndAwait(backend, [req('a'), req('b')], instant)).rejects.toBe(fatal);
      expect(cancel).toHaveBeenCalledWith('job-2');
      expect(cancel).toHaveBeenCalledWith('job-1');
    });
  });
});
