import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../db/migrate.js';

let testDb: Database.Database;
let mockConfig: Record<string, unknown> | null = null;
const mockFetch = vi.fn();

vi.mock('../../db/client.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock('../../utils/config.js', () => ({
  loadConfig: () => mockConfig,
}));

vi.mock('../../utils/telemetry.js', () => ({
  trackEvent: () => {},
  captureError: () => {},
  classifyError: (err: unknown) => ({
    error_type: 'unknown',
    error_message: err instanceof Error ? err.message : String(err),
  }),
}));

const { pruneEmbeddings } = await import('../prune.js');
const { loadVectorExtension, createAllVectorTables, insertEmbedding, countVectors } = await import('../store.js');
const { backfillEmbeddings } = await import('../backfill.js');
const { deleteSessionInsights } = await import('../../analysis/analysis-db.js');
const { purgeSessions } = await import('../../db/purge.js');
const { embeddingsRecomputeCommand, embeddingsSearchCommand } = await import('../../commands/embeddings.js');
const { buildEmbeddingConfig } = await import('../../commands/search.js');

function vecWithValue(val: number, dim = 768): Float32Array {
  const v = new Float32Array(dim);
  v[0] = val;
  return v;
}

function seedProjectAndSession(db: Database.Database, sessionId = 'sess-1', deletedAt: string | null = null): void {
  db.prepare(`
    INSERT OR IGNORE INTO projects (id, name, path, last_activity)
    VALUES ('proj-1', 'TestProj', '/tmp/proj', datetime('now'))
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, deleted_at)
    VALUES (?, 'proj-1', 'TestProj', '/tmp/proj', datetime('now'), datetime('now'), ?)
  `).run(sessionId, deletedAt);
}

function insertInsight(
  db: Database.Database,
  id: string,
  sessionId = 'sess-1',
  status: 'pending' | 'computed' | 'stale' | 'failed' = 'computed',
  content = 'Insight body content',
): void {
  db.prepare(`
    INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, timestamp, created_at, scope, analysis_version, embedding_status)
    VALUES (?, ?, 'proj-1', 'TestProj', 'decision', ?, ?, ?, '[]', 0.9, 'llm', datetime('now'), datetime('now'), 'session', '3.1.0', ?)
  `).run(id, sessionId, `Title ${id}`, content, content, status);
}

function insertMessage(
  db: Database.Database,
  id: string,
  sessionId = 'sess-1',
  content = 'User message content',
  status: 'pending' | 'computed' | 'stale' | 'failed' = 'computed',
): void {
  db.prepare(`
    INSERT INTO messages (id, session_id, type, content, timestamp, embedding_status)
    VALUES (?, ?, 'user', ?, datetime('now'), ?)
  `).run(id, sessionId, content, status);
}

function setupFetchMock(dim = 768): void {
  mockFetch.mockImplementation(async (_url: string, opts: RequestInit) => {
    const body = JSON.parse(opts.body as string) as { input?: string[] };
    const count = Array.isArray(body.input) ? body.input.length : 1;
    const embeddings = Array.from({ length: count }, (_, i) => {
      const arr = new Array(dim).fill(0);
      arr[0] = i + 1;
      return arr;
    });
    return {
      ok: true,
      json: async () => ({ embeddings }),
    };
  });
}

