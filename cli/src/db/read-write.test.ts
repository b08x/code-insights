import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createTestDb, makeParsedSession, makeParsedMessage } from '../__fixtures__/db/seed.js';

// ──────────────────────────────────────────────────────
// Module-scoped mutable DB reference.
//
// vi.mock() is hoisted above imports, so the mock factory runs
// at module-evaluation time. We use a module-scoped variable
// that beforeEach updates, and the mocked getDb() reads via
// closure at call time (not capture time).
// ──────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('./client.js', () => ({
  getDb: () => testDb,
  closeDb: () => {},
  getDbPath: () => ':memory:',
}));

vi.mock('../utils/device.js', () => ({
  getDeviceId: () => 'test-device-id',
  getDeviceInfo: () => ({
    deviceId: 'test-device',
    hostname: 'test-host',
    platform: 'darwin',
    username: 'testuser',
  }),
  generateStableProjectId: (path: string) => ({
    projectId: 'proj-' + path.split('/').pop(),
    source: 'path-hash' as const,
    gitRemoteUrl: null,
  }),
  getGitRemoteUrl: () => null,
}));

// Dynamic imports AFTER mocks are declared — vitest hoists vi.mock()
// above these imports, so the modules receive the mocked dependencies.
const { sessionExists, getSessions, getProjects } = await import('./read.js');
const { insertSessionWithProject, insertMessages } = await import('./write.js');

// ──────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────

