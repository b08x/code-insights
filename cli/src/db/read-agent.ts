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
const VECTOR_CANDIDATE_K = 50;

const DEFAULT_SQL_MAX_ROWS = 50;
const DEFAULT_SQL_MAX_CELL_CHARS = 400;
const DEFAULT_SQL_MAX_TOTAL_BYTES = 24_000;

export const ANALYTICAL_TABLES = new Set([
  'projects',
  'sessions',
  'messages',
  'messages_fts',
  'insights',
  'session_facets',
  'session_steps',
  'analysis_usage',
  'reflect_snapshots',
  'usage_stats',
]);

export const ALLOWED_TABLE_FUNCTIONS = new Set([
  'json_each',
  'json_tree',
]);

const FORBIDDEN_SQL_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'VACUUM',
  'REINDEX',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'TRIGGER',
  'LOAD_EXTENSION',
]);

const FROM_CLAUSE_END_KEYWORDS = new Set([
  'WHERE',
  'GROUP',
  'HAVING',
  'WINDOW',
  'ORDER',
  'LIMIT',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'VALUES',
  'SET',
]);

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

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&');
}

// ─── Facet brief extraction ───────────────────────────────────────────────────

export interface SessionFacetBrief {
  outcomeSatisfaction: string;
  workflowPattern: string | null;
  hadCourseCorrection: boolean;
  frictionCategories: string[];
  effectivePatternCategories: string[];
}

