import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, makeParsedSession } from '../../__fixtures__/db/seed.js';

let testDb: Database.Database;

vi.mock('../../db/client.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getDbPath: () => ':memory:',
}));

// Mock telemetry to avoid errors
vi.mock('../../utils/telemetry.js', () => ({
  trackEvent: vi.fn(),
  identifyUser: vi.fn(),
  captureError: vi.fn(),
  classifyError: vi.fn(),
}));

const { getTrivialSessions, pruneTrivialSessions } = await import('../sync.js');
const { insertSessionWithProject } = await import('../../db/write.js');

describe('sync prune logic', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  it('getTrivialSessions returns sessions with messageCount <= 2', () => {
    // Insert a trivial session
    const trivial = makeParsedSession({
      id: 'trivial-1',
      messageCount: 2,
      generatedTitle: 'Trivial Session',
      projectName: 'project-a'
    });
    insertSessionWithProject(trivial);

    // Insert a non-trivial session
    const nonTrivial = makeParsedSession({
      id: 'nontrivial-1',
      messageCount: 5,
      generatedTitle: 'Big Session',
      projectName: 'project-a'
    });
    insertSessionWithProject(nonTrivial);

    const sessions = getTrivialSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('trivial-1');
    expect(sessions[0].title).toBe('Trivial Session');
  });

  it('getTrivialSessions excludes antigravity sessions even if low message count', () => {
    const antigravity = makeParsedSession({
      id: 'ag-1',
      messageCount: 2,
      sourceTool: 'antigravity',
      generatedTitle: 'Antigravity Session'
    });
    insertSessionWithProject(antigravity);

    const sessions = getTrivialSessions();
    // Should still only have 'trivial-1' if inserted in previous test, 
    // but beforeEach clears the DB, so it should be 0 here if only ag-1 is inserted.
    expect(sessions.find(s => s.id === 'ag-1')).toBeUndefined();
  });

  it('getTrivialSessions respects custom_title over generated_title', () => {
    const session = makeParsedSession({
      id: 'session-custom',
      messageCount: 1,
      generatedTitle: 'Generated',
      projectName: 'project-a'
    });
    insertSessionWithProject(session);
    
    // Manually set custom_title since makeParsedSession doesn't have it (or check if it does)
    testDb.prepare('UPDATE sessions SET custom_title = ? WHERE id = ?').run('Custom Title', 'session-custom');

    const sessions = getTrivialSessions();
    expect(sessions[0].title).toBe('Custom Title');
  });

  it('pruneTrivialSessions soft-deletes sessions', () => {
    const trivial = makeParsedSession({ id: 't1', messageCount: 1 });
    insertSessionWithProject(trivial);

    const sessionsBefore = getTrivialSessions();
    expect(sessionsBefore).toHaveLength(1);

    const result = pruneTrivialSessions(['t1']);
    expect(result.deleted).toBe(1);

    const sessionsAfter = getTrivialSessions();
    expect(sessionsAfter).toHaveLength(0);

    // Verify it's still in DB but has deleted_at set
    const row = testDb.prepare('SELECT deleted_at FROM sessions WHERE id = ?').get('t1') as { deleted_at: string | null };
    expect(row.deleted_at).not.toBeNull();
  });
});
