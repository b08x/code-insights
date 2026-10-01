/**
 * submitAndAwait: provider-independent batch driver.
 *
 *   split into jobs -> submit -> poll to a terminal state -> reconcile rows by custom_id
 *   -> re-run failed/missing rows synchronously through `resync` (the normal transport).
 *
 * Job-level failure (failed / expired / cancelled) and deadline overrun throw; the caller decides
 * what to do with the whole set (preanalyze enqueues it instead). Row-level failure never throws.
 */

import { isTransient } from './http.js';
import {
  BatchJobError,
  BatchTimeoutError,
  type BatchBackend,
  type BatchRequest,
  type BatchRow,
  type BatchRowFailure,
  type BatchRowSuccess,
} from './types.js';

/** Both providers document a 24h completion window; allow a little slack for finalization. */
export const DEFAULT_BATCH_TIMEOUT_MS = 25 * 60 * 60 * 1000;
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Consecutive transient poll failures (429/5xx/network) tolerated before giving up. */
const MAX_POLL_FAILURES = 3;

export interface SubmitOptions {
  pollIntervalMs?: number;
  /** Deadline per job, measured from submission. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Re-run one failed or missing row synchronously. Absent: failed rows stay failed. */
  resync?: (request: BatchRequest) => Promise<BatchRowSuccess>;
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  onProgress?: (message: string) => void;
}

export interface SubmitSummary {
  submitted: number;
  jobs: number;
  /** Rows the provider returned as successful. */
  succeeded: number;
  /** Rows that errored or were absent from the provider output (before resync). */
  failedRows: number;
  resynced: number;
  resyncFailed: number;
  /** custom_ids in the provider output that were never submitted (ignored). */
  unknownIds: string[];
  /** Output objects without a usable custom_id. */
  unparsed: number;
}

export interface SubmitResult {
  /** One entry per submitted request, keyed by custom_id. */
  rows: Map<string, BatchRow>;
  summary: SubmitSummary;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

async function runJob(
  backend: BatchBackend,
  requests: BatchRequest[],
  o: Required<Pick<SubmitOptions, 'pollIntervalMs' | 'timeoutMs' | 'sleep' | 'now'>> & Pick<SubmitOptions, 'signal' | 'onProgress'>,
): Promise<{ rows: BatchRow[]; unparsed: number }> {
  const jobId = await backend.submit(requests, o.signal);
  o.onProgress?.(`${backend.provider} batch ${jobId} submitted (${requests.length} requests)`);
  const deadline = o.now() + o.timeoutMs;
  let failures = 0;
  // A job we stop waiting for (abort, fatal poll error, timeout, sibling failure) keeps running and
  // billing at the provider unless cancelled. A provider-reported terminal state needs no cancel.
  let needsCancel = true;

  try {
    for (;;) {
      if (o.signal?.aborted) throw o.signal.reason;
      let result;
      try {
        result = await backend.poll(jobId, o.signal);
        failures = 0;
      } catch (err) {
        if (!isTransient(err) || ++failures >= MAX_POLL_FAILURES) throw err;
        result = { state: 'pending' as const };
      }
      if (result.state === 'done') {
        needsCancel = false;
        return { rows: result.rows, unparsed: result.unparsed ?? 0 };
      }
      if (result.state === 'failed') {
        needsCancel = false;
        throw new BatchJobError(backend.provider, jobId, result.status, result.message, result.rows ?? []);
      }
      if (o.now() >= deadline) throw new BatchTimeoutError(backend.provider, jobId, o.timeoutMs);
      await o.sleep(o.pollIntervalMs, o.signal);
    }
  } finally {
    if (needsCancel) await backend.cancel?.(jobId).catch(() => {});
  }
}

export async function submitAndAwait(
  backend: BatchBackend,
  requests: BatchRequest[],
  options: SubmitOptions = {},
): Promise<SubmitResult> {
  const ids = new Set<string>();
  for (const r of requests) {
    if (ids.has(r.customId)) throw new Error(`Duplicate batch custom_id '${r.customId}'.`);
    ids.add(r.customId);
  }
  const summary: SubmitSummary = { submitted: requests.length, jobs: 0, succeeded: 0, failedRows: 0, resynced: 0, resyncFailed: 0, unknownIds: [], unparsed: 0 };
  const rows = new Map<string, BatchRow>();
  if (requests.length === 0) return { rows, summary };

  const o = {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_BATCH_TIMEOUT_MS,
    sleep: options.sleep ?? defaultSleep,
    now: options.now ?? Date.now,
    signal: options.signal,
    onProgress: options.onProgress,
  };

  const slices: BatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += backend.maxRequestsPerJob) {
    slices.push(requests.slice(i, i + backend.maxRequestsPerJob));
  }
  summary.jobs = slices.length;
  // allSettled semantics: when one job fails, abort the siblings (each cancels its own provider job)
  // and wait for all of them before rethrowing the first real failure.
  const stop = new AbortController();
  const onCallerAbort = () => stop.abort(o.signal!.reason);
  if (o.signal?.aborted) onCallerAbort();
  else o.signal?.addEventListener('abort', onCallerAbort, { once: true });
  let firstError: { error: unknown } | undefined;
  const settled = await Promise.allSettled(slices.map(async slice => {
    try {
      return await runJob(backend, slice, { ...o, signal: stop.signal });
    } catch (error) {
      firstError ??= { error };
      stop.abort(error);
      throw error;
    }
  }));
  o.signal?.removeEventListener('abort', onCallerAbort);
  if (firstError) throw firstError.error;
  const outputs = settled.map(r => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof runJob>>>).value);

  // Reconcile by custom_id only: output order and count are not trusted.
  const first = new Map<string, BatchRow>();
  for (const out of outputs) {
    summary.unparsed += out.unparsed;
    for (const row of out.rows) {
      if (!ids.has(row.customId)) summary.unknownIds.push(row.customId);
      else if (!first.has(row.customId)) first.set(row.customId, row); // duplicates: first wins
    }
  }

  const retry: BatchRequest[] = [];
  for (const req of requests) {
    const row = first.get(req.customId);
    if (row?.ok) {
      rows.set(req.customId, row);
      summary.succeeded++;
    } else {
      const failure: BatchRowFailure = row ?? { customId: req.customId, ok: false, error: 'missing from batch output' };
      rows.set(req.customId, failure);
      summary.failedRows++;
      retry.push(req);
    }
  }

  if (options.resync) {
    // Sequential: the synchronous path is rate-limited by the provider, and failures are rare.
    for (const req of retry) {
      if (options.signal?.aborted) throw options.signal.reason;
      try {
        rows.set(req.customId, await options.resync(req));
        summary.resynced++;
      } catch (err) {
        rows.set(req.customId, { customId: req.customId, ok: false, error: err instanceof Error ? err.message : String(err) });
        summary.resyncFailed++;
      }
    }
  }
  return { rows, summary };
}
