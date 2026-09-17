// Analysis chunks vector store — manages vec_analysis_chunks table.
// Separate from vec_messages/vec_insights to avoid schema drift.
// Stores annotated conversation chunks with phase/significance metadata.

import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingResult } from './types.js';
import type { ChunkPhase, ChunkSignificance, ChildChunk, AnalysisChunk } from './annotated-chunker.js';

// ── Table management ─────────────────────────────────────────────────────────

const CHUNKS_TABLE = 'analysis_chunks';
const CHUNKS_VEC_TABLE = 'vec_analysis_chunks';

/** Load sqlite-vec extension (idempotent). */
export function loadVecExtension(db: Database.Database): void {
  sqliteVec.load(db);
}

/** Ensure the analysis_chunks metadata table exists. */
export function ensureAnalysisChunksTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${CHUNKS_TABLE} (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      parent_chunk_id TEXT,
      content TEXT NOT NULL,
      annotated_content TEXT NOT NULL,
      phase TEXT NOT NULL,
      significance TEXT NOT NULL,
      why_context TEXT NOT NULL,
      related_to TEXT DEFAULT '[]',
      message_ids TEXT DEFAULT '[]',
      embedding_status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_analysis_chunks_session
    ON ${CHUNKS_TABLE} (session_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_analysis_chunks_embedding_status
    ON ${CHUNKS_TABLE} (embedding_status)
  `);
}

/** Ensure the vec_analysis_chunks virtual table exists with the correct dimension. */
export function ensureAnalysisChunksVecTable(db: Database.Database, dim: number): void {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`)
    .get(CHUNKS_VEC_TABLE) as { sql: string } | undefined;

  if (row) {
    const match = row.sql.match(/float\[(\d+)\]/);
    if (match) {
      const existingDim = parseInt(match[1], 10);
      if (existingDim !== dim) {
        db.exec(`DROP TABLE IF EXISTS ${CHUNKS_VEC_TABLE}`);
        createAnalysisChunksVecTable(db, dim);
      }
    }
  } else {
    createAnalysisChunksVecTable(db, dim);
  }
}

function createAnalysisChunksVecTable(db: Database.Database, dim: number): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${CHUNKS_VEC_TABLE} USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dim}]
    )
  `);
}

/** Create both tables in one call. */
export function ensureAllAnalysisTables(db: Database.Database, dim: number): void {
  ensureAnalysisChunksTable(db);
  ensureAnalysisChunksVecTable(db, dim);
}

// ── Insert operations ────────────────────────────────────────────────────────

/** Convert Float32Array to Buffer for sqlite-vec BLOB insertion. */
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/** Insert a single analysis chunk (metadata + optional embedding). */
export function insertAnalysisChunk(
  db: Database.Database,
  chunk: AnalysisChunk,
  embedding?: EmbeddingResult,
): void {
  ensureAnalysisChunksTable(db);

  db.prepare(`
    INSERT OR REPLACE INTO ${CHUNKS_TABLE}
    (id, session_id, chunk_index, parent_chunk_id, content, annotated_content,
     phase, significance, why_context, related_to, message_ids, embedding_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk.id,
    chunk.sessionId,
    chunk.index,
    chunk.parentChunkId,
    chunk.content,
    chunk.annotatedContent,
    chunk.phase,
    chunk.significance,
    chunk.whyContext,
    JSON.stringify(chunk.relatedTo),
    JSON.stringify(chunk.messageIds),
    embedding ? 'computed' : 'pending',
  );

  if (embedding) {
    insertChunkEmbedding(db, embedding);
  }
}

