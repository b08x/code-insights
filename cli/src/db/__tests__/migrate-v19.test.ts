import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../schema.js';

const cols = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>);

const insertLabel = (db: Database.Database, id: string, split = 'train') =>
  db.prepare(
    `INSERT INTO session_labels (session_id, outcome, split) VALUES (?, 'high', ?)`
  ).run(id, split);

describe('SQLite Migration v19: session_labels', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('CURRENT_SCHEMA_VERSION is >= 19', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(19);
  });

  it('creates session_labels with the label-2 columns on a fresh database', () => {
    const result = runMigrations(db);
    expect(result.v19Applied).toBe(true);
    const names = cols(db, 'session_labels').map(c => c.name);
    expect(names).toEqual([
      'session_id', 'target', 'outcome', 'friction_categories_json', 'pattern_categories_json',
      'key_points_json', 'forbidden_claims_json', 'note', 'split', 'created_at', 'updated_at', 'deleted_at',
    ]);
  });

  it('migrates a v18 database without touching existing rows', () => {
    runMigrations(db);
    db.exec(`
      DROP TRIGGER IF EXISTS session_labels_split_immutable;
      DROP TRIGGER IF EXISTS session_labels_no_delete;
      DROP TABLE session_labels;
      INSERT INTO projects (id, name, path, last_activity) VALUES ('p1','P','/p','2026-01-01');
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s1','p1','P','/p','2026-01-01','2026-01-01');
      DELETE FROM schema_version WHERE version >= 19;
    `);
    const result = runMigrations(db);
    expect(result.v19Applied).toBe(true);
    expect(result.v18Applied).toBe(false);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(() => insertLabel(db, 's1')).not.toThrow();
  });

  it('is idempotent', () => {
    runMigrations(db);
    expect(runMigrations(db).v19Applied).toBe(false);
    db.prepare('DELETE FROM schema_version WHERE version = 19').run();
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('applies column defaults', () => {
    runMigrations(db);
    insertLabel(db, 's1');
    const row = db.prepare('SELECT * FROM session_labels WHERE session_id = ?').get('s1') as Record<string, unknown>;
    expect(row.target).toBe('session-analysis');
    expect(row.friction_categories_json).toBe('[]');
    expect(row.pattern_categories_json).toBe('[]');
    expect(row.key_points_json).toBe('[]');
    expect(row.forbidden_claims_json).toBe('[]');
    expect(row.note).toBeNull();
    expect(row.deleted_at).toBeNull();
    expect(typeof row.created_at).toBe('string');
  });

  it('rejects a split outside train/validation/test', () => {
    runMigrations(db);
    expect(() => insertLabel(db, 's1', 'holdout')).toThrow();
  });

  it('makes split immutable on UPDATE but allows other columns to change', () => {
    runMigrations(db);
    insertLabel(db, 's1', 'validation');
    expect(() => db.prepare(`UPDATE session_labels SET split = 'test' WHERE session_id = 's1'`).run()).toThrow(/immutable/);
    db.prepare(`UPDATE session_labels SET outcome = 'low', split = 'validation' WHERE session_id = 's1'`).run();
    const row = db.prepare('SELECT outcome, split FROM session_labels').get();
    expect(row).toEqual({ outcome: 'low', split: 'validation' });
  });

  it('aborts hard DELETE so a split can never be re-rolled (labels are soft-deleted)', () => {
    runMigrations(db);
    insertLabel(db, 's1', 'test');
    expect(() => db.prepare(`DELETE FROM session_labels WHERE session_id = 's1'`).run()).toThrow(/soft-delete/);
    db.prepare(`UPDATE session_labels SET deleted_at = datetime('now') WHERE session_id = 's1'`).run();
    expect(db.prepare('SELECT split FROM session_labels').get()).toEqual({ split: 'test' });
  });
});
