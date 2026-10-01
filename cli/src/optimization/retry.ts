/**
 * Per-call retry for optimization backends (engine-16).
 *
 * One rate-limit error must cost one call's retry, never a restart of the whole run, so retries
 * live around each transport call (student, judge, batch resync) instead of around GEPA.compile.
 * Only transient failures retry: 429 / 5xx / network resets / provider overload. Cancellation,
 * identity mismatches, parse failures and 4xx errors surface immediately.
 */

export interface RetryOptions {
  /** Total attempts including the first. Default 4. */
  attempts?: number;
  /** First backoff; doubles each retry. Default 1000 ms. */
  baseDelayMs?: number;
  /** Upper bound of one backoff. Default 30 s. */
  maxDelayMs?: number;
  /** Test seam; rejects with the signal's reason when aborted. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  /** Called before each retry (log, accounting). */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  isTransient?: (error: unknown) => boolean;
}

const TRANSIENT_MESSAGE = /rate.?limit|too many requests|\b429\b|\b50[0234]\b|overloaded|timeout|timed out|econnreset|etimedout|econnrefused|socket hang up|fetch failed|network|temporar|try again/i;

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: string; status?: number; statusCode?: number; code?: string; message?: string };
  if (e.name === 'AbortError' || e.name === 'IdentityMismatchError') return false;
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  return TRANSIENT_MESSAGE.test(`${e.code ?? ''} ${e.message ?? ''}`);
}

export const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export async function retryCall<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const transient = opts.isTransient ?? isTransientError;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (opts.signal?.aborted || attempt >= attempts || !transient(err)) throw err;
      const delay = Math.min(max, base * 2 ** (attempt - 1));
      opts.onRetry?.(attempt, err, delay);
      await sleep(delay, opts.signal);
    }
  }
}
