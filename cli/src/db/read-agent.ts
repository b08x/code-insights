// Read-only query functions backing the dashboard chat agent's tools.
// They take an explicit `db` so they are testable against an in-memory database and
// never touch the process-wide connection. Every text field returned is length-capped
// so a tool result can never dump a full transcript into the model context (agent-3).

import type Database from 'better-sqlite3';
import { querySimilar } from '../embeddings/store.js';

export const SNIPPET_MAX_CHARS = 300;
export const TURN_MAX_CHARS = 1500;
const RRF_K = 60;
const STAGE_LIMIT = 20;

function cap(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
}

/** Quote each term so user text cannot be interpreted as FTS5 operators. */
function buildSafeFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter(t => t.length > 0)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
}

/** Centre the snippet on the first matching term, then hard-cap the length. */
function snippetAround(content: string, terms: string[]): string {
  const lower = content.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  const start = Math.max(0, idx - 60);
  const slice = content.slice(start, start + SNIPPET_MAX_CHARS);
  return cap(slice.replace(/\s+/g, ' ').trim(), SNIPPET_MAX_CHARS);
}

// ─── searchSessionSnippets ────────────────────────────────────────────────────

export interface SessionSearchFilters {
  projectId?: string;
  sourceTool?: string;
}

export interface SessionSnippet {
  sessionId: string;
  title: string;
  projectName: string;
  startedAt: string;
  score: number;
  snippet: string;
}

export interface SessionSearchOptions {
  /** Pre-computed query embedding. Embedding is async, so the caller supplies it; omit for keyword-only. */
  queryVector?: Float32Array | null;
}

/**
 * Hybrid session search fused with Reciprocal Rank Fusion:
 * 1. FTS5/BM25 over messages, 2. LIKE over session metadata, 3. vector KNN over insights.
 * Returns at most `limit` sessions, each with a length-capped snippet.
 */
