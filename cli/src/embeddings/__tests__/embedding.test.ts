// Unit tests for the embedding pipeline.
// Mocks Ollama HTTP responses; tests batching, store operations, and backfill logic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// ─── Mock Ollama before importing the client ───────────────────────
const mockFetch = vi.fn();
global.fetch = mockFetch;

function setupMockOllama(dim: number = 768) {
  mockFetch.mockImplementation(async (url: string, opts: any) => {
    const body = JSON.parse(opts.body);
    const count = Array.isArray(body.input) ? body.input.length : 1;
    // Return deterministic vectors: each vector is [i, i, i, ...] for item i
    const embeddings = Array.from({ length: count }, (_, i) => {
      const v = new Array(dim).fill(0);
      v[0] = i + 1; // first element = index+1 for easy identification
      return v;
    });
    return {
      ok: true,
      json: async () => ({ embeddings }),
    };
  });
}

// ─── Tests ─────────────────────────────────────────────────────────

import { embedTexts, embedOne, EmbeddingError } from '../ollama-client.js';
import type { EmbeddingConfig } from '../types.js';
import {
  loadVectorExtension,
  createAllVectorTables,
  insertEmbedding,
  insertEmbeddingsBatch,
  querySimilar,
  querySimilarExcluding,
  rebuildVectorStore,
  countVectors,
  vecToBlob,
  findSimilar,
  markStale,
} from '../store.js';

const TEST_CONFIG: EmbeddingConfig = {
  model: 'embeddinggemma:latest',
  baseUrl: 'http://localhost:11434',
  dim: 768,
  batchSize: 3,
  rateLimitPerMinute: 0,
};

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  loadVectorExtension(db);
  createAllVectorTables(db, 768);
  return db;
}

describe('ollama-client', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  it('embedOne returns a single embedding', async () => {
    setupMockOllama(768);
    const result = await embedOne(TEST_CONFIG, 'test-1', 'hello world');
    expect(result.id).toBe('test-1');
    expect(result.vector).toBeInstanceOf(Float32Array);
    expect(result.vector.length).toBe(768);
    expect(result.model).toBe('embeddinggemma:latest');
    expect(result.sourceText).toBe('hello world');
  });

  it('embedTexts processes items in batches', async () => {
    setupMockOllama(768);
    const items = Array.from({ length: 7 }, (_, i) => ({
      id: `item-${i}`,
      text: `text ${i}`,
    }));

    // batchSize=3 → 3 batches: [0,1,2], [3,4,5], [6]
    const results = await embedTexts(TEST_CONFIG, items);
    expect(results.length).toBe(7);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // Verify IDs are preserved
    for (let i = 0; i < 7; i++) {
      expect(results[i].id).toBe(`item-${i}`);
    }
  });

  it('throws EmbeddingError on non-200 response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    });

    await expect(embedOne(TEST_CONFIG, 'fail-1', 'test')).rejects.toThrow(EmbeddingError);
  });

  it('throws EmbeddingError on missing embeddings in response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    await expect(embedOne(TEST_CONFIG, 'fail-2', 'test')).rejects.toThrow(EmbeddingError);
  });

  it('throws EmbeddingError on mismatched embedding count', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3]] }),
    });

    await expect(
      embedTexts(TEST_CONFIG, [
        { id: 'a', text: 'hello' },
        { id: 'b', text: 'world' },
      ]),
    ).rejects.toThrow(EmbeddingError);
  });
});