function extractCategories(rawJson: string | null | undefined): string[] {
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (item && typeof item === 'object' && typeof (item as { category?: unknown }).category === 'string') {
        const cat = (item as { category: string }).category.trim();
        if (cat && !seen.has(cat)) {
          seen.add(cat);
          out.push(cat);
          if (out.length >= 5) break;
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

function toFacetBrief(row: {
  outcome_satisfaction?: string | null;
  workflow_pattern?: string | null;
  had_course_correction?: number | null;
  friction_points?: string | null;
  effective_patterns?: string | null;
}): SessionFacetBrief | null {
  if (!row.outcome_satisfaction) return null;
  return {
    outcomeSatisfaction: row.outcome_satisfaction,
    workflowPattern: row.workflow_pattern ?? null,
    hadCourseCorrection: row.had_course_correction === 1,
    frictionCategories: extractCategories(row.friction_points),
    effectivePatternCategories: extractCategories(row.effective_patterns),
  };
}

// ─── Guarded read-only SQL validator & executor ───────────────────────────────

interface SqlToken {
  type: 'word' | 'string' | 'ident' | 'symbol' | 'number' | 'param';
  value: string;
  upper: string;
}

function stripSqlFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:sql|sqlite)?\s*([\s\S]*?)\s*```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

function tokenizeSql(sql: string): { ok: true; tokens: SqlToken[] } | { ok: false; error: string } {
  const tokens: SqlToken[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const ch = sql[i];

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    // Line comment
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return { ok: false, error: 'Unclosed block comment in SQL' };
      i = end + 2;
      continue;
    }

    // Single-quoted string literal
    if (ch === "'") {
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          val += "'";
          j += 2;
        } else if (sql[j] === "'") {
          break;
        } else {
          val += sql[j++];
        }
      }
      if (j >= n) return { ok: false, error: 'Unclosed string literal in SQL' };
      tokens.push({ type: 'string', value: val, upper: val.toUpperCase() });
      i = j + 1;
      continue;
    }

    // Double-quoted or backtick identifier
    if (ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (sql[j] === quote && sql[j + 1] === quote) {
          val += quote;
          j += 2;
        } else if (sql[j] === quote) {
          break;
        } else {
          val += sql[j++];
        }
      }
      if (j >= n) return { ok: false, error: 'Unclosed quoted identifier in SQL' };
      tokens.push({ type: 'ident', value: val, upper: val.toUpperCase() });
      i = j + 1;
      continue;
    }

    // Bracket identifier [name]
    if (ch === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end === -1) return { ok: false, error: 'Unclosed bracket identifier in SQL' };
      const val = sql.slice(i + 1, end);
      tokens.push({ type: 'ident', value: val, upper: val.toUpperCase() });
      i = end + 1;
      continue;
    }

    // Bind parameters (:name, @name, $name, ?)
    if (ch === '?') {
      let j = i + 1;
      while (j < n && /\d/.test(sql[j])) j++;
      const val = sql.slice(i, j);
      tokens.push({ type: 'param', value: val, upper: val });
      i = j;
      continue;
    }
    if ((ch === ':' || ch === '@' || ch === '$') && i + 1 < n && /[A-Za-z_]/.test(sql[i + 1])) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const val = sql.slice(i, j);
      tokens.push({ type: 'param', value: val, upper: val.toUpperCase() });
      i = j;
      continue;
    }

    // Numbers
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[0-9.eExXa-fA-F+-]/.test(sql[j])) {
        if ((sql[j] === '+' || sql[j] === '-') && !/[eE]/.test(sql[j - 1])) break;
        j++;
      }
      const val = sql.slice(i, j);
      tokens.push({ type: 'number', value: val, upper: val.toUpperCase() });
      i = j;
      continue;
    }

    // Words (keywords or unquoted identifiers)
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
      const val = sql.slice(i, j);
      tokens.push({ type: 'word', value: val, upper: val.toUpperCase() });
      i = j;
      continue;
    }

    // Single-character symbols
    tokens.push({ type: 'symbol', value: ch, upper: ch });
    i++;
  }

  return { ok: true, tokens };
}

function skipBalancedParens(tokens: SqlToken[], openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    if (tokens[i].type === 'symbol' && tokens[i].value === '(') depth++;
    else if (tokens[i].type === 'symbol' && tokens[i].value === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

/** Collect CTE names declared in a WITH clause starting at `withIdx`. */
function collectCteNamesFromWith(tokens: SqlToken[], withIdx: number, out: Set<string>): void {
  let i = withIdx + 1;
  if (tokens[i]?.type === 'word' && tokens[i].upper === 'RECURSIVE') i++;

  while (i < tokens.length) {
    const nameTok = tokens[i];
    if (!nameTok || (nameTok.type !== 'word' && nameTok.type !== 'ident')) break;
    const candidateName = nameTok.value.toLowerCase();
    i++;

    // Optional column list: cte_name(col1, col2)
    if (tokens[i]?.type === 'symbol' && tokens[i].value === '(') {
      i = skipBalancedParens(tokens, i) + 1;
    }

    if (tokens[i]?.type !== 'word' || tokens[i].upper !== 'AS') break;
    i++;

    // Optional MATERIALIZED / NOT MATERIALIZED
    if (tokens[i]?.type === 'word' && tokens[i].upper === 'NOT') i++;
    if (tokens[i]?.type === 'word' && tokens[i].upper === 'MATERIALIZED') i++;

    if (tokens[i]?.type !== 'symbol' || tokens[i].value !== '(') break;
    out.add(candidateName);
    i = skipBalancedParens(tokens, i) + 1;

    if (tokens[i]?.type === 'symbol' && tokens[i].value === ',') {
      i++;
      continue;
    }
    break;
  }
}

/**
 * Validate that a SQL string is a single read-only SELECT/WITH query referencing
 * only analytical Code Insights tables, declared CTEs, and safe JSON table functions.
 */
export function validateReadOnlySql(
  rawSql: string,
): { ok: true; sql: string; tables: string[] } | { ok: false; error: string } {
  const cleaned = stripSqlFences(rawSql);
  if (!cleaned) {
    return { ok: false, error: 'SQL query is empty' };
  }

  const lexed = tokenizeSql(cleaned);
  if (!lexed.ok) return lexed;
  const tokens = lexed.tokens;
  if (tokens.length === 0) {
    return { ok: false, error: 'SQL query contains no tokens' };
  }

  // Only allow at most one trailing semicolon
  let hasTrailingSemi = false;
  for (let idx = 0; idx < tokens.length; idx++) {
    if (tokens[idx].type === 'symbol' && tokens[idx].value === ';') {
      if (idx === tokens.length - 1) {
        hasTrailingSemi = true;
      } else {
        return { ok: false, error: 'Only a single SQL statement is allowed' };
      }
    }
  }
  const activeTokens = hasTrailingSemi ? tokens.slice(0, -1) : tokens;
  if (activeTokens.length === 0) {
    return { ok: false, error: 'SQL query is empty' };
  }

  const first = activeTokens[0];
  if (first.type !== 'word' || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
    return { ok: false, error: 'Only SELECT or WITH queries are allowed' };
  }

  // Reject mutating/DDL/PRAGMA/extension keywords outside quoted identifiers and string literals
  for (let idx = 0; idx < activeTokens.length; idx++) {
    const tok = activeTokens[idx];
    if (tok.type !== 'word') continue;
    if (FORBIDDEN_SQL_KEYWORDS.has(tok.upper)) {
      return { ok: false, error: `Forbidden SQL keyword: ${tok.upper}` };
    }
    if (tok.upper === 'REPLACE') {
      const next = activeTokens[idx + 1];
      if (!next || next.type !== 'symbol' || next.value !== '(') {
        return { ok: false, error: 'Forbidden SQL keyword: REPLACE' };
      }
    }
  }

  // Collect all CTE names across top-level and nested WITH clauses
  const cteNames = new Set<string>();
  for (let idx = 0; idx < activeTokens.length; idx++) {
    const tok = activeTokens[idx];
    if (tok.type === 'word' && tok.upper === 'WITH') {
      collectCteNamesFromWith(activeTokens, idx, cteNames);
    }
  }

  // Walk tokens to inspect every table reference in FROM / JOIN / comma-join clauses
  const referencedTables = new Set<string>();
  let depth = 0;
  const inFromAtDepth = new Map<number, boolean>();
  const expectTableAtDepth = new Map<number, boolean>();

  for (let idx = 0; idx < activeTokens.length; idx++) {
    const tok = activeTokens[idx];

    if (tok.type === 'symbol' && tok.value === '(') {
      const wasExpecting = expectTableAtDepth.get(depth) === true;
      expectTableAtDepth.set(depth, false);
      depth++;
      if (wasExpecting) {
        const inner = activeTokens[idx + 1];
        // Parenthesized join like FROM (t1 JOIN t2 ...) instead of subquery FROM (SELECT ...)
        if (inner && !(inner.type === 'word' && (inner.upper === 'SELECT' || inner.upper === 'WITH' || inner.upper === 'VALUES')) && !(inner.type === 'symbol' && inner.value === '(')) {
          inFromAtDepth.set(depth, true);
          expectTableAtDepth.set(depth, true);
        }
      }
      continue;
    }

    if (tok.type === 'symbol' && tok.value === ')') {
      inFromAtDepth.delete(depth);
      expectTableAtDepth.delete(depth);
      depth = Math.max(0, depth - 1);
      continue;
    }

    if (tok.type === 'word' && (tok.upper === 'FROM' || tok.upper === 'JOIN')) {
      inFromAtDepth.set(depth, true);
      expectTableAtDepth.set(depth, true);
      continue;
    }

    if (inFromAtDepth.get(depth) && tok.type === 'word' && FROM_CLAUSE_END_KEYWORDS.has(tok.upper)) {
      inFromAtDepth.set(depth, false);
      expectTableAtDepth.set(depth, false);
      continue;
    }

    if (inFromAtDepth.get(depth) && tok.type === 'symbol' && tok.value === ',') {
      expectTableAtDepth.set(depth, true);
      continue;
    }

    if (expectTableAtDepth.get(depth) && (tok.type === 'word' || tok.type === 'ident')) {
      expectTableAtDepth.set(depth, false);

      let schema: string | null = null;
      let tableTok = tok;

      if (
        activeTokens[idx + 1]?.type === 'symbol' &&
        activeTokens[idx + 1].value === '.' &&
        activeTokens[idx + 2] &&
        (activeTokens[idx + 2].type === 'word' || activeTokens[idx + 2].type === 'ident')
      ) {
        schema = tok.value.toLowerCase();
        tableTok = activeTokens[idx + 2];
        idx += 2;
      }

      const tableName = tableTok.value.toLowerCase();

      if (schema !== null && schema !== 'main') {
        return { ok: false, error: `Schema prefix '${schema}' is not allowed` };
      }

      const isTableFn =
        schema === null &&
        activeTokens[idx + 1]?.type === 'symbol' &&
        activeTokens[idx + 1].value === '(' &&
        ALLOWED_TABLE_FUNCTIONS.has(tableName);

      if (isTableFn) {
        continue;
      }

      if (schema === null && cteNames.has(tableName)) {
        continue;
      }

      if (!ANALYTICAL_TABLES.has(tableName)) {
        return {
          ok: false,
          error: `Table '${tableName}' is not allowed. Allowed analytical tables: ${[...ANALYTICAL_TABLES].join(', ')}`,
        };
      }

      referencedTables.add(tableName);
    }
  }

  // Strip a trailing semicolon cleanly outside comments/strings
  const finalSql = hasTrailingSemi ? cleaned.replace(/;\s*$/, '').trim() : cleaned;
  return { ok: true, sql: finalSql, tables: [...referencedTables] };
}

export interface ReadOnlySqlResult {
  ok: boolean;
  sql: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  truncated: boolean;
  referencedSessionIds: string[];
  error?: string;
}

function sanitizeSqlCell(value: unknown, maxCellChars: number): unknown {
  if (typeof value === 'string') return cap(value, maxCellChars);
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[binary]';
  return value;
}

function resolveCanonicalSessionIds(db: Database.Database, candidates: string[]): string[] {
  if (candidates.length === 0) return [];
  const unique = [...new Set(candidates)].slice(0, 200);
  const placeholders = unique.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT s.id AS id, s.parent_session_id AS parent_session_id, p.deleted_at AS parent_deleted_at
    FROM sessions s
    LEFT JOIN sessions p ON p.id = s.parent_session_id
    WHERE s.id IN (${placeholders}) AND s.deleted_at IS NULL
  `).all(...unique) as Array<{
    id: string;
    parent_session_id: string | null;
    parent_deleted_at: string | null;
  }>;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.parent_session_id && r.parent_deleted_at) continue;
    const canonical = r.parent_session_id ?? r.id;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

