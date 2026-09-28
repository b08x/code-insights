import type Database from 'better-sqlite3';
import { getDb } from './client.js';
import { recalculateUsageStats } from './write.js';

export interface PurgeOptions {
  sessionIds?: string[];
  reason?: string;
  dryRun?: boolean;
}

export interface PurgeResult {
  purgedCount: number;
  sessionIds: string[];
}

/**
 * Check if a session has been tombstoned in deleted_sessions.
 */
export function isSessionTombstoned(sessionId: string, db: Database.Database = getDb()): boolean {
  try {
    const row = db.prepare('SELECT 1 FROM deleted_sessions WHERE id = ?').get(sessionId);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Hard delete sessions and register tombstones in deleted_sessions to permanently block re-import on resync.
 * If options.sessionIds is omitted, purges all sessions currently soft-deleted (deleted_at IS NOT NULL).
 */
export function purgeSessions(
  db: Database.Database = getDb(),
  options: PurgeOptions = {}
): PurgeResult {
  const targetIds: string[] = options.sessionIds && options.sessionIds.length > 0
    ? options.sessionIds
    : (db.prepare('SELECT id FROM sessions WHERE deleted_at IS NOT NULL').all() as Array<{ id: string }>).map(r => r.id);

  if (targetIds.length === 0) {
    return { purgedCount: 0, sessionIds: [] };
  }

  if (options.dryRun) {
    return { purgedCount: targetIds.length, sessionIds: targetIds };
  }

  const reason = options.reason || 'User purged';

  const insertTombstone = db.prepare(`
    INSERT INTO deleted_sessions (id, deleted_at, reason)
    VALUES (?, datetime('now'), ?)
    ON CONFLICT(id) DO UPDATE SET
      deleted_at = datetime('now'),
      reason = excluded.reason
  `);

  const deleteSessionSteps = db.prepare('DELETE FROM session_steps WHERE session_id = ?');
  const deleteFacets = db.prepare('DELETE FROM session_facets WHERE session_id = ?');
  const deleteInsights = db.prepare('DELETE FROM insights WHERE session_id = ?');
  const deleteUsage = db.prepare('DELETE FROM analysis_usage WHERE session_id = ?');
  const deleteQueue = db.prepare('DELETE FROM analysis_queue WHERE session_id = ?');
  const deleteMessages = db.prepare('DELETE FROM messages WHERE session_id = ?');
  const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');

  // Track affected projects to adjust session_count
  const projectIds = new Set<string>();
  const getProjectStmt = db.prepare('SELECT project_id FROM sessions WHERE id = ?');

  const runTx = db.transaction(() => {
    for (const id of targetIds) {
      const projRow = getProjectStmt.get(id) as { project_id?: string } | undefined;
      if (projRow?.project_id) {
        projectIds.add(projRow.project_id);
      }

      insertTombstone.run(id, reason);
      deleteSessionSteps.run(id);
      deleteFacets.run(id);
      deleteInsights.run(id);
      deleteUsage.run(id);
      deleteQueue.run(id);
      deleteMessages.run(id);
      deleteSession.run(id);
    }

    const updateProjectCount = db.prepare(`
      UPDATE projects
      SET session_count = (SELECT COUNT(*) FROM sessions WHERE project_id = projects.id),
          updated_at = datetime('now')
      WHERE id = ?
    `);
    for (const projId of projectIds) {
      updateProjectCount.run(projId);
    }
  });

  runTx();

  try {
    recalculateUsageStats();
  } catch {
    // Non-fatal if usage stats recalculation fails
  }

  return {
    purgedCount: targetIds.length,
    sessionIds: targetIds,
  };
}

/**
 * Remove a session from the tombstone table, allowing it to be synced again if desired.
 */
export function unTombstoneSession(sessionId: string, db: Database.Database = getDb()): boolean {
  const result = db.prepare('DELETE FROM deleted_sessions WHERE id = ?').run(sessionId);
  return result.changes > 0;
}