describe('store', () => {
  it('creates vector tables for both entity types', () => {
    const db = freshDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vec_insights', 'vec_messages')")
      .all() as Array<{ name: string }>;
    expect(tables.map(t => t.name).sort()).toEqual(['vec_insights', 'vec_messages']);
    db.close();
  });

  it('insertEmbedding and countVectors work', () => {
    const db = freshDb();
    const vec = new Float32Array(768);
    vec[0] = 1.0;
    vec[1] = 2.0;

    insertEmbedding(db, 'insight', 'i1', vec);
    expect(countVectors(db, 'insight')).toBe(1);
    expect(countVectors(db, 'message')).toBe(0);
    db.close();
  });

  it('insertEmbeddingsBatch inserts multiple vectors in a transaction', () => {
    const db = freshDb();
    const embeddings = Array.from({ length: 100 }, (_, i) => ({
      id: `batch-${i}`,
      vector: new Float32Array(768).fill(i),
      sourceText: `text ${i}`,
      model: 'test',
      dim: 768,
    }));

    insertEmbeddingsBatch(db, 'insight', embeddings);
    expect(countVectors(db, 'insight')).toBe(100);
    db.close();
  });

  it('querySimilar returns nearest neighbors by cosine distance', () => {
    const db = freshDb();

    // Insert 5 vectors where vector i has 1.0 at position i*10, rest 0
    for (let i = 0; i < 5; i++) {
      const v = new Float32Array(768);
      v[i * 10] = 1.0;
      insertEmbedding(db, 'insight', `v${i}`, v);
    }

    // Query with vector closest to v2
    const queryVec = new Float32Array(768);
    queryVec[2 * 10] = 1.0;

    const results = querySimilar(db, 'insight', queryVec, 3);
    expect(results.length).toBe(3);
    expect(results[0].id).toBe('v2'); // closest to itself
    expect(results[0].distance).toBeCloseTo(0, 5);
    db.close();
  });

  it('querySimilarExcludes filters out the query id', () => {
    const db = freshDb();

    for (let i = 0; i < 5; i++) {
      const v = new Float32Array(768);
      v[i * 10] = 1.0;
      insertEmbedding(db, 'insight', `v${i}`, v);
    }

    const queryVec = new Float32Array(768);
    queryVec[2 * 10] = 1.0;

    const results = querySimilarExcluding(db, 'insight', queryVec, 3, 'v2');
    expect(results.length).toBe(3);
    expect(results.every(r => r.id !== 'v2')).toBe(true);
    db.close();
  });

  it('querySimilarFiltered filters by project_id', async () => {
    const { querySimilarFiltered } = await import('../store.js');
    const db = freshDb();

    // Create insights table with project_id
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        project_id TEXT,
        project_name TEXT,
        type TEXT,
        title TEXT,
        content TEXT,
        summary TEXT,
        bullets TEXT,
        confidence REAL,
        source TEXT,
        metadata TEXT,
        timestamp TEXT,
        created_at TEXT,
        scope TEXT,
        analysis_version TEXT,
        embedding_status TEXT
      )
    `);

    // Insert vectors for two projects
    const projA = 'proj-alpha';
    const projB = 'proj-beta';

    for (let i = 0; i < 3; i++) {
      const v = new Float32Array(768);
      v[i * 10] = 1.0;
      insertEmbedding(db, 'insight', `alpha-${i}`, v);
      db.prepare('INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, timestamp, created_at, scope, analysis_version, embedding_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`alpha-${i}`, `sess-${i}`, projA, 'Alpha', 'decision', `Alpha insight ${i}`, `Content ${i}`, `Summary ${i}`, '[]', 0.8, 'llm', '2025-01-01', '2025-01-01', 'session', '3.0.0', 'computed');
    }

    for (let i = 0; i < 3; i++) {
      const v = new Float32Array(768);
      v[i * 10] = 1.0;
      insertEmbedding(db, 'insight', `beta-${i}`, v);
      db.prepare('INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, timestamp, created_at, scope, analysis_version, embedding_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`beta-${i}`, `sess-${i}`, projB, 'Beta', 'decision', `Beta insight ${i}`, `Content ${i}`, `Summary ${i}`, '[]', 0.8, 'llm', '2025-01-01', '2025-01-01', 'session', '3.0.0', 'computed');
    }

    // Query with vector closest to alpha-1, filtered to project alpha
    const queryVec = new Float32Array(768);
    queryVec[1 * 10] = 1.0;

    const results = querySimilarFiltered(db, 'insight', queryVec, 5, projA);
    // Should only return alpha project insights
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.id.startsWith('alpha-'))).toBe(true);
    expect(results.some(r => r.id.startsWith('beta-'))).toBe(false);

    // Query filtered to project beta
    const resultsB = querySimilarFiltered(db, 'insight', queryVec, 5, projB);
    expect(resultsB.every(r => r.id.startsWith('beta-'))).toBe(true);

    db.close();
  });

  it('querySimilarFiltered returns empty when no matching project', async () => {
    const { querySimilarFiltered } = await import('../store.js');
    const db = freshDb();

    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT, project_name TEXT,
        type TEXT, title TEXT, content TEXT, summary TEXT, bullets TEXT,
        confidence REAL, source TEXT, metadata TEXT, timestamp TEXT,
        created_at TEXT, scope TEXT, analysis_version TEXT, embedding_status TEXT
      )
    `);

    const v = new Float32Array(768);
    v[0] = 1.0;
    insertEmbedding(db, 'insight', 'only-one', v);
    db.prepare('INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, timestamp, created_at, scope, analysis_version, embedding_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('only-one', 'sess-1', 'proj-exists', 'Exists', 'decision', 'Only', 'Content', 'Summary', '[]', 0.8, 'llm', '2025-01-01', '2025-01-01', 'session', '3.0.0', 'computed');

    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;

    // Query for a different project — should return empty
    const results = querySimilarFiltered(db, 'insight', queryVec, 5, 'proj-nonexistent');
    expect(results.length).toBe(0);

    db.close();
  });

  it('rebuildVectorStore drops and recreates the table', () => {
    const db = freshDb();

    // Insert some data
    insertEmbedding(db, 'insight', 'old-1', new Float32Array(768).fill(1));
    expect(countVectors(db, 'insight')).toBe(1);

    // Rebuild with new data
    const newEmbeddings = [
      { id: 'new-1', vector: new Float32Array(768).fill(2), sourceText: 'new', model: 'test', dim: 768 },
    ];
    rebuildVectorStore(db, 'insight', newEmbeddings, 768);
    expect(countVectors(db, 'insight')).toBe(1);

    const row = db.prepare('SELECT id FROM vec_insights').get() as { id: string };
    expect(row.id).toBe('new-1');
    db.close();
  });

  it('vecToBlob produces correct binary representation', () => {
    const vec = new Float32Array([1.0, 2.0, 3.0]);
    const blob = vecToBlob(vec);
    expect(blob.length).toBe(12); // 3 * 4 bytes

    // Verify round-trip
    const recovered = new Float32Array(blob.buffer, blob.byteOffset, 3);
    expect(recovered[0]).toBeCloseTo(1.0, 5);
    expect(recovered[1]).toBeCloseTo(2.0, 5);
    expect(recovered[2]).toBeCloseTo(3.0, 5);
  });

  it('findSimilar returns results above similarity threshold', () => {
    const db = freshDb();

    // Create minimal insights table for metadata join
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        bullets TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        analysis_version TEXT NOT NULL,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    // Insert 5 orthogonal vectors (each has 1.0 at a unique position)
    for (let i = 0; i < 5; i++) {
      const v = new Float32Array(768);
      v[i * 10] = 1.0;
      insertEmbedding(db, 'insight', `v${i}`, v);
    }

    // Also insert into the insights table so metadata join works
    const metaStmt = db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, content,
        summary, bullets, confidence, source, metadata, timestamp, created_at, scope,
        analysis_version, embedding_status)
      VALUES (?, 's1', 'p1', 'proj', 'summary', 'Title', 'Content',
        'Summary', '[]', 0.9, 'llm', ?, '2024-01-01', '2024-01-01', 'session',
        '3.0.0', 'computed')
    `);
    for (let i = 0; i < 5; i++) {
      metaStmt.run(`v${i}`, JSON.stringify({ index: i }));
    }

    // Query with vector identical to v2 → should find v2 at distance ~0
    const queryVec = new Float32Array(768);
    queryVec[2 * 10] = 1.0;

    const results = findSimilar(db, 'insight', queryVec, 0.90, 3);
    expect(results.length).toBe(1); // only v2 is identical (distance=0, similarity=1.0)
    expect(results[0].id).toBe('v2');
    expect(results[0].distance).toBeCloseTo(0, 5);
    expect(results[0].metadata).toBe(JSON.stringify({ index: 2 }));
    db.close();
  });

  it('findSimilar returns empty when no vectors exceed threshold', () => {
    const db = freshDb();

    // Create minimal insights table
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        bullets TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        analysis_version TEXT NOT NULL,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    // Insert orthogonal vectors
    for (let i = 0; i < 3; i++) {
      const v = new Float32Array(768);
      v[i * 10] = 1.0;
      insertEmbedding(db, 'insight', `v${i}`, v);
    }

    // Query with a vector that doesn't match any
    const queryVec = new Float32Array(768);
    queryVec[500] = 1.0;

    const results = findSimilar(db, 'insight', queryVec, 0.90, 5);
    expect(results.length).toBe(0);
    db.close();
  });

  it('findSimilar respects the limit parameter', () => {
    const db = freshDb();

    // Create minimal insights table
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        bullets TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        analysis_version TEXT NOT NULL,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    // Insert 10 nearly-identical vectors (all close to [1,0,0,...])
    for (let i = 0; i < 10; i++) {
      const v = new Float32Array(768);
      v[0] = 1.0;
      v[1] = i * 0.01; // tiny variation
      insertEmbedding(db, 'insight', `near${i}`, v);
    }

    const queryVec = new Float32Array(768);
    queryVec[0] = 1.0;

    const results = findSimilar(db, 'insight', queryVec, 0.85, 3);
    expect(results.length).toBeLessThanOrEqual(3);
    db.close();
  });

  it('markStale updates embedding_status to stale', () => {
    const db = freshDb();

    // Create minimal insights table
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        project_name TEXT NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        bullets TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        metadata TEXT,
        timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        analysis_version TEXT NOT NULL,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
      )
    `);

    // Insert an insight row
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, content,
        summary, bullets, confidence, source, metadata, timestamp, created_at, scope,
        analysis_version, embedding_status)
      VALUES ('stale-1', 's1', 'p1', 'proj', 'summary', 'Title', 'Content',
        'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session',
        '3.0.0', 'computed')
    `).run();

    markStale(db, 'insight', 'stale-1');

    const row = db.prepare('SELECT embedding_status FROM insights WHERE id = ?').get('stale-1') as { embedding_status: string };
    expect(row.embedding_status).toBe('stale');
    db.close();
  });
});

describe('backfill integration', () => {
  beforeEach(() => {
    mockFetch.mockClear();
    setupMockOllama(768);
  });

  it.skip('backfillEmbeddings skips when no pending rows', async () => {
    const { backfillEmbeddings } = await import('../backfill.js');
    const db = freshDb();

    // Insert schema tables needed by backfill
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_version VALUES (1, datetime('now'));
    `);

    const stats = await backfillEmbeddings(TEST_CONFIG, 'insight');
    expect(stats.total).toBe(0);
    expect(stats.computed).toBe(0);
    db.close();
  });
});