/**
 * Validate and execute a single read-only SQL query with strict row, cell, and payload caps.
 * Never throws on bad SQL; returns structured `{ ok: false, error }` for self-repair retries.
 */
export function executeReadOnlySql(
  db: Database.Database,
  rawSql: string,
  opts: { maxRows?: number; maxCellChars?: number; maxTotalBytes?: number } = {},
): ReadOnlySqlResult {
  const maxRows = opts.maxRows ?? DEFAULT_SQL_MAX_ROWS;
  const maxCellChars = opts.maxCellChars ?? DEFAULT_SQL_MAX_CELL_CHARS;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_SQL_MAX_TOTAL_BYTES;

  const validation = validateReadOnlySql(rawSql);
  if (!validation.ok) {
    return {
      ok: false,
      sql: stripSqlFences(rawSql),
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      referencedSessionIds: [],
      error: validation.error,
    };
  }

  const restoreQueryOnly = !db.readonly;
  let previousQueryOnly: unknown;
  if (restoreQueryOnly) {
    previousQueryOnly = db.pragma('query_only', { simple: true });
    db.pragma('query_only = ON');
  }

  try {
    const stmt = db.prepare(validation.sql);
    if (!stmt.readonly) {
      return {
        ok: false,
        sql: validation.sql,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        referencedSessionIds: [],
        error: 'Statement is not read-only',
      };
    }

    const columns = stmt.columns().map(c => c.name);
    const rows: Array<Record<string, unknown>> = [];
    const candidateSessionIds: string[] = [];
    const allowIdColumn = validation.tables.includes('sessions');
    let truncated = false;
    let totalBytes = 0;

    for (const rawRow of stmt.iterate() as Iterable<Record<string, unknown>>) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }

      const cleanRow: Record<string, unknown> = {};
      for (const [col, val] of Object.entries(rawRow)) {
        if (typeof val === 'string' && val.length > 0) {
          if (col === 'session_id' || col === 'sessionId' || (allowIdColumn && col === 'id')) {
            candidateSessionIds.push(val);
          }
        }
        cleanRow[col] = sanitizeSqlCell(val, maxCellChars);
      }

      const rowBytes = Buffer.byteLength(JSON.stringify(cleanRow), 'utf8');
      if (rows.length > 0 && totalBytes + rowBytes > maxTotalBytes) {
        truncated = true;
        break;
      }
      totalBytes += rowBytes;
      rows.push(cleanRow);
    }

    const referencedSessionIds = resolveCanonicalSessionIds(db, candidateSessionIds);

    return {
      ok: true,
      sql: validation.sql,
      columns,
      rows,
      rowCount: rows.length,
      truncated,
      referencedSessionIds,
    };
  } catch (err) {
    return {
      ok: false,
      sql: validation.sql,
      columns: [],
      rows: [],
      rowCount: 0,
      truncated: false,
      referencedSessionIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (restoreQueryOnly) {
      try {
        db.pragma(`query_only = ${previousQueryOnly ? 'ON' : 'OFF'}`);
      } catch {
        // Ignore cleanup errors if DB was closed.
      }
    }
  }
}

