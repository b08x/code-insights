import type Database from 'better-sqlite3';
import { loadVectorExtension } from './store.js';

export interface PruneOptions {
  /**
   * When set, any embedding_metadata + vector row whose model !== targetModel
   * is pruned and its live entity is re-queued as 'pending' if no targetModel
   * vectors remain for that entity. Omit to prune only orphans, legacy flat rows,
   * and missing-vector metadata ghosts.
   */
  targetModel?: string;
  /** Preview removals without modifying the database. */
  dryRun?: boolean;
}

export interface PruneReport {
  targetModel: string | null;
  dryRun: boolean;
  /** Pre-V14 rows with empty entity_id. */
  legacyFlatRemoved: number;
  /** Post-V14 rows whose parent insight/message no longer exists. */
  orphanEntityRemoved: number;
  /** Metadata rows for live entities whose vector ID is absent from vec_*. */
  missingVectorRemoved: number;
  /** Metadata rows for live entities matching a different model than targetModel. */
  wrongModelRemoved: number;
  totalMetadataRemoved: number;
  vecInsightsRemoved: number;
  vecMessagesRemoved: number;
  danglingInsightVectorsRemoved: number;
  danglingMessageVectorsRemoved: number;
  orphanInsightChunksRemoved: number;
  orphanMessageChunksRemoved: number;
  requeuedInsights: number;
  requeuedMessages: number;
}

const BATCH_SIZE = 500;

function getExistingTables(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
    .all() as Array<{ name: string }>;
  return new Set(rows.map(r => r.name));
}

function collectIdSet(db: Database.Database, sql: string): Set<string> {
  const ids = new Set<string>();
  for (const row of db.prepare(sql).iterate() as Iterable<{ id: string }>) {
    ids.add(row.id);
  }
  return ids;
}

function deleteInBatches(
  db: Database.Database,
  sqlPrefix: string,
  ids: string[],
  sqlSuffix = '',
): void {
  if (ids.length === 0) return;
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(',');
    db.prepare(`${sqlPrefix} (${placeholders})${sqlSuffix}`).run(...batch);
  }
}

/**
 * Audit and prune stale, orphaned, pre-V14, and off-model embedding artifacts.
 * Reconciles `embedding_metadata`, `vec_insights`, `vec_messages`, and `entity_chunks`,
 * and marks any live entity whose only vectors were pruned back to `embedding_status = 'pending'`.
 */
