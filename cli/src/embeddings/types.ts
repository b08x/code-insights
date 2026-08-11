// Embedding types for the code-insights embedding pipeline.
// Aligns with AutoRefine's dual-form pattern: embeddings for "insight" and "message" entities
// enable semantic retrieval, deduplication, and RAG context injection.

export interface EmbeddingConfig {
  model: string;              // e.g. 'qwen3-embedding:0.6b'
  baseUrl: string;            // e.g. 'http://tinybot:11434'
  dim: number;                // 1024 for qwen3-embedding
  batchSize: number;          // 50 — Ollama /api/embed accepts multiple inputs
  rateLimitPerMinute: number; // 0 = disabled
}

export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: 'qwen3-embedding:0.6b',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://tinybot:11434',
  dim: 1024,
  batchSize: 50,
  rateLimitPerMinute: 0,
};

export interface EmbeddingResult {
  id: string;
  vector: Float32Array;       // dim-length float32
  sourceText: string;         // the text that was embedded
  model: string;
  dim: number;
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