// ─── searchSessionSnippets ────────────────────────────────────────────────────

export interface SessionSearchFilters {
  projectId?: string;
  projectName?: string;
  sourceTool?: string;
  since?: string;
  until?: string;
}

export interface SessionSnippet {
  sessionId: string;
  title: string;
  projectName: string;
  gitBranch: string | null;
  sourceTool: string;
  startedAt: string;
  endedAt: string;
  messageCount: number;
  sessionCharacter: string | null;
  score: number;
  snippet: string;
  childMatchCount?: number;
  facets: SessionFacetBrief | null;
}

export interface SessionSearchOptions {
  /** Pre-computed query embedding. Embedding is async, so the caller supplies it; omit for keyword-only. */
  queryVector?: Float32Array | null;
}

function buildSessionFilterSql(
  sessionAlias: string,
  parentAlias: string,
  filters: SessionSearchFilters,
): { sql: string; params: unknown[] } {
  const conds: string[] = [
    `${sessionAlias}.deleted_at IS NULL`,
    `(${sessionAlias}.parent_session_id IS NULL OR (${parentAlias}.id IS NOT NULL AND ${parentAlias}.deleted_at IS NULL))`,
  ];
  const params: unknown[] = [];

  if (filters.projectId) {
    conds.push(`COALESCE(${parentAlias}.project_id, ${sessionAlias}.project_id) = ?`);
    params.push(filters.projectId);
  }
  if (filters.projectName) {
    conds.push(`LOWER(COALESCE(${parentAlias}.project_name, ${sessionAlias}.project_name)) LIKE LOWER(?) ESCAPE '\\'`);
    params.push(`%${escapeLike(filters.projectName.trim())}%`);
  }
  if (filters.sourceTool) {
    conds.push(`(${sessionAlias}.source_tool = ? OR ${parentAlias}.source_tool = ?)`);
    params.push(filters.sourceTool, filters.sourceTool);
  }
  if (filters.since) {
    conds.push(`datetime(COALESCE(${parentAlias}.started_at, ${sessionAlias}.started_at)) >= datetime(?)`);
    params.push(filters.since);
  }
  if (filters.until) {
    conds.push(`datetime(COALESCE(${parentAlias}.started_at, ${sessionAlias}.started_at)) <= datetime(?)`);
    params.push(filters.until);
  }

  return { sql: conds.join(' AND '), params };
}

