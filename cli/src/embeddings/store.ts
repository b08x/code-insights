// sqlite-vec vector store management.
// Manages vec0 virtual tables for KNN similarity search over embeddings.

import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { EmbeddingResult, EmbeddingEntityType } from './types.js';

const VECTOR_TABLES: Record<EmbeddingEntityType, string> = {
  insight: 'vec_insights',
  message: 'vec_messages',
};

/** Load the sqlite-vec extension into a database connection. */
export function loadVectorExtension(db: Database.Database): void {
  sqliteVec.load(db);
}

/** Create a vec0 virtual table for the given entity type if it doesn't exist. */
export function createVectorTable(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  dim: number,
): void {
  const tableName = VECTOR_TABLES[entityType];
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dim}]
    )
  `);
}

/** Create both vector tables (insights + messages) in one call. */
export function createAllVectorTables(db: Database.Database, dim: number): void {
  createVectorTable(db, 'insight', dim);
  createVectorTable(db, 'message', dim);
}

/**
 * Ensures the vector table exists with the specified dimension.
 * If it exists but has a different dimension, throws an error.
 */
export function ensureVectorTableWithDim(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  dim: number,
): void {
  const tableName = VECTOR_TABLES[entityType];
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = ?`).get(tableName) as { sql: string } | undefined;
  
  if (row) {
    const match = row.sql.match(/float\[(\d+)\]/);
    if (match) {
      const existingDim = parseInt(match[1], 10);
      if (existingDim !== dim) {
        throw new Error(`Model dimension mismatch: the existing vector index was created with dimension ${existingDim}, but your model produces dimension ${dim}. To switch models, you must recompute all embeddings and rebuild the vector store by running: \`code-insights embeddings recompute --all --rebuild\``);
      }
    }
  } else {
    createVectorTable(db, entityType, dim);
  }
}

/** Convert a Float32Array to a Buffer for sqlite-vec BLOB insertion. */
export function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Insert or replace a single embedding into the appropriate vector table.
 */
export function insertEmbedding(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  id: string,
  vector: Float32Array,
): void {
  const tableName = VECTOR_TABLES[entityType];
  db.prepare(`INSERT OR REPLACE INTO ${tableName} (id, embedding) VALUES (?, ?)`)
    .run(id, vecToBlob(vector));
}

/**
 * Batch-insert embeddings in a transaction for performance.
 */
export function insertEmbeddingsBatch(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  embeddings: EmbeddingResult[],
): void {
  if (embeddings.length === 0) return;
  const tableName = VECTOR_TABLES[entityType];
  const stmt = db.prepare(`INSERT OR REPLACE INTO ${tableName} (id, embedding) VALUES (?, ?)`);
  const txn = db.transaction((items: EmbeddingResult[]) => {
    for (const item of items) {
      stmt.run(item.id, vecToBlob(item.vector));
    }
  });
  txn(embeddings);
}

/**
 * KNN query: find the top-k most similar vectors to the query vector.
 * Returns { id, distance }[] sorted by ascending distance.
 *
 * NOTE: sqlite-vec vec0 requires LIMIT on KNN queries.
 * Any post-filtering (e.g., excluding self, filtering by session) must be done in JS.
 */
export function querySimilar(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  queryVector: Float32Array,
  topK: number,
): Array<{ id: string; distance: number }> {
  const tableName = VECTOR_TABLES[entityType];
  const candidates = db
    .prepare(
      `SELECT id, distance FROM ${tableName} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`,
    )
    .all(vecToBlob(queryVector), topK * 10) as Array<{ id: string; distance: number }>;

  if (candidates.length === 0) return [];

  // Map chunk IDs to entity IDs
  const placeholders = candidates.map(() => '?').join(', ');
  const metaRows = db
    .prepare(`SELECT id as chunk_id, entity_id FROM embedding_metadata WHERE id IN (${placeholders})`)
    .all(...candidates.map(c => c.id)) as Array<{ chunk_id: string; entity_id: string }>;
  const metaMap = new Map(metaRows.map(r => [r.chunk_id, r.entity_id]));

  const result: Array<{ id: string; distance: number }> = [];
  const seenEntities = new Set<string>();

  for (const c of candidates) {
    const entityId = metaMap.get(c.id);
    if (!entityId) continue;
    
    if (!seenEntities.has(entityId)) {
      seenEntities.add(entityId);
      result.push({ id: entityId, distance: c.distance });
      if (result.length === topK) break;
    }
  }

  return result;
}

/**
 * KNN query with self-exclusion: returns top-k similar vectors excluding the query id.
 * Fetches topK+1 from sqlite-vec, then filters in JS.
 */
export function querySimilarExcluding(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  queryVector: Float32Array,
  topK: number,
  excludeId: string,
): Array<{ id: string; distance: number }> {
  const candidates = querySimilar(db, entityType, queryVector, topK + 1);
  return candidates.filter(c => c.id !== excludeId).slice(0, topK);
}

/**
 * Rebuild the entire vector table from scratch (for backfill).
 * Drops and recreates the virtual table, then bulk-inserts all embeddings.
 */
export function rebuildVectorStore(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  embeddings: EmbeddingResult[],
  dim: number,
): void {
  const tableName = VECTOR_TABLES[entityType];
  db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  createVectorTable(db, entityType, dim);
  insertEmbeddingsBatch(db, entityType, embeddings);
}

/**
 * Delete a single embedding from the vector store.
 */
