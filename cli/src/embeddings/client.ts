// Embedding client entry point.
// Re-exports the Ollama client; future: add OpenAI/Gemini providers via AxAI.

export { embedTexts, embedOne, EmbeddingError } from './ollama-client.js';
export type { EmbeddingConfig, EmbeddingResult, EmbeddingEntityType, BackfillStats, EmbedRequestOptions } from './types.js';
export { DEFAULT_EMBEDDING_CONFIG, resolveEmbeddingConfig } from './types.js';
export type { SimilarInsight } from './store.js';
export { findSimilar, markStale } from './store.js';
