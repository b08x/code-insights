/**
 * Mistral batch backend. Endpoints (docs.mistral.ai/api/endpoint/batch, verified 2026-09-30):
 *   POST /v1/batch/jobs                      { endpoint, model, requests[<=10000], timeout_hours, metadata }
 *   GET  /v1/batch/jobs/{id}?inline=true     job + `outputs` (inline results)
 *   GET  /v1/files/{file_id}/content         output_file / error_file (JSONL)
 *   POST /v1/batch/jobs/{id}/cancel
 * Job status: QUEUED RUNNING SUCCESS FAILED TIMEOUT_EXCEEDED CANCELLATION_REQUESTED CANCELLED.
 * Inline requests are used (no file upload), so a job carries at most 9,999 requests.
 */

import { calculateAnalysisCost } from '../analysis/analysis-pricing.js';
import { batchFetch, parseJsonl, type FetchFn } from './http.js';
import { parseResultRow } from './rows.js';
import { BATCH_DISCOUNT, type BatchBackend, type BatchPollResult, type BatchRequest, type BatchRow } from './types.js';

const BASE = 'https://api.mistral.ai';
/** Docs: "fewer than 10,000 requests" for inline batching (OpenAPI maxItems is 10000). */
export const MISTRAL_MAX_INLINE_REQUESTS = 9_999;

interface MistralJob {
  id: string;
  status: string;
  output_file?: string | null;
  error_file?: string | null;
  outputs?: unknown[] | null;
  errors?: Array<{ message: string; count?: number }>;
}

export interface MistralBatchOptions {
  apiKey: string;
  model: string;
  fetch?: FetchFn;
  /** Job expiry (Mistral `timeout_hours`, 1-168, default 24). */
  timeoutHours?: number;
}

export function createMistralBatchBackend(opts: MistralBatchOptions): BatchBackend {
  const fetchFn = opts.fetch ?? fetch;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.apiKey}` };
  const call = (path: string, init: RequestInit) => batchFetch('mistral', 'Mistral', fetchFn, `${BASE}${path}`, { headers, ...init });

  const price = (i: number, o: number) =>
    Math.round(BATCH_DISCOUNT * calculateAnalysisCost('mistral', opts.model, { inputTokens: i, outputTokens: o }) * 1_000_000) / 1_000_000;

  async function download(fileId: string, signal?: AbortSignal): Promise<BatchRow[]> {
    const res = await call(`/v1/files/${fileId}/content`, { signal });
    const { objects } = parseJsonl(await res.text());
    return objects.map(o => parseResultRow(o, price)).filter((r): r is BatchRow => r !== null);
  }

  /** Output rows from `outputs` (inline) or the output/error files; empty when nothing is available. */
  async function collectRows(job: MistralJob, signal?: AbortSignal): Promise<BatchRow[]> {
    const rows: BatchRow[] = [];
    if (job.outputs && job.outputs.length > 0) {
      for (const o of job.outputs) {
        const r = parseResultRow(o, price);
        if (r) rows.push(r);
      }
    } else if (job.output_file) {
      rows.push(...await download(job.output_file, signal));
    }
    if (job.error_file) rows.push(...await download(job.error_file, signal));
    return rows;
  }

  return {
    provider: 'mistral',
    model: opts.model,
    maxRequestsPerJob: MISTRAL_MAX_INLINE_REQUESTS,

    async submit(requests: BatchRequest[], signal) {
      const res = await call('/v1/batch/jobs', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          endpoint: '/v1/chat/completions',
          model: opts.model,
          requests: requests.map(r => ({ custom_id: r.customId, body: r.body })),
          timeout_hours: opts.timeoutHours ?? 24,
          metadata: { source: 'code-insights' },
        }),
      });
      const job = await res.json() as MistralJob;
      if (!job.id) throw new Error('Mistral batch API returned no job id.');
      return job.id;
    },

    async poll(jobId, signal): Promise<BatchPollResult> {
      const res = await call(`/v1/batch/jobs/${jobId}?inline=true`, { signal });
      const job = await res.json() as MistralJob;
      switch (job.status) {
        case 'SUCCESS':
          return { state: 'done', rows: await collectRows(job, signal) };
        case 'FAILED':
        case 'TIMEOUT_EXCEEDED':
        case 'CANCELLED': {
          // Partial output on a terminal non-success job is undocumented: take it when present.
          const rows = await collectRows(job, signal).catch(() => []);
          return { state: 'failed', status: job.status, message: job.errors?.map(e => e.message).join('; ') || job.status, rows };
        }
        default: // QUEUED, RUNNING, CANCELLATION_REQUESTED, anything new
          return { state: 'pending' };
      }
    },

    async cancel(jobId) {
      await call(`/v1/batch/jobs/${jobId}/cancel`, { method: 'POST' });
    },
  };
}