export function deleteEmbedding(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  id: string, // this is the entity_id
): void {
  const tableName = VECTOR_TABLES[entityType];
  
  // Find all chunk IDs for this entity
  const chunkRows = db.prepare(`SELECT id FROM embedding_metadata WHERE entity_id = ? AND entity_type = ?`).all(id, entityType) as Array<{ id: string }>;
  if (chunkRows.length === 0) return;
  
  const chunkIds = chunkRows.map(r => r.id);
  const placeholders = chunkIds.map(() => '?').join(',');
  
  db.prepare(`DELETE FROM ${tableName} WHERE id IN (${placeholders})`).run(...chunkIds);
  db.prepare(`DELETE FROM embedding_metadata WHERE entity_id = ? AND entity_type = ?`).run(id, entityType);
  db.prepare(`DELETE FROM entity_chunks WHERE entity_id = ? AND entity_type = ?`).run(id, entityType);
}

/**
 * Get the count of vectors in a vector table.
 */
export function countVectors(
  db: Database.Database,
  entityType: EmbeddingEntityType,
): number {
  const tableName = VECTOR_TABLES[entityType];
  const row = db.prepare(`SELECT COUNT(*) as n FROM ${tableName}`).get() as { n: number };
  return row.n;
}

// ── Semantic deduplication ─────────────────────────────────────────

export interface SimilarInsight {
  id: string;
  distance: number;
  metadata: string | null;
}

const ENTITY_TABLES: Record<EmbeddingEntityType, string> = {
  insight: 'insights',
  message: 'messages',
};

/**
 * Find semantically similar embeddings above a cosine-similarity threshold.
 *
 * Cosine similarity = 1 - distance.  Threshold is expressed as similarity
 * (e.g. 0.90 → distance <= 0.10).  We fetch `limit * 2` candidates from
 * sqlite-vec to allow for post-filtering, then join with the entity table
 * to attach metadata.
 */
export function findSimilar(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  queryVector: Float32Array,
  threshold: number,
  limit: number,
): SimilarInsight[] {
  const vecTable = VECTOR_TABLES[entityType];
  const entityTable = ENTITY_TABLES[entityType];
  const maxDistance = 1 - threshold; // convert similarity → distance

  // Fetch extra candidates to allow for distance filtering.
  const candidates = db
    .prepare(
      `SELECT v.id, v.distance
       FROM ${vecTable} v
       WHERE v.embedding MATCH ?
       ORDER BY v.distance
       LIMIT ?`,
    )
    .all(vecToBlob(queryVector), limit * 10) as Array<{ id: string; distance: number }>;

  const within = candidates.filter(c => c.distance <= maxDistance);
  if (within.length === 0) return [];

  // Map chunk IDs to entity IDs
  const placeholders = within.map(() => '?').join(', ');
  const metaRows = db
    .prepare(`SELECT id as chunk_id, entity_id FROM embedding_metadata WHERE id IN (${placeholders})`)
    .all(...within.map(c => c.id)) as Array<{ chunk_id: string; entity_id: string }>;
  const metaMap = new Map(metaRows.map(r => [r.chunk_id, r.entity_id]));

  const uniqueEntities = [];
  const seenEntities = new Set<string>();
  
  for (const c of within) {
    const entityId = metaMap.get(c.id);
    if (!entityId) continue;
    if (!seenEntities.has(entityId)) {
      seenEntities.add(entityId);
      uniqueEntities.push({ id: entityId, distance: c.distance });
      if (uniqueEntities.length === limit) break;
    }
  }

  if (uniqueEntities.length === 0) return [];

  // Batch-fetch metadata from the entity table.
  const entityPlaceholders = uniqueEntities.map(() => '?').join(', ');
  const entityStmt = db.prepare(
    `SELECT id, metadata FROM ${entityTable} WHERE id IN (${entityPlaceholders})`,
  );
  const entityRows = entityStmt.all(...uniqueEntities.map(c => c.id)) as Array<{ id: string; metadata: string | null }>;
  const entityMap = new Map(entityRows.map(r => [r.id, r.metadata]));

  return uniqueEntities.map(c => ({
    id: c.id,
    distance: c.distance,
    metadata: entityMap.get(c.id) ?? null,
  }));
}

/**
 * Mark an insight's embedding as stale (triggers re-computation on next analysis).
 */
export function markStale(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  id: string,
): void {
  const table = ENTITY_TABLES[entityType];
  db.prepare(`UPDATE ${table} SET embedding_status = 'stale' WHERE id = ?`).run(id);
}

// ── Retrieval-augmented insight generation ─────────────────────────

/**
 * KNN query with project filter: find top-k similar vectors where the
 * matching insight belongs to the same project.
 *
 * sqlite-vec does not support JOINs inside MATCH queries, so we:
 * 1. Fetch a larger candidate set from vec_insights (topK * 10)
 * 2. Join against the insights table to get project_id
 * 3. Filter by project_id in JS
 * 4. Return up to topK results
 *
 * Only works for 'insight' entity type (which has a project_id column
 * in the insights table). For 'message' entity type, falls back to
 * unfiltered querySimilar.
 */
export function querySimilarFiltered(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  queryVector: Float32Array,
  topK: number,
  projectId: string,
): Array<{ id: string; distance: number }> {
  if (entityType !== 'insight') {
    return querySimilar(db, entityType, queryVector, topK);
  }

  // Fetch extra candidates to account for cross-project filtering.
  const candidateMultiplier = 10;
  const candidates = querySimilar(db, entityType, queryVector, topK * candidateMultiplier);
  if (candidates.length === 0) return [];

  // Batch-fetch project_ids for all candidates from the insights table.
  const ids = candidates.map(c => c.id);
  const batchSize = 500;
  const projectMap = new Map<string, string>();

  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, project_id FROM insights WHERE id IN (${placeholders})`
    ).all(...batch) as Array<{ id: string; project_id: string }>;
    for (const row of rows) {
      projectMap.set(row.id, row.project_id);
    }
  }

  return candidates
    .filter(c => projectMap.get(c.id) === projectId)
    .slice(0, topK);
}
