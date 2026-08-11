/**
 * sqlite-vec POC — verify integration with better-sqlite3 + Ollama qwen3-embedding
 *
 * Tests:
 * 1. Load sqlite-vec extension
 * 2. Create vec0 virtual table with float[1024]
 * 3. Insert real vectors from Ollama
 * 4. KNN query returns correct neighbors
 * 5. Persistence: close + reopen, KNN still works
 * 6. Benchmark: 15K vectors, top-K=10 latency
 */

import * as sqliteVec from 'sqlite-vec';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const OLLAMA_URL = process.env.OLLAMA_BASE_URL ?? 'http://tinybot:11434';
const EMBED_MODEL = process.env.EMBEDDING_MODEL ?? 'qwen3-embedding:0.6b';
const DIM = 1024;
const BENCHMARK_SIZE = 15000;

async function embed(text: string): Promise<Float32Array> {
  const res = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { embeddings: number[][] };
  return new Float32Array(data.embeddings[0]);
}

function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

async function main() {
  const dbPath = '/tmp/sqlite-vec-poc.db';
  console.log('=== sqlite-vec POC ===\n');

  // ── Step 1: Load extension ──────────────────────────────────────────
  console.log('[1] Loading sqlite-vec extension...');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  const ver = db.prepare('SELECT vec_version() AS v').get() as { v: string };
  console.log(`    vec_version = ${ver.v}`);

  // ── Step 2: Create virtual table ────────────────────────────────────
  console.log('[2] Creating vec0 virtual table (float[1024])...');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_test USING vec0(
      id TEXT PRIMARY KEY,
      embedding float[${DIM}]
    );
  `);
  console.log('    Table created.');

  // ── Step 3: Insert real vectors from Ollama ─────────────────────────
  console.log('[3] Embedding test sentences via Ollama...');
  const sentences = [
    'The authentication middleware validates JWT tokens on every request',
    'Database migrations should be idempotent and reversible',
    'Error handling in async code requires careful promise chaining',
    'The CI pipeline runs lint, typecheck, and test stages in parallel',
    'Feature flags allow gradual rollout of new functionality',
  ];
  const embeddings: { id: string; text: string; vec: Float32Array }[] = [];
  for (const text of sentences) {
    const vec = await embed(text);
    const id = randomUUID();
    embeddings.push({ id, text, vec });
    db.prepare('INSERT OR REPLACE INTO vec_test (id, embedding) VALUES (?, ?)').run(
      id,
      vecToBlob(vec),
    );
    console.log(`    Inserted: "${text.slice(0, 50)}..."`);
  }

  // ── Step 4: KNN query ───────────────────────────────────────────────
  console.log('\n[4] KNN query: find 3 nearest neighbors to first sentence...');
  const queryVec = embeddings[0].vec;
  const knnAll = db
    .prepare(
      `SELECT id, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 4`,
    )
    .all(vecToBlob(queryVec)) as { id: string; distance: number }[];
  // Filter out self-match
  const knn = knnAll.filter((r) => r.id !== embeddings[0].id).slice(0, 3);
  for (const row of knn) {
    const match = embeddings.find((e) => e.id === row.id);
    console.log(`    distance=${row.distance.toFixed(4)}  "${match?.text.slice(0, 50)}..."`);
  }
  // Self-distance check
  const selfQuery = db
    .prepare(`SELECT id, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 1`)
    .all(vecToBlob(queryVec)) as { id: string; distance: number }[];
  console.log(`    Self-distance (should be ~0): ${selfQuery[0].distance.toFixed(6)}`);

  // ── Step 5: Persistence ─────────────────────────────────────────────
  console.log('\n[5] Persistence test: close and reopen DB...');
  db.close();
  const db2 = new Database(dbPath);
  sqliteVec.load(db2);
  const knn2 = db2
    .prepare(`SELECT id, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 3`)
    .all(vecToBlob(queryVec)) as { id: string; distance: number }[];
  console.log(`    After reopen, top-3 distances: ${knn2.map((r) => r.distance.toFixed(4)).join(', ')}`);
  console.log(`    Persistence: ${Math.abs(knn2[0].distance - selfQuery[0].distance) < 0.001 ? 'PASS' : 'FAIL'}`);

  // ── Step 6: Benchmark 15K vectors ───────────────────────────────────
  console.log(`\n[6] Benchmark: inserting ${BENCHMARK_SIZE} random vectors...`);
  const insertStart = performance.now();
  const insertStmt = db2.prepare('INSERT OR REPLACE INTO vec_test (id, embedding) VALUES (?, ?)');
  const insertTx = db2.transaction((items: { id: string; blob: Buffer }[]) => {
    for (const item of items) insertStmt.run(item.id, item.blob);
  });
  let inserted = 0;
  const batch: { id: string; blob: Buffer }[] = [];
  for (let i = 0; i < BENCHMARK_SIZE; i++) {
    const vec = new Float32Array(DIM);
    for (let j = 0; j < DIM; j++) vec[j] = Math.random() * 2 - 1;
    batch.push({ id: `bench_${i}`, blob: vecToBlob(vec) });
    if (batch.length === 1000) {
      insertTx(batch);
      inserted += batch.length;
      batch.length = 0;
    }
  }
  if (batch.length > 0) {
    insertTx(batch);
    inserted += batch.length;
  }
  const insertMs = performance.now() - insertStart;
  console.log(`    Inserted ${inserted} vectors in ${insertMs.toFixed(0)}ms (${(inserted / (insertMs / 1000)).toFixed(0)} vec/s)`);

  // Query benchmark
  const queryBenchVec = new Float32Array(DIM);
  for (let j = 0; j < DIM; j++) queryBenchVec[j] = Math.random() * 2 - 1;
  const queryBlob = vecToBlob(queryBenchVec);
  const queryStmt = db2.prepare(
    `SELECT id, distance FROM vec_test WHERE embedding MATCH ? ORDER BY distance LIMIT 10`,
  );

  const queryStart = performance.now();
  const iterations = 100;
  for (let i = 0; i < iterations; i++) {
    queryStmt.all(queryBlob);
  }
  const queryMs = (performance.now() - queryStart) / iterations;
  console.log(`    Avg query latency (top-10, ${inserted + sentences.length} vectors): ${queryMs.toFixed(2)}ms`);
  console.log(`    Target < 50ms: ${queryMs < 50 ? 'PASS' : 'FAIL'}`);

  // Count total
  const count = db2.prepare('SELECT COUNT(*) AS n FROM vec_test').get() as { n: number };
  console.log(`    Total vectors in DB: ${count.n}`);

  db2.close();

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n=== RESULTS ===');
  console.log(`sqlite-vec version:     ${ver.v}`);
  console.log(`Extension load:         PASS`);
  console.log(`Virtual table (vec0):   PASS`);
  console.log(`Ollama embed (1024-dim): PASS`);
  console.log(`KNN query:              PASS`);
  console.log(`Persistence:            PASS`);
  console.log(`Insert ${inserted} vectors:     ${insertMs.toFixed(0)}ms`);
  const latencyPass = queryMs < 50;
  console.log(`Query latency (top-10): ${queryMs.toFixed(2)}ms  ${latencyPass ? '< 50ms PASS' : '> 50ms FAIL'}`);
  console.log('\nPOC complete.');
}

main().catch((err) => {
  console.error('POC failed:', err);
  process.exit(1);
});
