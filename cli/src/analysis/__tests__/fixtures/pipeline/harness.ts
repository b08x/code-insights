// Shared helpers for the pipeline characterization tests (Phase 1, step 6a).
// Not a test file: loaded by pipeline-characterization.test.ts and
// transport-characterization.test.ts. Pure helpers only — every vi.mock lives in the test
// files because vitest hoists mocks per file.

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type Database from 'better-sqlite3';

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_DIR = HERE;
export const GOLDEN_DIR = join(HERE, 'golden');

// ── Input loading ─────────────────────────────────────────────────────────────

export interface FixtureSession {
  id: string;
  project_id: string;
  project_name: string;
  project_path: string;
  summary: string | null;
  ended_at: string;
  message_count: number;
  compact_count: number | null;
  auto_compact_count: number | null;
  slash_commands: string | null;
}

export interface FixtureMessage {
  id: string;
  type: 'user' | 'assistant' | 'system';
  content: string;
  thinking: string | null;
  tool_calls: string | null;
  tool_results: string | null;
  usage: string | null;
  timestamp: string;
  parent_id: string | null;
}

interface InputFile {
  name: string;
  description: string;
  session: FixtureSession;
  messages?: FixtureMessage[];
  generate?: { count: number; contentChars: number; toolResultChars: number; startAt: string; gapSeconds: number };
}

export interface LoadedInput {
  name: string;
  session: FixtureSession;
  /** Rows shaped like the `messages` table (session_id filled in). */
  messages: Array<FixtureMessage & { session_id: string }>;
}

const FILLER = [
  'We need to keep the billing totals consistent across the invoice and the ledger export.',
  'The retry wrapper swallows the original error, which makes the failure hard to trace.',
  'Extract the pricing rules into a table so the tests can enumerate every plan tier.',
  'The migration must be idempotent because the job may be re-run after a partial failure.',
  'Prefer a narrow interface here; the caller only needs the amount and the currency.',
];

/**
 * Deterministic generator for the long sessions so the repo does not carry 400KB JSON blobs.
 * Alternates human / assistant rows; assistant rows carry a tool call + result so the
 * formatter's tool sections and the chunker's token accounting are both exercised.
 */
function generateMessages(spec: NonNullable<InputFile['generate']>): FixtureMessage[] {
  const out: FixtureMessage[] = [];
  const start = Date.parse(spec.startAt);
  for (let i = 0; i < spec.count; i++) {
    const isUser = i % 2 === 0;
    const base = `#${i} ${FILLER[i % FILLER.length]} `;
    const content = (base.repeat(Math.ceil(spec.contentChars / base.length))).slice(0, spec.contentChars);
    const result = (`result-${i} ` + 'x'.repeat(spec.toolResultChars)).slice(0, spec.toolResultChars);
    out.push({
      id: `g${i}`,
      type: isUser ? 'user' : 'assistant',
      content,
      thinking: null,
      tool_calls: isUser ? null : JSON.stringify([{ name: 'Read' }]),
      tool_results: isUser ? null : JSON.stringify([{ output: result }]),
      usage: null,
      timestamp: new Date(start + i * spec.gapSeconds * 1000).toISOString(),
      parent_id: null,
    });
  }
  return out;
}

export function loadInput(name: string): LoadedInput {
  const file = JSON.parse(readFileSync(join(HERE, 'inputs', `${name}.json`), 'utf-8')) as InputFile;
  const messages = file.messages ?? generateMessages(file.generate!);
  return {
    name: file.name,
    session: file.session,
    messages: messages.map(m => ({ ...m, session_id: file.session.id })),
  };
}

export function loadResponse(file: string): string {
  return readFileSync(join(HERE, 'responses', file), 'utf-8');
}

// ── DB seeding / snapshotting ─────────────────────────────────────────────────

