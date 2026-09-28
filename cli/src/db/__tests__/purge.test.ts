import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { purgeSessions, isSessionTombstoned, unTombstoneSession } from '../purge.js';
import { insertSessionWithProjectAndReturnIsNew, insertMessages } from '../write.js';
import type { ParsedSession } from '../../types.js';

describe('Session Purge and Tombstones', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('p1', 'test-project', '/tmp/test', datetime('now'));

      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, deleted_at)
      VALUES ('s-deleted-1', 'p1', 'test-project', '/tmp/test', datetime('now'), datetime('now'), datetime('now'));

      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, deleted_at)
      VALUES ('s-active', 'p1', 'test-project', '/tmp/test', datetime('now'), datetime('now'), NULL);

      INSERT INTO messages (id, session_id, type, content, timestamp)
      VALUES ('m1', 's-deleted-1', 'user', 'malformed query', datetime('now'));

      INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, timestamp, created_at, scope)
      VALUES ('ins-1', 's-deleted-1', 'p1', 'test-project', 'decision', 'A title', 'content', 'summary', 0.8, 'llm', datetime('now'), datetime('now'), 'session');

      INSERT INTO session_steps (session_id, idx, turn_ref, label, driver, target, state)
      VALUES ('s-deleted-1', 0, 'User#1', 'Step 1', 'User_Decide', 'Target_SrcCode', 'State_Success');
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('purges soft-deleted sessions, removes child records, and records tombstone', () => {
    const result = purgeSessions(db);
    expect(result.purgedCount).toBe(1);
    expect(result.sessionIds).toContain('s-deleted-1');

    // s-deleted-1 is removed from sessions and child tables
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-deleted-1')).toBeUndefined();
    expect(db.prepare('SELECT * FROM messages WHERE session_id = ?').all('s-deleted-1')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM insights WHERE session_id = ?').all('s-deleted-1')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM session_steps WHERE session_id = ?').all('s-deleted-1')).toHaveLength(0);

    // Active session is intact
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-active')).toBeDefined();

    // Tombstone exists
    expect(isSessionTombstoned('s-deleted-1', db)).toBe(true);
    expect(isSessionTombstoned('s-active', db)).toBe(false);

    const tombstone = db.prepare('SELECT * FROM deleted_sessions WHERE id = ?').get('s-deleted-1') as any;
    expect(tombstone).toBeDefined();
    expect(tombstone.reason).toBe('User purged');
  });

  it('respects dryRun flag without mutating database', () => {
    const result = purgeSessions(db, { dryRun: true });
    expect(result.purgedCount).toBe(1);

    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-deleted-1')).toBeDefined();
    expect(isSessionTombstoned('s-deleted-1', db)).toBe(false);
  });

  it('can purge a specific session ID even if deleted_at was not yet set', () => {
    const result = purgeSessions(db, { sessionIds: ['s-active'], reason: 'Targeted purge' });
    expect(result.purgedCount).toBe(1);
    expect(result.sessionIds).toEqual(['s-active']);

    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-active')).toBeUndefined();
    expect(isSessionTombstoned('s-active', db)).toBe(true);
  });

  it('prevents writing session and messages when session is tombstoned', () => {
    purgeSessions(db, { sessionIds: ['s-deleted-1'] });
    expect(isSessionTombstoned('s-deleted-1', db)).toBe(true);

    const fakeSession: ParsedSession = {
      id: 's-deleted-1',
      projectName: 'test-project',
      projectPath: '/tmp/test',
      startedAt: new Date(),
      endedAt: new Date(),
      messageCount: 5,
      userMessageCount: 2,
      assistantMessageCount: 3,
      toolCallCount: 0,
      sourceTool: 'claude-code',
      messages: [
        {
          id: 'new-msg-1',
          sessionId: 's-deleted-1',
          type: 'user',
          content: 'hello again',
          toolCalls: [],
          toolResults: [],
          timestamp: new Date(),
        },
      ],
    };

    // Attempt insert
    const isNew = insertSessionWithProjectAndReturnIsNew(fakeSession, true, db);
    expect(isNew).toBe(false);

    insertMessages(fakeSession, true, db);

    // Verify neither session nor messages were written
    expect(db.prepare('SELECT * FROM sessions WHERE id = ?').get('s-deleted-1')).toBeUndefined();
    expect(db.prepare('SELECT * FROM messages WHERE session_id = ?').all('s-deleted-1')).toHaveLength(0);
  });

  it('allows unTombstoneSession to unblock a session', () => {
    purgeSessions(db, { sessionIds: ['s-deleted-1'] });
    expect(isSessionTombstoned('s-deleted-1', db)).toBe(true);

    const removed = unTombstoneSession('s-deleted-1', db);
    expect(removed).toBe(true);
    expect(isSessionTombstoned('s-deleted-1', db)).toBe(false);
  });
});
