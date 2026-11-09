/**
 * OpenRouter batch backend. Endpoints (openrouter.ai/docs/batch-quickstart, verified 2026-09-30):
 *   POST /api/v1/batches   { endpoint, model, completion_window: '24h', requests: [{custom_id, body}] }
 *                          -> 202 { id, status: 'validating', ... }. `requests` MUST be serialized last.
 *   GET  /api/v1/batches/{id}
 *                          -> { status, request_counts, usage{cost,...}, results[] | null, error | null }
 * Status: validating -> in_progress -> finalizing -> completed; also failed, expired, cancelling,
 * cancelled. `results` is non-null only when status is `completed` (no separate download endpoint).
 * Results live 30 days; per-request bans (stream, empty input, ...) fail the WHOLE batch after the
 * 202, with `error` explaining it.
 */

import { batchFetch, type FetchFn } from './http.js';
import { parseResultRow } from './rows.js';
import { batchPrice } from './pricing.js';
import type { BatchBackend, BatchPollResult, BatchRequest, BatchRow } from './types.js';

const BASE = 'https://openrouter.ai/api/v1';

interface OpenRouterBatch {
  id: string;
  status: string;
  usage?: { cost?: number; is_byok?: boolean } | null;
  results?: unknown[] | null;
  error?: { code?: number; message?: string } | null;
}

export interface OpenRouterBatchOptions {
  apiKey: string;
  model: string;
  fetch?: FetchFn;
}

/**
 * OpenRouter reports one batch-level `usage.cost`, not a per-row cost. Split it across successful
 * rows by token share so per-session cost sums back to the authoritative total.
 */
function apportionCost(rows: BatchRow[], totalCost: number): BatchRow[] {
  const ok = rows.filter((r): r is Extract<BatchRow, { ok: true }> => r.ok);
  const tokens = ok.reduce((s, r) => s + r.inputTokens + r.outputTokens, 0);
  return rows.map(r => {
    if (!r.ok) return r;
    const share = tokens > 0 ? (r.inputTokens + r.outputTokens) / tokens : 1 / ok.length;
    return { ...r, costUsd: Math.round(totalCost * share * 1_000_000) / 1_000_000 };
  });
}

export function createOpenRouterBatchBackend(opts: OpenRouterBatchOptions): BatchBackend {
  const fetchFn = opts.fetch ?? fetch;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${opts.apiKey}`,
    'HTTP-Referer': 'http://localhost:7890',
    'X-Title': 'Code Insights',
  };
  const call = (path: string, init: RequestInit) => batchFetch('openrouter', 'OpenRouter', fetchFn, `${BASE}${path}`, { headers, ...init });
  // Fallback when the batch carries no usage.cost: list price x the documented 50% batch discount.
  const listPrice = (i: number, o: number) => batchPrice('openrouter', opts.model, i, o);

  return {
    provider: 'openrouter',
    model: opts.model,
    // No documented per-batch request cap (unverified); one job per call keeps the client simple.
    maxRequestsPerJob: Number.MAX_SAFE_INTEGER,

    async submit(requests: BatchRequest[], signal) {
      // Key order matters: the API stream-parses the body and 400s if `requests` comes first.
      const body = JSON.stringify({
        endpoint: '/v1/chat/completions',
        model: opts.model,
        completion_window: '24h',
        requests: requests.map(r => ({ custom_id: r.customId, body: r.body })),
      });
      const res = await call('/batches', { method: 'POST', signal, body });
      const batch = await res.json() as OpenRouterBatch;
      if (!batch.id) throw new Error('OpenRouter batch API returned no batch id.');
      return batch.id;
    },

    async poll(jobId, signal): Promise<BatchPollResult> {
      const res = await call(`/batches/${jobId}`, { signal });
      const batch = await res.json() as OpenRouterBatch;
      switch (batch.status) {
        case 'completed': {
          const parsed = (batch.results ?? []).map(r => parseResultRow(r, listPrice));
          let rows = parsed.filter((r): r is BatchRow => r !== null);
          const total = batch.usage?.cost;
          if (typeof total === 'number' && rows.some(r => r.ok)) rows = apportionCost(rows, total);
          return { state: 'done', rows, unparsed: parsed.length - rows.length };
        }
        case 'failed':
        case 'expired':
        case 'cancelled':
          return { state: 'failed', status: batch.status, message: batch.error?.message ?? batch.status };
        default: // validating, in_progress, finalizing, cancelling, anything new
          return { state: 'pending' };
      }
    },

    async cancel(jobId) {
      // Cancel endpoint is not in the pages verified for this client; callers swallow the error.
      await call(`/batches/${jobId}/cancel`, { method: 'POST' });
    },
  };
}
