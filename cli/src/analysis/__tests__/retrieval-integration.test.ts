// Integration tests for retrieval-augmented insight generation (AutoRefine pattern).
// Tests the full pipeline: sqlite-vec retrieval → prompt injection → semantic dedup.
//
// Uses in-memory SQLite with sqlite-vec for vector operations.
// Prompt builders are tested with direct input (no LLM calls).

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  loadVectorExtension,
  createVectorTable,
  insertEmbedding,
  querySimilar,
  querySimilarFiltered,
  findSimilar,
  vecToBlob,
} from '../../embeddings/store.js';
import {
  buildSessionAnalysisInstructions,
  buildFacetOnlyInstructions,
  type RelatedInsight,
} from '../prompts.js';
import {
  saveInsightsToDbWithDedup,
  type InsightRow,
  type DedupMetrics,
  EMPTY_DEDUP_METRICS,
} from '../analysis-db.js';

// ─── Helpers ─────────────────────────────────────────────────────────

const EMBEDDING_DIM = 768;

/** Create an in-memory SQLite DB with insights table + vector tables. */
function makeTestDb(): Database.Database {
  const db = new Database(':memory:');
  sqliteVec.load(db);

  db.exec(`
    CREATE TABLE insights (
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

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_insights USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    )
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_messages USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${EMBEDDING_DIM}]
    )
  `);

  return db;
}

/** Deterministic mock embedding: identical text → identical vector. */
async function mockEmbedFn(text: string): Promise<Float32Array> {
  return syncMockEmbedFn(text);
}

/** Synchronous version for use in non-async contexts. */
function syncMockEmbedFn(text: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const seed = Math.abs(hash);
  vec[seed % EMBEDDING_DIM] = 1.0;
  vec[(seed + 1) % EMBEDDING_DIM] = 0.5;
  vec[(seed + 2) % EMBEDDING_DIM] = 0.25;
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) vec[i] /= norm;
  }
  return vec;
}

/** Create a unit vector at a specific index (useful for orthogonal vectors). */
function unitVectorAt(index: number): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  vec[index % EMBEDDING_DIM] = 1.0;
  return vec;
}