export function pruneEmbeddings(
  db: Database.Database,
  opts: PruneOptions = {},
): PruneReport {
  const dryRun = opts.dryRun ?? false;
  const targetModel = opts.targetModel ?? null;
  const tables = getExistingTables(db);

  const hasInsights = tables.has('insights');
  const hasMessages = tables.has('messages');
  const hasMetadata = tables.has('embedding_metadata');
  const hasEntityChunks = tables.has('entity_chunks');
  const hasVecInsights = tables.has('vec_insights');
  const hasVecMessages = tables.has('vec_messages');

  if (hasVecInsights || hasVecMessages) {
    loadVectorExtension(db);
  }

  if (!dryRun && hasMetadata) {
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_embedding_metadata_entity ON embedding_metadata(entity_type, entity_id)`,
    );
  }

  const liveInsightIds = hasInsights ? collectIdSet(db, `SELECT id FROM insights`) : new Set<string>();
  const liveMessageIds = hasMessages ? collectIdSet(db, `SELECT id FROM messages`) : new Set<string>();
  const vecInsightIds = hasVecInsights ? collectIdSet(db, `SELECT id FROM vec_insights`) : new Set<string>();
  const vecMessageIds = hasVecMessages ? collectIdSet(db, `SELECT id FROM vec_messages`) : new Set<string>();

  const metaIdsToDelete: string[] = [];
  const metaIdSet = new Set<string>();
  const keptInsightMetaIds = new Set<string>();
  const keptMessageMetaIds = new Set<string>();
  const keptInsightEntities = new Set<string>();
  const keptMessageEntities = new Set<string>();
  const affectedLiveInsights = new Set<string>();
  const affectedLiveMessages = new Set<string>();

  let legacyFlatRemoved = 0;
  let orphanEntityRemoved = 0;
  let missingVectorRemoved = 0;
  let wrongModelRemoved = 0;

  if (hasMetadata) {
    const metaRows = db
      .prepare(`SELECT id, entity_type, entity_id, model FROM embedding_metadata`)
      .iterate() as Iterable<{
      id: string;
      entity_type: 'insight' | 'message';
      entity_id: string;
      model: string;
    }>;

    for (const m of metaRows) {
      metaIdSet.add(m.id);
      const isInsight = m.entity_type === 'insight';
      const inVec = isInsight ? vecInsightIds.has(m.id) : vecMessageIds.has(m.id);

      if (!m.entity_id) {
        legacyFlatRemoved++;
        metaIdsToDelete.push(m.id);
        if (inVec) {
          if (isInsight && liveInsightIds.has(m.id)) affectedLiveInsights.add(m.id);
          if (!isInsight && liveMessageIds.has(m.id)) affectedLiveMessages.add(m.id);
        }
        continue;
      }

      const entityExists = isInsight ? liveInsightIds.has(m.entity_id) : liveMessageIds.has(m.entity_id);
      if (!entityExists) {
        orphanEntityRemoved++;
        metaIdsToDelete.push(m.id);
        continue;
      }

      if (!inVec) {
        missingVectorRemoved++;
        metaIdsToDelete.push(m.id);
        if (isInsight) affectedLiveInsights.add(m.entity_id);
        else affectedLiveMessages.add(m.entity_id);
        continue;
      }

      if (targetModel && m.model !== targetModel) {
        wrongModelRemoved++;
        metaIdsToDelete.push(m.id);
        if (isInsight) affectedLiveInsights.add(m.entity_id);
        else affectedLiveMessages.add(m.entity_id);
        continue;
      }

      if (isInsight) {
        keptInsightMetaIds.add(m.id);
        keptInsightEntities.add(m.entity_id);
      } else {
        keptMessageMetaIds.add(m.id);
        keptMessageEntities.add(m.entity_id);
      }
    }
  }

  const requeueInsightIds = [...affectedLiveInsights].filter(id => !keptInsightEntities.has(id));
  const requeueMessageIds = [...affectedLiveMessages].filter(id => !keptMessageEntities.has(id));
  const requeueInsightSet = new Set(requeueInsightIds);
  const requeueMessageSet = new Set(requeueMessageIds);

  const vecInsightsToDelete: string[] = [];
  let danglingInsightVectorsRemoved = 0;
  for (const id of vecInsightIds) {
    if (!keptInsightMetaIds.has(id)) {
      vecInsightsToDelete.push(id);
      if (!metaIdSet.has(id)) danglingInsightVectorsRemoved++;
    }
  }

  const vecMessagesToDelete: string[] = [];
  let danglingMessageVectorsRemoved = 0;
  for (const id of vecMessageIds) {
    if (!keptMessageMetaIds.has(id)) {
      vecMessagesToDelete.push(id);
      if (!metaIdSet.has(id)) danglingMessageVectorsRemoved++;
    }
  }

  const chunkIdsToDelete: string[] = [];
  let orphanInsightChunksRemoved = 0;
  let orphanMessageChunksRemoved = 0;

  if (hasEntityChunks) {
    const chunkRows = db
      .prepare(`SELECT id, entity_type, entity_id FROM entity_chunks`)
      .iterate() as Iterable<{ id: string; entity_type: 'insight' | 'message'; entity_id: string }>;

    for (const c of chunkRows) {
      if (c.entity_type === 'insight') {
        const isOrphan = !liveInsightIds.has(c.entity_id);
        if (isOrphan || requeueInsightSet.has(c.entity_id)) {
          chunkIdsToDelete.push(c.id);
          if (isOrphan) orphanInsightChunksRemoved++;
        }
      } else {
        const isOrphan = !liveMessageIds.has(c.entity_id);
        if (isOrphan || requeueMessageSet.has(c.entity_id)) {
          chunkIdsToDelete.push(c.id);
          if (isOrphan) orphanMessageChunksRemoved++;
        }
      }
    }
  }

  if (!dryRun) {
    db.transaction(() => {
      if (hasVecInsights) {
        deleteInBatches(db, `DELETE FROM vec_insights WHERE id IN`, vecInsightsToDelete);
      }
      if (hasVecMessages) {
        deleteInBatches(db, `DELETE FROM vec_messages WHERE id IN`, vecMessagesToDelete);
      }
      if (hasMetadata) {
        deleteInBatches(db, `DELETE FROM embedding_metadata WHERE id IN`, metaIdsToDelete);
      }
      if (hasEntityChunks) {
        deleteInBatches(db, `DELETE FROM entity_chunks WHERE id IN`, chunkIdsToDelete);
      }
      if (hasInsights) {
        deleteInBatches(
          db,
          `UPDATE insights SET embedding_status = 'pending' WHERE id IN`,
          requeueInsightIds,
        );
      }
      if (hasMessages) {
        deleteInBatches(
          db,
          `UPDATE messages SET embedding_status = 'pending' WHERE id IN`,
          requeueMessageIds,
        );
      }
    })();
  }

  return {
    targetModel,
    dryRun,
    legacyFlatRemoved,
    orphanEntityRemoved,
    missingVectorRemoved,
    wrongModelRemoved,
    totalMetadataRemoved: metaIdsToDelete.length,
    vecInsightsRemoved: vecInsightsToDelete.length,
    vecMessagesRemoved: vecMessagesToDelete.length,
    danglingInsightVectorsRemoved,
    danglingMessageVectorsRemoved,
    orphanInsightChunksRemoved,
    orphanMessageChunksRemoved,
    requeuedInsights: requeueInsightIds.length,
    requeuedMessages: requeueMessageIds.length,
  };
}
