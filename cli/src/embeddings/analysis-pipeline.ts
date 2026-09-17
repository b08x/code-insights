// Ingest-time embedding pipeline for analysis chunks.
// Chunks + embeds messages immediately at ingest for instant searchability.
// Supports soft readiness gate: parallel compute, wait only if needed.

import { getDb } from '../db/client.js';
import type { SQLiteMessageRow } from '../analysis/prompt-types.js';
import type { EmbeddingConfig, EmbeddingResult } from './types.js';
import { DEFAULT_EMBEDDING_CONFIG } from './types.js';
import { embedTexts } from './ollama-client.js';
import {
  chunkConversation,
  splitIntoChildChunks,
  DEFAULT_CHUNKER_CONFIG,
  type AnalysisChunk,
  type ChildChunk,
  type ChunkerConfig,
} from './annotated-chunker.js';
import {
  loadVecExtension,
  ensureAllAnalysisTables,
  insertAnalysisChunk,
  batchInsertChildEmbeddings,
  getPendingChunks,
  areChunksReady,
  getEmbeddingStatus,
  deleteChunksBySession,
} from './analysis-chunks-store.js';
import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ChunkingResult {
  sessionId: string;
  parentChunks: number;
  childChunks: number;
  embedded: boolean;
  error?: string;
}

export interface ReadinessResult {
  ready: boolean;
  status: {
    total: number;
    computed: number;
    pending: number;
    failed: number;
  };
}

// ── Core pipeline ────────────────────────────────────────────────────────────

/**
 * Chunk and embed a session's messages for retrieval-augmented analysis.
 * Called at ingest time (message sync) for immediate searchability.
 *
 * Flow:
 * 1. Group messages into role-boundary exchanges
 * 2. Annotate each chunk (phase, significance, why_context)
 * 3. Split into parent/child chunks
 * 4. Embed child chunks in batches
 * 5. Store metadata + embeddings in analysis_chunks / vec_analysis_chunks
 *
 * @returns ChunkingResult with stats, or error if embedding fails
 */
export async function chunkAndEmbedSession(
  sessionId: string,
  messages: SQLiteMessageRow[],
  config: EmbeddingConfig = DEFAULT_EMBEDDING_CONFIG,
  chunkerConfig: ChunkerConfig = DEFAULT_CHUNKER_CONFIG,
): Promise<ChunkingResult> {
  const db = getDb();
  loadVecExtension(db);

  // Clean up any existing chunks for this session (re-ingest)
  deleteChunksBySession(db, sessionId);

  // 1. Chunk conversation
  const parentChunks = chunkConversation(sessionId, messages, chunkerConfig);
  const childChunks = splitIntoChildChunks(parentChunks, chunkerConfig);

  if (childChunks.length === 0) {
    return {
      sessionId,
      parentChunks: 0,
      childChunks: 0,
      embedded: false,
      error: 'No chunks produced (empty conversation)',
    };
  }

  // 2. Ensure tables exist (first chunk determines dimension)
  // We need to embed first to get dim, so embed first batch then create tables
  try {
    // 3. Embed child chunks in batches
    const allEmbeddings: EmbeddingResult[] = [];
    const batchSize = config.batchSize;

    for (let i = 0; i < childChunks.length; i += batchSize) {
      const batch = childChunks.slice(i, i + batchSize);
      const items = batch.map(c => ({ id: c.id, text: c.annotatedText }));
      const results = await embedTexts(config, items);
      allEmbeddings.push(...results);
    }

    // 4. Ensure tables with correct dimension
    if (allEmbeddings.length > 0) {
      ensureAllAnalysisTables(db, allEmbeddings[0].dim);
    }

    // 5. Store parent chunks (metadata only, no embedding)
    for (const parent of parentChunks) {
      insertAnalysisChunk(db, parent);
    }

    // 6. Store child chunk embeddings
    batchInsertChildEmbeddings(db, allEmbeddings, childChunks);

    return {
      sessionId,
      parentChunks: parentChunks.length,
      childChunks: childChunks.length,
      embedded: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      sessionId,
      parentChunks: parentChunks.length,
      childChunks: childChunks.length,
      embedded: false,
      error: msg,
    };
  }
}

// ── Soft readiness gate ──────────────────────────────────────────────────────

/**
 * Check if embeddings are ready for a session.
 * If not, trigger background computation and return false.
 * Used by the soft gate: analysis proceeds once embeddings are ready,
 * no blocking unless they're not ready by LLM call time.
 */
export function checkEmbeddingReadiness(
  db: Database.Database,
  sessionId: string,
): ReadinessResult {
  const status = getEmbeddingStatus(db, sessionId);
  return {
    ready: status.pending === 0 && status.total > 0,
    status,
  };
}

/**
 * Wait for embeddings to be ready, with a timeout.
 * Returns true if ready, false if timed out.
 * Used by the soft gate before LLM call.
 */
export async function waitForEmbeddings(
  db: Database.Database,
  sessionId: string,
  timeoutMs: number = 10_000,
): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (areChunksReady(db, sessionId)) {
      return true;
    }
    await new Promise(r => setTimeout(r, 200));
  }

  return areChunksReady(db, sessionId);
}

// ── Status operations ────────────────────────────────────────────────────────

/**
 * Get embedding status summary for a session.
 * Useful for CLI status commands and debugging.
 */
export function getSessionChunkStatus(
  sessionId: string,
): { total: number; computed: number; pending: number; failed: number; ready: boolean } {
  const db = getDb();
  loadVecExtension(db);
  const status = getEmbeddingStatus(db, sessionId);
  return {
    ...status,
    ready: status.pending === 0 && status.total > 0,
  };
}

/**
 * Get embedding status summary across all sessions.
 */
export function getGlobalChunkStatus(): {
  totalChunks: number;
  totalSessions: number;
} {
  const db = getDb();
  loadVecExtension(db);

  const chunkRow = db.prepare(`SELECT COUNT(*) as n FROM analysis_chunks`).get() as { n: number };
  const sessionRow = db.prepare(`SELECT COUNT(DISTINCT session_id) as n FROM analysis_chunks`).get() as { n: number };

  return {
    totalChunks: chunkRow.n,
    totalSessions: sessionRow.n,
  };
}
