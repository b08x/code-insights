import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../schema.js';

describe('SQLite Migration v16: deleted_sessions Table', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is 16', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(16);
  });

  it('creates deleted_sessions table and schema_version reaches 16 on fresh database', () => {
    const result = runMigrations(db);
    expect(result.v16Applied).toBe(true);

    const versionRow = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(versionRow.v).toBe(16);

    const tableInfo = db.prepare('PRAGMA table_info(deleted_sessions)').all() as Array<{ name: string; type: string; pk: number }>;
    const colNames = tableInfo.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('deleted_at');
    expect(colNames).toContain('reason');

    const idCol = tableInfo.find(c => c.name === 'id');
    expect(idCol?.pk).toBe(1);
  });

  it('migrates existing v15 database to v16 cleanly', () => {
    // Run up to v15
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);');
    for (let i = 1; i <= 15; i++) {
      db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(i);
    }
    // Minimal tables needed
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, last_activity TEXT);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, project_id TEXT, project_name TEXT, project_path TEXT, started_at TEXT, ended_at TEXT);
    `);

    const result = runMigrations(db);
    expect(result.v16Applied).toBe(true);

    const versionRow = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
    expect(versionRow.v).toBe(16);

    // Verify deleted_sessions table was created
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='deleted_sessions'").all();
    expect(tables).toHaveLength(1);
  });
});
