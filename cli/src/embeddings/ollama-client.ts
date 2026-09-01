// Ollama embedding client — HTTP wrapper around /api/embed.
// Handles batching, retry with exponential backoff, and rate limiting.

import type { EmbeddingConfig, EmbeddingResult } from './types.js';

const MAX_RETRIES = 3;
const BASE_RETRY_MS = 1000;

/**
 * Maximum characters to send to Ollama per text.
 * Most embedding models have a context window of 512-4096 tokens.
 * 6000 chars is ~1500 tokens, which is a safe compromise for most local models.
 */
const MAX_EMBEDDING_CHARS = 6000;

/** Thrown when Ollama returns a non-200 or the response is malformed. */
export class EmbeddingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** Sleep for ms. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Track simple token-bucket rate limiter state. */
function createRateLimiter(rpm: number): { wait: () => Promise<void> } {
  if (rpm <= 0) return { wait: () => Promise.resolve() };

  const intervalMs = 60_000 / rpm;
  let lastRequest = 0;

  return {
    wait: async () => {
      const now = Date.now();
      const elapsed = now - lastRequest;
      if (elapsed < intervalMs) {
        await sleep(intervalMs - elapsed);
      }
      lastRequest = Date.now();
    },
  };
}

/**
 * Embed a single batch of texts via Ollama /api/embed.
 * Returns Float32Array[] aligned 1:1 with inputs.
 */
async function embedBatch(
  config: EmbeddingConfig,
  texts: string[],
  rateLimiter: { wait: () => Promise<void> },
): Promise<Float32Array[]> {
  await rateLimiter.wait();

  const url = `${config.baseUrl.replace(/\/+$/, '')}/api/embed`;
  const body = JSON.stringify({ model: config.model, input: texts });

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        
        if (res.status === 404) {
          if (text.includes('not found') && text.includes('model')) {
            throw new EmbeddingError(
              `Model '${config.model}' not found in Ollama. Please run: ollama pull ${config.model}`,
            );
          }
          
          if (url.endsWith('/api/embed')) {
            // Fallback for older Ollama versions that only support /api/embeddings
            const fallbackResults = await Promise.all(
              texts.map(async (text) => {
                const fallbackUrl = `${config.baseUrl.replace(/\/+$/, '')}/api/embeddings`;
                const fallbackBody = JSON.stringify({ model: config.model, prompt: text });
                const fallbackRes = await fetch(fallbackUrl, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: fallbackBody,
                });
                if (!fallbackRes.ok) {
                  const errText = await fallbackRes.text().catch(() => '');
                  if (fallbackRes.status === 404 && errText.includes('not found') && errText.includes('model')) {
                    throw new EmbeddingError(`Model '${config.model}' not found in Ollama. Please run: ollama pull ${config.model}`);
                  }
                  throw new Error(`Fallback /api/embeddings returned ${fallbackRes.status}: ${errText.slice(0, 200)}`);
                }
                const fallbackJson = (await fallbackRes.json()) as { embedding?: number[] };
                if (!fallbackJson.embedding || !Array.isArray(fallbackJson.embedding)) {
                  throw new Error('Fallback response missing embedding array');
                }
                return fallbackJson.embedding;
              })
            );
            return fallbackResults.map(e => new Float32Array(e));
          }
        }

        throw new EmbeddingError(
          `Ollama /api/embed returned ${res.status}: ${text.slice(0, 200)}`,
        );
      }

      const json = (await res.json()) as { embeddings?: number[][] };

      if (!json.embeddings || !Array.isArray(json.embeddings)) {
        throw new EmbeddingError('Ollama response missing embeddings array');
      }

      if (json.embeddings.length !== texts.length) {
        throw new EmbeddingError(
          `Expected ${texts.length} embeddings, got ${json.embeddings.length}`,
        );
      }

      return json.embeddings.map(e => new Float32Array(e));
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRIES) {
        await sleep(BASE_RETRY_MS * 2 ** (attempt - 1));
      }
    }
  }

  throw new EmbeddingError(
    `Embedding failed after ${MAX_RETRIES} attempts`,
    lastError,
  );
}

/**
 * Embed multiple texts in batches of config.batchSize.
 * Returns EmbeddingResult[] with vectors aligned to inputs.
 */
export async function embedTexts(
  config: EmbeddingConfig,
  items: Array<{ id: string; text: string }>,
): Promise<EmbeddingResult[]> {
  const rateLimiter = createRateLimiter(config.rateLimitPerMinute);
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < items.length; i += config.batchSize) {
    const batch = items.slice(i, i + config.batchSize);
    
    // Truncate texts to prevent context length errors in Ollama
    const texts = batch.map(b => 
      b.text.length > MAX_EMBEDDING_CHARS 
        ? b.text.slice(0, MAX_EMBEDDING_CHARS) 
        : b.text
    );
    
    const vectors = await embedBatch(config, texts, rateLimiter);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        id: batch[j].id,
        vector: vectors[j],
        sourceText: texts[j], // Use the potentially truncated text as the source
        model: config.model,
        dim: vectors[j].length,
      });
    }
  }

  return results;
}

/**
 * Embed a single text (convenience wrapper).
 */
export async function embedOne(
  config: EmbeddingConfig,
  id: string,
  text: string,
): Promise<EmbeddingResult> {
  const results = await embedTexts(config, [{ id, text }]);
  return results[0];
}
