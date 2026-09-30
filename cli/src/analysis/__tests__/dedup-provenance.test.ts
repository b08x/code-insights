/**
 * Provenance under dedup (found-5/6). A near-duplicate merge only appends the new row's
 * `metadata.link_ids` to the existing row; the existing row's title/content/summary are still the
 * text its original student produced. `student_identity` / `prompt_version_id` describe who
 * produced the stored text, so the merge deliberately does NOT restamp them: restamping would
 * attribute one student's output to another and corrupt per-identity scoring and prompt-version
 * comparisons. Exact duplicates are skipped for the same reason.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

let testDb: Database.Database;
vi.mock('../../db/client.js', () => ({ getDb: () => testDb }));

import { runMigrations } from '../../db/schema.js';
import { saveInsightsToDbWithDedup, type InsightRow } from '../analysis-db.js';

function row(overrides: Partial<InsightRow>): InsightRow {
  return {
    id: 'x', session_id: 's1', project_id: 'p1', project_name: 'proj', type: 'learning',
    title: 't', content: 'c', summary: 's', bullets: '[]', confidence: 0.9, source: 'llm',
    metadata: null, timestamp: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z',
    scope: 'session', analysis_version: '3.0.0', embedding_status: 'pending',
    ...overrides,
  };
}

const noop = () => {};
const embed = async () => new Float32Array(768);

beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
  // Stand-in for the sqlite-vec table: only its row count is read by the dedup fast path.
  testDb.exec('DROP TABLE IF EXISTS vec_insights; CREATE TABLE vec_insights (id TEXT PRIMARY KEY)');
  testDb.prepare("INSERT INTO vec_insights (id) VALUES ('old')").run();
  testDb.pragma('foreign_keys = OFF'); // insights rows only; no session/project fixtures needed
});

afterEach(() => testDb.close());

describe('saveInsightsToDbWithDedup provenance', () => {
  it('near-duplicate merge appends link_ids but keeps the original student_identity/prompt_version_id', async () => {
    testDb.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets,
        confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status,
        student_identity, prompt_version_id)
      VALUES ('old', 's0', 'p1', 'proj', 'learning', 'orig', 'orig content', 'orig', '[]', 0.9, 'llm',
        '{"link_ids":["a"]}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'session', '3.0.0', 'computed',
        'codex-native|codex-native|', NULL)
    `).run();

    const findSimilar = vi.fn((_db, _type, _vec, threshold: number) =>
      threshold >= 0.9 ? [] : [{ id: 'old', distance: 0.1, metadata: null }]);

    const metrics = await saveInsightsToDbWithDedup(
      [row({ id: 'new', metadata: JSON.stringify({ link_ids: ['b'] }), student_identity: 'opencode|x/y|high', prompt_version_id: null })],
      embed, noop, noop, noop, findSimilar,
    );

    expect(metrics.nearDuplicatesMerged).toBe(1);
    const stored = testDb.prepare('SELECT metadata, content, student_identity, prompt_version_id FROM insights WHERE id = ?').get('old') as any;
    expect(JSON.parse(stored.metadata).link_ids).toEqual(['a', 'b']);
    expect(stored.content).toBe('orig content');
    expect(stored.student_identity).toBe('codex-native|codex-native|');
    expect(stored.prompt_version_id).toBeNull();
    expect(testDb.prepare("SELECT COUNT(*) AS n FROM insights WHERE id = 'new'").get()).toEqual({ n: 0 });
  });

  it('non-duplicate rows are inserted with their own provenance', async () => {
    await saveInsightsToDbWithDedup(
      [row({ id: 'fresh', student_identity: 'opencode|x/y|high', prompt_version_id: null })],
      embed, noop, noop, noop, () => [],
    );
    const stored = testDb.prepare('SELECT student_identity FROM insights WHERE id = ?').get('fresh') as any;
    expect(stored.student_identity).toBe('opencode|x/y|high');
  });
});
