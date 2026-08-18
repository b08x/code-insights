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

/**
 * Backfill embeddings for a specific entity type.
 *
 * 1. Load the sqlite-vec extension
 * 2. Create virtual tables if needed
 * 3. Query rows WHERE embedding_status = 'pending'
 * 4. Embed via Ollama in batches
 * 5. Store vectors in sqlite-vec + embedding_metadata
 * 6. Update embedding_status to 'computed'
 */
export async function backfillEmbeddings(
  config: EmbeddingConfig,
  entityType: EmbeddingEntityType,
  onProgress?: (computed: number, total: number) => void,
): Promise<BackfillStats> {
  const db = getDb();
  loadVectorExtension(db);
  // We will create the vector tables after we fetch the first batch of embeddings,
  // so we can dynamically detect the exact dimension produced by the model.


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

  // Prepare items for embedding
  const items = pendingRows.map(row => ({
    id: row.id,
    text:
      entityType === 'insight'
        ? insightSourceText(row as { type: string; project_name: string; title: string; content: string; summary: string })
        : messageSourceText(row as { content: string }),
  }));

  const metaStmt = db.prepare(`
    INSERT OR REPLACE INTO embedding_metadata (id, entity_type, model, dim, source_text, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
  `);
  const statusStmt = db.prepare(`
    UPDATE ${entityType === 'insight' ? 'insights' : 'messages'}
    SET embedding_status = 'computed'
    WHERE id = ?
  `);
  const updateBatch = db.transaction((results: EmbeddingResult[]) => {
    for (const r of results) {
      metaStmt.run(r.id, entityType, r.model, r.dim, r.sourceText);
      statusStmt.run(r.id);
    }
  });

  let tableEnsured = false;

  // Embed and save in batches
  for (let i = 0; i < items.length; i += config.batchSize) {
    const batch = items.slice(i, i + config.batchSize);
    try {
      const results = await embedTexts(config, batch);
      
      if (results.length > 0) {
        if (!tableEnsured) {
          ensureVectorTableWithDim(db, entityType, results[0].dim);
          tableEnsured = true;
        }
        insertEmbeddingsBatch(db, entityType, results);
        updateBatch(results);
        stats.computed += results.length;
      }
    } catch (err) {
      // Mark the whole batch as failed
      const msg = err instanceof Error ? err.message : String(err);
      for (const item of batch) {
        stats.failed++;
        stats.errors.push({ id: item.id, error: msg });
        updateStatus(db, entityType, item.id, 'failed');
      }
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