/** Insert a child chunk (metadata + optional embedding). */
export function insertChildChunk(
  db: Database.Database,
  chunk: ChildChunk,
  embedding?: EmbeddingResult,
): void {
  ensureAnalysisChunksTable(db);

  db.prepare(`
    INSERT OR REPLACE INTO ${CHUNKS_TABLE}
    (id, session_id, chunk_index, parent_chunk_id, content, annotated_content,
     phase, significance, why_context, related_to, message_ids, embedding_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chunk.id,
    chunk.sessionId,
    chunk.childIndex,
    chunk.parentId,
    chunk.text,
    chunk.annotatedText,
    chunk.phase,
    chunk.significance,
    chunk.whyContext,
    '[]',
    '[]',
    embedding ? 'computed' : 'pending',
  );

  if (embedding) {
    insertChunkEmbedding(db, embedding);
  }
}

/** Batch-insert embeddings into vec_analysis_chunks. */
function insertChunkEmbedding(db: Database.Database, embedding: EmbeddingResult): void {
  db.prepare(`INSERT OR REPLACE INTO ${CHUNKS_VEC_TABLE} (id, embedding) VALUES (?, ?)`)
    .run(embedding.id, vecToBlob(embedding.vector));
}

/** Batch-insert child chunk embeddings in a transaction. */
export function batchInsertChildEmbeddings(
  db: Database.Database,
  embeddings: EmbeddingResult[],
  childChunks: ChildChunk[],
): void {
  if (embeddings.length === 0) return;

  const metaStmt = db.prepare(`
    UPDATE ${CHUNKS_TABLE} SET embedding_status = 'computed' WHERE id = ?
  `);
  const vecStmt = db.prepare(`
    INSERT OR REPLACE INTO ${CHUNKS_VEC_TABLE} (id, embedding) VALUES (?, ?)
  `);

  db.transaction(() => {
    for (let i = 0; i < embeddings.length; i++) {
      const emb = embeddings[i];
      const chunk = childChunks[i];
      if (chunk) {
        metaStmt.run(chunk.id);
      }
      vecStmt.run(emb.id, vecToBlob(emb.vector));
    }
  })();
}

// ── Query operations ─────────────────────────────────────────────────────────

/** Get all chunks for a session. */
export function getChunksBySession(
  db: Database.Database,
  sessionId: string,
): Array<{
  id: string;
  session_id: string;
  chunk_index: number;
  parent_chunk_id: string | null;
  content: string;
  annotated_content: string;
  phase: string;
  significance: string;
  why_context: string;
  related_to: string;
  message_ids: string;
  embedding_status: string;
}> {
  return db.prepare(`
    SELECT id, session_id, chunk_index, parent_chunk_id, content, annotated_content,
           phase, significance, why_context, related_to, message_ids, embedding_status
    FROM ${CHUNKS_TABLE}
    WHERE session_id = ?
    ORDER BY chunk_index ASC
  `).all(sessionId) as any[];
}

/** Get chunk IDs pending embedding for a session. */
export function getPendingChunks(
  db: Database.Database,
  sessionId: string,
): string[] {
  const rows = db.prepare(`
    SELECT id FROM ${CHUNKS_TABLE}
    WHERE session_id = ? AND embedding_status = 'pending'
    ORDER BY chunk_index ASC
  `).all(sessionId) as Array<{ id: string }>;
  return rows.map(r => r.id);
}

/** Check if all chunks for a session have embeddings. */
export function areChunksReady(
  db: Database.Database,
  sessionId: string,
): boolean {
  const row = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN embedding_status = 'computed' THEN 1 ELSE 0 END) as computed
    FROM ${CHUNKS_TABLE}
    WHERE session_id = ?
  `).get(sessionId) as { total: number; computed: number } | undefined;

  if (!row || row.total === 0) return false;
  return row.total === row.computed;
}

