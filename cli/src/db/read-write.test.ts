import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
const { sessionExists, getSessions, getProjects, getLastSession, getSessionCount, getProjectList } = await import('./read.js');
const { insertSessionWithProject, insertMessages } = await import('./write.js');

// ──────────────────────────────────────────────────────
// Test suite
// ──────────────────────────────────────────────────────

describe('Database read/write operations', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  afterEach(() => {
    testDb.close();
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

  // ────────────────────────────────────────────────────
  // getLastSession
  // ────────────────────────────────────────────────────

  describe('getLastSession', () => {
    it('returns null when no sessions exist', () => {
      expect(getLastSession()).toBeNull();
    });

    it('returns the most recent session', () => {
      const older = makeParsedSession({
        id: 'sess-older',
        startedAt: new Date('2025-06-10T09:00:00Z'),
        endedAt: new Date('2025-06-10T10:00:00Z'),
      });
      const newer = makeParsedSession({
        id: 'sess-newer',
        startedAt: new Date('2025-06-15T09:00:00Z'),
        endedAt: new Date('2025-06-15T10:00:00Z'),
      });

      insertSessionWithProject(older);
      insertSessionWithProject(newer);

      const result = getLastSession();
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-newer');
    });

    it('filters by sourceTool', () => {
      const claude = makeParsedSession({
        id: 'sess-last-claude',
        sourceTool: 'claude-code',
        startedAt: new Date('2025-06-15T09:00:00Z'),
        endedAt: new Date('2025-06-15T10:00:00Z'),
      });
      const cursor = makeParsedSession({
        id: 'sess-last-cursor',
        sourceTool: 'cursor',
        startedAt: new Date('2025-06-16T09:00:00Z'),
        endedAt: new Date('2025-06-16T10:00:00Z'),
      });

      insertSessionWithProject(claude);
      insertSessionWithProject(cursor);

      const claudeResult = getLastSession({ sourceTool: 'claude-code' });
      expect(claudeResult).not.toBeNull();
      expect(claudeResult!.id).toBe('sess-last-claude');
      expect(claudeResult!.sourceTool).toBe('claude-code');

      const cursorResult = getLastSession({ sourceTool: 'cursor' });
      expect(cursorResult).not.toBeNull();
      expect(cursorResult!.id).toBe('sess-last-cursor');
    });

    it('filters by projectId', () => {
      // The mock generateStableProjectId returns 'proj-' + last path segment,
      // so different projectPath tail segments produce different projectIds.
      const sessionA = makeParsedSession({
        id: 'sess-proj-a',
        projectPath: '/projects/alpha',
        projectName: 'alpha',
        startedAt: new Date('2025-06-15T09:00:00Z'),
        endedAt: new Date('2025-06-15T10:00:00Z'),
      });
      const sessionB = makeParsedSession({
        id: 'sess-proj-b',
        projectPath: '/projects/beta',
        projectName: 'beta',
        startedAt: new Date('2025-06-16T09:00:00Z'),
        endedAt: new Date('2025-06-16T10:00:00Z'),
      });

      insertSessionWithProject(sessionA);
      insertSessionWithProject(sessionB);

      const result = getLastSession({ projectId: 'proj-alpha' });
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-proj-a');
      expect(result!.projectName).toBe('alpha');
    });

    it('returns correct field mapping for a known session', () => {
      const session = makeParsedSession({
        id: 'sess-fields',
        projectName: 'my-project',
        startedAt: new Date('2025-06-15T09:00:00Z'),
        endedAt: new Date('2025-06-15T10:00:00Z'),
        sourceTool: 'claude-code',
        generatedTitle: 'The Title',
        sessionCharacter: 'feature_build',
      });

      insertSessionWithProject(session);

      const result = getLastSession();
      expect(result).not.toBeNull();
      expect(result!.id).toBe('sess-fields');
      expect(result!.projectName).toBe('my-project');
      expect(result!.startedAt).toBeInstanceOf(Date);
      expect(result!.sourceTool).toBe('claude-code');
      expect(result!.generatedTitle).toBe('The Title');
      expect(result!.sessionCharacter).toBe('feature_build');
    });
  });

  // ────────────────────────────────────────────────────
  // getSessionCount
  // ────────────────────────────────────────────────────

  describe('getSessionCount', () => {
    it('returns 0 when no sessions exist', () => {
      expect(getSessionCount()).toBe(0);
    });

    it('returns correct count for all sessions', () => {
      insertSessionWithProject(makeParsedSession({ id: 'cnt-sess-1' }));
      insertSessionWithProject(makeParsedSession({ id: 'cnt-sess-2' }));
      insertSessionWithProject(makeParsedSession({ id: 'cnt-sess-3' }));

      expect(getSessionCount()).toBe(3);
    });

    it('filters by periodStart', () => {
      const old = makeParsedSession({
        id: 'cnt-old',
        startedAt: new Date('2025-01-01T00:00:00Z'),
        endedAt: new Date('2025-01-01T01:00:00Z'),
      });
      const recent = makeParsedSession({
        id: 'cnt-recent',
        startedAt: new Date('2025-06-15T00:00:00Z'),
        endedAt: new Date('2025-06-15T01:00:00Z'),
      });

      insertSessionWithProject(old);
      insertSessionWithProject(recent);

      const count = getSessionCount({ periodStart: new Date('2025-06-01T00:00:00Z') });
      expect(count).toBe(1);
    });

    it('filters by sourceTool', () => {
      insertSessionWithProject(makeParsedSession({ id: 'cnt-claude-1', sourceTool: 'claude-code' }));
      insertSessionWithProject(makeParsedSession({ id: 'cnt-claude-2', sourceTool: 'claude-code' }));
      insertSessionWithProject(makeParsedSession({ id: 'cnt-cursor-1', sourceTool: 'cursor' }));

      expect(getSessionCount({ sourceTool: 'claude-code' })).toBe(2);
      expect(getSessionCount({ sourceTool: 'cursor' })).toBe(1);
    });

    it('filters by projectId', () => {
      // Different projectPath tails -> different projectIds via the mock
      const sessAlpha1 = makeParsedSession({
        id: 'cnt-alpha-1',
        projectPath: '/projects/cnt-alpha',
        projectName: 'cnt-alpha',
      });
      const sessAlpha2 = makeParsedSession({
        id: 'cnt-alpha-2',
        projectPath: '/projects/cnt-alpha',
        projectName: 'cnt-alpha',
      });
      const sessBeta = makeParsedSession({
        id: 'cnt-beta-1',
        projectPath: '/projects/cnt-beta',
        projectName: 'cnt-beta',
      });

      insertSessionWithProject(sessAlpha1);
      insertSessionWithProject(sessAlpha2);
      insertSessionWithProject(sessBeta);

      expect(getSessionCount({ projectId: 'proj-cnt-alpha' })).toBe(2);
      expect(getSessionCount({ projectId: 'proj-cnt-beta' })).toBe(1);
    });
  });

  // ────────────────────────────────────────────────────
  // getProjectList
  // ────────────────────────────────────────────────────

  describe('getProjectList', () => {
    it('returns empty array when no sessions exist', () => {
      expect(getProjectList()).toEqual([]);
    });

    it('returns distinct project names from sessions', () => {
      // Two sessions for the same project path -> same projectId, should appear once
      insertSessionWithProject(makeParsedSession({
        id: 'pl-sess-1',
        projectPath: '/projects/my-project',
        projectName: 'my-project',
      }));
      insertSessionWithProject(makeParsedSession({
        id: 'pl-sess-2',
        projectPath: '/projects/my-project',
        projectName: 'my-project',
      }));
      // A second distinct project
      insertSessionWithProject(makeParsedSession({
        id: 'pl-sess-3',
        projectPath: '/projects/other-project',
        projectName: 'other-project',
      }));

      const list = getProjectList();
      expect(list).toHaveLength(2);
    });

    it('returns sorted by project_name', () => {
      insertSessionWithProject(makeParsedSession({
        id: 'pl-sort-zebra',
        projectPath: '/projects/zebra',
        projectName: 'zebra',
      }));
      insertSessionWithProject(makeParsedSession({
        id: 'pl-sort-apple',
        projectPath: '/projects/apple',
        projectName: 'apple',
      }));
      insertSessionWithProject(makeParsedSession({
        id: 'pl-sort-mango',
        projectPath: '/projects/mango',
        projectName: 'mango',
      }));

      const list = getProjectList();
      expect(list).toHaveLength(3);
      expect(list[0].name).toBe('apple');
      expect(list[1].name).toBe('mango');
      expect(list[2].name).toBe('zebra');
    });

    it('returns id and name fields for each entry', () => {
      insertSessionWithProject(makeParsedSession({
        id: 'pl-fields-sess',
        projectPath: '/projects/pl-fields',
        projectName: 'pl-fields',
      }));

      const list = getProjectList();
      expect(list).toHaveLength(1);
      expect(list[0].id).toBe('proj-pl-fields');
      expect(list[0].name).toBe('pl-fields');
    });
  });
});
