// Prompt quality analysis — the prompt-quality pass of the shared pipeline
// (cli/src/analysis/pipeline.ts): genuine-human-message gate, session-shape counts, truncation,
// timeout, persistence and usage all live there.

import type { SQLiteMessageRow } from '@code-insights/cli/analysis/prompt-types';
import type { SessionData } from '@code-insights/cli/analysis/analysis-db';
import { runPipelinePass, type AnalysisOptions, type AnalysisResult } from './analysis-internal.js';

/**
 * Analyze prompt quality for a session.
 */
export function analyzePromptQuality(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: AnalysisOptions,
): Promise<AnalysisResult> {
  return runPipelinePass('prompt_quality', session, messages, options);
}
