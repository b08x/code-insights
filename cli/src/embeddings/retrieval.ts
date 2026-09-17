// Shared retrieval layer for long conversation analysis.
// Used by both CLI (insights check --analyze) and server (analyzeSession).
// Handles threshold detection, dynamic query construction, and context augmentation.

import type Database from 'better-sqlite3';
import { getDb } from '../db/client.js';
import type { SQLiteMessageRow } from '../analysis/prompt-types.js';
import type { EmbeddingConfig } from './types.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';
import { embedOne, embedTexts } from './ollama-client.js';
import { loadVecExtension } from './analysis-chunks-store.js';
import {
  querySimilarChunksFiltered,
  getChunksBySession,
  areChunksReady,
} from './analysis-chunks-store.js';
import { chunkText } from './chunker.js';
import type { ChunkPhase } from './annotated-chunker.js';

// ── Types ────────────────────────────────────────────────────────────────────

export interface RetrievalContext {
  /** Retrieved chunks formatted for prompt injection */
  augmentedChunks: string;
  /** Position tags for orientation */
  positionTags: string[];
  /** Total tokens in retrieved context (estimated) */
  estimatedTokens: number;
  /** Number of chunks retrieved */
  chunkCount: number;
  /** Whether this session used retrieval (false if below threshold) */
  usedRetrieval: boolean;
}

export interface RetrievalConfig {
  enabled: boolean;
  topK: number;
  similarityThreshold: number;
  sameProjectOnly: boolean;
  /** Max context window tokens for the model */
  maxInputTokens: number;
  /** Threshold ratio to trigger retrieval (0-1) */
  retrievalThresholdRatio: number;
}

export const DEFAULT_RETRIEVAL: RetrievalConfig = {
  enabled: true,
  topK: 20,
  similarityThreshold: 0.5,
  sameProjectOnly: true,
  maxInputTokens: 128_000,
  retrievalThresholdRatio: 0.8,
};

// ── Threshold detection ──────────────────────────────────────────────────────

/**
 * Estimate tokens in a text (rough: 1 token ≈ 4 chars).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Check if a session exceeds the retrieval threshold.
 * Returns true if the conversation is too long and should use retrieval.
 */
export function shouldUseRetrieval(
  formattedMessages: string,
  config: RetrievalConfig = DEFAULT_RETRIEVAL,
): boolean {
  if (!config.enabled) return false;
  const tokens = estimateTokens(formattedMessages);
  return tokens > config.maxInputTokens * config.retrievalThresholdRatio;
}

// ── Dynamic query construction ───────────────────────────────────────────────

/**
 * Build a dynamic query for chunk retrieval.
 * Combines: analysis instructions + session summary + related past insights.
 * Adapts per session to resist shortcut learning.
 */
function buildRetrievalQuery(
  sessionSummary: string | null,
  projectName: string,
  sessionMeta?: { compactCount?: number; autoCompactCount?: number },
): string {
  const parts: string[] = [];

  parts.push('Find conversation segments most relevant to session analysis.');

  if (projectName) {
    parts.push(`Project: ${projectName}`);
  }

  if (sessionSummary) {
    parts.push(`Session summary: ${sessionSummary.slice(0, 500)}`);
  }

  if (sessionMeta?.compactCount && sessionMeta.compactCount > 0) {
    parts.push(`Session had ${sessionMeta.compactCount} compactions.`);
  }

  parts.push('Focus on: decisions made, errors encountered, patterns established, key insights.');

  return parts.join(' ');
}

// ── Context augmentation ─────────────────────────────────────────────────────

/**
 * Augment retrieved chunks with window context and position tags.
 * Hybrid B+C: window augmentation (summary + position) + neighbor inclusion.
 */
function augmentRetrievedChunks(
  chunks: Array<{
    id: string;
    content: string;
    phase: string;
    significance: string;
    whyContext: string;
    chunkIndex: number;
    distance: number;
  }>,
  allChunks: Array<{ chunk_index: number; content: string }>,
  totalMessages: number,
): { augmented: string[]; positionTags: string[] } {
  const augmented: string[] = [];
  const positionTags: string[] = [];

  // Build a map for neighbor lookup
  const chunkMap = new Map(allChunks.map(c => [c.chunk_index, c]));

  for (const chunk of chunks) {
    // Position tag
    const positionTag = `turn ${chunk.chunkIndex + 1} of ~${Math.ceil(totalMessages / 5)}`;
    positionTags.push(positionTag);

    // Neighbor inclusion (±1 adjacent chunks)
    const prevChunk = chunkMap.get(chunk.chunkIndex - 1);
    const nextChunk = chunkMap.get(chunk.chunkIndex + 1);

    let contextParts: string[] = [];
    contextParts.push(`[Position: ${positionTag}]`);
    contextParts.push(`[Phase: ${chunk.phase} | Significance: ${chunk.significance}]`);

    if (chunk.whyContext) {
      contextParts.push(`[Why it matters: ${chunk.whyContext}]`);
    }

    if (prevChunk) {
      const prevPreview = prevChunk.content.slice(0, 200);
      contextParts.push(`\n<prev_context>\n${prevPreview}\n</prev_context>`);
    }

    contextParts.push(`\n<segment>\n${chunk.content}\n</segment>`);

    if (nextChunk) {
      const nextPreview = nextChunk.content.slice(0, 200);
      contextParts.push(`\n<next_context>\n${nextPreview}\n</next_context>`);
    }

    augmented.push(contextParts.join('\n'));
  }

  return { augmented, positionTags };
}

/**
 * Deduplicate overlapping neighbor previews to control token cost.
 */
