import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../schema.js';

function freshDb(): Database.Database {
  return new Database(':memory:');
}

describe('runMigrations — V11 embedding schema', () => {
  it('CURRENT_SCHEMA_VERSION is >= 11', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
  });

  it('sets v11Applied on fresh database', () => {
    const db = freshDb();
    const result = runMigrations(db);
    expect(result.v11Applied).toBe(true);
    db.close();
  });

  it('v11Applied is false on re-run (already applied)', () => {
    const db = freshDb();
    runMigrations(db);
    const result = runMigrations(db);
    expect(result.v11Applied).toBe(false);
    db.close();
  });

  it('creates embedding_status column on insights table', () => {
    const db = freshDb();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(insights)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'embedding_status')).toBe(true);
    db.close();
  });

  it('creates embedding_status column on messages table', () => {
    const db = freshDb();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    expect(cols.some(c => c.name === 'embedding_status')).toBe(true);
    db.close();
  });

  it('embedding_status defaults to pending for insights', () => {
    const db = freshDb();
    runMigrations(db);

    // Insert a minimal insight row (skip embedding_status to test DEFAULT)
    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p1', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s1', 'p1', 'test', '/test', datetime('now'), datetime('now'));
    `);
    db.prepare(`
      INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, timestamp, scope, analysis_version)
        VALUES ('i1', 's1', 'p1', 'test', 'summary', 'Test', 'Test content', 'Test summary', 0.9, 'llm', datetime('now'), 'session', '1.0.0')
    `).run();

    const row = db.prepare('SELECT embedding_status FROM insights WHERE id = ?').get('i1') as { embedding_status: string };
    expect(row.embedding_status).toBe('pending');
    db.close();
  });

  it('embedding_status defaults to pending for messages', () => {
    const db = freshDb();
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p2', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s2', 'p2', 'test', '/test', datetime('now'), datetime('now'));
    `);
    db.prepare(`
      INSERT INTO messages (id, session_id, type, content, timestamp)
        VALUES ('m1', 's2', 'user', 'hello', datetime('now'))
    `).run();

    const row = db.prepare('SELECT embedding_status FROM messages WHERE id = ?').get('m1') as { embedding_status: string };
    expect(row.embedding_status).toBe('pending');
    db.close();
  });

  it('creates embedding_metadata table with correct columns', () => {
    const db = freshDb();
    runMigrations(db);

    const cols = db.prepare("PRAGMA table_info(embedding_metadata)").all() as Array<{ name: string; type: string }>;
    const colNames = cols.map(c => c.name);

    expect(colNames).toContain('id');
    expect(colNames).toContain('entity_type');
    expect(colNames).toContain('model');
    expect(colNames).toContain('dim');
    expect(colNames).toContain('source_text');
    expect(colNames).toContain('created_at');
    expect(colNames).toContain('updated_at');
    db.close();
  });

  it('embedding_metadata entity_type CHECK constraint rejects invalid values', () => {
    const db = freshDb();
    runMigrations(db);

    expect(() => {
      db.prepare(`
        INSERT INTO embedding_metadata (id, entity_type, model, dim, source_text)
          VALUES ('em1', 'invalid', 'test-model', 768, 'test')
      `).run();
    }).toThrow();
    db.close();
  });

  it('embedding_metadata accepts valid entity_type values', () => {
    const db = freshDb();
    runMigrations(db);

    const insert = db.prepare(`
      INSERT INTO embedding_metadata (id, entity_type, model, dim, source_text)
        VALUES (?, ?, ?, 768, 'test')
    `);
    expect(() => insert.run('em1', 'insight', 'test-model')).not.toThrow();
    expect(() => insert.run('em2', 'message', 'test-model')).not.toThrow();
    db.close();
  });

  it('creates indexes on embedding_metadata', () => {
    const db = freshDb();
    runMigrations(db);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_embedding_metadata%'").all() as Array<{ name: string }>;
    const names = indexes.map(i => i.name);
    expect(names).toContain('idx_embedding_metadata_type');
    expect(names).toContain('idx_embedding_metadata_model');
    db.close();
  });

  it('creates index on insights embedding_status', () => {
    const db = freshDb();
    runMigrations(db);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_insights_embedding_status'").all();
    expect(indexes.length).toBe(1);
    db.close();
  });

  it('creates index on messages embedding_status', () => {
    const db = freshDb();
    runMigrations(db);

    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_messages_embedding_status'").all();
    expect(indexes.length).toBe(1);
    db.close();
  });

  it('embedding_status CHECK constraint rejects invalid states', () => {
    const db = freshDb();
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
        VALUES ('p3', 'test', '/test', datetime('now'));
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s3', 'p3', 'test', '/test', datetime('now'), datetime('now'));
    `);

    expect(() => {
      db.prepare(`
        INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, timestamp, scope, analysis_version, embedding_status)
          VALUES ('i1', 's3', 'p3', 'test', 'summary', 'Test', 'Test', 'Test', 0.9, 'llm', datetime('now'), 'session', '1.0.0', 'invalid')
      `).run();
    }).toThrow();
    db.close();
  });
});
