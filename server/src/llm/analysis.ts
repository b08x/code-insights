// Session analysis entry point for the server. All orchestration (retrieval, related insights,
// chunking, parsing, persistence, usage/cost) lives in the shared pipeline
// (cli/src/analysis/pipeline.ts); this module only adapts it to the server's AnalysisResult.
//
// analyzePromptQuality → prompt-quality-analysis.ts
// findRecurringInsights → recurring-insights.ts
// extractFacetsOnly → facet-extraction.ts
// Shared types/helpers → analysis-internal.ts

import type { SQLiteMessageRow } from './prompt-types.js';
import type { InsightRow, SessionData } from './analysis-db.js';
import { runPipelinePass, type AnalysisProgress, type AnalysisOptions, type AnalysisResult } from './analysis-internal.js';

// Re-export from sub-modules so existing imports of these from analysis.ts keep working.
export { analyzePromptQuality } from './prompt-quality-analysis.js';
export { findRecurringInsights } from './recurring-insights.js';
export type { RecurringInsightGroup, RecurringInsightResult } from './recurring-insights.js';
export { extractFacetsOnly } from './facet-extraction.js';

// Re-export shared types (routes and route-helpers import these from analysis.ts)
export type { AnalysisProgress, AnalysisOptions, AnalysisResult };
export type { InsightRow, SessionData };

/**
 * Analyze a session and generate insights, saving them to SQLite.
 * Session pass only; the title is written by the pipeline.
 */
export function analyzeSession(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: AnalysisOptions,
): Promise<AnalysisResult> {
  return runPipelinePass('session', session, messages, options);
}
