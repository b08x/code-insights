import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../schema.js';

const cols = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; dflt_value: string | null }>);

describe('SQLite Migration v18: analysis provenance columns', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('CURRENT_SCHEMA_VERSION is >= 18', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(18);
  });

  it('adds nullable student_identity and prompt_version_id to insights and session_facets on a fresh database', () => {
    const result = runMigrations(db);
    expect(result.v18Applied).toBe(true);
    for (const table of ['insights', 'session_facets']) {
      const columns = cols(db, table);
      for (const name of ['student_identity', 'prompt_version_id']) {
        const col = columns.find(c => c.name === name);
        expect(col, `${table}.${name}`).toBeDefined();
        expect(col!.notnull).toBe(0);
        expect(col!.dflt_value).toBeNull();
      }
    }
  });

  it('migrates a v17 database: existing rows survive with NULL provenance', () => {
    // A v17 fixture: the real v1..v17 schema, one analyzed session, then roll the version back.
    runMigrations(db);
    db.exec(`
      DROP TABLE insights; DROP TABLE session_facets;
      CREATE TABLE insights (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL, project_name TEXT NOT NULL,
        type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, bullets TEXT,
        confidence REAL NOT NULL, source TEXT NOT NULL DEFAULT 'llm', metadata TEXT, timestamp TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), scope TEXT NOT NULL DEFAULT 'session',
        analysis_version TEXT NOT NULL DEFAULT '1.0.0', linked_insight_ids TEXT,
        embedding_status TEXT NOT NULL DEFAULT 'pending'
      );
      CREATE TABLE session_facets (
        session_id TEXT PRIMARY KEY, outcome_satisfaction TEXT NOT NULL, workflow_pattern TEXT,
        had_course_correction INTEGER NOT NULL DEFAULT 0, course_correction_reason TEXT,
        iteration_count INTEGER NOT NULL DEFAULT 0, friction_points TEXT, effective_patterns TEXT,
        extracted_at TEXT NOT NULL DEFAULT (datetime('now')), analysis_version TEXT NOT NULL DEFAULT '1.0.0'
      );
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, timestamp, analysis_version)
        VALUES ('i1','s1','p1','P','summary','t','c','c',0.9,'2026-01-01','3.1.0');
      INSERT INTO session_facets (session_id, outcome_satisfaction, analysis_version) VALUES ('s1','high','3.1.0');
      DELETE FROM schema_version WHERE version >= 18;
    `);
    expect(cols(db, 'insights').some(c => c.name === 'student_identity')).toBe(false);

    const result = runMigrations(db);
    expect(result.v18Applied).toBe(true);
    expect(result.v17Applied).toBe(false);

    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT id, analysis_version, student_identity, prompt_version_id FROM insights').all())
      .toEqual([{ id: 'i1', analysis_version: '3.1.0', student_identity: null, prompt_version_id: null }]);
    expect(db.prepare('SELECT session_id, student_identity, prompt_version_id FROM session_facets').all())
      .toEqual([{ session_id: 's1', student_identity: null, prompt_version_id: null }]);
  });

  it('is idempotent and tolerates columns that already exist', () => {
    runMigrations(db);
    expect(runMigrations(db).v18Applied).toBe(false);
    db.prepare('DELETE FROM schema_version WHERE version = 18').run();
    expect(() => runMigrations(db)).not.toThrow();
  });
});
