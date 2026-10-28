import type { BatchProviderId } from './types.js';

export type FetchFn = typeof fetch;

/** Error from a batch HTTP call; `status` lets the poller treat 429/5xx as transient. */
export class BatchHttpError extends Error {
  constructor(readonly provider: BatchProviderId, readonly status: number, message: string) {
    super(message);
    this.name = 'BatchHttpError';
  }
}

export const isTransient = (err: unknown): boolean =>
  err instanceof BatchHttpError ? err.status === 429 || err.status >= 500 : err instanceof TypeError; // fetch network failure

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  try {
    const data = JSON.parse(text) as { message?: string; error?: { message?: string } | string };
    if (typeof data.error === 'string') return data.error;
    return data.error?.message ?? data.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

/** fetch + status check with the same friendly messages as the sync transports. */
export async function batchFetch(
  provider: BatchProviderId,
  label: string,
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetchFn(url, init);
  if (response.ok) return response;
  const detail = await errorDetail(response);
  if (response.status === 401 || response.status === 403) {
    throw new BatchHttpError(provider, response.status, `Invalid API key for ${label}.${detail ? ` (${detail})` : ''}`);
  }
  throw new BatchHttpError(provider, response.status, `${label} batch API error (HTTP ${response.status})${detail ? `: ${detail}` : ''}`);
}

/** Split a JSONL body into parsed objects; malformed lines are counted, not thrown. */
export function parseJsonl(text: string): { objects: unknown[]; malformed: number } {
  const objects: unknown[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      objects.push(JSON.parse(trimmed));
    } catch {
      malformed++;
    }
  }
  return { objects, malformed };
}

/** chat.completion message content is a string, or (Mistral) an array of text chunks. */
export function extractContent(body: unknown): string | null {
  const choice = (body as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(c => (typeof c === 'string' ? c : (c as { text?: string })?.text ?? '')).join('');
  }
  return null;
}