describe('Database read/write operations', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  // ────────────────────────────────────────────────────
  // insertSessionWithProject + sessionExists
  // ────────────────────────────────────────────────────

  describe('insertSessionWithProject', () => {
    it('inserts a session that can be verified with sessionExists', () => {
      const session = makeParsedSession();
      insertSessionWithProject(session);

      expect(sessionExists(session.id)).toBe(true);
    });

    it('returns false from sessionExists for unknown session IDs', () => {
      expect(sessionExists('nonexistent-id')).toBe(false);
    });

    it('upserts without error when inserting the same session twice', () => {
      const session = makeParsedSession();
      insertSessionWithProject(session);
      expect(() => insertSessionWithProject(session)).not.toThrow();

      // Still exactly one session row
      const sessions = getSessions();
      expect(sessions).toHaveLength(1);
    });

    it('inserts the project record alongside the session', () => {
      const session = makeParsedSession({ projectName: 'alpha-project' });
      insertSessionWithProject(session);

      const projects = getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].name).toBe('alpha-project');
      expect(projects[0].session_count).toBe(1);
    });

    it('increments project session_count for new sessions', () => {
      const s1 = makeParsedSession({ id: 'session-001' });
      const s2 = makeParsedSession({ id: 'session-002' });

      insertSessionWithProject(s1);
      insertSessionWithProject(s2);

      const projects = getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0].session_count).toBe(2);
    });
  });

  // ────────────────────────────────────────────────────
  // getSessions
  // ────────────────────────────────────────────────────

  describe('getSessions', () => {
    it('returns inserted sessions with correct field mapping', () => {
      const session = makeParsedSession({
        id: 'sess-abc',
        projectName: 'test-proj',
        messageCount: 10,
        userMessageCount: 5,
        assistantMessageCount: 5,
        toolCallCount: 3,
        sourceTool: 'claude-code',
        generatedTitle: 'My Title',
        sessionCharacter: 'bug_hunt',
      });

      insertSessionWithProject(session);

      const rows = getSessions();
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.id).toBe('sess-abc');
      expect(row.projectName).toBe('test-proj');
      expect(row.messageCount).toBe(10);
      expect(row.userMessageCount).toBe(5);
      expect(row.assistantMessageCount).toBe(5);
      expect(row.toolCallCount).toBe(3);
      expect(row.sourceTool).toBe('claude-code');
      expect(row.generatedTitle).toBe('My Title');
      expect(row.sessionCharacter).toBe('bug_hunt');
    });

    it('returns sessions ordered by started_at descending', () => {
      const earlier = makeParsedSession({
        id: 'session-earlier',
        startedAt: new Date('2025-06-14T09:00:00Z'),
        endedAt: new Date('2025-06-14T10:00:00Z'),
      });
      const later = makeParsedSession({
        id: 'session-later',
        startedAt: new Date('2025-06-15T09:00:00Z'),
        endedAt: new Date('2025-06-15T10:00:00Z'),
      });

      insertSessionWithProject(earlier);
      insertSessionWithProject(later);

      const rows = getSessions();
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('session-later');
      expect(rows[1].id).toBe('session-earlier');
    });

    it('filters sessions by sourceTool', () => {
      const claude = makeParsedSession({ id: 'sess-claude', sourceTool: 'claude-code' });
      const cursor = makeParsedSession({ id: 'sess-cursor', sourceTool: 'cursor' });

      insertSessionWithProject(claude);
      insertSessionWithProject(cursor);

      const claudeOnly = getSessions({ sourceTool: 'claude-code' });
      expect(claudeOnly).toHaveLength(1);
      expect(claudeOnly[0].id).toBe('sess-claude');

      const cursorOnly = getSessions({ sourceTool: 'cursor' });
      expect(cursorOnly).toHaveLength(1);
      expect(cursorOnly[0].id).toBe('sess-cursor');
    });

    it('filters sessions by periodStart', () => {
      const old = makeParsedSession({
        id: 'sess-old',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        endedAt: new Date('2025-01-01T01:00:00Z'),
      });
      const recent = makeParsedSession({
        id: 'sess-recent',
        startedAt: new Date('2025-06-15T00:00:00Z'),
        endedAt: new Date('2025-06-15T01:00:00Z'),
      });

      insertSessionWithProject(old);
      insertSessionWithProject(recent);

      const filtered = getSessions({ periodStart: new Date('2025-06-01T00:00:00Z') });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('sess-recent');
    });

    it('returns empty array when no sessions exist', () => {
      const rows = getSessions();
      expect(rows).toEqual([]);
    });

    it('maps usage fields correctly when present', () => {
      const session = makeParsedSession({
        id: 'sess-usage',
        usage: {
          totalInputTokens: 1000,
          totalOutputTokens: 2000,
          cacheCreationTokens: 300,
          cacheReadTokens: 400,
          estimatedCostUsd: 0.05,
          modelsUsed: ['claude-3-opus', 'claude-3-sonnet'],
          primaryModel: 'claude-3-opus',
          usageSource: 'jsonl',
        },
      });

      insertSessionWithProject(session);

      const rows = getSessions();
      expect(rows).toHaveLength(1);

      const row = rows[0];
      expect(row.totalInputTokens).toBe(1000);
      expect(row.totalOutputTokens).toBe(2000);
      expect(row.cacheCreationTokens).toBe(300);
      expect(row.cacheReadTokens).toBe(400);
      expect(row.estimatedCostUsd).toBe(0.05);
      expect(row.primaryModel).toBe('claude-3-opus');
      expect(row.modelsUsed).toEqual(['claude-3-opus', 'claude-3-sonnet']);
      expect(row.usageSource).toBe('jsonl');
    });

    it('returns undefined for optional usage fields when not present', () => {
      const session = makeParsedSession({ id: 'sess-no-usage' });
      // no usage set
      insertSessionWithProject(session);

      const rows = getSessions();
      const row = rows[0];

      expect(row.totalInputTokens).toBeUndefined();
      expect(row.totalOutputTokens).toBeUndefined();
      expect(row.estimatedCostUsd).toBeUndefined();
      expect(row.primaryModel).toBeUndefined();
      expect(row.modelsUsed).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────
  // getProjects
  // ────────────────────────────────────────────────────

  describe('getProjects', () => {
    it('returns inserted projects with correct fields', () => {
      insertSessionWithProject(makeParsedSession({ projectName: 'my-app' }));

      const projects = getProjects();
      expect(projects).toHaveLength(1);
      expect(projects[0]).toEqual(
        expect.objectContaining({
          name: 'my-app',
          session_count: 1,
        }),
      );
      expect(projects[0].id).toBeDefined();
      expect(projects[0].path).toBeDefined();
      expect(projects[0].last_activity).toBeDefined();
    });

    it('returns empty array when no projects exist', () => {
      expect(getProjects()).toEqual([]);
    });

    it('returns projects ordered by last_activity descending', () => {
      const older = makeParsedSession({
        id: 'sess-a',
        projectPath: '/projects/alpha',
        projectName: 'alpha',
        endedAt: new Date('2025-06-10T00:00:00Z'),
      });
      const newer = makeParsedSession({
        id: 'sess-b',
        projectPath: '/projects/beta',
        projectName: 'beta',
        endedAt: new Date('2025-06-15T00:00:00Z'),
      });

      insertSessionWithProject(older);
      insertSessionWithProject(newer);

      const projects = getProjects();
      expect(projects).toHaveLength(2);
      expect(projects[0].name).toBe('beta');
      expect(projects[1].name).toBe('alpha');
    });
  });

  // ────────────────────────────────────────────────────
  // insertMessages
  // ────────────────────────────────────────────────────

  describe('insertMessages', () => {
    it('inserts messages for a session', () => {
      const session = makeParsedSession({
        id: 'sess-msg',
        messages: [
          makeParsedMessage({ id: 'msg-1', sessionId: 'sess-msg', type: 'user', content: 'Hello' }),
          makeParsedMessage({ id: 'msg-2', sessionId: 'sess-msg', type: 'assistant', content: 'Hi there' }),
        ],
      });

      insertSessionWithProject(session);
      insertMessages(session);

      const rows = testDb
        .prepare('SELECT id, session_id, type, content FROM messages WHERE session_id = ? ORDER BY timestamp')
        .all('sess-msg') as Array<{ id: string; session_id: string; type: string; content: string }>;

      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('msg-1');
      expect(rows[0].type).toBe('user');
      expect(rows[0].content).toBe('Hello');
      expect(rows[1].id).toBe('msg-2');
      expect(rows[1].type).toBe('assistant');
      expect(rows[1].content).toBe('Hi there');
    });

    it('is a no-op when session has no messages', () => {
      const session = makeParsedSession({ id: 'sess-empty', messages: [] });
      insertSessionWithProject(session);
      expect(() => insertMessages(session)).not.toThrow();

      const rows = testDb.prepare('SELECT COUNT(*) AS cnt FROM messages').get() as { cnt: number };
      expect(rows.cnt).toBe(0);
    });

    it('ignores duplicate message IDs (INSERT OR IGNORE)', () => {
      const msg = makeParsedMessage({ id: 'msg-dup', sessionId: 'sess-dup' });
      const session = makeParsedSession({ id: 'sess-dup', messages: [msg] });

      insertSessionWithProject(session);
      insertMessages(session);
      // Insert again — should not throw or duplicate
      expect(() => insertMessages(session)).not.toThrow();

      const rows = testDb
        .prepare('SELECT COUNT(*) AS cnt FROM messages WHERE id = ?')
        .get('msg-dup') as { cnt: number };
      expect(rows.cnt).toBe(1);
    });

    it('stores tool_calls as JSON when present', () => {
      const msg = makeParsedMessage({
        id: 'msg-tools',
        sessionId: 'sess-tools',
        type: 'assistant',
        toolCalls: [{ id: 'tc-1', name: 'Read', input: { file_path: '/test.ts' } }],
      });
      const session = makeParsedSession({ id: 'sess-tools', messages: [msg] });

      insertSessionWithProject(session);
      insertMessages(session);

      const row = testDb
        .prepare('SELECT tool_calls FROM messages WHERE id = ?')
        .get('msg-tools') as { tool_calls: string | null };

      expect(row.tool_calls).not.toBeNull();
      const parsed = JSON.parse(row.tool_calls!);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe('Read');
    });

    it('stores thinking content when present', () => {
      const msg = makeParsedMessage({
        id: 'msg-think',
        sessionId: 'sess-think',
        type: 'assistant',
        thinking: 'Let me consider the options...',
      });
      const session = makeParsedSession({ id: 'sess-think', messages: [msg] });

      insertSessionWithProject(session);
      insertMessages(session);

      const row = testDb
        .prepare('SELECT thinking FROM messages WHERE id = ?')
        .get('msg-think') as { thinking: string | null };

      expect(row.thinking).toBe('Let me consider the options...');
    });
  });
});
