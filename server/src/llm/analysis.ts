// Core analysis engine — server-side. Handles LLM orchestration, chunking, and response merging.
// SQLite persistence (saveInsightsToDb, saveFacetsToDb, etc.) lives in analysis-db.ts.
// Ported from web repo (src/lib/llm/analysis.ts) with SQLite persistence replacing Firestore.
// Key differences from web repo:
//   - Uses SQLiteMessageRow instead of web Message type
//   - Writes insights directly to SQLite via analysis-db.ts (not Firestore)
//   - Abort handling uses error.name === 'AbortError' (not DOMException)
//   - Uses session's existing project_id from SQLite (not re-derived hash)
//
// analyzePromptQuality → prompt-quality-analysis.ts
// findRecurringInsights → recurring-insights.ts
// extractFacetsOnly → facet-extraction.ts
// Shared types/helpers → analysis-internal.ts

import { jsonrepair } from 'jsonrepair';
import { createLLMClient, isLLMConfigured, loadLLMConfig } from './client.js';
import type { SQLiteMessageRow, AnalysisResponse } from './prompt-types.js';
import type { RelatedInsight } from './prompts.js';
import { formatMessagesForAnalysis } from './message-format.js';
import { extractJsonPayload, parseAnalysisResponse } from './response-parsers.js';
import {
  SHARED_ANALYST_SYSTEM_PROMPT,
  buildCacheableConversationBlock,
  buildSessionAnalysisInstructions,
  buildFacetOnlyInstructions,
} from './prompts.js';
import {
  ANALYSIS_VERSION,
  convertToInsightRows,
  saveInsightsToDb,
  deleteSessionInsights,
  saveFacetsToDb,
  saveSessionStepsToDb,
  type InsightRow,
  type SessionData,
} from './analysis-db.js';
import {
  MAX_INPUT_TOKENS,
  buildSessionMeta,
  type AnalysisProgress,
  type AnalysisOptions,
  type AnalysisResult,
} from './analysis-internal.js';
import { calculateAnalysisCost } from './analysis-pricing.js';
import { saveAnalysisUsage } from './analysis-usage-db.js';
import { getDb } from '@code-insights/cli/db/client';
import { loadConfig } from '@code-insights/cli/utils/config';
import * as sqliteVec from 'sqlite-vec';
import { embedOne, DEFAULT_EMBEDDING_CONFIG } from '@code-insights/cli/embeddings/client';
import { loadVectorExtension, querySimilarFiltered } from '@code-insights/cli/embeddings/store';
import type { EmbeddingConfig } from '@code-insights/cli/embeddings/types';
import { shouldUseRetrieval, retrieveAnalysisChunks, generateSessionSummary } from '@code-insights/cli/embeddings/retrieval';
import { checkEmbeddingReadiness, chunkAndEmbedSession } from '@code-insights/cli/embeddings/analysis-pipeline';

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
 */
