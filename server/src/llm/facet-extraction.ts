// Facet-only extraction — backfill path for sessions that already have insights.
// This is the `facets` pass of the shared pipeline (cli/src/analysis/pipeline.ts): full
// conversation (head+tail truncated to the budget), jsonrepair fallback, pattern normalization
// on save and 'facet' usage recording all live there.

import type { SQLiteMessageRow } from '@code-insights/cli/analysis/prompt-types';
import type { SessionData } from '@code-insights/cli/analysis/analysis-db';
import { runPipelinePass } from './analysis-internal.js';

export async function extractFacetsOnly(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: { signal?: AbortSignal },
): Promise<{ success: boolean; error?: string }> {
  const result = await runPipelinePass('facets', session, messages, options);
  if (result.success) return { success: true };
  return { success: false, error: result.error_type === 'abort' ? 'Cancelled' : result.error };
}
