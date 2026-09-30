// Shared types and the adapter between the server's AnalysisResult contract and the unified
// analysis pipeline (cli/src/analysis/pipeline.ts). Not part of the public API — consumers
// import from analysis.ts or a specific analysis module.

import { createLLMClient, isLLMConfigured } from '@code-insights/cli/llm/client';
import { ProviderRunner } from '@code-insights/cli/analysis/provider-runner';
import {
  analyzeSessionPipeline,
  type AnalysisPass,
  type PipelineProgress,
  type PipelineResult,
} from '@code-insights/cli/analysis/pipeline';
import type { SQLiteMessageRow } from '@code-insights/cli/analysis/prompt-types';
import type { SessionData, InsightRow } from '@code-insights/cli/analysis/analysis-db';

// ─── Shared types ─────────────────────────────────────────────────────────────

export type AnalysisProgress = PipelineProgress;

export interface AnalysisOptions {
  onProgress?: (progress: AnalysisProgress) => void;
  signal?: AbortSignal;
}

export interface AnalysisResult {
  success: boolean;
  insights: InsightRow[];
  error?: string;
  error_type?: string;
  response_length?: number;
  response_preview?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic: tokens written to the prompt cache (incurs 25% surcharge). */
    cacheCreationTokens?: number;
    /** Anthropic: tokens read from the prompt cache (90% discount vs normal input). */
    cacheReadTokens?: number;
  };
}

// ─── Pipeline adapter ─────────────────────────────────────────────────────────

function toAnalysisResult(result: PipelineResult): AnalysisResult {
  if (result.success) {
    return { success: true, insights: result.insights, usage: result.usage };
  }
  return {
    success: false,
    insights: result.insights,
    error: result.error,
    error_type: result.error_type,
    ...(result.response_length !== undefined && { response_length: result.response_length }),
    ...(result.response_preview !== undefined && { response_preview: result.response_preview }),
    ...(result.usage && { usage: result.usage }),
  };
}

/**
 * Run one analysis pass for a session through the shared pipeline using the configured LLM.
 * Returns (never throws) the AnalysisResult shape the routes and SSE helpers expect.
 */
export async function runPipelinePass(
  pass: AnalysisPass,
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: AnalysisOptions,
): Promise<AnalysisResult> {
  if (!isLLMConfigured()) {
    return {
      success: false,
      insights: [],
      error: 'LLM not configured. Run `code-insights config llm` to configure a provider.',
    };
  }

  if (messages.length === 0) {
    return { success: false, insights: [], error: 'No messages found for this session.' };
  }

  try {
    const runner = ProviderRunner.fromClient(createLLMClient());
    const result = await analyzeSessionPipeline(session.id, {
      runner,
      passes: [pass],
      // The route already loaded these rows; hand them over instead of re-querying.
      input: { session, messages },
      onProgress: options?.onProgress,
      signal: options?.signal,
    });
    return toAnalysisResult(result);
  } catch (error) {
    // The pipeline returns failures; this only catches client construction errors.
    return {
      success: false,
      insights: [],
      error: error instanceof Error ? error.message : 'Analysis failed',
      error_type: 'api_error',
    };
  }
}
