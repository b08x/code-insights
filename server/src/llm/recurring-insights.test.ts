// Tests for vector-based recurring insight detection.
// Covers: vector math, KNN grouping, MMR deduplication, end-to-end flow.

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock the DB and LLM before importing the module under test ───

let testDb: Database.Database;

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

const mockChat = vi.fn();
const mockIsConfigured = vi.fn(() => true);

vi.mock('@code-insights/cli/llm/client', () => ({
  isLLMConfigured: (...args: unknown[]) => mockIsConfigured(...args),
  createLLMClient: () => ({
    provider: 'test',
    model: 'test-model',
    chat: mockChat,
    estimateTokens: (text: string) => Math.ceil(text.length / 4),
  }),
  loadLLMConfig: () => ({ provider: 'test', model: 'test-model' }),
}));

// Import after mocks are set up
const {
  findRecurringInsights,
  findRecurringInsightsByVector,
  findRecurringInsightsByLLM,
  loadInsightEmbeddings,
} = await import('./recurring-insights.js');

// ─── Helpers ──────────────────────────────────────────────────────

/** Create an in-memory DB with insights, embedding_metadata, and vec_insights. */
function freshDb(dim: number = 1024): Database.Database {
  const db = new Database(':memory:');
  // Load sqlite-vec extension
  sqliteVec.load(db);
  // Create the insights table (simplified schema matching the real one)
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id                 TEXT PRIMARY KEY,
      session_id         TEXT NOT NULL,
      project_id         TEXT NOT NULL,
      project_name       TEXT NOT NULL,
      type               TEXT NOT NULL,
      title              TEXT NOT NULL,
      content            TEXT NOT NULL,
      summary            TEXT NOT NULL,
      bullets            TEXT,
      confidence         REAL NOT NULL,
      source             TEXT NOT NULL DEFAULT 'llm',
      metadata           TEXT,
      timestamp          TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (datetime('now')),
      scope              TEXT NOT NULL DEFAULT 'session',
      analysis_version   TEXT NOT NULL DEFAULT '1.0.0',
      linked_insight_ids TEXT,
      embedding_status   TEXT NOT NULL DEFAULT 'pending'
        CHECK(embedding_status IN ('pending', 'computed', 'stale', 'failed'))
    );
  `);
  // Create embedding_metadata table (V14+ chunk provenance)
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_metadata (
      id              TEXT PRIMARY KEY,
      entity_type     TEXT NOT NULL CHECK(entity_type IN ('insight', 'message')),
      entity_id       TEXT NOT NULL,
      model           TEXT NOT NULL,
      dim             INTEGER NOT NULL,
      source_text     TEXT NOT NULL,
      parent_chunk_id TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_embedding_metadata_entity ON embedding_metadata(entity_type, entity_id);
  `);
  // Create the sqlite-vec virtual table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_insights USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dim}]
    );
  `);
  return db;
}

/** Insert an insight row and one or more child chunk vectors + metadata rows. */
function insertInsightWithChunks(
  db: Database.Database,
  id: string,
  sessionId: string,
  type: string,
  title: string,
  summary: string,
  vectors: Float32Array[],
  timestamp?: string,
) {
  db.prepare(`
    INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
    VALUES (?, ?, 'proj-1', 'test-project', ?, ?, ?, '', 0.9, COALESCE(?, datetime('now')))
  `).run(id, sessionId, type, title, summary, timestamp ?? null);

  const insertVec = db.prepare('INSERT OR REPLACE INTO vec_insights (id, embedding) VALUES (?, ?)');
  const insertMeta = db.prepare(`
    INSERT OR REPLACE INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id)
    VALUES (?, 'insight', ?, 'embeddinggemma-2:440m', ?, ?, ?)
  `);

  const parentChunkId = `${id}_p0`;
  for (let i = 0; i < vectors.length; i++) {
    const chunkId = `${parentChunkId}_c${i}`;
    const vec = vectors[i];
    const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    insertVec.run(chunkId, blob);
    insertMeta.run(chunkId, id, vec.length, `${title}\n${summary}`, parentChunkId);
  }
}

/** Insert an insight row + its single chunk embedding into the test DB. */
function insertInsightWithEmbedding(
  db: Database.Database,
  id: string,
  sessionId: string,
  type: string,
  title: string,
  summary: string,
  vector: Float32Array,
  timestamp?: string,
) {
  insertInsightWithChunks(db, id, sessionId, type, title, summary, [vector], timestamp);
}

/** Create a unit vector where only the `index`-th component is 1.0 (rest 0). */
function oneHotVector(dim: number, index: number): Float32Array {
  const v = new Float32Array(dim);
  v[index] = 1.0;
  return v;
}

/** Create a random-ish unit vector for testing. */
function makeVector(dim: number, seed: number): Float32Array {
  const v = new Float32Array(dim);
  // Deterministic pseudo-random based on seed
  let s = seed;
  for (let i = 0; i < dim; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    v[i] = (s / 0x7fffffff) * 2 - 1;
  }
  // Normalize to unit length
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

// ─── Tests ────────────────────────────────────────────────────────

describe('findRecurringInsightsByVector', () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockIsConfigured.mockClear();
    mockIsConfigured.mockReturnValue(true);
    mockChat.mockResolvedValue({ content: 'Test Theme' });
  });

  it('returns error when LLM is not configured', async () => {
    mockIsConfigured.mockReturnValue(false);
    const db = freshDb();
    testDb = db;

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: makeVector(1024, 1) },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(false);
    expect(result.error).toContain('LLM not configured');
    db.close();
  });

  it('returns error when fewer than 2 embeddings', async () => {
    const db = freshDb();
    testDb = db;

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: makeVector(1024, 1) },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(false);
    expect(result.error).toContain('at least 2');
    db.close();
  });

  it('returns empty groups when no similar pairs exist', async () => {
    const db = freshDb();
    testDb = db;

    // Insert two orthogonal vectors (cosine similarity = 0)
    const v1 = oneHotVector(1024, 0);
    const v2 = oneHotVector(1024, 1);
    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'T1', 'S1', v1);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'T2', 'S2', v2);

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: v1 },
      { id: 'i2', sessionId: 's2', title: 'T2', summary: 'S2', type: 'pattern', vector: v2 },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(0);
    expect(result.updatedCount).toBe(0);
    db.close();
  });

  it('groups two identical insights together', async () => {
    const db = freshDb();
    testDb = db;

    // Same vector = cosine similarity = 1.0 (above 0.85 threshold)
    const v1 = makeVector(1024, 42);
    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'Error handling', 'Use Result type', v1);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'Error wrapping', 'Wrap errors in Result', v1);

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'Error handling', summary: 'Use Result type', type: 'pattern', vector: v1 },
      { id: 'i2', sessionId: 's2', title: 'Error wrapping', summary: 'Wrap errors in Result', type: 'pattern', vector: v1 },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].insightIds).toContain('i1');
    expect(result.groups[0].insightIds).toContain('i2');
    expect(result.updatedCount).toBe(2);
    db.close();
  });

  it('groups three similar insights, excludes dissimilar one', async () => {
    const db = freshDb();
    testDb = db;

    // Three similar vectors, one orthogonal
    const vSimilar = makeVector(1024, 100);
    const vDifferent = oneHotVector(1024, 500); // orthogonal to everything

    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'T1', 'S1', vSimilar);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'T2', 'S2', vSimilar);
    insertInsightWithEmbedding(db, 'i3', 's3', 'pattern', 'T3', 'S3', vSimilar);
    insertInsightWithEmbedding(db, 'i4', 's4', 'learning', 'Unrelated', 'Different topic', vDifferent);

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: vSimilar },
      { id: 'i2', sessionId: 's2', title: 'T2', summary: 'S2', type: 'pattern', vector: vSimilar },
      { id: 'i3', sessionId: 's3', title: 'T3', summary: 'S3', type: 'pattern', vector: vSimilar },
      { id: 'i4', sessionId: 's4', title: 'Unrelated', summary: 'Different topic', type: 'learning', vector: vDifferent },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].insightIds).toHaveLength(3);
    expect(result.groups[0].insightIds).not.toContain('i4');
    db.close();
  });

  it('calls LLM exactly once per group for theme naming', async () => {
    const db = freshDb();
    testDb = db;

    const v1 = makeVector(1024, 100);
    const v2 = oneHotVector(1024, 500);

    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'T1', 'S1', v1);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'T2', 'S2', v1);
    insertInsightWithEmbedding(db, 'i3', 's3', 'learning', 'U1', 'Diff', v2);

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: v1 },
      { id: 'i2', sessionId: 's2', title: 'T2', summary: 'S2', type: 'pattern', vector: v1 },
      { id: 'i3', sessionId: 's3', title: 'U1', summary: 'Diff', type: 'learning', vector: v2 },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    // Only 1 LLM call for 1 group (not 3 calls for 3 insights)
    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(result.groups[0].theme).toBe('Test Theme');
    db.close();
  });

  it('writes bidirectional links to the insights table', async () => {
    const db = freshDb();
    testDb = db;

    const v1 = makeVector(1024, 77);
    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'T1', 'S1', v1);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'T2', 'S2', v1);

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: v1 },
      { id: 'i2', sessionId: 's2', title: 'T2', summary: 'S2', type: 'pattern', vector: v1 },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);

    // Verify links were written
    const i1 = db.prepare('SELECT linked_insight_ids FROM insights WHERE id = ?').get('i1') as { linked_insight_ids: string };
    const i2 = db.prepare('SELECT linked_insight_ids FROM insights WHERE id = ?').get('i2') as { linked_insight_ids: string };

    expect(JSON.parse(i1.linked_insight_ids)).toContain('i2');
    expect(JSON.parse(i2.linked_insight_ids)).toContain('i1');
    db.close();
  });

  it('respects MMR: two distinct clusters produce two groups', async () => {
    const db = freshDb();
    testDb = db;

    // Cluster A: similar vectors at positions 0-9
    const vA = oneHotVector(1024, 0);
    // Cluster B: similar vectors at positions 100-109
    const vB = oneHotVector(1024, 100);

    insertInsightWithEmbedding(db, 'a1', 's1', 'pattern', 'Auth token', 'JWT validation', vA);
    insertInsightWithEmbedding(db, 'a2', 's2', 'pattern', 'Auth check', 'Verify JWT', vA);
    insertInsightWithEmbedding(db, 'b1', 's3', 'pattern', 'DB connection', 'Pool sizing', vB);
    insertInsightWithEmbedding(db, 'b2', 's4', 'pattern', 'DB pool', 'Connection pool config', vB);

    const embeddings = [
      { id: 'a1', sessionId: 's1', title: 'Auth token', summary: 'JWT validation', type: 'pattern', vector: vA },
      { id: 'a2', sessionId: 's2', title: 'Auth check', summary: 'Verify JWT', type: 'pattern', vector: vA },
      { id: 'b1', sessionId: 's3', title: 'DB connection', summary: 'Pool sizing', type: 'pattern', vector: vB },
      { id: 'b2', sessionId: 's4', title: 'DB pool', summary: 'Connection pool config', type: 'pattern', vector: vB },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(2);

    // Verify groups contain the right members
    const groupA = result.groups.find(g => g.insightIds.includes('a1'));
    const groupB = result.groups.find(g => g.insightIds.includes('b1'));
    expect(groupA).toBeDefined();
    expect(groupB).toBeDefined();
    expect(groupA!.insightIds).toContain('a2');
    expect(groupB!.insightIds).toContain('b2');
    db.close();
  });

  it('does not group insights below the similarity threshold', async () => {
    const db = freshDb();
    testDb = db;

    // Create vectors with cosine similarity ~0.5 (below 0.85 threshold)
    // For unit vectors: cos_sim = dot product
    // We need two vectors where dot = 0.5
    const dim = 1024;
    const v1 = new Float32Array(dim);
    v1[0] = 1.0; // unit vector along axis 0
    v1[1] = 0.0;

    const v2 = new Float32Array(dim);
    v2[0] = 0.5;
    v2[1] = Math.sqrt(1 - 0.25); // normalize: sqrt(1 - 0.25) = sqrt(0.75)
    // dot(v1, v2) = 0.5*1 + 0*sqrt(0.75) = 0.5

    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'T1', 'S1', v1);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'T2', 'S2', v2);

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: v1 },
      { id: 'i2', sessionId: 's2', title: 'T2', summary: 'S2', type: 'pattern', vector: v2 },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(0);
    db.close();
  });

  it('handles empty vec_insights table gracefully', async () => {
    const db = freshDb();
    testDb = db;

    // Don't insert any embeddings into vec_insights
    const v1 = makeVector(1024, 1);
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i1', 's1', 'proj-1', 'test-project', 'pattern', 'T1', 'S1', '', 0.9, datetime('now'))
    `).run();

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: v1 },
    ];

    // Should return error about needing at least 2 embeddings
    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(false);
    db.close();
  });

  it('returns empty groups when 2+ embeddings are passed against an empty vec_insights table', async () => {
    const db = freshDb();
    testDb = db;

    const embeddings = [
      { id: 'i1', sessionId: 's1', title: 'T1', summary: 'S1', type: 'pattern', vector: makeVector(1024, 1) },
      { id: 'i2', sessionId: 's2', title: 'T2', summary: 'S2', type: 'pattern', vector: makeVector(1024, 1) },
    ];

    const result = await findRecurringInsightsByVector(embeddings);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(0);
    expect(result.updatedCount).toBe(0);
    db.close();
  });
});

