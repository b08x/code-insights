// Batch backfill job: compute embeddings for all pending insights and messages.
// Processes in batches, stores vectors in sqlite-vec, updates embedding_status.

import { getDb } from '../db/client.js';
import { embedTexts } from './ollama-client.js';
import type { EmbeddingConfig } from './types.js';
import {
  loadVectorExtension,
  createAllVectorTables,
  insertEmbeddingsBatch,
  ensureVectorTableWithDim,
} from './store.js';
import type { EmbeddingEntityType, BackfillStats, EmbeddingResult } from './types.js';
import type Database from 'better-sqlite3';

/** Construct the source text that gets embedded for an insight. */
function insightSourceText(row: {
  type: string;
  project_name: string;
  title: string;
  content: string;
  summary: string;
}): string {
  return `${row.type} [${row.project_name}] ${row.title}\n${row.content}\n${row.summary}`;
}

/** Construct the source text for a message (just the content). */
function messageSourceText(row: { content: string }): string {
  return row.content;
}

import { chunkText } from './chunker.js';

const PARENT_CHUNK_MAX = 4000;
const CHILD_CHUNK_MAX = 512;

/**
 * Backfill embeddings for a specific entity type.
 *
 * 1. Load the sqlite-vec extension
 * 2. Create virtual tables if needed
 * 3. Query rows WHERE embedding_status = 'pending'
 * 4. Split into parent and child chunks
 * 5. Embed child chunks via Ollama in batches
 * 6. Store vectors in sqlite-vec + embedding_metadata + entity_chunks
 * 7. Update embedding_status to 'computed'
 */
export async function backfillEmbeddings(
  config: EmbeddingConfig,
  entityType: EmbeddingEntityType,
  onProgress?: (computed: number, total: number) => void,
): Promise<BackfillStats> {
  const db = getDb();
  loadVectorExtension(db);

  const stats: BackfillStats = {
    entityType,
    total: 0,
    computed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Fetch pending rows
  let pendingRows: Array<{ id: string; type?: string; project_name?: string; title?: string; content: string; summary?: string }>;

  if (entityType === 'insight') {
    pendingRows = db
      .prepare(
        `SELECT id, type, project_name, title, content, summary
         FROM insights
         WHERE embedding_status = 'pending'`,
      )
      .all() as Array<{ id: string; type: string; project_name: string; title: string; content: string; summary: string }>;
  } else {
    pendingRows = db
      .prepare(
        `SELECT id, content
         FROM messages
         WHERE embedding_status = 'pending'
           AND type = 'user'
           AND content != ''`,
      )
      .all() as Array<{ id: string; content: string }>;
  }

  stats.total = pendingRows.length;

  if (pendingRows.length === 0) {
    return stats;
  }

  // Define prepared statements
  const chunkStmt = db.prepare(`
    INSERT OR REPLACE INTO entity_chunks (id, entity_type, entity_id, chunk_index, content)
      VALUES (?, ?, ?, ?, ?)
  `);
  const metaStmt = db.prepare(`
    INSERT OR REPLACE INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);
  const statusStmt = db.prepare(`
    UPDATE ${entityType === 'insight' ? 'insights' : 'messages'}
    SET embedding_status = 'computed'
    WHERE id = ?
  `);

  const updateBatch = db.transaction((entityIds: string[], childResults: Array<EmbeddingResult & { entityId: string }>) => {
    // 1. Insert embeddings and metadata
    for (const r of childResults) {
      metaStmt.run(r.id, entityType, r.entityId, r.model, r.dim, r.sourceText, r.parentChunkId);
    }
    // 2. Mark parent entities as computed
    for (const id of entityIds) {
      statusStmt.run(id);
    }
  });

  let tableEnsured = false;

  // Process each pending row
  for (let rowIdx = 0; rowIdx < pendingRows.length; rowIdx++) {
    const row = pendingRows[rowIdx];
    const sourceTxt = entityType === 'insight'
      ? insightSourceText(row as { type: string; project_name: string; title: string; content: string; summary: string })
      : messageSourceText(row as { content: string });

    try {
      // 1. Split into parent chunks
      const parentChunks = chunkText(sourceTxt, PARENT_CHUNK_MAX);
      const childItems: Array<{ id: string; text: string; parentId: string }> = [];
      
      db.transaction(() => {
        for (let pIdx = 0; pIdx < parentChunks.length; pIdx++) {
          const pText = parentChunks[pIdx];
          const parentId = `${row.id}_p${pIdx}`;
          
          chunkStmt.run(parentId, entityType, row.id, pIdx, pText);
          
          // 2. Split each parent chunk into child chunks
          const childChunks = chunkText(pText, CHILD_CHUNK_MAX);
          for (let cIdx = 0; cIdx < childChunks.length; cIdx++) {
            childItems.push({
              id: `${parentId}_c${cIdx}`,
              text: childChunks[cIdx],
              parentId: parentId
            });
          }
        }
      })();

      // 3. Embed child chunks in batches
      const allChildResults: Array<EmbeddingResult & { entityId: string }> = [];
      for (let i = 0; i < childItems.length; i += config.batchSize) {
        const batch = childItems.slice(i, i + config.batchSize);
        const results = await embedTexts(config, batch);
        
        // Attach parent chunk id and entity_id
        for (let j = 0; j < results.length; j++) {
          (results[j] as any).parentChunkId = batch[j].parentId;
          (results[j] as any).entityId = row.id;
        }
        allChildResults.push(...(results as Array<EmbeddingResult & { entityId: string }>));
      }

      // 4. Save results
      if (allChildResults.length > 0) {
        if (!tableEnsured) {
          ensureVectorTableWithDim(db, entityType, allChildResults[0].dim);
          tableEnsured = true;
        }
        insertEmbeddingsBatch(db, entityType, allChildResults);
      }
      
      updateBatch([row.id], allChildResults);
      stats.computed++;
      
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stats.failed++;
      stats.errors.push({ id: row.id, error: msg });
      updateStatus(db, entityType, row.id, 'failed');
    }

    if (onProgress) {
      onProgress(stats.computed + stats.failed, stats.total);
    }
  }

  return stats;
}

function updateStatus(
  db: Database.Database,
  entityType: EmbeddingEntityType,
  id: string,
  status: 'computed' | 'stale' | 'failed',
): void {
  const table = entityType === 'insight' ? 'insights' : 'messages';
  db.prepare(`UPDATE ${table} SET embedding_status = ? WHERE id = ?`).run(status, id);
}

/**
 * Backfill both insights and messages.
 */
export async function backfillAll(
  config: EmbeddingConfig,
  onProgress?: (entity: string, computed: number, total: number) => void,
): Promise<{ insights: BackfillStats; messages: BackfillStats }> {
  const insights = await backfillEmbeddings(config, 'insight', (c, t) => onProgress?.('insight', c, t));
  const messages = await backfillEmbeddings(config, 'message', (c, t) => onProgress?.('message', c, t));
  return { insights, messages };
}
