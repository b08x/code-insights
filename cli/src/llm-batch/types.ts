/**
 * Shared shapes for the provider batch clients (Mistral, OpenRouter).
 *
 * Everything provider-specific (HTTP paths, status names, result row layout) stays inside
 * mistral.ts / openrouter.ts; submitAndAwait and its callers only see these types. That is the
 * seam that absorbs API drift (OpenRouter Batch launched 2026-09-22): a shape change touches one
 * backend file and its fixture test.
 */

export type BatchProviderId = 'mistral' | 'openrouter';

/** Both providers accept an OpenAI-style chat completion body per request. */
export interface BatchChatBody {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature?: number;
  max_tokens?: number;
}

export interface BatchRequest {
  /** Unique within one submitAndAwait call; the only key used to match results back. */
  customId: string;
  body: BatchChatBody;
}

export interface BatchRowSuccess {
  customId: string;
  ok: true;
  content: string;
  inputTokens: number;
  outputTokens: number;
  /** Discounted cost of this row when computable. */
  costUsd?: number;
}

export interface BatchRowFailure {
  customId: string;
  ok: false;
  error: string;
}

export type BatchRow = BatchRowSuccess | BatchRowFailure;

export type BatchPollResult =
  | { state: 'pending' }
  /** Terminal success: `rows` holds every row the provider reported (successes and errors). */
  | { state: 'done'; rows: BatchRow[]; /** Ids present in the output that this backend could not parse into a row. */ unparsed?: number }
  /** Terminal non-success (failed / expired / cancelled / timeout). `rows` = any partial output. */
  | { state: 'failed'; status: string; message: string; rows?: BatchRow[] };

export interface BatchBackend {
  readonly provider: BatchProviderId;
  readonly model: string;
  /** Requests per job. Mistral inline batching is capped below 10,000; OpenRouter documents no cap. */
  readonly maxRequestsPerJob: number;
  /** Create the job; resolves with the provider job id. */
  submit(requests: BatchRequest[], signal?: AbortSignal): Promise<string>;
  poll(jobId: string, signal?: AbortSignal): Promise<BatchPollResult>;
  /** Best-effort; errors are swallowed by the caller. */
  cancel?(jobId: string): Promise<void>;
}

/** Terminal job that produced no usable result set (failed / expired / cancelled). */
export class BatchJobError extends Error {
  constructor(
    readonly provider: BatchProviderId,
    readonly jobId: string,
    readonly status: string,
    message: string,
    /** Partial rows the provider did return, if any. */
    readonly partialRows: BatchRow[] = [],
  ) {
    super(`${provider} batch ${jobId} ${status}: ${message}`);
    this.name = 'BatchJobError';
  }
}

/** The job did not reach a terminal state before the caller's deadline. */
export class BatchTimeoutError extends Error {
  constructor(readonly provider: BatchProviderId, readonly jobId: string, readonly timeoutMs: number) {
    super(`${provider} batch ${jobId} did not finish within ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'BatchTimeoutError';
  }
}

/** Per-row discount applied by both providers to list prices. */
export const BATCH_DISCOUNT = 0.5;
