import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '../../../cli/src/db/migrate.js';

// ──────────────────────────────────────────────────────
// Module-scoped mutable DB reference for mocking.
// ──────────────────────────────────────────────────────

let testDb: Database.Database;

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock('@code-insights/cli/utils/telemetry', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
}));

const mockChat = vi.fn();
const mockIsLLMConfigured = vi.fn(() => false);
const mockLoadLLMConfig = vi.fn(() => ({ provider: 'openai', model: 'gpt-4o' }));

vi.mock('../llm/client.js', () => ({
  isLLMConfigured: () => mockIsLLMConfigured(),
  createLLMClient: () => ({ chat: mockChat, provider: 'openai', model: 'gpt-4o', estimateTokens: (t: string) => Math.ceil(t.length / 4) }),
  loadLLMConfig: () => mockLoadLLMConfig(),
}));

const { createApp } = await import('../index.js');

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedProjectAndSession(projectId: string, sessionId: string) {
  testDb.prepare(`
    INSERT INTO projects (id, name, path, last_activity, session_count)
    VALUES (?, 'test', '/test', datetime('now'), 1)
  `).run(projectId);

  testDb.prepare(`
    INSERT INTO sessions (id, project_id, project_name, project_path,
      started_at, ended_at, message_count, source_tool,
      generated_title, estimated_cost_usd)
    VALUES (?, ?, 'test', '/test', '2025-06-15T10:00:00Z', '2025-06-15T11:00:00Z',
      5, 'claude-code', 'Test Session', 0.25)
  `).run(sessionId, projectId);
}

function seedInsight(
  sessionId: string,
  projectId: string,
  type: string,
  title: string,
  content: string,
  metadata: Record<string, unknown> = {},
  timestamp?: string,
) {
  const ts = timestamp || new Date().toISOString();
  testDb.prepare(`
    INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, metadata, timestamp)
    VALUES (?, ?, ?, 'test', ?, ?, ?, ?, 0.9, 'llm', ?, ?)
  `).run(randomUUID(), sessionId, projectId, type, title, content, content, JSON.stringify(metadata), ts);
}

