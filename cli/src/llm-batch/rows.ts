import { extractContent } from './http.js';
import type { BatchRow } from './types.js';

/**
 * Both providers return one object per request:
 *   { id, custom_id, response: { status_code, body: <chat.completion> } | null, error: null | {...} }
 * Verified from the OpenRouter quickstart and Mistral's example output (see README); the Mistral
 * error-file row layout is NOT documented, so failures are read leniently (any non-null `error`,
 * non-200 status or missing content is a failed row).
 * Returns null when the object has no usable custom_id (counted as unparsed by the caller).
 */
export function parseResultRow(raw: unknown, priceRow?: (inputTokens: number, outputTokens: number) => number | undefined): BatchRow | null {
  const row = raw as {
    custom_id?: unknown;
    response?: { status_code?: number; body?: unknown } | null;
    error?: unknown;
  } | null;
  if (!row || typeof row.custom_id !== 'string' || row.custom_id === '') return null;
  const customId = row.custom_id;

  if (row.error !== null && row.error !== undefined) {
    const e = row.error as { message?: string };
    return { customId, ok: false, error: typeof row.error === 'string' ? row.error : e.message ?? JSON.stringify(row.error) };
  }
  const status = row.response?.status_code;
  if (status !== undefined && status !== 200) {
    const b = row.response?.body as { error?: { message?: string }; message?: string } | undefined;
    return { customId, ok: false, error: `HTTP ${status}${b?.error?.message ?? b?.message ? `: ${b?.error?.message ?? b?.message}` : ''}` };
  }
  const content = extractContent(row.response?.body);
  if (content === null) return { customId, ok: false, error: 'response had no message content' };

  const usage = (row.response?.body as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const costUsd = priceRow?.(inputTokens, outputTokens);
  return { customId, ok: true, content, inputTokens, outputTokens, ...(costUsd !== undefined && { costUsd }) };
}