describe('embedding prune and lifecycle', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    loadVectorExtension(testDb);
    createAllVectorTables(testDb, 768);
    mockConfig = null;
    global.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockReset();
  });

  afterEach(() => {
    testDb.close();
  });

  it('pruneEmbeddings supports dryRun and cleans legacy, orphan, ghost, off-model, and dangling records', () => {
    seedProjectAndSession(testDb, 'sess-1');

    // Live entities
    insertInsight(testDb, 'ins-good', 'sess-1', 'computed');
    insertInsight(testDb, 'ins-wrong-model', 'sess-1', 'computed');
    insertInsight(testDb, 'ins-ghost-only', 'sess-1', 'computed');
    insertMessage(testDb, 'msg-good', 'sess-1', 'hello world', 'computed');
    insertMessage(testDb, 'msg-ws', 'sess-1', '\n', 'computed'); // computed with 0 chunks — must stay computed

    // 1. Valid target-model insight + legacy flat pre-V14 row for the same insight
    insertEmbedding(testDb, 'insight', 'ins-good_p0_c0', vecWithValue(1));
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-good_p0', 'insight', 'ins-good', 0, 'good')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-good_p0_c0', 'insight', 'ins-good', 'embeddinggemma-2:440m', 768, 'good', 'ins-good_p0')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text) VALUES ('ins-good', 'insight', '', 'embeddinggemma:latest', 768, 'legacy')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text) VALUES ('ins-deleted-legacy', 'insight', '', 'qwen3-embedding:0.6b', 1024, 'legacy deleted')`).run();

    // 2. Wrong-model live insight (should be removed from vec + metadata + chunks and re-queued)
    insertEmbedding(testDb, 'insight', 'ins-wrong-model_p0_c0', vecWithValue(2));
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-wrong-model_p0', 'insight', 'ins-wrong-model', 0, 'wrong')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-wrong-model_p0_c0', 'insight', 'ins-wrong-model', 'embeddinggemma:latest', 768, 'wrong', 'ins-wrong-model_p0')`).run();

    // 3. Ghost metadata for live insight whose vector is missing from vec_insights (should be removed & re-queued)
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-ghost-only_p0', 'insight', 'ins-ghost-only', 0, 'ghost')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-ghost-only_p0_c0', 'insight', 'ins-ghost-only', 'embeddinggemma-2:440m', 768, 'ghost', 'ins-ghost-only_p0')`).run();

    // 4. Orphan-entity metadata + vec + chunk (insight no longer exists)
    insertEmbedding(testDb, 'insight', 'ins-orphan_p0_c0', vecWithValue(3));
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-orphan_p0', 'insight', 'ins-orphan', 0, 'orphan')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-orphan_p0_c0', 'insight', 'ins-orphan', 'embeddinggemma-2:440m', 768, 'orphan', 'ins-orphan_p0')`).run();

    // 5. Dangling vector with no metadata row
    insertEmbedding(testDb, 'insight', 'dangling-vec-1', vecWithValue(4));

    // 6. Valid message + orphan message metadata + orphan message chunk
    insertEmbedding(testDb, 'message', 'msg-good_p0_c0', vecWithValue(5));
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('msg-good_p0', 'message', 'msg-good', 0, 'hello world')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('msg-good_p0_c0', 'message', 'msg-good', 'embeddinggemma-2:440m', 768, 'hello world', 'msg-good_p0')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('msg-orphan_p0_c0', 'message', 'msg-orphan', 768, 'embeddinggemma:latest', 'old', 'msg-orphan_p0')`.replace(`768, 'embeddinggemma:latest'`, `'embeddinggemma:latest', 768`)).run();
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('msg-orphan_p0', 'message', 'msg-orphan', 0, 'old')`).run();

    // Dry run should report everything and leave DB untouched
    const dry = pruneEmbeddings(testDb, { targetModel: 'embeddinggemma-2:440m', dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.legacyFlatRemoved).toBe(2);
    expect(dry.orphanEntityRemoved).toBe(2);
    expect(dry.missingVectorRemoved).toBe(1);
    expect(dry.wrongModelRemoved).toBe(1);
    expect(dry.totalMetadataRemoved).toBe(6);
    expect(dry.vecInsightsRemoved).toBe(3); // ins-wrong-model, ins-orphan, dangling-vec-1
    expect(dry.danglingInsightVectorsRemoved).toBe(1);
    expect(dry.vecMessagesRemoved).toBe(0);
    expect(dry.orphanInsightChunksRemoved).toBe(1);
    expect(dry.orphanMessageChunksRemoved).toBe(1);
    expect(dry.requeuedInsights).toBe(2); // ins-wrong-model + ins-ghost-only
    expect(dry.requeuedMessages).toBe(0);
    expect(countVectors(testDb, 'insight')).toBe(4);

    // Apply prune
    const applied = pruneEmbeddings(testDb, { targetModel: 'embeddinggemma-2:440m', dryRun: false });
    expect(applied).toEqual({ ...dry, dryRun: false });

    expect(countVectors(testDb, 'insight')).toBe(1);
    expect(countVectors(testDb, 'message')).toBe(1);
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM embedding_metadata`).get()).toEqual({ n: 2 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM entity_chunks`).get()).toEqual({ n: 2 });
    expect(testDb.prepare(`SELECT embedding_status FROM insights WHERE id = 'ins-good'`).get()).toEqual({ embedding_status: 'computed' });
    expect(testDb.prepare(`SELECT embedding_status FROM insights WHERE id = 'ins-wrong-model'`).get()).toEqual({ embedding_status: 'pending' });
    expect(testDb.prepare(`SELECT embedding_status FROM insights WHERE id = 'ins-ghost-only'`).get()).toEqual({ embedding_status: 'pending' });
    expect(testDb.prepare(`SELECT embedding_status FROM messages WHERE id = 'msg-ws'`).get()).toEqual({ embedding_status: 'computed' });
  });

  it('deleteSessionInsights and purgeSessions remove vec, metadata, and chunk rows', () => {
    seedProjectAndSession(testDb, 'sess-a');
    seedProjectAndSession(testDb, 'sess-b');
    insertInsight(testDb, 'ins-a', 'sess-a', 'computed');
    insertInsight(testDb, 'ins-b', 'sess-b', 'computed');
    insertMessage(testDb, 'msg-b', 'sess-b', 'msg content', 'computed');

    insertEmbedding(testDb, 'insight', 'ins-a_p0_c0', vecWithValue(1));
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-a_p0_c0', 'insight', 'ins-a', 'embeddinggemma-2:440m', 768, 'a', 'ins-a_p0')`).run();
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-a_p0', 'insight', 'ins-a', 0, 'a')`).run();

    insertEmbedding(testDb, 'insight', 'ins-b_p0_c0', vecWithValue(2));
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-b_p0_c0', 'insight', 'ins-b', 'embeddinggemma-2:440m', 768, 'b', 'ins-b_p0')`).run();
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-b_p0', 'insight', 'ins-b', 0, 'b')`).run();

    insertEmbedding(testDb, 'message', 'msg-b_p0_c0', vecWithValue(3));
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('msg-b_p0_c0', 'message', 'msg-b', 'embeddinggemma-2:440m', 768, 'm', 'msg-b_p0')`).run();
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('msg-b_p0', 'message', 'msg-b', 0, 'm')`).run();

    deleteSessionInsights('sess-a', {});
    expect(countVectors(testDb, 'insight')).toBe(1);
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM embedding_metadata WHERE entity_id = 'ins-a'`).get()).toEqual({ n: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM entity_chunks WHERE entity_id = 'ins-a'`).get()).toEqual({ n: 0 });

    purgeSessions(testDb, { sessionIds: ['sess-b'], reason: 'test purge' });
    expect(countVectors(testDb, 'insight')).toBe(0);
    expect(countVectors(testDb, 'message')).toBe(0);
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM embedding_metadata`).get()).toEqual({ n: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM entity_chunks`).get()).toEqual({ n: 0 });
  });

  it('backfillEmbeddings picks up stale rows and prunes extra old chunks on shrink without leaving chunks on error', async () => {
    seedProjectAndSession(testDb, 'sess-1');
    insertInsight(testDb, 'ins-stale', 'sess-1', 'computed', 'Short updated text');
    // Seed 2 prior chunks (simulating previously longer content or old model)
    insertEmbedding(testDb, 'insight', 'ins-stale_p0_c0', vecWithValue(1));
    insertEmbedding(testDb, 'insight', 'ins-stale_p0_c1', vecWithValue(2));
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-stale_p0', 'insight', 'ins-stale', 0, 'old')`).run();
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-stale_p1', 'insight', 'ins-stale', 1, 'old-p1')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-stale_p0_c0', 'insight', 'ins-stale', 'embeddinggemma:latest', 768, 'old0', 'ins-stale_p0')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-stale_p0_c1', 'insight', 'ins-stale', 'embeddinggemma:latest', 768, 'old1', 'ins-stale_p0')`).run();

    // First verify failed Ollama call does not leave partial entity_chunks on a pending insight
    insertInsight(testDb, 'ins-fail', 'sess-1', 'pending', 'Will fail');
    mockFetch.mockRejectedValue(new Error('Ollama offline'));
    const failStats = await backfillEmbeddings({
      model: 'embeddinggemma-2:440m',
      baseUrl: 'http://127.0.0.1:11434',
      dim: 768,
      batchSize: 50,
      rateLimitPerMinute: 0,
    }, 'insight');
    expect(failStats.failed).toBe(1);
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM entity_chunks WHERE entity_id = 'ins-fail'`).get()).toEqual({ n: 0 });

    // Re-queue both as stale/pending and succeed
    testDb.prepare(`UPDATE insights SET embedding_status = 'stale' WHERE id = 'ins-stale'`).run();
    testDb.prepare(`UPDATE insights SET embedding_status = 'pending' WHERE id = 'ins-fail'`).run();
    setupFetchMock(768);

    const okStats = await backfillEmbeddings({
      model: 'embeddinggemma-2:440m',
      baseUrl: 'http://127.0.0.1:11434',
      dim: 768,
      batchSize: 50,
      rateLimitPerMinute: 0,
    }, 'insight');

    expect(okStats.computed).toBe(2);
    expect(countVectors(testDb, 'insight')).toBe(2); // 1 chunk each for ins-stale + ins-fail; old c1 & p1 removed!
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM embedding_metadata WHERE model = 'embeddinggemma:latest'`).get()).toEqual({ n: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM entity_chunks WHERE id = 'ins-stale_p1'`).get()).toEqual({ n: 0 });
  }, 15_000);

  it('embeddingsRecomputeCommand --all --rebuild clears metadata and entity_chunks and drops vec tables', async () => {
    seedProjectAndSession(testDb, 'sess-1');
    insertInsight(testDb, 'ins-1', 'sess-1', 'computed');
    insertInsight(testDb, 'ins-2', 'sess-1', 'failed');
    insertMessage(testDb, 'msg-1', 'sess-1', 'hello', 'computed');
    insertEmbedding(testDb, 'insight', 'ins-1_p0_c0', vecWithValue(1));
    insertEmbedding(testDb, 'message', 'msg-1_p0_c0', vecWithValue(1));
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-1_p0_c0', 'insight', 'ins-1', 'embeddinggemma-2:440m', 768, 'a', 'ins-1_p0')`).run();
    testDb.prepare(`INSERT INTO entity_chunks (id, entity_type, entity_id, chunk_index, content) VALUES ('ins-1_p0', 'insight', 'ins-1', 0, 'a')`).run();

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await embeddingsRecomputeCommand({ all: true, rebuild: true });
    logSpy.mockRestore();

    expect(testDb.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('vec_insights', 'vec_messages')`).all()).toEqual([]);
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM embedding_metadata`).get()).toEqual({ n: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM entity_chunks`).get()).toEqual({ n: 0 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM insights WHERE embedding_status = 'pending'`).get()).toEqual({ n: 2 });
    expect(testDb.prepare(`SELECT COUNT(*) as n FROM messages WHERE embedding_status = 'pending'`).get()).toEqual({ n: 1 });
  });

  it('embeddingsSearchCommand joins sessions.deleted_at cleanly without missing-column errors', async () => {
    seedProjectAndSession(testDb, 'sess-active', null);
    seedProjectAndSession(testDb, 'sess-deleted', '2026-01-01T00:00:00Z');
    insertInsight(testDb, 'ins-active', 'sess-active', 'computed', 'Active insight');
    insertInsight(testDb, 'ins-deleted', 'sess-deleted', 'computed', 'Deleted session insight');

    insertEmbedding(testDb, 'insight', 'ins-active_p0_c0', vecWithValue(1));
    insertEmbedding(testDb, 'insight', 'ins-deleted_p0_c0', vecWithValue(1));
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-active_p0_c0', 'insight', 'ins-active', 'embeddinggemma-2:440m', 768, 'a', 'ins-active_p0')`).run();
    testDb.prepare(`INSERT INTO embedding_metadata (id, entity_type, entity_id, model, dim, source_text, parent_chunk_id) VALUES ('ins-deleted_p0_c0', 'insight', 'ins-deleted', 'embeddinggemma-2:440m', 768, 'd', 'ins-deleted_p0')`).run();

    setupFetchMock(768);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await embeddingsSearchCommand('active query', { topK: '5', model: 'embeddinggemma-2:440m' });

    logSpy.mockRestore();
    errSpy.mockRestore();
    const out = logs.join('\n');
    expect(out).toContain('Title ins-active');
    expect(out).not.toContain('Title ins-deleted');
  });

  it('search.ts buildEmbeddingConfig honors dashboard.embedding config and CLI overrides', () => {
    mockConfig = {
      dashboard: {
        embedding: {
          provider: 'ollama',
          model: 'embeddinggemma-2:440m',
          baseUrl: 'http://tinybot:11434',
        },
      },
    };

    expect(buildEmbeddingConfig()).toMatchObject({
      model: 'embeddinggemma-2:440m',
      baseUrl: 'http://tinybot:11434',
    });

    expect(buildEmbeddingConfig({ model: 'custom-model', batchSize: '25' })).toMatchObject({
      model: 'custom-model',
      baseUrl: 'http://tinybot:11434',
      batchSize: 25,
    });
  });
});
