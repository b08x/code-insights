import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../schema.js';

describe('SQLite Migration v17: chat conversation store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('CURRENT_SCHEMA_VERSION is >= 17', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(17);
  });

  it('creates chat tables on a fresh database', () => {
    const result = runMigrations(db);
    expect(result.v17Applied).toBe(true);

    const conv = (db.prepare('PRAGMA table_info(chat_conversations)').all() as Array<{ name: string }>).map(c => c.name);
    expect(conv).toEqual(expect.arrayContaining(['id', 'title', 'created_at', 'updated_at']));

    const msg = (db.prepare('PRAGMA table_info(chat_messages)').all() as Array<{ name: string }>).map(c => c.name);
    expect(msg).toEqual(
      expect.arrayContaining(['id', 'conversation_id', 'role', 'content', 'context_json', 'tool_calls_json', 'created_at']),
    );
  });

  it('migrates an existing v16 database and keeps prior data', () => {
    db.exec('CREATE TABLE schema_version (version INTEGER PRIMARY KEY);');
    for (let i = 1; i <= 16; i++) {
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i);
    }
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT, last_activity TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT, project_name TEXT, project_path TEXT, started_at TEXT, ended_at TEXT);
      INSERT INTO projects (id, name, path, last_activity) VALUES ('p1', 'P', '/p', '2026-01-01');
      CREATE TABLE insights (id TEXT PRIMARY KEY, session_id TEXT);
      CREATE TABLE session_facets (session_id TEXT PRIMARY KEY);
    `);

    const result = runMigrations(db);
    expect(result.v17Applied).toBe(true);
    expect(result.v16Applied).toBe(false);

    const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(v.v).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM projects').get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('chat_conversations','chat_messages')").all()).toHaveLength(2);
  });

  it('deletes messages when a conversation is deleted (cascade)', () => {
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare("INSERT INTO chat_conversations (id, title) VALUES ('c1', 't')").run();
    db.prepare("INSERT INTO chat_messages (id, conversation_id, role, content) VALUES ('m1','c1','user','hi')").run();
    db.prepare("DELETE FROM chat_conversations WHERE id = 'c1'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get()).toEqual({ n: 0 });
  });

  it('is idempotent', () => {
    runMigrations(db);
    const second = runMigrations(db);
    expect(second.v17Applied).toBe(false);
  });
});
