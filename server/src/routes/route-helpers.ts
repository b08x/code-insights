// Shared helpers for route files — eliminates duplicated SQL queries and LLM guard blocks.
// Centralising these here ensures the session/messages query columns stay in sync across
// analysis.ts, facets.ts, export.ts, and reflect.ts. If a new column is added to the
// sessions or messages tables it only needs updating in one place.

import type { MiddlewareHandler } from 'hono';
import { getDb } from '@code-insights/cli/db/client';
import { isLLMConfigured } from '../llm/client.js';
import type { SessionData } from '../llm/analysis.js';
import type { SQLiteMessageRow } from '../llm/analysis.js';

/**
 * Load a session row for LLM analysis. Returns undefined if the session doesn't exist
 * or has been soft-deleted. The selected columns match exactly what the analysis engine
 * expects via the SessionData interface.
 */
export function loadSessionForAnalysis(db: ReturnType<typeof getDb>, sessionId: string): SessionData | undefined {
  return db.prepare(`
    SELECT id, project_id, project_name, project_path, summary, ended_at,
           compact_count, auto_compact_count, slash_commands
    FROM sessions WHERE id = ? AND deleted_at IS NULL
  `).get(sessionId) as SessionData | undefined;
}

/**
 * Load all messages for a session, ordered by timestamp ascending.
 * The selected columns match the SQLiteMessageRow interface consumed by the analysis engine.
 */
export function loadSessionMessages(db: ReturnType<typeof getDb>, sessionId: string): SQLiteMessageRow[] {
  return db.prepare(`
    SELECT id, session_id, type, content, thinking, tool_calls, tool_results, usage, timestamp, parent_id
    FROM messages WHERE session_id = ? ORDER BY timestamp ASC
  `).all(sessionId) as SQLiteMessageRow[];
}

/**
 * Hono middleware factory that short-circuits with a 400 if no LLM provider is configured.
 * Apply per-route: app.post('/route', requireLLM(), async (c) => { ... })
 * The error shape { success: false, error: '...' } matches the analysis endpoint convention.
 */
export function requireLLM(): MiddlewareHandler {
  return async (c, next) => {
    if (!isLLMConfigured()) {
      return c.json({
        success: false,
        error: 'LLM not configured. Run `code-insights config llm` to configure a provider.',
      }, 400);
    }
    await next();
  };
}