/**
 * Hybrid session search fused with Reciprocal Rank Fusion:
 * 1. FTS5/BM25 over messages, 2. LIKE over session metadata,
 * 3. vector KNN over vec_insights, 4. vector KNN over vec_messages.
 * All filters run BEFORE stage LIMITs, and subagent hits roll up into their parent session.
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
  const directSnippets = new Map<string, string>();
  const childSnippets = new Map<string, string>();
  const childMatches = new Map<string, Set<string>>();

  const bump = (canonicalId: string, rank: number) =>
    scores.set(canonicalId, (scores.get(canonicalId) ?? 0) + 1 / (RRF_K + rank + 1));

  const recordMatch = (
    row: { id: string; parent_session_id: string | null; agent_type: string | null },
    rank: number,
    rawSnippet: string,
  ) => {
    const canonicalId = row.parent_session_id ?? row.id;
    bump(canonicalId, rank);
    if (row.parent_session_id) {
      let set = childMatches.get(canonicalId);
      if (!set) {
        set = new Set<string>();
        childMatches.set(canonicalId, set);
      }
      set.add(row.id);
      if (!childSnippets.has(canonicalId) && rawSnippet) {
        const prefix = `[subagent${row.agent_type ? `:${row.agent_type}` : ''}] `;
        childSnippets.set(canonicalId, cap(prefix + rawSnippet, SNIPPET_MAX_CHARS));
      }
    } else if (!directSnippets.has(canonicalId) && rawSnippet) {
      directSnippets.set(canonicalId, cap(rawSnippet, SNIPPET_MAX_CHARS));
    }
  };

  const terms = trimmed.split(/\s+/).filter(t => t.length > 1);
  const snippetTerms = terms.length ? terms : [trimmed];
  const sessionFilter = buildSessionFilterSql('s', 'p', filters);

  // 1. BM25 keyword search over message text (filtered pre-LIMIT, rolled up to parent)
  try {
    const fts = buildSafeFtsQuery(trimmed);
    if (fts) {
      const rows = db.prepare(`
        SELECT s.id AS id, s.parent_session_id AS parent_session_id, s.agent_type AS agent_type, m.content AS content
        FROM messages_fts f
        JOIN messages m ON f.rowid = m.rowid
        JOIN sessions s ON s.id = m.session_id
        LEFT JOIN sessions p ON p.id = s.parent_session_id
        WHERE messages_fts MATCH ? AND ${sessionFilter.sql}
        ORDER BY bm25(messages_fts) ASC
        LIMIT ?
      `).all(fts, ...sessionFilter.params, STAGE_LIMIT * 5) as Array<{
        id: string;
        parent_session_id: string | null;
        agent_type: string | null;
        content: string;
      }>;
      const seen = new Set<string>();
      let rank = 0;
      for (const row of rows) {
        const canonicalId = row.parent_session_id ?? row.id;
        if (row.parent_session_id) {
          let set = childMatches.get(canonicalId);
          if (!set) {
            set = new Set<string>();
            childMatches.set(canonicalId, set);
          }
          set.add(row.id);
        }
        if (seen.has(canonicalId)) continue;
        seen.add(canonicalId);
        recordMatch(row, rank++, snippetAround(row.content, snippetTerms));
        if (rank >= STAGE_LIMIT) break;
      }
    }
  } catch {
    // FTS unavailable or malformed — other stages still run.
  }

  // 2. Metadata LIKE (AND across terms, filtered pre-LIMIT)
  if (terms.length > 0) {
    const likeWhere = terms
      .map(
        () =>
          "(s.summary LIKE ? ESCAPE '\\' OR s.generated_title LIKE ? ESCAPE '\\' OR s.custom_title LIKE ? ESCAPE '\\' OR s.project_name LIKE ? ESCAPE '\\' OR s.project_path LIKE ? ESCAPE '\\' OR COALESCE(s.git_branch, '') LIKE ? ESCAPE '\\' OR s.source_tool LIKE ? ESCAPE '\\')",
      )
      .join(' AND ');
    const likeParams = terms.flatMap(t => Array(7).fill(`%${escapeLike(t)}%`));
    const rows = db.prepare(`
      SELECT s.id AS id, s.parent_session_id AS parent_session_id, s.agent_type AS agent_type, s.summary AS summary
      FROM sessions s
      LEFT JOIN sessions p ON p.id = s.parent_session_id
      WHERE (${likeWhere}) AND ${sessionFilter.sql}
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(...likeParams, ...sessionFilter.params, STAGE_LIMIT * 2) as Array<{
      id: string;
      parent_session_id: string | null;
      agent_type: string | null;
      summary: string | null;
    }>;
    const seen = new Set<string>();
    let rank = 0;
    for (const row of rows) {
      const canonicalId = row.parent_session_id ?? row.id;
      if (row.parent_session_id) {
        let set = childMatches.get(canonicalId);
        if (!set) {
          set = new Set<string>();
          childMatches.set(canonicalId, set);
        }
        set.add(row.id);
      }
      if (seen.has(canonicalId)) continue;
      seen.add(canonicalId);
      recordMatch(row, rank++, row.summary ? snippetAround(row.summary, terms) : '');
      if (rank >= STAGE_LIMIT) break;
    }
  }

  // 3. Vector KNN over insights
  if (opts.queryVector) {
    try {
      const hits = querySimilar(db, 'insight', opts.queryVector, VECTOR_CANDIDATE_K);
      if (hits.length > 0) {
        const ids = hits.map(h => h.id);
        const rows = db.prepare(`
          SELECT i.id AS insight_id, i.summary AS summary,
                 s.id AS id, s.parent_session_id AS parent_session_id, s.agent_type AS agent_type
          FROM insights i
          JOIN sessions s ON s.id = i.session_id
          LEFT JOIN sessions p ON p.id = s.parent_session_id
          WHERE i.id IN (${ids.map(() => '?').join(',')}) AND ${sessionFilter.sql}
        `).all(...ids, ...sessionFilter.params) as Array<{
          insight_id: string;
          summary: string;
          id: string;
          parent_session_id: string | null;
          agent_type: string | null;
        }>;
        const byId = new Map(rows.map(r => [r.insight_id, r]));
        const seen = new Set<string>();
        let rank = 0;
        for (const h of hits) {
          const ins = byId.get(h.id);
          if (!ins) continue;
          const canonicalId = ins.parent_session_id ?? ins.id;
          if (ins.parent_session_id) {
            let set = childMatches.get(canonicalId);
            if (!set) {
              set = new Set<string>();
              childMatches.set(canonicalId, set);
            }
            set.add(ins.id);
          }
          if (seen.has(canonicalId)) continue;
          seen.add(canonicalId);
          recordMatch(ins, rank++, cap(ins.summary, SNIPPET_MAX_CHARS));
        }
      }
    } catch {
      // Vector extension/table missing — other stages still stand.
    }

    // 4. Vector KNN over messages
    try {
      const hits = querySimilar(db, 'message', opts.queryVector, VECTOR_CANDIDATE_K);
      if (hits.length > 0) {
        const ids = hits.map(h => h.id);
        const rows = db.prepare(`
          SELECT m.id AS message_id, m.content AS content,
                 s.id AS id, s.parent_session_id AS parent_session_id, s.agent_type AS agent_type
          FROM messages m
          JOIN sessions s ON s.id = m.session_id
          LEFT JOIN sessions p ON p.id = s.parent_session_id
          WHERE m.id IN (${ids.map(() => '?').join(',')}) AND ${sessionFilter.sql}
        `).all(...ids, ...sessionFilter.params) as Array<{
          message_id: string;
          content: string;
          id: string;
          parent_session_id: string | null;
          agent_type: string | null;
        }>;
        const byId = new Map(rows.map(r => [r.message_id, r]));
        const seen = new Set<string>();
        let rank = 0;
        for (const h of hits) {
          const msg = byId.get(h.id);
          if (!msg) continue;
          const canonicalId = msg.parent_session_id ?? msg.id;
          if (msg.parent_session_id) {
            let set = childMatches.get(canonicalId);
            if (!set) {
              set = new Set<string>();
              childMatches.set(canonicalId, set);
            }
            set.add(msg.id);
          }
          if (seen.has(canonicalId)) continue;
          seen.add(canonicalId);
          recordMatch(msg, rank++, snippetAround(msg.content, snippetTerms));
        }
      }
    } catch {
      // Vector extension/table missing — other stages still stand.
    }
  }

  const ranked = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ id, score }));
  if (ranked.length === 0) return [];

  // Hydrate canonical parent sessions + facets
  const ids = ranked.map(r => r.id);
  const meta = db.prepare(`
    SELECT s.id, s.project_name, s.git_branch, s.source_tool, s.started_at, s.ended_at,
           s.message_count, s.session_character, s.summary,
           COALESCE(s.custom_title, s.generated_title, '') AS title,
           sf.outcome_satisfaction, sf.workflow_pattern, sf.had_course_correction,
           sf.friction_points, sf.effective_patterns
    FROM sessions s
    LEFT JOIN session_facets sf ON sf.session_id = s.id
    WHERE s.id IN (${ids.map(() => '?').join(',')}) AND s.deleted_at IS NULL
  `).all(...ids) as Array<{
    id: string;
    project_name: string;
    git_branch: string | null;
    source_tool: string;
    started_at: string;
    ended_at: string;
    message_count: number;
    session_character: string | null;
    summary: string | null;
    title: string;
    outcome_satisfaction: string | null;
    workflow_pattern: string | null;
    had_course_correction: number | null;
    friction_points: string | null;
    effective_patterns: string | null;
  }>;
  const metaById = new Map(meta.map(m => [m.id, m]));

  const out: SessionSnippet[] = [];
  for (const r of ranked) {
    const m = metaById.get(r.id);
    if (!m) continue;
    const childCount = childMatches.get(r.id)?.size ?? 0;
    const snippet = directSnippets.get(r.id) ?? childSnippets.get(r.id) ?? cap(m.summary, SNIPPET_MAX_CHARS);
    out.push({
      sessionId: r.id,
      title: cap(m.title, 120),
      projectName: m.project_name,
      gitBranch: m.git_branch,
      sourceTool: m.source_tool,
      startedAt: m.started_at,
      endedAt: m.ended_at,
      messageCount: m.message_count,
      sessionCharacter: m.session_character,
      score: Math.round(r.score * 10000) / 10000,
      snippet,
      ...(childCount > 0 ? { childMatchCount: childCount } : {}),
      facets: toFacetBrief(m),
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

export interface SubagentBrief {
  sessionId: string;
  agentType: string | null;
  title: string;
  messageCount: number;
  startedAt: string;
}

export interface SessionWindow {
  sessionId: string;
  title: string;
  projectName: string;
  sourceTool: string;
  gitBranch: string | null;
  startedAt: string;
  endedAt: string;
  parentSessionId: string | null;
  agentType: string | null;
  summary: string;
  facets: SessionFacetBrief | null;
  subagents: SubagentBrief[];
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
    SELECT s.id, s.project_name, s.source_tool, s.git_branch, s.started_at, s.ended_at,
           s.parent_session_id, s.agent_type, s.summary,
           COALESCE(s.custom_title, s.generated_title, '') AS title,
           sf.outcome_satisfaction, sf.workflow_pattern, sf.had_course_correction,
           sf.friction_points, sf.effective_patterns
    FROM sessions s
    LEFT JOIN session_facets sf ON sf.session_id = s.id
    WHERE s.id = ? AND s.deleted_at IS NULL
  `).get(sessionId) as {
    id: string;
    project_name: string;
    source_tool: string;
    git_branch: string | null;
    started_at: string;
    ended_at: string;
    parent_session_id: string | null;
    agent_type: string | null;
    summary: string | null;
    title: string;
    outcome_satisfaction: string | null;
    workflow_pattern: string | null;
    had_course_correction: number | null;
    friction_points: string | null;
    effective_patterns: string | null;
  } | undefined;
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

  const subagentRows = db.prepare(`
    SELECT id, agent_type, COALESCE(custom_title, generated_title, '') AS title, message_count, started_at
    FROM sessions
    WHERE parent_session_id = ? AND deleted_at IS NULL
    ORDER BY started_at ASC
    LIMIT 10
  `).all(sessionId) as Array<{
    id: string;
    agent_type: string | null;
    title: string;
    message_count: number;
    started_at: string;
  }>;

  return {
    sessionId,
    title: session.title,
    projectName: session.project_name,
    sourceTool: session.source_tool,
    gitBranch: session.git_branch,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    parentSessionId: session.parent_session_id,
    agentType: session.agent_type,
    summary: cap(session.summary, 600),
    facets: toFacetBrief(session),
    subagents: subagentRows.map(c => ({
      sessionId: c.id,
      agentType: c.agent_type,
      title: cap(c.title, 120),
      messageCount: c.message_count,
      startedAt: c.started_at,
    })),
    totalTurns: total,
    fromTurn: from,
    toTurn: to,
    turns: rows.map((r, i) => ({ turn: from + i, type: r.type, timestamp: r.timestamp, content: cap(r.content, TURN_MAX_CHARS) })),
  };
}