/** Get embedding status summary for a session. */
export function getEmbeddingStatus(
  db: Database.Database,
  sessionId: string,
): { total: number; computed: number; pending: number; failed: number } {
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN embedding_status = 'computed' THEN 1 ELSE 0 END) as computed,
      SUM(CASE WHEN embedding_status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN embedding_status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM ${CHUNKS_TABLE}
    WHERE session_id = ?
  `).get(sessionId) as any;

  return {
    total: row?.total ?? 0,
    computed: row?.computed ?? 0,
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
  };
}

// ── Vector search operations ─────────────────────────────────────────────────

/**
 * KNN query against vec_analysis_chunks.
 * Returns top-K chunk IDs by cosine similarity.
 */
export function querySimilarChunks(
  db: Database.Database,
  queryVector: Float32Array,
  topK: number,
): Array<{ id: string; distance: number }> {
  const candidates = db.prepare(`
    SELECT id, distance FROM ${CHUNKS_VEC_TABLE}
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(vecToBlob(queryVector), topK) as Array<{ id: string; distance: number }>;

  return candidates;
}

/**
 * KNN query with session exclusion and optional phase filter.
 * Fetches topK*10 candidates from vec, filters in JS.
 */
export function querySimilarChunksFiltered(
  db: Database.Database,
  queryVector: Float32Array,
  topK: number,
  excludeSessionId?: string,
  phaseFilter?: ChunkPhase,
): Array<{ id: string; distance: number; phase: string; significance: string }> {
  const fetchLimit = topK * 10;
  const candidates = db.prepare(`
    SELECT id, distance FROM ${CHUNKS_VEC_TABLE}
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `).all(vecToBlob(queryVector), fetchLimit) as Array<{ id: string; distance: number }>;

  if (candidates.length === 0) return [];

  // Fetch metadata for filtering
  const ids = candidates.map(c => c.id);
  const batchSize = 500;
  const metaMap = new Map<string, { session_id: string; phase: string; significance: string }>();

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, session_id, phase, significance
      FROM ${CHUNKS_TABLE}
      WHERE id IN (${placeholders})
    `).all(...batch) as Array<{ id: string; session_id: string; phase: string; significance: string }>;
    for (const row of rows) {
      metaMap.set(row.id, row);
    }
  }

  const results: Array<{ id: string; distance: number; phase: string; significance: string }> = [];
  const seen = new Set<string>();

  for (const c of candidates) {
    const meta = metaMap.get(c.id);
    if (!meta) continue;
    if (excludeSessionId && meta.session_id === excludeSessionId) continue;
    if (phaseFilter && meta.phase !== phaseFilter) continue;

    // Deduplicate by parent chunk (strip _c suffix)
    const parentId = c.id.replace(/_c\d+$/, '');
    if (seen.has(parentId)) continue;
    seen.add(parentId);

    results.push({
      id: c.id,
      distance: c.distance,
      phase: meta.phase,
      significance: meta.significance,
    });

    if (results.length >= topK) break;
  }

  return results;
}

// ── Cleanup operations ───────────────────────────────────────────────────────

/** Delete all chunks and embeddings for a session. */
export function deleteChunksBySession(db: Database.Database, sessionId: string): void {
  const chunkIds = db.prepare(`
    SELECT id FROM ${CHUNKS_TABLE} WHERE session_id = ?
  `).all(sessionId) as Array<{ id: string }>;

  if (chunkIds.length === 0) return;

  const ids = chunkIds.map(r => r.id);
  const placeholders = ids.map(() => '?').join(',');

  db.transaction(() => {
    db.prepare(`DELETE FROM ${CHUNKS_VEC_TABLE} WHERE id IN (${placeholders})`).run(...ids);
    db.prepare(`DELETE FROM ${CHUNKS_TABLE} WHERE session_id = ?`).run(sessionId);
  })();
}

/** Get total count of analysis chunks across all sessions. */
export function countAnalysisChunks(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) as n FROM ${CHUNKS_TABLE}`).get() as { n: number };
  return row.n;
}

/** Get count of sessions with analysis chunks. */
export function countSessionsWithChunks(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(DISTINCT session_id) as n FROM ${CHUNKS_TABLE}`).get() as { n: number };
  return row.n;
}