function parseSSEEvents(text: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  const blocks = text.split('\n\n').filter(Boolean);
  for (const block of blocks) {
    const lines = block.split('\n');
    let event = '';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) data = line.slice(5).trim();
    }
    if (event && data) events.push({ event, data });
  }
  return events;
}

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('Export routes', () => {
  beforeEach(() => {
    testDb = initTestDb();
    mockIsLLMConfigured.mockReturnValue(false);
    mockChat.mockReset();
    mockLoadLLMConfig.mockReturnValue({ provider: 'openai', model: 'gpt-4o' });
  });

  afterEach(() => {
    testDb.close();
  });

  describe('POST /api/export/markdown', () => {
    it('exports markdown for given session IDs', async () => {
      seedProjectAndSession('proj-1', 'sess-1');

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['sess-1'] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/markdown');
      const text = await res.text();
      expect(text).toContain('# Code Insights Export');
      expect(text).toContain('Test Session');
    });

    it('returns 200 with markdown when neither sessionIds nor projectId provided ("everything" export)', async () => {
      seedProjectAndSession('proj-1', 'sess-1');

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# Code Insights Export');
      expect(text).toContain('Test Session');
    });

    it('returns 400 when sessionIds is not an array', async () => {
      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: 'not-an-array' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('sessionIds must be an array');
    });

    it('exports by projectId when no sessionIds provided', async () => {
      seedProjectAndSession('proj-1', 'sess-1');

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'proj-1' }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# Code Insights Export');
      expect(text).toContain('Test Session');
    });

    it('returns header-only markdown when no sessions match', async () => {
      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['nonexistent'] }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('# Code Insights Export');
      // No session sections — just the header
      expect(text).not.toContain('## ');
    });

    it('returns 400 when template is invalid', async () => {
      seedProjectAndSession('proj-1', 'sess-1');

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['sess-1'], template: 'invalid' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('template must be');
    });

    it('knowledge-base template includes structured insight content', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'decision', 'Use SQLite over Postgres', 'Chose SQLite for local-first simplicity.', {
        reasoning: 'No network overhead, zero-config, works offline',
        choice: 'SQLite',
        situation: 'local-first data storage',
        alternatives: [{ option: 'Postgres', rejected_because: 'too slow to set up locally' }],
        revisit_when: 'multi-user collaboration is needed',
      });
      seedInsight('sess-1', 'proj-1', 'learning', 'WAL mode prevents read locks', 'WAL mode allows concurrent reads during writes.', {
        symptom: 'CLI sync blocked dashboard reads',
        root_cause: 'default journal mode locks the entire database during writes',
        takeaway: 'Always enable WAL mode for local SQLite databases with concurrent access',
        applies_when: 'running CLI sync while dashboard is open',
      });

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['sess-1'], template: 'knowledge-base' }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();

      // Session present
      expect(text).toContain('Test Session');
      // Decision insight
      expect(text).toContain('Use SQLite over Postgres');
      expect(text).toContain('**Reasoning:**');
      // Verifies the rejected_because fix — must appear in output
      expect(text).toContain('rejected because too slow to set up locally');
      // Learning insight
      expect(text).toContain('WAL mode prevents read locks');
      expect(text).toContain('**What Happened:**');
      expect(text).toContain('**Root Cause:**');
      expect(text).toContain('**Takeaway:**');
    });

    it('agent-rules template produces imperative format', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'decision', 'Use SQLite over Postgres', 'Chose SQLite for local-first simplicity.', {
        reasoning: 'No network overhead, zero-config, works offline',
        choice: 'SQLite',
        situation: 'local-first data storage',
        alternatives: [{ option: 'Postgres', rejected_because: 'too slow to set up locally' }],
        revisit_when: 'multi-user collaboration is needed',
      });
      seedInsight('sess-1', 'proj-1', 'learning', 'WAL mode prevents read locks', 'WAL mode allows concurrent reads during writes.', {
        symptom: 'CLI sync blocked dashboard reads',
        root_cause: 'default journal mode locks the entire database during writes',
        takeaway: 'Always enable WAL mode for local SQLite databases with concurrent access',
        applies_when: 'running CLI sync while dashboard is open',
      });

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['sess-1'], template: 'agent-rules' }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();

      expect(text).toContain('# Agent Rules Export');
      expect(text).toContain('## Decisions');
      expect(text).toContain('- USE SQLite');
      expect(text).toContain('- DO NOT use Postgres');
      expect(text).toContain('## Learnings');
      expect(text).toContain('- WHEN ');
    });

    it('sessions with no insights show graceful note', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      // No insights seeded

      const app = createApp();
      const res = await app.request('/api/export/markdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionIds: ['sess-1'], template: 'knowledge-base' }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('*No insights for this session.*');
    });
  });

  describe('POST /api/export/generate', () => {
    it('returns 400 when LLM not configured', async () => {
      mockIsLLMConfigured.mockReturnValue(false);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', format: 'knowledge-brief' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('LLM not configured');
    });

    it('returns 400 for invalid scope', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'invalid', format: 'knowledge-brief' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('scope must be');
    });

    it('returns 400 when scope=project but no projectId', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'project', format: 'knowledge-brief' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('projectId is required');
    });

    it('returns 400 for invalid format', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', format: 'invalid-format' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('format must be');
    });

    it('returns 400 for invalid depth', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', format: 'knowledge-brief', depth: 'maximum' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('depth must be');
    });

    it('returns 200 with content and metadata on success (scope=all)', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'decision', 'Use SQLite', 'SQLite is local-first.', {});

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Exported Knowledge', usage: { total_tokens: 500 } });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', format: 'knowledge-brief', depth: 'standard' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe('# Exported Knowledge');
      expect(body.metadata).toBeDefined();
      expect(body.metadata.scope).toBe('all');
      expect(body.metadata.depth).toBe('standard');
      expect(typeof body.metadata.insightCount).toBe('number');
      expect(typeof body.metadata.sessionCount).toBe('number');
    });

    it('returns 200 with content on success (scope=project)', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'learning', 'WAL mode tip', 'Use WAL mode.', {});

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Project Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'project', projectId: 'proj-1', format: 'agent-rules' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe('# Project Export');
    });

    it('returns 422 when LLM throws an error', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'decision', 'Some decision', 'Content.', {});

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockRejectedValue(new Error('API rate limit'));

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', format: 'knowledge-brief' }),
      });
      expect(res.status).toBe(422);
      const body = await res.json();
      expect(body.error).toContain('API rate limit');
    });

    it('returns 200 even when no insights are found (empty prompt case)', async () => {
      // No insights seeded — LLM still gets called with empty context
      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'all', format: 'knowledge-brief' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.content).toBe('');
    });
  });

  describe('GET /api/export/generate/stream', () => {
    it('returns 400 when LLM not configured', async () => {
      mockIsLLMConfigured.mockReturnValue(false);

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=all&format=agent-rules');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('LLM not configured');
    });

    it('returns 400 when format is missing', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=all');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('format must be');
    });

    it('returns 400 for invalid scope', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=badscope&format=agent-rules');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('scope must be');
    });

    it('returns 400 when scope=project and no projectId', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=project&format=agent-rules');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('projectId is required');
    });

    it('emits error SSE event when no insights found', async () => {
      // No insights seeded
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=all&format=agent-rules');
      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSSEEvents(text);

      const errorEvent = events.find(e => e.event === 'error');
      expect(errorEvent).toBeDefined();
      const errorData = JSON.parse(errorEvent!.data);
      expect(errorData.error).toContain('No insights found');
    });

    it('emits progress and complete SSE events on success', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'decision', 'Use SQLite', 'SQLite is local-first.', {});

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Streamed Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=all&format=knowledge-brief');
      expect(res.status).toBe(200);
      const text = await res.text();
      const events = parseSSEEvents(text);

      const progressEvent = events.find(e => e.event === 'progress');
      expect(progressEvent).toBeDefined();
      const progressData = JSON.parse(progressEvent!.data);
      expect(progressData.phase).toBe('loading_insights');

      const completeEvent = events.find(e => e.event === 'complete');
      expect(completeEvent).toBeDefined();
      const completeData = JSON.parse(completeEvent!.data);
      expect(completeData.content).toBe('# Streamed Export');
      expect(completeData.metadata).toBeDefined();
      expect(completeData.metadata.scope).toBe('all');
    });
  });

  describe('POST /api/export/generate with date range filtering', () => {
    it('filters insights by date range (from only)', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      // Insight from 2024-01-01 (excluded)
      seedInsight('sess-1', 'proj-1', 'decision', 'Old Decision', 'Old content', {}, '2024-01-01T10:00:00Z');
      // Insight from 2024-06-01 (included)
      seedInsight('sess-1', 'proj-1', 'decision', 'New Decision', 'New content', {}, '2024-06-01T10:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Filtered Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateFrom: '2024-06-01'
        }),
      });

      expect(res.status).toBe(200);
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('New Decision')
          })
        ]),
        expect.any(Object)
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.not.stringContaining('Old Decision')
          })
        ]),
        expect.any(Object)
      );
    });

    it('filters insights by date range (to only)', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      // Insight from 2024-01-01 (included)
      seedInsight('sess-1', 'proj-1', 'decision', 'Early Decision', 'Early content', {}, '2024-01-01T10:00:00Z');
      // Insight from 2024-06-01 (excluded - after to date)
      seedInsight('sess-1', 'proj-1', 'decision', 'Late Decision', 'Late content', {}, '2024-06-01T10:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Filtered Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateTo: '2024-05-31'
        }),
      });

      expect(res.status).toBe(200);
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Early Decision')
          })
        ]),
        expect.any(Object)
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.not.stringContaining('Late Decision')
          })
        ]),
        expect.any(Object)
      );
    });

    it('filters insights by date range (both from and to)', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      // Before range
      seedInsight('sess-1', 'proj-1', 'decision', 'Before Range', 'Before content', {}, '2024-01-01T10:00:00Z');
      // In range
      seedInsight('sess-1', 'proj-1', 'decision', 'In Range', 'In range content', {}, '2024-03-15T10:00:00Z');
      // After range
      seedInsight('sess-1', 'proj-1', 'decision', 'After Range', 'After content', {}, '2024-07-01T10:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Range Filtered Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateFrom: '2024-03-01',
          dateTo: '2024-06-30'
        }),
      });

      expect(res.status).toBe(200);
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('In Range')
          })
        ]),
        expect.any(Object)
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.not.stringContaining('Before Range')
          })
        ]),
        expect.any(Object)
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.not.stringContaining('After Range')
          })
        ]),
        expect.any(Object)
      );
    });

    it('returns 400 for invalid dateFrom format', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateFrom: 'invalid-date'
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dateFrom must be a valid YYYY-MM-DD date');
    });

    it('returns 400 for invalid dateTo format', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateTo: '2024/06/01'
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dateTo must be a valid YYYY-MM-DD date');
    });

    it('returns 400 when dateFrom is after dateTo', async () => {
      mockIsLLMConfigured.mockReturnValue(true);

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateFrom: '2024-06-01',
          dateTo: '2024-05-01'
        }),
      });

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('dateFrom must be before or equal to dateTo');
    });

    it('includes date range in prompt context when user selected', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedInsight('sess-1', 'proj-1', 'decision', 'Test Decision', 'Test content', {}, '2024-03-15T10:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Export with Date Range Context' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateFrom: '2024-03-01',
          dateTo: '2024-06-30'
        }),
      });

      expect(res.status).toBe(200);
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Date range: 2024-03-01 to 2024-06-30 (user selected)')
          })
        ]),
        expect.any(Object)
      );
    });

    it('works with project scope and date filtering', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      seedProjectAndSession('proj-2', 'sess-2');
      // Project 1 insight in range
      seedInsight('sess-1', 'proj-1', 'decision', 'Project 1 Decision', 'Project 1 content', {}, '2024-03-15T10:00:00Z');
      // Project 2 insight in range (should be excluded by project scope)
      seedInsight('sess-2', 'proj-2', 'decision', 'Project 2 Decision', 'Project 2 content', {}, '2024-03-15T10:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Project Filtered Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'project',
          projectId: 'proj-1',
          format: 'knowledge-brief',
          dateFrom: '2024-03-01',
          dateTo: '2024-06-30'
        }),
      });

      expect(res.status).toBe(200);
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('Project 1 Decision')
          })
        ]),
        expect.any(Object)
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.not.stringContaining('Project 2 Decision')
          })
        ]),
        expect.any(Object)
      );
    });

    it('handles edge case: exact boundary dates', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      // Exactly on from date boundary (included)
      seedInsight('sess-1', 'proj-1', 'decision', 'From Boundary', 'From boundary content', {}, '2024-03-01T00:00:00Z');
      // Exactly on to date boundary (included via half-open interval)
      seedInsight('sess-1', 'proj-1', 'decision', 'To Boundary', 'To boundary content', {}, '2024-06-30T23:59:59Z');
      // Just after to date boundary (excluded)
      seedInsight('sess-1', 'proj-1', 'decision', 'After Boundary', 'After boundary content', {}, '2024-07-01T00:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Boundary Test Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: 'all',
          format: 'knowledge-brief',
          dateFrom: '2024-03-01',
          dateTo: '2024-06-30'
        }),
      });

      expect(res.status).toBe(200);
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringMatching(/(From Boundary|To Boundary).*(From Boundary|To Boundary)/s)
          })
        ]),
        expect.any(Object)
      );
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.not.stringContaining('After Boundary')
          })
        ]),
        expect.any(Object)
      );
    });
  });

  describe('GET /api/export/generate/stream with date range filtering', () => {
    it('filters insights by date range in stream mode', async () => {
      seedProjectAndSession('proj-1', 'sess-1');
      // Old insight (excluded)
      seedInsight('sess-1', 'proj-1', 'decision', 'Old Decision', 'Old content', {}, '2024-01-01T10:00:00Z');
      // New insight (included)
      seedInsight('sess-1', 'proj-1', 'decision', 'New Decision', 'New content', {}, '2024-06-01T10:00:00Z');

      mockIsLLMConfigured.mockReturnValue(true);
      mockChat.mockResolvedValue({ content: '# Streamed Filtered Export' });

      const app = createApp();
      const res = await app.request('/api/export/generate/stream?scope=all&format=knowledge-brief&dateFrom=2024-06-01');
      expect(res.status).toBe(200);

      const text = await res.text();
      const events = parseSSEEvents(text);

      const completeEvent = events.find(e => e.event === 'complete');
      expect(completeEvent).toBeDefined();
      const completeData = JSON.parse(completeEvent!.data);
      expect(completeData.content).toBe('# Streamed Filtered Export');

      // Verify LLM was called with filtered content
      expect(mockChat).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.stringContaining('New Decision')
          })
        ]),
        expect.any(Object)
      );
    });
  });
});