function makeInsightRow(overrides: Partial<InsightRow> = {}): InsightRow {
  return {
    id: `insight-${Math.random().toString(36).slice(2, 8)}`,
    session_id: 's1',
    project_id: 'p1',
    project_name: 'test-project',
    type: 'summary',
    title: 'Test Insight',
    content: 'This is test content for the insight.',
    summary: 'Test summary',
    bullets: '[]',
    confidence: 0.9,
    source: 'llm',
    metadata: null,
    timestamp: '2024-01-01T00:00:00Z',
    created_at: '2024-01-01T00:00:00Z',
    scope: 'session',
    analysis_version: '3.0.0',
    embedding_status: 'pending',
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Retrieval query: querySimilarFiltered
// ═══════════════════════════════════════════════════════════════════════

describe('querySimilarFiltered — sqlite-vec retrieval query', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('returns only insights matching the specified project_id', () => {
    // Insert vectors for two different projects
    const vecA = unitVectorAt(0);
    const vecB = unitVectorAt(1);

    insertEmbedding(db, 'insight', 'insight-proj1-a', vecA);
    insertEmbedding(db, 'insight', 'insight-proj2-a', vecB); // different vector, different project

    // Insert corresponding insight rows with project_ids
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('insight-proj1-a', 's1', 'proj1', 'Project One', 'decision', 'Use Vitest', 'Chose Vitest for speed', 'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('insight-proj2-a', 's2', 'proj2', 'Project Two', 'decision', 'Use Jest', 'Chose Jest for compat', 'Summary', '[]', 0.88, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();

    // Query with vecA (closest to insight-proj1-a) filtered to proj1
    const results = querySimilarFiltered(db, 'insight', vecA, 5, 'proj1');

    expect(results.length).toBe(1);
    expect(results[0].id).toBe('insight-proj1-a');
  });

  it('returns empty when no insights match the project filter', () => {
    const vec = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'insight-other', vec);
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('insight-other', 's1', 'other-project', 'Other', 'summary', 'Title', 'Content', 'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();

    const results = querySimilarFiltered(db, 'insight', vec, 5, 'nonexistent-project');
    expect(results.length).toBe(0);
  });

  it('respects the topK limit after project filtering', () => {
    // Insert 5 insights in the same project with slightly different vectors
    for (let i = 0; i < 5; i++) {
      const vec = unitVectorAt(i);
      const id = `insight-p1-${i}`;
      insertEmbedding(db, 'insight', id, vec);
      db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
        VALUES (?, 's1', 'proj1', 'Project One', 'summary', 'Title', 'Content', 'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run(id);
    }

    // Query with topK=2 — should return at most 2
    const queryVec = unitVectorAt(0);
    const results = querySimilarFiltered(db, 'insight', queryVec, 2, 'proj1');
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns results sorted by ascending distance', () => {
    // Insert vectors at increasing distance from position 0
    for (let i = 0; i < 4; i++) {
      const vec = unitVectorAt(i * 10); // positions 0, 10, 20, 30
      const id = `insight-dist-${i}`;
      insertEmbedding(db, 'insight', id, vec);
      db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
        VALUES (?, 's1', 'proj1', 'Project One', 'summary', 'Title', 'Content', 'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run(id);
    }

    const queryVec = unitVectorAt(0);
    const results = querySimilarFiltered(db, 'insight', queryVec, 10, 'proj1');

    // Verify ascending distance order
    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  it('falls back to unfiltered query for non-insight entity types', () => {
    const vec = unitVectorAt(0);
    insertEmbedding(db, 'message', 'msg-1', vec);

    // For 'message' entity type, querySimilarFiltered delegates to querySimilar
    // (no project_id filtering since messages table doesn't have it in the same way)
    const results = querySimilarFiltered(db, 'message', vec, 5, 'any-project');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('msg-1');
  });

  it('returns empty when vector table is empty', () => {
    const vec = unitVectorAt(0);
    const results = querySimilarFiltered(db, 'insight', vec, 5, 'proj1');
    expect(results.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Prompt builders: relatedInsights inclusion/exclusion
// ═══════════════════════════════════════════════════════════════════════

describe('buildSessionAnalysisInstructions — relatedInsights in prompt', () => {
  const sampleInsights: RelatedInsight[] = [
    { type: 'decision', title: 'Use Vitest', content: 'Chose Vitest for speed and ESM support', confidence: 0.85 },
    { type: 'learning', title: 'Testing helps', content: 'Write tests early to catch regressions', confidence: 0.80 },
    { type: 'technique', title: 'TDD loop', content: 'Red-green-refactor cycle', confidence: 0.90 },
  ];

  it('includes <related_insights> block when relatedInsights are provided', () => {
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<related_insights>');
    expect(result).toContain('</related_insights>');
  });

  it('formats each insight with correct XML structure', () => {
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<insight index="1">');
    expect(result).toContain('<type>decision</type>');
    expect(result).toContain('<title>Use Vitest</title>');
    expect(result).toContain('<content>Chose Vitest for speed and ESM support</content>');
    expect(result).toContain('<confidence>0.85</confidence>');
    expect(result).toContain('</insight>');
  });

  it('numbers insights sequentially starting from 1', () => {
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<insight index="1">');
    expect(result).toContain('<insight index="2">');
    expect(result).toContain('<insight index="3">');
  });

  it('includes <related_insights_instructions> with dedup guidance', () => {
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<related_insights_instructions>');
    expect(result).toContain('Do NOT duplicate them');
    expect(result).toContain('Instead, note if they reinforce or contradict');
    expect(result).toContain('reference it by index');
  });

  it('omits <related_insights> block when relatedInsights is empty array', () => {
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, []);
    expect(result).not.toContain('<related_insights>');
    expect(result).not.toContain('<related_insights_instructions>');
  });

  it('omits <related_insights> block when relatedInsights is undefined', () => {
    const result = buildSessionAnalysisInstructions('my-app', null);
    expect(result).not.toContain('<related_insights>');
    expect(result).not.toContain('<related_insights_instructions>');
  });

  it('still includes core prompt sections when relatedInsights are present', () => {
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<task>');
    expect(result).toContain('<context>');
    expect(result).toContain('<project_name>my-app</project_name>');
    expect(result).toContain('<rules>');
    expect(result).toContain('<output_schema>');
    expect(result).toContain('<json>...</json>');
  });

  it('includes session summary in context when provided', () => {
    const result = buildSessionAnalysisInstructions('my-app', 'Fixed a critical auth bug', undefined, undefined, sampleInsights);
    expect(result).toContain('<session_summary>Fixed a critical auth bug</session_summary>');
  });

  it('handles single related insight', () => {
    const singleInsight: RelatedInsight[] = [
      { type: 'decision', title: 'One thing', content: 'Only one insight here', confidence: 0.95 },
    ];
    const result = buildSessionAnalysisInstructions('my-app', null, undefined, undefined, singleInsight);
    expect(result).toContain('<insight index="1">');
    expect(result).not.toContain('<insight index="2">');
    expect(result).toContain('<title>One thing</title>');
  });
});

describe('buildFacetOnlyInstructions — relatedInsights in facet prompt', () => {
  const sampleInsights: RelatedInsight[] = [
    { type: 'decision', title: 'Use Vitest', content: 'Chose Vitest for speed', confidence: 0.85 },
  ];

  it('includes <related_insights> block when relatedInsights are provided', () => {
    const result = buildFacetOnlyInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<related_insights>');
    expect(result).toContain('</related_insights>');
  });

  it('includes dedup guidance in facet instructions', () => {
    const result = buildFacetOnlyInstructions('my-app', null, undefined, undefined, sampleInsights);
    expect(result).toContain('<related_insights_instructions>');
    expect(result).toContain('Do NOT duplicate them');
  });

  it('omits <related_insights> block when relatedInsights is empty', () => {
    const result = buildFacetOnlyInstructions('my-app', null, undefined, undefined, []);
    expect(result).not.toContain('<related_insights>');
  });

  it('omits <related_insights> block when relatedInsights is undefined', () => {
    const result = buildFacetOnlyInstructions('my-app', null);
    expect(result).not.toContain('<related_insights>');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Semantic deduplication: findSimilar
// ═══════════════════════════════════════════════════════════════════════

describe('findSimilar — semantic deduplication', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('detects exact duplicate (identical vector, distance ≈ 0)', () => {
    const vec = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'existing-1', vec);
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('existing-1', 's1', 'p1', 'proj', 'summary', 'Title', 'Content', 'Summary', '[]', 0.9, 'llm', '{"link_ids": ["old-1"]}', '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();

    const results = findSimilar(db, 'insight', vec, 0.90, 5);
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('existing-1');
    expect(results[0].distance).toBeCloseTo(0, 5);
  });

  it('returns empty for dissimilar vectors (below threshold)', () => {
    const v1 = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'orig-1', v1);

    const v2 = unitVectorAt(500); // orthogonal
    const results = findSimilar(db, 'insight', v2, 0.90, 5);
    expect(results.length).toBe(0);
  });

  it('returns metadata from the insights table', () => {
    const vec = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'with-meta', vec);
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('with-meta', 's1', 'p1', 'proj', 'summary', 'Title', 'Content', 'Summary', '[]', 0.9, 'llm', '{"key": "value"}', '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();

    const results = findSimilar(db, 'insight', vec, 0.90, 5);
    expect(results[0].metadata).toBe('{"key": "value"}');
  });

  it('returns null metadata when insight row is missing', () => {
    const vec = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'orphan-1', vec);
    // No insight row inserted

    const results = findSimilar(db, 'insight', vec, 0.90, 5);
    expect(results.length).toBe(1);
    expect(results[0].metadata).toBeNull();
  });

  it('respects the limit parameter', () => {
    // Insert 5 vectors at different positions
    for (let i = 0; i < 5; i++) {
      const vec = unitVectorAt(i);
      insertEmbedding(db, 'insight', `insight-${i}`, vec);
    }

    const queryVec = unitVectorAt(0);
    const results = findSimilar(db, 'insight', queryVec, 0.50, 3);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('converts similarity threshold to distance correctly', () => {
    // Insert a vector
    const v1 = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'target', v1);

    // Query with identical vector — distance = 0, similarity = 1.0
    // Threshold 0.90 means maxDistance = 0.10
    const results = findSimilar(db, 'insight', v1, 0.90, 5);
    expect(results.length).toBe(1);

    // Threshold 1.0 means maxDistance = 0.0 — only exact match
    const resultsStrict = findSimilar(db, 'insight', v1, 1.0, 5);
    expect(resultsStrict.length).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. End-to-end dedup: saveInsightsToDbWithDedup
// ═══════════════════════════════════════════════════════════════════════

describe('saveInsightsToDbWithDedup — write-time deduplication', () => {
  // NOTE: saveInsightsToDbWithDedup uses getDb() singleton internally for writes,
  // so we can only test the fast path (empty vector table) and empty input here.
  // The dedup logic (findSimilar, threshold checks) is tested through findSimilar above.

  it('returns EMPTY_DEDUP_METRICS for empty input', async () => {
    const metrics = await saveInsightsToDbWithDedup(
      [],
      mockEmbedFn,
      loadVectorExtension,
      createVectorTable,
      insertEmbedding,
      findSimilar,
    );

    expect(metrics).toEqual(EMPTY_DEDUP_METRICS);
  });

  it('DedupMetrics interface has correct shape', () => {
    const metrics: DedupMetrics = {
      duplicatesSkipped: 2,
      nearDuplicatesMerged: 1,
      embeddingsMarkedStale: 0,
      embeddingsRecomputed: 0,
    };
    expect(metrics.duplicatesSkipped).toBe(2);
    expect(metrics.nearDuplicatesMerged).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Cross-component integration: retrieval → prompt → dedup
// ═══════════════════════════════════════════════════════════════════════

describe('Retrieval → Prompt → Dedup integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeTestDb();
  });

  it('retrieved insights can be formatted into prompt and deduplicated', () => {
    // Simulate: retrieve insights from sqlite-vec, format into prompt, check for dupes

    // Step 1: Insert existing insights with embeddings
    const vec1 = unitVectorAt(0);
    const vec2 = unitVectorAt(10);
    insertEmbedding(db, 'insight', 'ret-1', vec1);
    insertEmbedding(db, 'insight', 'ret-2', vec2);

    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('ret-1', 's1', 'proj1', 'My Project', 'decision', 'Use Vitest', 'Chose Vitest for speed', 'Summary', '[]', 0.85, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('ret-2', 's1', 'proj1', 'My Project', 'learning', 'Testing helps', 'Write tests early', 'Summary', '[]', 0.80, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();

    // Step 2: Retrieve similar insights (simulating retrieveRelatedInsights)
    const queryVec = unitVectorAt(0); // closest to ret-1
    const candidates = querySimilarFiltered(db, 'insight', queryVec, 5, 'proj1');
    expect(candidates.length).toBeGreaterThan(0);

    // Step 3: Build RelatedInsight[] from candidates (simulating the mapping in retrieveRelatedInsights)
    const relatedInsights: RelatedInsight[] = candidates.map(c => {
      const row = db.prepare('SELECT type, title, content, confidence FROM insights WHERE id = ?').get(c.id) as {
        type: string; title: string; content: string; confidence: number;
      };
      return {
        type: row.type,
        title: row.title,
        content: row.content.slice(0, 300),
        confidence: row.confidence,
      };
    });

    // Step 4: Format into prompt
    const prompt = buildSessionAnalysisInstructions('My Project', null, undefined, undefined, relatedInsights);
    expect(prompt).toContain('<related_insights>');
    expect(prompt).toContain('Use Vitest');
    expect(prompt).toContain('Testing helps');
    expect(prompt).toContain('Do NOT duplicate them');

    // Step 5: Verify dedup would catch a duplicate
    const dupeCheck = findSimilar(db, 'insight', vec1, 0.90, 1);
    expect(dupeCheck.length).toBe(1);
    expect(dupeCheck[0].id).toBe('ret-1');
  });

  it('insights from different projects are not mixed in retrieval', () => {
    // Insert insights for two projects
    const vec = unitVectorAt(0);
    insertEmbedding(db, 'insight', 'p1-insight', vec);
    insertEmbedding(db, 'insight', 'p2-insight', vec); // same vector, different project

    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('p1-insight', 's1', 'proj1', 'Project One', 'decision', 'P1 Decision', 'Content', 'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, bullets, confidence, source, metadata, timestamp, created_at, scope, analysis_version, embedding_status)
      VALUES ('p2-insight', 's2', 'proj2', 'Project Two', 'decision', 'P2 Decision', 'Content', 'Summary', '[]', 0.9, 'llm', null, '2024-01-01', '2024-01-01', 'session', '3.0.0', 'computed')`).run();

    // Retrieve for proj1 — should only get p1-insight
    const results = querySimilarFiltered(db, 'insight', vec, 5, 'proj1');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('p1-insight');

    // Retrieve for proj2 — should only get p2-insight
    const results2 = querySimilarFiltered(db, 'insight', vec, 5, 'proj2');
    expect(results2.length).toBe(1);
    expect(results2[0].id).toBe('p2-insight');
  });
});