describe('loadInsightEmbeddings', () => {
  it('maps chunk IDs through embedding_metadata and excludes raw unmapped vec_insights rows', () => {
    const db = freshDb();

    const v1 = makeVector(1024, 1);
    const v2 = makeVector(1024, 2);
    insertInsightWithEmbedding(db, 'mapped-1', 's1', 'decision', 'Mapped', 'Summary', v1);

    // Insert an insight with a direct vec_insights.id = insights.id row and NO embedding_metadata row
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('raw-only', 's2', 'proj-1', 'test-project', 'decision', 'Raw', 'Summary', '', 0.9, datetime('now'))
    `).run();
    db.prepare('INSERT INTO vec_insights (id, embedding) VALUES (?, ?)').run(
      'raw-only',
      Buffer.from(v2.buffer, v2.byteOffset, v2.byteLength),
    );

    const loaded = loadInsightEmbeddings(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('mapped-1');
    expect(loaded[0].title).toBe('Mapped');
    db.close();
  });

  it('excludes summary and prompt_quality insights', () => {
    const db = freshDb();

    insertInsightWithEmbedding(db, 'i-sum', 's1', 'summary', 'Sum', 'S', makeVector(1024, 1));
    insertInsightWithEmbedding(db, 'i-pq', 's2', 'prompt_quality', 'PQ', 'S', makeVector(1024, 2));
    insertInsightWithEmbedding(db, 'i-dec', 's3', 'decision', 'Dec', 'S', makeVector(1024, 3));
    insertInsightWithEmbedding(db, 'i-lrn', 's4', 'learning', 'Lrn', 'S', makeVector(1024, 4));

    const loaded = loadInsightEmbeddings(db);
    expect(loaded.map(e => e.id).sort()).toEqual(['i-dec', 'i-lrn']);
    db.close();
  });

  it('pools multiple chunks per insight into a single normalized InsightEmbedding', () => {
    const db = freshDb();

    const c0 = oneHotVector(1024, 0);
    const c1 = oneHotVector(1024, 1);
    insertInsightWithChunks(db, 'multi-1', 's1', 'learning', 'Multi', 'Chunked', [c0, c1]);

    const loaded = loadInsightEmbeddings(db);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('multi-1');
    expect(loaded[0].vector).toHaveLength(1024);

    // Pooled unit vector of e0 + e1 is (1/sqrt(2), 1/sqrt(2), 0, ...)
    const expected = Math.SQRT1_2;
    expect(loaded[0].vector[0]).toBeCloseTo(expected, 5);
    expect(loaded[0].vector[1]).toBeCloseTo(expected, 5);
    expect(loaded[0].vector[2]).toBeCloseTo(0, 5);
    db.close();
  });

  it('ignores legacy flat rows, message metadata, ghost metadata, and dangling vectors', () => {
    const db = freshDb();
    const v = makeVector(1024, 7);
    const blob = Buffer.from(v.buffer, v.byteOffset, v.byteLength);

    // Valid insight
    insertInsightWithEmbedding(db, 'i-valid', 's1', 'decision', 'Valid', 'S', v);

    // Pre-V14 legacy flat row (entity_id = '')
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i-legacy', 's2', 'proj-1', 'test-project', 'decision', 'Legacy', 'S', '', 0.9, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text)
      VALUES ('i-legacy', 'insight', '', 'embeddinggemma:latest', 1024, 'legacy')
    `).run();
    db.prepare('INSERT INTO vec_insights (id, embedding) VALUES (?, ?)').run('i-legacy', blob);

    // Wrong entity_type ('message')
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i-msg', 's3', 'proj-1', 'test-project', 'decision', 'MsgType', 'S', '', 0.9, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id)
      VALUES ('i-msg_p0_c0', 'message', 'i-msg', 'embeddinggemma-2:440m', 1024, 'msg', 'i-msg_p0')
    `).run();
    db.prepare('INSERT INTO vec_insights (id, embedding) VALUES (?, ?)').run('i-msg_p0_c0', blob);

    // Ghost metadata without vector in vec_insights
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i-ghost', 's4', 'proj-1', 'test-project', 'decision', 'Ghost', 'S', '', 0.9, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id)
      VALUES ('i-ghost_p0_c0', 'insight', 'i-ghost', 'embeddinggemma-2:440m', 1024, 'ghost', 'i-ghost_p0')
    `).run();

    // Dangling vector with no metadata
    db.prepare('INSERT INTO vec_insights (id, embedding) VALUES (?, ?)').run('dangling_p0_c0', blob);

    const loaded = loadInsightEmbeddings(db);
    expect(loaded.map(e => e.id)).toEqual(['i-valid']);
    db.close();
  });

  it('filters by candidateIds when provided', () => {
    const db = freshDb();

    insertInsightWithEmbedding(db, 'i1', 's1', 'decision', 'One', 'S1', makeVector(1024, 1));
    insertInsightWithEmbedding(db, 'i2', 's2', 'decision', 'Two', 'S2', makeVector(1024, 2));
    insertInsightWithEmbedding(db, 'i3', 's3', 'decision', 'Three', 'S3', makeVector(1024, 3));

    const loaded = loadInsightEmbeddings(db, ['i1', 'i3', 'i1']);
    expect(loaded.map(e => e.id).sort()).toEqual(['i1', 'i3']);
    db.close();
  });

  it('caps distinct insights at MAX_CANDIDATES (200) rather than truncating by chunks', () => {
    const db = freshDb();

    const c0 = oneHotVector(1024, 0);
    const c1 = oneHotVector(1024, 1);

    // Insert 205 insights with 2 chunks each (410 total chunks)
    for (let i = 0; i < 205; i++) {
      const padded = String(i).padStart(3, '0');
      insertInsightWithChunks(
        db,
        `ins-${padded}`,
        `s-${padded}`,
        'decision',
        `Title ${padded}`,
        `Summary ${padded}`,
        [c0, c1],
        `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
      );
    }

    const loaded = loadInsightEmbeddings(db);
    expect(loaded).toHaveLength(200);
    expect(new Set(loaded.map(e => e.id)).size).toBe(200);
    // Verify each loaded insight retained both chunks in its pooled vector
    for (const item of loaded) {
      expect(item.vector[0]).toBeCloseTo(Math.SQRT1_2, 5);
      expect(item.vector[1]).toBeCloseTo(Math.SQRT1_2, 5);
    }
    db.close();
  });

  it('returns empty array cleanly when vec_insights or embedding_metadata is missing', () => {
    const dbNoMeta = new Database(':memory:');
    sqliteVec.load(dbNoMeta);
    dbNoMeta.exec('CREATE TABLE insights (id TEXT PRIMARY KEY, session_id TEXT, title TEXT, summary TEXT, type TEXT, timestamp TEXT)');
    dbNoMeta.exec('CREATE VIRTUAL TABLE vec_insights USING vec0(id TEXT PRIMARY KEY, embedding float[1024])');
    expect(loadInsightEmbeddings(dbNoMeta)).toEqual([]);
    dbNoMeta.close();

    const dbNoVec = new Database(':memory:');
    dbNoVec.exec('CREATE TABLE insights (id TEXT PRIMARY KEY, session_id TEXT, title TEXT, summary TEXT, type TEXT, timestamp TEXT)');
    dbNoVec.exec('CREATE TABLE embedding_metadata (id TEXT PRIMARY KEY, entity_type TEXT, entity_id TEXT, model TEXT, dim INTEGER, source_text TEXT)');
    expect(loadInsightEmbeddings(dbNoVec)).toEqual([]);
    dbNoVec.close();
  });
});

describe('findRecurringInsights (unified entry point)', () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockIsConfigured.mockClear();
    mockIsConfigured.mockReturnValue(true);
    mockChat.mockResolvedValue({ content: 'Unified Theme' });
  });

  it('uses vector path via embedding_metadata and writes insight IDs to linked_insight_ids', async () => {
    const db = freshDb();
    testDb = db;

    const vSim = makeVector(1024, 42);
    const vDiff = oneHotVector(1024, 500);
    insertInsightWithEmbedding(db, 'i1', 's1', 'pattern', 'Error handling', 'Use Result type', vSim);
    insertInsightWithEmbedding(db, 'i2', 's2', 'pattern', 'Error wrapping', 'Wrap errors in Result', vSim);
    insertInsightWithEmbedding(db, 'i3', 's3', 'learning', 'Unrelated', 'Something else', vDiff);

    const result = await findRecurringInsights([
      { id: 'i1', type: 'pattern', title: 'Error handling', summary: 'Use Result type', project_name: 'test-project', session_id: 's1' },
      { id: 'i2', type: 'pattern', title: 'Error wrapping', summary: 'Wrap errors in Result', project_name: 'test-project', session_id: 's2' },
      { id: 'i3', type: 'learning', title: 'Unrelated', summary: 'Something else', project_name: 'test-project', session_id: 's3' },
    ]);

    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].insightIds.sort()).toEqual(['i1', 'i2']);
    expect(result.groups[0].theme).toBe('Unified Theme');

    // Confirm theme-naming prompt was used (vector path), NOT full JSON clustering prompt
    expect(mockChat).toHaveBeenCalledTimes(1);
    const messages = mockChat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain('cosine similarity >= 0.85');
    expect(messages[1].content).not.toContain('Respond with valid JSON only');

    // Confirm linked_insight_ids stores insight IDs, not chunk IDs
    const row1 = db.prepare('SELECT linked_insight_ids FROM insights WHERE id = ?').get('i1') as { linked_insight_ids: string };
    const row2 = db.prepare('SELECT linked_insight_ids FROM insights WHERE id = ?').get('i2') as { linked_insight_ids: string };
    expect(JSON.parse(row1.linked_insight_ids)).toEqual(['i2']);
    expect(JSON.parse(row2.linked_insight_ids)).toEqual(['i1']);
    db.close();
  });

  it('groups multi-chunk insights whose pooled similarity >= 0.85 even when individual chunks differ by > 40 deg', async () => {
    const db = freshDb();
    testDb = db;

    const rad = (40 * Math.PI) / 180;
    const cos40 = Math.cos(rad);
    const sin40 = Math.sin(rad);

    // i1 chunks: (cos 40°, ±sin 40°, 0) -> pooled mean normalized to (1, 0, 0)
    const i1c0 = new Float32Array(1024);
    i1c0[0] = cos40;
    i1c0[1] = sin40;
    const i1c1 = new Float32Array(1024);
    i1c1[0] = cos40;
    i1c1[1] = -sin40;

    // i2 chunks: (cos 40°, 0, ±sin 40°) -> pooled mean normalized to (1, 0, 0)
    // Individual chunk cosine similarity with (1, 0, 0) is ~0.766 (< 0.85),
    // while pooled insight cosine similarity is 1.0 (>= 0.85).
    const i2c0 = new Float32Array(1024);
    i2c0[0] = cos40;
    i2c0[2] = sin40;
    const i2c1 = new Float32Array(1024);
    i2c1[0] = cos40;
    i2c1[2] = -sin40;

    insertInsightWithChunks(db, 'i1', 's1', 'decision', 'Auth A', 'Summary A', [i1c0, i1c1]);
    insertInsightWithChunks(db, 'i2', 's2', 'decision', 'Auth B', 'Summary B', [i2c0, i2c1]);

    const result = await findRecurringInsights([
      { id: 'i1', type: 'decision', title: 'Auth A', summary: 'Summary A', project_name: 'test-project', session_id: 's1' },
      { id: 'i2', type: 'decision', title: 'Auth B', summary: 'Summary B', project_name: 'test-project', session_id: 's2' },
    ]);

    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].insightIds.sort()).toEqual(['i1', 'i2']);
    db.close();
  });

  it('scopes vector search to caller-supplied insights (projectId scoping)', async () => {
    const db = freshDb();
    testDb = db;

    const vShared = makeVector(1024, 99);
    insertInsightWithEmbedding(db, 'p1-a', 's1', 'decision', 'Proj1 A', 'S', vShared);
    insertInsightWithEmbedding(db, 'p1-b', 's2', 'decision', 'Proj1 B', 'S', vShared);
    insertInsightWithEmbedding(db, 'p2-a', 's3', 'decision', 'Proj2 A', 'S', vShared);
    insertInsightWithEmbedding(db, 'p2-b', 's4', 'decision', 'Proj2 B', 'S', vShared);

    // Caller passes only project 1 insights
    const result = await findRecurringInsights([
      { id: 'p1-a', type: 'decision', title: 'Proj1 A', summary: 'S', project_name: 'proj1', session_id: 's1' },
      { id: 'p1-b', type: 'decision', title: 'Proj1 B', summary: 'S', project_name: 'proj1', session_id: 's2' },
    ]);

    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].insightIds.sort()).toEqual(['p1-a', 'p1-b']);

    // Project 2 insights must remain untouched
    const p2a = db.prepare('SELECT linked_insight_ids FROM insights WHERE id = ?').get('p2-a') as { linked_insight_ids: string | null };
    const p2b = db.prepare('SELECT linked_insight_ids FROM insights WHERE id = ?').get('p2-b') as { linked_insight_ids: string | null };
    expect(p2a.linked_insight_ids).toBeNull();
    expect(p2b.linked_insight_ids).toBeNull();
    db.close();
  });

  it('falls back to LLM when fewer than 2 supplied insights have embeddings', async () => {
    const db = freshDb();
    testDb = db;

    insertInsightWithEmbedding(db, 'i1', 's1', 'decision', 'Has Vec', 'S1', makeVector(1024, 1));
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i2', 's2', 'proj-1', 'test-project', 'decision', 'No Vec', 'S2', '', 0.9, datetime('now'))
    `).run();

    // Even if unrelated embedded insights exist in DB, only i1 & i2 were passed
    insertInsightWithEmbedding(db, 'other-1', 's3', 'decision', 'Other', 'S3', makeVector(1024, 1));

    mockChat.mockResolvedValue({
      content: '{"groups": [{"insightIds": ["i1", "i2"], "theme": "Fallback Theme"}]}',
    });

    const result = await findRecurringInsights([
      { id: 'i1', type: 'decision', title: 'Has Vec', summary: 'S1', project_name: 'test-project', session_id: 's1' },
      { id: 'i2', type: 'decision', title: 'No Vec', summary: 'S2', project_name: 'test-project', session_id: 's2' },
    ]);

    expect(result.success).toBe(true);
    expect(result.groups).toEqual([{ insightIds: ['i1', 'i2'], theme: 'Fallback Theme' }]);
    const messages = mockChat.mock.calls[0][0] as Array<{ role: string; content: string }>;
    expect(messages[1].content).toContain('Respond with valid JSON only');
    db.close();
  });

  it('falls back to LLM when embedding_metadata table is missing', async () => {
    const db = freshDb();
    testDb = db;
    db.exec('DROP TABLE embedding_metadata');

    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i1', 's1', 'proj-1', 'test-project', 'decision', 'A', 'S1', '', 0.9, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i2', 's2', 'proj-1', 'test-project', 'decision', 'B', 'S2', '', 0.9, datetime('now'))
    `).run();

    mockChat.mockResolvedValue({
      content: '{"groups": [{"insightIds": ["i1", "i2"], "theme": "No Metadata Fallback"}]}',
    });

    const result = await findRecurringInsights([
      { id: 'i1', type: 'decision', title: 'A', summary: 'S1', project_name: 'test-project', session_id: 's1' },
      { id: 'i2', type: 'decision', title: 'B', summary: 'S2', project_name: 'test-project', session_id: 's2' },
    ]);

    expect(result.success).toBe(true);
    expect(result.groups).toEqual([{ insightIds: ['i1', 'i2'], theme: 'No Metadata Fallback' }]);
    db.close();
  });
});

describe('findRecurringInsightsByLLM (fallback)', () => {
  beforeEach(() => {
    mockChat.mockClear();
    mockIsConfigured.mockClear();
    mockIsConfigured.mockReturnValue(true);
  });

  it('groups insights using LLM when vector search unavailable', async () => {
    const db = freshDb();
    testDb = db;

    // Insert insights without embeddings
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i1', 's1', 'proj-1', 'test-project', 'pattern', 'Error handling', 'Use Result type', '', 0.9, datetime('now'))
    `).run();
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
      VALUES ('i2', 's2', 'proj-1', 'test-project', 'pattern', 'Error wrapping', 'Wrap errors', '', 0.9, datetime('now'))
    `).run();

    mockChat.mockResolvedValue({
      content: '{"groups": [{"insightIds": ["i1", "i2"], "theme": "Error handling patterns"}]}',
    });

    const insights = [
      { id: 'i1', type: 'pattern', title: 'Error handling', summary: 'Use Result type', project_name: 'test', session_id: 's1' },
      { id: 'i2', type: 'pattern', title: 'Error wrapping', summary: 'Wrap errors', project_name: 'test', session_id: 's2' },
    ];

    const result = await findRecurringInsightsByLLM(insights);
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].insightIds).toEqual(['i1', 'i2']);
    expect(result.groups[0].theme).toBe('Error handling patterns');
    db.close();
  });

  it('filters out summary and prompt_quality types', async () => {
    const db = freshDb();
    testDb = db;

    mockChat.mockResolvedValue({ content: '{"groups": []}' });

    const insights = [
      { id: 'i1', type: 'summary', title: 'Summary', summary: 'S', project_name: 'test', session_id: 's1' },
      { id: 'i2', type: 'prompt_quality', title: 'PQ', summary: 'PQ', project_name: 'test', session_id: 's1' },
    ];

    const result = await findRecurringInsightsByLLM(insights);
    expect(result.success).toBe(false);
    expect(result.error).toContain('at least 2');
    db.close();
  });
});

// ─── Vector math unit tests ───────────────────────────────────────

describe('vector math helpers (internal)', () => {
  // We test these indirectly through the public API, but let's also
  // verify the cosine similarity threshold math directly.

  it('L2 distance of 0.548 corresponds to cosine similarity ~0.85', () => {
    // For unit vectors: cos_sim = 1 - (l2^2 / 2)
    // l2 = sqrt(2 * (1 - 0.85)) = sqrt(0.3) ≈ 0.5477
    const l2 = Math.sqrt(2 * (1 - 0.85));
    const cosSim = 1 - (l2 * l2) / 2;
    expect(cosSim).toBeCloseTo(0.85, 5);
  });

  it('identical unit vectors have cosine similarity 1.0', () => {
    const v = oneHotVector(1024, 0);
    // cos_sim(v, v) = dot(v,v) / (|v|*|v|) = 1 / (1*1) = 1
    let dot = 0;
    let norm = 0;
    for (let i = 0; i < v.length; i++) {
      dot += v[i] * v[i];
      norm += v[i] * v[i];
    }
    const cosSim = dot / Math.sqrt(norm) / Math.sqrt(norm);
    expect(cosSim).toBeCloseTo(1.0, 5);
  });

  it('orthogonal unit vectors have cosine similarity 0', () => {
    const v1 = oneHotVector(1024, 0);
    const v2 = oneHotVector(1024, 1);
    let dot = 0;
    for (let i = 0; i < v1.length; i++) {
      dot += v1[i] * v2[i];
    }
    expect(dot).toBeCloseTo(0, 5);
  });
});