export function searchSessionSnippets(
  db: Database.Database,
  query: string,
  filters: SessionSearchFilters = {},
  limit = 5,
  opts: SessionSearchOptions = {},
): SessionSnippet[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const scores = new Map<string, number>();
  const snippets = new Map<string, string>();
  const bump = (sid: string, rank: number) => scores.set(sid, (scores.get(sid) ?? 0) + 1 / (RRF_K + rank + 1));
  const terms = trimmed.split(/\s+/).filter(t => t.length > 1);

  // 1. BM25 keyword search over message text (one row per session, best rank first)
  try {
    const fts = buildSafeFtsQuery(trimmed);
    if (fts) {
      const rows = db.prepare(`
        SELECT m.session_id AS session_id, m.content AS content
        FROM messages_fts f JOIN messages m ON f.rowid = m.rowid
        WHERE messages_fts MATCH ?
        ORDER BY bm25(messages_fts) ASC
        LIMIT ?
      `).all(fts, STAGE_LIMIT * 5) as Array<{ session_id: string; content: string }>;
      const seen = new Set<string>();
      let rank = 0;
      for (const row of rows) {
        if (seen.has(row.session_id)) continue;
        seen.add(row.session_id);
        bump(row.session_id, rank++);
        snippets.set(row.session_id, snippetAround(row.content, terms.length ? terms : [trimmed]));
        if (rank >= STAGE_LIMIT) break;
      }
    }
  } catch {
    // FTS unavailable or malformed — other stages still run.
  }

  // 2. Metadata LIKE (AND across terms)
  if (terms.length > 0) {
    const where = terms
      .map(() => '(summary LIKE ? OR generated_title LIKE ? OR custom_title LIKE ? OR source_tool LIKE ? OR project_path LIKE ?)')
      .join(' AND ');
    const params = terms.flatMap(t => Array(5).fill(`%${t}%`));
    const rows = db.prepare(`SELECT id, summary FROM sessions WHERE ${where} LIMIT ?`)
      .all(...params, STAGE_LIMIT) as Array<{ id: string; summary: string | null }>;
    rows.forEach((row, rank) => {
      bump(row.id, rank);
      if (!snippets.has(row.id) && row.summary) snippets.set(row.id, snippetAround(row.summary, terms));
    });
  }

  // 3. Vector KNN over insights
  if (opts.queryVector) {
    try {
      const hits = querySimilar(db, 'insight', opts.queryVector, 10);
      if (hits.length > 0) {
        const ids = hits.map(h => h.id);
        const rows = db.prepare(`SELECT id, session_id, summary FROM insights WHERE id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids) as Array<{ id: string; session_id: string; summary: string }>;
        const byId = new Map(rows.map(r => [r.id, r]));
        hits.forEach((h, rank) => {
          const ins = byId.get(h.id);
          if (!ins) return;
          bump(ins.session_id, rank);
          if (!snippets.has(ins.session_id)) snippets.set(ins.session_id, cap(ins.summary, SNIPPET_MAX_CHARS));
        });
      }
    } catch {
      // Vector extension/table missing — keyword results stand alone.
    }
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }));
  if (ranked.length === 0) return [];

  // Hydrate + filter (soft-deleted sessions never surface)
  const ids = ranked.map(r => r.id);
  const conds = [`id IN (${ids.map(() => '?').join(',')})`, 'deleted_at IS NULL'];
  const params: unknown[] = [...ids];
  if (filters.projectId) { conds.push('project_id = ?'); params.push(filters.projectId); }
  if (filters.sourceTool) { conds.push('source_tool = ?'); params.push(filters.sourceTool); }
  const meta = db.prepare(`
    SELECT id, project_name, started_at, summary,
           COALESCE(custom_title, generated_title, '') AS title
    FROM sessions WHERE ${conds.join(' AND ')}
  `).all(...params) as Array<{ id: string; project_name: string; started_at: string; summary: string | null; title: string }>;
  const metaById = new Map(meta.map(m => [m.id, m]));

  const out: SessionSnippet[] = [];
  for (const r of ranked) {
    const m = metaById.get(r.id);
    if (!m) continue;
    out.push({
      sessionId: r.id,
      title: cap(m.title, 120),
      projectName: m.project_name,
      startedAt: m.started_at,
      score: Math.round(r.score * 10000) / 10000,
      snippet: snippets.get(r.id) ?? cap(m.summary, SNIPPET_MAX_CHARS),
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ─── getSessionWindow ─────────────────────────────────────────────────────────

export interface SessionWindowTurn {
  turn: number;
  type: string;
  timestamp: string;
  content: string;
}

export interface SessionWindow {
  sessionId: string;
  title: string;
  projectName: string;
  summary: string;
  totalTurns: number;
  fromTurn: number;
  toTurn: number;
  turns: SessionWindowTurn[];
}

/**
 * Inclusive, 0-based turn window of a session's messages (ordered by timestamp).
 * Bounds are clamped and the window is capped at `maxTurns` so one call cannot return a full transcript.
 */
export function getSessionWindow(
  db: Database.Database,
  sessionId: string,
  fromTurn: number,
  toTurn: number,
  opts: { maxTurns?: number } = {},
): SessionWindow | null {
  const session = db.prepare(`
    SELECT id, project_name, summary, COALESCE(custom_title, generated_title, '') AS title
    FROM sessions WHERE id = ? AND deleted_at IS NULL
  `).get(sessionId) as { id: string; project_name: string; summary: string | null; title: string } | undefined;
  if (!session) return null;

  const total = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(sessionId) as { n: number }).n;
  const maxTurns = opts.maxTurns ?? 40;
  const from = Math.max(0, Math.floor(Number.isFinite(fromTurn) ? fromTurn : 0));
  const requestedTo = Math.floor(Number.isFinite(toTurn) ? toTurn : from + maxTurns - 1);
  const to = Math.max(from, Math.min(total - 1, requestedTo, from + maxTurns - 1));
  const count = total === 0 ? 0 : to - from + 1;

  const rows = count > 0
    ? db.prepare(`
        SELECT type, content, timestamp FROM messages WHERE session_id = ?
        ORDER BY timestamp ASC, rowid ASC LIMIT ? OFFSET ?
      `).all(sessionId, count, from) as Array<{ type: string; content: string; timestamp: string }>
    : [];

  return {
    sessionId,
    title: session.title,
    projectName: session.project_name,
    summary: cap(session.summary, 600),
    totalTurns: total,
    fromTurn: from,
    toTurn: to,
    turns: rows.map((r, i) => ({ turn: from + i, type: r.type, timestamp: r.timestamp, content: cap(r.content, TURN_MAX_CHARS) })),
  };
}

// ─── listInsights ─────────────────────────────────────────────────────────────

export interface InsightFilters {
  sessionId?: string;
  projectId?: string;
  type?: string;
  limit?: number;
}

export interface InsightSummary {
  id: string;
  sessionId: string;
  projectName: string;
  type: string;
  title: string;
  summary: string;
  content: string;
  confidence: number;
  timestamp: string;
}

export function listInsights(db: Database.Database, filters: InsightFilters = {}): InsightSummary[] {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filters.sessionId) { conds.push('i.session_id = ?'); params.push(filters.sessionId); }
  if (filters.projectId) { conds.push('i.project_id = ?'); params.push(filters.projectId); }
  if (filters.type) { conds.push('i.type = ?'); params.push(filters.type); }
  const limit = Math.min(Math.max(filters.limit ?? 20, 1), 50);
  const rows = db.prepare(`
    SELECT i.id, i.session_id, i.project_name, i.type, i.title, i.summary, i.content, i.confidence, i.timestamp
    FROM insights i JOIN sessions s ON s.id = i.session_id
    WHERE s.deleted_at IS NULL ${conds.length ? 'AND ' + conds.join(' AND ') : ''}
    ORDER BY i.confidence DESC, i.timestamp DESC
    LIMIT ?
  `).all(...params, limit) as Array<Record<string, any>>;
  return rows.map(r => ({
    id: r.id,
    sessionId: r.session_id,
    projectName: r.project_name,
    type: r.type,
    title: r.title,
    summary: cap(r.summary, SNIPPET_MAX_CHARS),
    content: cap(r.content, SNIPPET_MAX_CHARS * 2),
    confidence: r.confidence,
    timestamp: r.timestamp,
  }));
}

// ─── getAnalyticsSummary ──────────────────────────────────────────────────────

export type AnalyticsRange = '7d' | '30d' | '90d' | 'all';

export interface AnalyticsSummary {
  range: AnalyticsRange;
  sessionCount: number;
  activeProjects: number;
  totalMessages: number;
  totalToolCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  bySourceTool: Array<{ sourceTool: string; sessionCount: number }>;
}

const RANGE_DAYS: Record<Exclude<AnalyticsRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function getAnalyticsSummary(db: Database.Database, range: AnalyticsRange = '30d'): AnalyticsSummary {
  const where = ['deleted_at IS NULL'];
  const params: unknown[] = [];
  if (range !== 'all') {
    where.push('started_at >= ?');
    params.push(new Date(Date.now() - RANGE_DAYS[range] * 86_400_000).toISOString());
  }
  const w = where.join(' AND ');
  const s = db.prepare(`
    SELECT COUNT(*) AS c, COUNT(DISTINCT project_id) AS p, COALESCE(SUM(message_count),0) AS m,
           COALESCE(SUM(tool_call_count),0) AS t, COALESCE(SUM(total_input_tokens),0) AS i,
           COALESCE(SUM(total_output_tokens),0) AS o, COALESCE(SUM(estimated_cost_usd),0) AS cost
    FROM sessions WHERE ${w}
  `).get(...params) as Record<string, number>;
  const by = db.prepare(`SELECT source_tool, COUNT(*) AS n FROM sessions WHERE ${w} GROUP BY source_tool ORDER BY n DESC`)
    .all(...params) as Array<{ source_tool: string; n: number }>;
  return {
    range,
    sessionCount: s.c,
    activeProjects: s.p,
    totalMessages: s.m,
    totalToolCalls: s.t,
    totalInputTokens: s.i,
    totalOutputTokens: s.o,
    estimatedCostUsd: Math.round(s.cost * 100) / 100,
    bySourceTool: by.map(b => ({ sourceTool: b.source_tool, sessionCount: b.n })),
  };
}
