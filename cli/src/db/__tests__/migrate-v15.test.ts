import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';

describe('Migration v15: session_steps table', () => {
  it('applies v15 migration on fresh database', () => {
    const db = new Database(':memory:');
    const result = runMigrations(db);

    expect(result.v15Applied).toBe(true);

    const versionRow = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number };
    expect(versionRow.version).toBeGreaterThanOrEqual(15);

    // Verify session_steps table exists
    const tableInfo = db.prepare("PRAGMA table_info('session_steps')").all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>;

    expect(tableInfo.length).toBeGreaterThan(0);
    const columns = tableInfo.map(c => c.name);
    expect(columns).toContain('session_id');
    expect(columns).toContain('idx');
    expect(columns).toContain('turn_ref');
    expect(columns).toContain('label');
    expect(columns).toContain('driver');
    expect(columns).toContain('target');
    expect(columns).toContain('state');
    expect(columns).toContain('targets');
    expect(columns).toContain('has_course_correction');
    expect(columns).toContain('ran_tests');
    expect(columns).toContain('used_tools');
    expect(columns).toContain('created_at');

    // Verify primary key is (session_id, idx)
    const pkColumns = tableInfo.filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
    expect(pkColumns).toEqual(['session_id', 'idx']);

    // Verify indexes exist
    const indexes = db.prepare("PRAGMA index_list('session_steps')").all() as Array<{ name: string }>;
    const indexNames = indexes.map(i => i.name);
    expect(indexNames).toContain('idx_session_steps_session_id');
    expect(indexNames).toContain('idx_session_steps_driver');
    expect(indexNames).toContain('idx_session_steps_state');
  });

  it('migrates from v14 to v15 seamlessly', () => {
    const db = new Database(':memory:');
    // Setup schema up to v14
    db.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')));
      INSERT INTO schema_version (version) VALUES (14);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, last_activity TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), project_name TEXT, project_path TEXT, started_at TEXT, ended_at TEXT);
    `);

    const result = runMigrations(db);
    expect(result.v15Applied).toBe(true);

    const versionRow = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as { version: number };
    expect(versionRow.version).toBeGreaterThanOrEqual(15);

    // Seed session
    db.prepare('INSERT INTO projects (id, name, path, last_activity) VALUES (?, ?, ?, ?)').run('proj-001', 'Test', '/path', '2026-01-01');
    db.prepare('INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      'sess-001',
      'proj-001',
      'Test',
      '/path',
      '2026-01-01T00:00:00Z',
      '2026-01-01T01:00:00Z',
    );

    // Can insert into session_steps
    db.prepare(`
      INSERT INTO session_steps (session_id, idx, turn_ref, label, driver, target, state, targets, has_course_correction, ran_tests, used_tools)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'sess-001',
      0,
      'User#1',
      'Initial setup',
      'User_Decide',
      'Target_Config',
      'State_Success',
      JSON.stringify(['Target_Config', 'Target_Test']),
      1,
      1,
      0,
    );

    const row = db.prepare('SELECT * FROM session_steps WHERE session_id = ?').get('sess-001') as any;
    expect(row).toBeDefined();
    expect(row.label).toBe('Initial setup');
    expect(row.has_course_correction).toBe(1);
    expect(row.ran_tests).toBe(1);
    expect(row.used_tools).toBe(0);
    expect(JSON.parse(row.targets)).toEqual(['Target_Config', 'Target_Test']);
  });
});
