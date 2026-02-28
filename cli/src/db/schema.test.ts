import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL, CURRENT_SCHEMA_VERSION } from './schema.js';
import { runMigrations } from './migrate.js';

// ──────────────────────────────────────────────────────
// Schema SQL tests
// ──────────────────────────────────────────────────────

describe('SCHEMA_SQL', () => {
  it('executes without errors on a fresh database', () => {
    const db = new Database(':memory:');
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
    db.close();
  });

  it('creates all expected tables', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('insights');
    expect(tableNames).toContain('usage_stats');

    db.close();
  });

  it('is idempotent — executing twice does not error (IF NOT EXISTS)', () => {
    const db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    expect(() => db.exec(SCHEMA_SQL)).not.toThrow();
    db.close();
  });
});

describe('CURRENT_SCHEMA_VERSION', () => {
  it('is a positive integer', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThan(0);
    expect(Number.isInteger(CURRENT_SCHEMA_VERSION)).toBe(true);
  });
});

// ──────────────────────────────────────────────────────
// Migration tests
// ──────────────────────────────────────────────────────

describe('runMigrations', () => {
  it('applies on a fresh database without error', () => {
    const db = new Database(':memory:');
    expect(() => runMigrations(db)).not.toThrow();
    db.close();
  });

  it('creates the schema_version table', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'")
      .all() as Array<{ name: string }>;

    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('schema_version');

    db.close();
  });

  it('creates all data tables via migration', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;

    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('projects');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('insights');
    expect(tableNames).toContain('usage_stats');
    expect(tableNames).toContain('schema_version');

    db.close();
  });

  it('sets version to CURRENT_SCHEMA_VERSION', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const row = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null };
    expect(row.v).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('is idempotent — running twice does not error', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    db.close();
  });

  it('is idempotent — running twice does not duplicate the version row', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    runMigrations(db);

    const rows = db.prepare('SELECT * FROM schema_version').all();
    expect(rows).toHaveLength(1);

    db.close();
  });

  it('creates expected indexes on sessions table', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);

    expect(indexNames).toContain('idx_sessions_project_id');
    expect(indexNames).toContain('idx_sessions_started_at');
    expect(indexNames).toContain('idx_sessions_source_tool');

    db.close();
  });
});
