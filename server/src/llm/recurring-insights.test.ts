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

vi.mock('./client.js', () => ({
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
  findRecurringInsightsByVector,
  findRecurringInsightsByLLM,
} = await import('./recurring-insights.js');

// ─── Helpers ──────────────────────────────────────────────────────

/** Create an in-memory DB with migrations + vec_insights virtual table. */
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
  // Create the sqlite-vec virtual table
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_insights USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${dim}]
    );
  `);
  return db;
}

/** Insert an insight row + its embedding into the test DB. */
function insertInsightWithEmbedding(
  db: Database.Database,
  id: string,
  sessionId: string,
  type: string,
  title: string,
  summary: string,
  vector: Float32Array,
) {
  db.prepare(`
    INSERT INTO insights (id, session_id, project_id, project_name, type, title, summary, content, confidence, timestamp)
    VALUES (?, ?, 'proj-1', 'test-project', ?, ?, ?, '', 0.9, datetime('now'))
  `).run(id, sessionId, type, title, summary);

  const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
  db.prepare('INSERT OR REPLACE INTO vec_insights (id, embedding) VALUES (?, ?)').run(id, blob);
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
