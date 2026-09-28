// ──────────────────────────────────────────────────────
// Local data source for stats commands
//
// Reads directly from the local SQLite database.
// Auto-syncs on prepare() unless --no-sync is passed.
// ──────────────────────────────────────────────────────

import type {
  StatsDataSource,
  SessionRow,
  SessionQueryOptions,
  UsageStatsDoc,
  ProjectResolution,
  PrepareResult,
  StatsFlags,
} from './types.js';
import { ProjectNotFoundError } from './types.js';
import { findSimilarNames } from './fuzzy-match.js';
import { getSessions, getSessionCount, getLastSession, getProjectList } from '../../../db/read.js';
import { getDb } from '../../../db/client.js';

// ──────────────────────────────────────────────────────
// LocalDataSource
// ──────────────────────────────────────────────────────

export class LocalDataSource implements StatsDataSource {
  readonly name = 'local';

  async prepare(flags: StatsFlags): Promise<PrepareResult> {
    // Initialize the DB (runs migrations if first use)
    const db = getDb();

    // Clean up any temporary schema_version > 14 if it was recorded
    try {
      db.prepare('DELETE FROM schema_version WHERE version > 14').run();
    } catch {
      // Ignore
    }

    // Backfill token estimates and cost for Antigravity sessions from stored message contents
    try {
      db.exec(`
        UPDATE sessions
        SET
          total_input_tokens = (
            SELECT COALESCE(SUM(LENGTH(content)) / 4, 0)
            FROM messages
            WHERE messages.session_id = sessions.id AND messages.type = 'user'
          ),
          total_output_tokens = (
            SELECT COALESCE(SUM(LENGTH(content)) / 4, 0)
            FROM messages
            WHERE messages.session_id = sessions.id AND messages.type = 'assistant'
          ),
          primary_model = 'gemini-2.0-flash'
        WHERE source_tool = 'antigravity'
          AND (total_input_tokens IS NULL OR total_input_tokens = 0);

        UPDATE sessions
        SET
          estimated_cost_usd = ROUND(
            (COALESCE(total_input_tokens, 0) * 0.0000001) + (COALESCE(total_output_tokens, 0) * 0.0000004),
            4
          )
        WHERE source_tool = 'antigravity'
          AND (estimated_cost_usd IS NULL OR estimated_cost_usd = 0);
      `);
    } catch {
      // Ignore
    }

    if (flags.noSync) {
      const count = getSessionCount();
      return { message: `${count} sessions in database`, dataChanged: false };
    }

    // Auto-sync before showing stats
    try {
      const { runSync } = await import('../../sync.js');
      const result = await runSync({ quiet: true });
      if (result.syncedCount > 0) {
        return {
          message: `Synced ${result.syncedCount} new sessions`,
          dataChanged: true,
        };
      }
      const total = getSessionCount();
      return { message: `${total} sessions`, dataChanged: false };
    } catch {
      const total = getSessionCount();
      return { message: `${total} sessions (sync failed)`, dataChanged: false };
    }
  }

  async getSessions(opts: SessionQueryOptions): Promise<SessionRow[]> {
    return getSessions(opts);
  }

  async getUsageStats(): Promise<UsageStatsDoc | null> {
    const db = getDb();
    const row = db.prepare(`
      SELECT total_input_tokens, total_output_tokens, cache_creation_tokens,
             cache_read_tokens, estimated_cost_usd, sessions_with_usage, last_updated_at
      FROM usage_stats WHERE id = 1
    `).get() as {
      total_input_tokens: number;
      total_output_tokens: number;
      cache_creation_tokens: number;
      cache_read_tokens: number;
      estimated_cost_usd: number;
      sessions_with_usage: number;
      last_updated_at: string;
    } | undefined;

    if (!row) return null;

    return {
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      cacheReadTokens: row.cache_read_tokens,
      estimatedCostUsd: row.estimated_cost_usd,
      sessionsWithUsage: row.sessions_with_usage,
      lastUpdatedAt: new Date(row.last_updated_at),
    };
  }

  async resolveProjectId(name: string): Promise<ProjectResolution> {
    const projectList = getProjectList();

    // Exact match (case-insensitive)
    const exact = projectList.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (exact) return { projectId: exact.id, projectName: exact.name };

    // Substring match
    const substring = projectList.filter((p) => p.name.toLowerCase().includes(name.toLowerCase()));
    if (substring.length === 1) return { projectId: substring[0].id, projectName: substring[0].name };

    // No match — throw with suggestions
    const suggestions = findSimilarNames(name, projectList.map((p) => p.name));
    throw new ProjectNotFoundError(
      `Project "${name}" not found.`,
      name,
      projectList.map((p) => ({ name: p.name })),
      suggestions,
    );
  }

  async getLastSession(opts?: Pick<SessionQueryOptions, 'sourceTool' | 'projectId'>): Promise<SessionRow | null> {
    return getLastSession(opts);
  }
}
