// Embedding types for the code-insights embedding pipeline.
// Aligns with AutoRefine's dual-form pattern: embeddings for "insight" and "message" entities
// enable semantic retrieval, deduplication, and RAG context injection.

import type { ClaudeInsightConfig } from '../types.js';

export interface EmbeddingConfig {
  model: string;              // e.g. 'embeddinggemma:latest'
  baseUrl: string;            // e.g. 'http://127.0.0.1:11434'
  dim: number;                // 768 for embeddinggemma
  batchSize: number;          // 50 — Ollama /api/embed accepts multiple inputs
  rateLimitPerMinute: number; // 0 = disabled
}

export interface EmbedRequestOptions {
  maxRetries?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: 'embeddinggemma:latest',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  dim: 768,
  batchSize: 50,
  rateLimitPerMinute: 0,
};

/**
 * Resolve the active embedding config from user config.
 * Returns null when configured to a non-Ollama provider (not yet supported by the Ollama client).
 */
export function resolveEmbeddingConfig(config: ClaudeInsightConfig | null | undefined): EmbeddingConfig | null {
  const emb = config?.dashboard?.embedding;
  if (!emb) return DEFAULT_EMBEDDING_CONFIG;
  if (emb.provider && emb.provider !== 'ollama') return null;
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    model: emb.model || DEFAULT_EMBEDDING_CONFIG.model,
    baseUrl: emb.baseUrl || DEFAULT_EMBEDDING_CONFIG.baseUrl,
  };
}

export interface EmbeddingResult {
  id: string;
  vector: Float32Array;       // dim-length float32
  sourceText: string;         // the text that was embedded
  model: string;
  dim: number;
  parentChunkId?: string;
}

export type EmbeddingEntityType = 'insight' | 'message';

export interface BackfillStats {
  entityType: EmbeddingEntityType;
  total: number;
  computed: number;
  skipped: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
}