export async function analyzeSession(
  session: SessionData,
  messages: SQLiteMessageRow[],
  options?: AnalysisOptions
): Promise<AnalysisResult> {
  if (!isLLMConfigured()) {
    return {
      success: false,
      insights: [],
      error: 'LLM not configured. Run `code-insights config llm` to configure a provider.',
    };
  }

  if (messages.length === 0) {
    return {
      success: false,
      insights: [],
      error: 'No messages found for this session.',
    };
  }

  try {
    const startTime = Date.now();
    const client = createLLMClient();
    const formattedMessages = formatMessagesForAnalysis(messages);
    const estimatedTokens = client.estimateTokens(formattedMessages);
    const sessionMeta = buildSessionMeta(session);

    // Retrieve related insights for RAG context (AutoRefine pattern)
    const retrievalConfig = getRetrievalConfig();
    const embeddingConfig: EmbeddingConfig = {
      ...DEFAULT_EMBEDDING_CONFIG,
    };
    const relatedInsights = await retrieveRelatedInsights(
      session,
      formattedMessages,
      embeddingConfig,
      retrievalConfig,
    );

    // Retrieval-augmented context for long conversations
    let retrievalContextBlock = '';
    try {
      if (shouldUseRetrieval(formattedMessages)) {
        const db = getDb();
        const readiness = checkEmbeddingReadiness(db, session.id);

        if (!readiness.ready) {
          await chunkAndEmbedSession(session.id, messages, embeddingConfig);
        }

        const sessionSummary = generateSessionSummary(messages);
        const retrieved = await retrieveAnalysisChunks(
          session.id,
          formattedMessages,
          session.summary || sessionSummary,
          session.project_name,
          sessionMeta,
          { ...retrievalConfig, maxInputTokens: MAX_INPUT_TOKENS, retrievalThresholdRatio: 0.8 },
          embeddingConfig,
        );

        if (retrieved.usedRetrieval) {
          retrievalContextBlock = `\n\n${retrieved.augmentedChunks}\n\n`;
        }
      }
    } catch {
      // Retrieval is non-fatal — fall back to full conversation
    }

    let analysisResponse: AnalysisResponse;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheCreationTokens = 0;
    let totalCacheReadTokens = 0;
    let chunkCount = 1;

    if (estimatedTokens > MAX_INPUT_TOKENS) {
      // Chunk the messages and analyze separately
      const chunks = chunkMessages(messages, client.estimateTokens.bind(client));
      const chunkResponses: AnalysisResponse[] = [];
      const totalChunks = chunks.length;
      chunkCount = totalChunks;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        options?.onProgress?.({ phase: 'analyzing', currentChunk: i + 1, totalChunks });

        const chunkFormatted = formatMessagesForAnalysis(chunk);
        const response = await client.chat([
          { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
          { role: 'user', content: [
            buildCacheableConversationBlock(chunkFormatted),
            { type: 'text' as const, text: `${retrievalContextBlock}${buildSessionAnalysisInstructions(session.project_name, session.summary, sessionMeta, undefined, relatedInsights)}` },
          ] },
        ], { signal: options?.signal });

        if (response.usage) {
          totalInputTokens += response.usage.inputTokens;
          totalOutputTokens += response.usage.outputTokens;
          totalCacheCreationTokens += response.usage.cacheCreationTokens ?? 0;
          totalCacheReadTokens += response.usage.cacheReadTokens ?? 0;
        }

        const parsed = parseAnalysisResponse(response.content);
        if (parsed.success) chunkResponses.push(parsed.data);
      }

      if (chunkResponses.length === 0) {
        return {
          success: false,
          insights: [],
          error: 'All chunks failed to parse LLM response',
          error_type: 'json_parse_error',
          usage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
        };
      }

      analysisResponse = mergeAnalysisResponses(chunkResponses);

      // Chunked sessions: extract facets separately using dedicated facet prompt
      // (facets are holistic — can't be merged across chunks)
      if (!analysisResponse.facets) {
        try {
          // Use full conversation for best quality; truncate here if exceeding token limits
          let facetMessages = formatMessagesForAnalysis(messages);
          const facetTokens = client.estimateTokens(facetMessages);
          if (facetTokens > MAX_INPUT_TOKENS) {
            const targetLength = Math.floor((MAX_INPUT_TOKENS / facetTokens) * facetMessages.length * 0.8);
            facetMessages = facetMessages.slice(0, targetLength) + '\n\n[... conversation truncated for analysis ...]';
          }
          const facetResponse = await client.chat([
            { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
            { role: 'user', content: [
              buildCacheableConversationBlock(facetMessages),
              { type: 'text' as const, text: buildFacetOnlyInstructions(session.project_name, session.summary, sessionMeta, undefined, relatedInsights) },
            ] },
          ], { signal: options?.signal });

          if (facetResponse.usage) {
            totalInputTokens += facetResponse.usage.inputTokens;
            totalOutputTokens += facetResponse.usage.outputTokens;
            totalCacheCreationTokens += facetResponse.usage.cacheCreationTokens ?? 0;
            totalCacheReadTokens += facetResponse.usage.cacheReadTokens ?? 0;
          }

          const facetJson = extractJsonPayload(facetResponse.content);
          if (facetJson) {
            try {
              analysisResponse.facets = JSON.parse(facetJson);
            } catch {
              // jsonrepair fallback
              try {
                analysisResponse.facets = JSON.parse(jsonrepair(facetJson));
              } catch {
                // Facet extraction failed for chunked session — non-fatal
              }
            }
          }
        } catch {
          // Facet extraction failed for chunked session — non-fatal, continue
        }
      }
    } else {
      options?.onProgress?.({ phase: 'analyzing', currentChunk: 1, totalChunks: 1 });
      const response = await client.chat([
        { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
        { role: 'user', content: [
          buildCacheableConversationBlock(formattedMessages),
          { type: 'text' as const, text: `${retrievalContextBlock}${buildSessionAnalysisInstructions(session.project_name, session.summary, sessionMeta, undefined, relatedInsights)}` },
        ] },
      ], { signal: options?.signal });

      if (response.usage) {
        totalInputTokens = response.usage.inputTokens;
        totalOutputTokens = response.usage.outputTokens;
        totalCacheCreationTokens = response.usage.cacheCreationTokens ?? 0;
        totalCacheReadTokens = response.usage.cacheReadTokens ?? 0;
      }

      const parsed = parseAnalysisResponse(response.content);
      if (!parsed.success) {
        return {
          success: false,
          insights: [],
          error: 'Failed to parse LLM response. Please try again.',
          error_type: parsed.error.error_type,
          response_length: parsed.error.response_length,
          response_preview: parsed.error.response_preview,
        };
      }

      analysisResponse = parsed.data;
    }

    options?.onProgress?.({ phase: 'saving' });
    const insights = convertToInsightRows(analysisResponse, session);

    // Save new insights first, then delete old non-prompt-quality insights
    // (safe order: if save fails, old data is preserved)
    saveInsightsToDb(insights);
    deleteSessionInsights(session.id, {
      excludeTypes: ['prompt_quality'],
      excludeIds: insights.map(i => i.id),
    });

    // Save facets if extracted
    if (analysisResponse.facets) {
      saveFacetsToDb(session.id, analysisResponse.facets, ANALYSIS_VERSION);
    }

    if (analysisResponse.step_matrix && analysisResponse.step_matrix.length > 0) {
      saveSessionStepsToDb(session.id, analysisResponse.step_matrix);
    }

    // Record analysis cost to analysis_usage table (V7).
    // Chunk token counts are already summed into totalInputTokens/etc above,
    // so a single INSERT OR REPLACE captures the full cost of all chunks.
    const llmConfig = loadLLMConfig();
    if (llmConfig && (totalInputTokens > 0 || totalOutputTokens > 0)) {
      const costUsd = calculateAnalysisCost(llmConfig.provider, llmConfig.model, {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheCreationTokens: totalCacheCreationTokens,
        cacheReadTokens: totalCacheReadTokens,
      });
      saveAnalysisUsage({
        session_id: session.id,
        analysis_type: 'session',
        provider: llmConfig.provider,
        model: llmConfig.model,
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cache_creation_tokens: totalCacheCreationTokens,
        cache_read_tokens: totalCacheReadTokens,
        estimated_cost_usd: costUsd,
        duration_ms: Date.now() - startTime,
        chunk_count: chunkCount,
      });
    }

    return {
      success: true,
      insights,
      usage: {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        ...(totalCacheCreationTokens > 0 && { cacheCreationTokens: totalCacheCreationTokens }),
        ...(totalCacheReadTokens > 0 && { cacheReadTokens: totalCacheReadTokens }),
      },
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { success: false, insights: [], error: 'Analysis cancelled', error_type: 'abort' };
    }
    return {
      success: false,
      insights: [],
      error: error instanceof Error ? error.message : 'Analysis failed',
      error_type: 'api_error',
    };
  }
}

// --- Retrieval-augmented insight generation ---

interface RetrievalConfig {
  enabled: boolean;
  topK: number;
  similarityThreshold: number;
  sameProjectOnly: boolean;
}

const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  enabled: true,
  topK: 5,
  similarityThreshold: 0.75,
  sameProjectOnly: true,
};

function getRetrievalConfig(): RetrievalConfig {
  const config = loadConfig();
  const retrieval = config?.dashboard?.analysis?.retrieval;
  return {
    enabled: retrieval?.enabled ?? DEFAULT_RETRIEVAL_CONFIG.enabled,
    topK: retrieval?.topK ?? DEFAULT_RETRIEVAL_CONFIG.topK,
    similarityThreshold: retrieval?.similarityThreshold ?? DEFAULT_RETRIEVAL_CONFIG.similarityThreshold,
    sameProjectOnly: retrieval?.sameProjectOnly ?? DEFAULT_RETRIEVAL_CONFIG.sameProjectOnly,
  };
}

/**
 * Retrieve semantically similar past insights for the same project.
 *
 * 1. Embed the session's formatted messages (or use pre-computed session embedding)
 * 2. Query sqlite-vec for top-K similar past insights
 * 3. Filter by same project_id for relevance
 * 4. Apply similarity threshold
 * 5. Return as RelatedInsight[] for prompt injection
 */
async function retrieveRelatedInsights(
  session: { id: string; project_id: string },
  formattedMessages: string,
  embeddingConfig: EmbeddingConfig,
  retrievalConfig: RetrievalConfig,
): Promise<RelatedInsight[]> {
  if (!retrievalConfig.enabled) return [];

  try {
    const db = getDb();

    // Ensure sqlite-vec extension is loaded
    loadVectorExtension(db);

    // Check if the vector table exists
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_insights'"
    ).get() as { name: string } | undefined;

    if (!tableCheck) {
      return [];
    }

    // Embed the session text (truncate to avoid excessive token usage)
    const maxEmbedChars = 4000;
    const textToEmbed = formattedMessages.length > maxEmbedChars
      ? formattedMessages.slice(0, maxEmbedChars)
      : formattedMessages;

    const embedding = await embedOne(embeddingConfig, `session-${session.id}`, textToEmbed);

    // Query for similar insights, filtered by project
    const candidates = querySimilarFiltered(
      db,
      'insight',
      embedding.vector,
      retrievalConfig.topK,
      session.project_id,
    );

    if (candidates.length === 0) return [];

    // Fetch insight details for the candidates
    const ids = candidates.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, type, title, content, confidence FROM insights WHERE id IN (${placeholders})`
    ).all(...ids) as Array<{
      id: string;
      type: string;
      title: string;
      content: string;
      confidence: number;
    }>;

    // Build a map for ordering by similarity
    const insightMap = new Map(rows.map(r => [r.id, r]));

    // Convert to RelatedInsight[], ordered by similarity, filtered by threshold
    const results: RelatedInsight[] = [];
    for (const candidate of candidates) {
      const insight = insightMap.get(candidate.id);
      if (!insight) continue;

      // Convert distance to similarity (cosine similarity ~ 1 - distance for unit vectors)
      const similarity = 1 - candidate.distance;
      if (similarity < retrievalConfig.similarityThreshold) continue;

      results.push({
        type: insight.type,
        title: insight.title,
        content: insight.content.slice(0, 300),
        confidence: insight.confidence,
      });

      if (results.length >= retrievalConfig.topK) break;
    }

    return results;
  } catch {
    // Retrieval failure is non-fatal — fall back to analysis without related insights
    return [];
  }
}

// --- Internal helpers ---

function chunkMessages(
  messages: SQLiteMessageRow[],
  estimateTokens: (text: string) => number
): SQLiteMessageRow[][] {
  const chunks: SQLiteMessageRow[][] = [];
  let currentChunk: SQLiteMessageRow[] = [];
  let currentTokens = 0;
  const chunkLimit = MAX_INPUT_TOKENS * 0.8;

  for (const message of messages) {
    let toolResults: Array<{ output?: string }> = [];
    try {
      toolResults = message.tool_results ? JSON.parse(message.tool_results) as Array<{ output?: string }> : [];
    } catch {
      toolResults = [];
    }

    const messageText = [
      message.content,
      message.thinking?.slice(0, 1000) ?? '',
      ...toolResults.map(r => (r.output || '').slice(0, 500)),
    ].join(' ');
    const messageTokens = estimateTokens(messageText);

    if (currentTokens + messageTokens > chunkLimit && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(message);
    currentTokens += messageTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function mergeAnalysisResponses(responses: AnalysisResponse[]): AnalysisResponse {
  if (responses.length === 0) {
    return {
      summary: { title: 'Analysis failed', content: '', bullets: [] },
      decisions: [],
      learnings: [],
    };
  }

  if (responses.length === 1) return responses[0];

  const merged: AnalysisResponse = {
    summary: responses[0].summary,
    decisions: [],
    learnings: [],
  };

  for (const response of responses) {
    merged.decisions.push(...response.decisions);
    merged.learnings.push(...response.learnings);
  }

  merged.decisions = deduplicateByTitle(merged.decisions).slice(0, 3);
  merged.learnings = deduplicateByTitle(merged.learnings).slice(0, 5);

  return merged;
}

function deduplicateByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const normalized = item.title.toLowerCase().trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}