export function seedSession(db: Database.Database, input: LoadedInput): void {
  const s = input.session;
  db.prepare(
    `INSERT OR IGNORE INTO projects (id, name, path, last_activity, session_count) VALUES (?, ?, ?, datetime('now'), 1)`,
  ).run(s.project_id, s.project_name, s.project_path);
  db.prepare(
    `INSERT INTO sessions (id, project_id, project_name, project_path, summary, started_at, ended_at,
       message_count, compact_count, auto_compact_count, slash_commands, source_tool)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claude-code')`,
  ).run(
    s.id, s.project_id, s.project_name, s.project_path, s.summary, input.messages[0].timestamp, s.ended_at,
    s.message_count, s.compact_count ?? 0, s.auto_compact_count ?? 0, s.slash_commands ?? '[]',
  );
  const ins = db.prepare(
    `INSERT INTO messages (id, session_id, type, content, thinking, tool_calls, tool_results, usage, timestamp, parent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of input.messages) {
    ins.run(m.id, m.session_id, m.type, m.content, m.thinking, m.tool_calls, m.tool_results, m.usage, m.timestamp, m.parent_id);
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
// Columns that change on every run (ids, clocks, wall-clock durations).
const VOLATILE_KEYS = new Set(['id', 'created_at', 'updated_at', 'timestamp', 'analyzed_at', 'extracted_at', 'duration_ms']);

function scrubRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (VOLATILE_KEYS.has(k)) continue;
    out[k] = typeof v === 'string' ? v.replace(UUID_RE, '<uuid>') : v;
  }
  return out;
}

function rows(db: Database.Database, sql: string, ...params: unknown[]): Array<Record<string, unknown>> {
  return (db.prepare(sql).all(...params) as Array<Record<string, unknown>>).map(scrubRow);
}

/** Persistence state after a run, with volatile columns removed and rows in a stable order. */
export function snapshotDb(db: Database.Database, sessionId: string) {
  return {
    insights: rows(db, 'SELECT * FROM insights WHERE session_id = ? AND source = ? ORDER BY type, title', sessionId, 'llm'),
    session_facets: rows(db, 'SELECT * FROM session_facets WHERE session_id = ?', sessionId),
    session_steps: rows(db, 'SELECT * FROM session_steps WHERE session_id = ? ORDER BY 1, 2', sessionId),
    analysis_usage: rows(db, 'SELECT * FROM analysis_usage WHERE session_id = ? ORDER BY analysis_type', sessionId),
    generated_title: (db.prepare('SELECT generated_title FROM sessions WHERE id = ?').get(sessionId) as { generated_title: string | null }).generated_title,
  };
}

// ── Prompt capture ────────────────────────────────────────────────────────────

const FULL_TEXT_LIMIT = 24_000;

/**
 * Golden form of a prompt string. Short prompts are stored verbatim (the exact text sent).
 * Prompts above FULL_TEXT_LIMIT (the 280/400-message sessions, 300KB+) are stored as
 * length + sha256 + head + tail + the framing markers found in them, so any byte change
 * still fails the snapshot without committing a megabyte of generated filler.
 */
export function capturePrompt(text: string): string | PromptDigest {
  if (text.length <= FULL_TEXT_LIMIT) return text;
  return digest(text);
}

export interface PromptDigest {
  length: number;
  sha256: string;
  head: string;
  tail: string;
  /** Everything after the conversation block — i.e. the instruction/context suffix, verbatim. */
  suffixAfterConversation: string;
}

export function digest(text: string): PromptDigest {
  const endMarker = '--- END CONVERSATION ---';
  const idx = text.lastIndexOf(endMarker);
  return {
    length: text.length,
    sha256: createHash('sha256').update(text).digest('hex'),
    head: text.slice(0, 400),
    tail: text.slice(-400),
    suffixAfterConversation: idx >= 0 ? text.slice(idx) : '',
  };
}

/** Flatten server ContentBlock[] so the block boundaries and cache_control flags stay visible. */
export function describeServerContent(content: string | Array<{ type: string; text: string; cache_control?: unknown }>) {
  if (typeof content === 'string') return { kind: 'string', text: capturePrompt(content) };
  return {
    kind: 'blocks',
    blocks: content.map(b => ({
      type: b.type,
      ...(b.cache_control ? { cache_control: b.cache_control } : {}),
      text: capturePrompt(b.text),
    })),
  };
}

/** Replace long strings in a request body with length+hash so transport goldens stay small. */
export function redactLongStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 200
      ? `<string length=${value.length} sha256=${createHash('sha256').update(value).digest('hex').slice(0, 16)}>`
      : value;
  }
  if (Array.isArray(value)) return value.map(redactLongStrings);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactLongStrings(v)]));
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}