function deduplicateChunks(chunks: string[]): string[] {
  const seen = new Set<string>();
  return chunks.filter(chunk => {
    // Use first 100 chars as dedup key
    const key = chunk.slice(0, 100);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Main retrieval function ──────────────────────────────────────────────────

/**
 * Retrieve relevant chunks for a session's analysis.
 *
 * Flow:
 * 1. Check threshold — if below, return (no retrieval needed)
 * 2. Check embedding readiness
 * 3. Build dynamic query from session context
 * 4. Embed query vector
 * 5. KNN search against vec_analysis_chunks
 * 6. Augment retrieved chunks with window + neighbors
 * 7. Return formatted context for prompt injection
 */
export async function retrieveAnalysisChunks(
  sessionId: string,
  formattedMessages: string,
  sessionSummary: string | null,
  projectName: string,
  sessionMeta?: { compactCount?: number; autoCompactCount?: number },
  config: RetrievalConfig = DEFAULT_RETRIEVAL,
  embeddingConfig: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG,
): Promise<RetrievalContext> {
  const emptyContext: RetrievalContext = {
    augmentedChunks: '',
    positionTags: [],
    estimatedTokens: 0,
    chunkCount: 0,
    usedRetrieval: false,
  };

  // 1. Check threshold
  if (!shouldUseRetrieval(formattedMessages, config)) {
    return emptyContext;
  }

  const db = getDb();
  loadVecExtension(db);

  // 2. Check embedding readiness
  if (!areChunksReady(db, sessionId)) {
    return emptyContext;
  }

  // 3. Build dynamic query
  const queryText = buildRetrievalQuery(sessionSummary, projectName, sessionMeta);

  try {
    // 4. Embed query
    const queryEmbedding = await embedOne(embeddingConfig, `query-${sessionId}`, queryText);

    // 5. KNN search
    const candidates = querySimilarChunksFiltered(
      db,
      queryEmbedding.vector,
      config.topK,
      sessionId, // exclude self
    );

    if (candidates.length === 0) {
      return emptyContext;
    }

    // 6. Fetch full chunk content
    const chunkIds = candidates.map(c => c.id);
    const placeholders = chunkIds.map(() => '?').join(',');
    const chunkRows = db.prepare(`
      SELECT id, chunk_index, content, phase, significance, why_context
      FROM analysis_chunks
      WHERE id IN (${placeholders})
    `).all(...chunkIds) as Array<{
      id: string;
      chunk_index: number;
      content: string;
      phase: string;
      significance: string;
      why_context: string;
    }>;

    // Map candidates to full data
    const chunkDataMap = new Map(chunkRows.map(r => [r.id, r]));
    const enrichedCandidates = candidates
      .map(c => {
        const data = chunkDataMap.get(c.id);
        if (!data) return null;
        return {
          id: c.id,
          content: data.content,
          phase: data.phase,
          significance: data.significance,
          whyContext: data.why_context,
          chunkIndex: data.chunk_index,
          distance: c.distance,
        };
      })
      .filter(Boolean) as Array<{
        id: string;
        content: string;
        phase: string;
        significance: string;
        whyContext: string;
        chunkIndex: number;
        distance: number;
      }>;

    // 7. Get all chunks for neighbor context
    const allChunks = getChunksBySession(db, sessionId);
    const totalMessages = allChunks.reduce((acc, c) => {
      try {
        const ids = JSON.parse(c.message_ids || '[]');
        return acc + ids.length;
      } catch { return acc; }
    }, 0);

    // 8. Augment with window + neighbors
    const { augmented, positionTags } = augmentRetrievedChunks(
      enrichedCandidates,
      allChunks.map(c => ({ chunk_index: c.chunk_index, content: c.content })),
      totalMessages || formattedMessages.split('\n').length,
    );

    // 9. Deduplicate
    const deduped = deduplicateChunks(augmented);

    // 10. Build final context
    const contextBlock = [
      '## Retrieved Context (most relevant segments)',
      '',
      'The following segments were retrieved as most relevant to this analysis:',
      '',
      ...deduped,
    ].join('\n');

    const estimatedTokens = estimateTokens(contextBlock);

    return {
      augmentedChunks: contextBlock,
      positionTags,
      estimatedTokens,
      chunkCount: deduped.length,
      usedRetrieval: true,
    };
  } catch (err) {
    // Retrieval failure is non-fatal
    return emptyContext;
  }
}

// ── Utility: session summary generation ──────────────────────────────────────

/**
 * Generate a compact session summary for query construction.
 * Uses first/last messages + key signals.
 */
export function generateSessionSummary(
  messages: SQLiteMessageRow[],
  maxLength: number = 500,
): string {
  if (messages.length === 0) return '';

  const parts: string[] = [];

  // First user message
  const firstUser = messages.find(m => m.type === 'user');
  if (firstUser) {
    parts.push(`Start: ${firstUser.content.slice(0, 200)}`);
  }

  // Count tools used
  const tools = new Set<string>();
  for (const m of messages) {
    try {
      const calls = JSON.parse(m.tool_calls || '[]') as Array<{ name?: string }>;
      for (const c of calls) {
        if (c.name) tools.add(c.name);
      }
    } catch { /* ignore */ }
  }
  if (tools.size > 0) {
    parts.push(`Tools: ${[...tools].slice(0, 5).join(', ')}`);
  }

  // Message count breakdown
  const userCount = messages.filter(m => m.type === 'user').length;
  const assistantCount = messages.filter(m => m.type === 'assistant').length;
  parts.push(`Messages: ${userCount} user, ${assistantCount} assistant`);

  // Last assistant message (outcome hint)
  const lastAssistant = [...messages].reverse().find(m => m.type === 'assistant');
  if (lastAssistant) {
    parts.push(`End: ${lastAssistant.content.slice(0, 200)}`);
  }

  return parts.join('\n').slice(0, maxLength);
}
