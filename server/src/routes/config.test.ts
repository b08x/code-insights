import Database from 'better-sqlite3';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@code-insights/cli/db/schema';
import { saveConfig } from '@code-insights/cli/utils/config';

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
}));

let mockConfig: any = null;
vi.mock('@code-insights/cli/utils/config', () => ({
  loadConfig: () => mockConfig,
  saveConfig: vi.fn(),
}));

vi.mock('@code-insights/cli/llm/client', () => ({
  loadLLMConfig: () => null,
  isLLMConfigured: () => false,
  testLLMConfig: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@code-insights/cli/llm/providers/ollama', () => ({
  discoverOllamaModels: vi.fn().mockResolvedValue([]),
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

// ──────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────

describe('Config routes', () => {
  beforeEach(() => {
    testDb = initTestDb();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('GET /api/config/llm', () => {
    it('returns config shape when no config exists', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm');
      expect(res.status).toBe(200);
      const body = await res.json();
      // loadConfig returns null, so llm is undefined
      expect(body.dashboardPort).toBe(7890);
      expect(body.provider).toBeUndefined();
      expect(body.model).toBeUndefined();
    });
  });

  describe('PUT /api/config/llm', () => {
    it('returns 400 for port above valid range', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardPort: 99999 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/dashboardPort/);
    });

    it('returns 400 for negative port', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardPort: -1 }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/dashboardPort/);
    });

    it('returns 400 for non-integer port', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dashboardPort: 'abc' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/dashboardPort/);
    });

    it('returns 400 for invalid provider name', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'notreal', model: 'some-model' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/provider/);
    });

    it('returns 400 when provider is given but model is empty', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // model is omitted — no existing config to fall back to, so model resolves to ''
        body: JSON.stringify({ provider: 'ollama' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/model/);
    });

    it('returns 200 with ok:true when no fields are provided (no-op)', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('returns 200 when updating with valid provider and model', async () => {
      const app = createApp();
      const res = await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', model: 'llama3' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    it('calls saveConfig when LLM config changes', async () => {
      vi.mocked(saveConfig).mockClear();
      const app = createApp();
      await app.request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' }),
      });
      expect(vi.mocked(saveConfig)).toHaveBeenCalledOnce();
    });
  });

  describe('agent.codebaseTools', () => {
    afterEach(() => { mockConfig = null; });
    const put = (body: unknown) => createApp().request('/api/config/llm', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const base = () => ({ sync: { claudeDir: '', excludeProjects: [] }, dashboard: { agent: { provider: 'openai', model: 'm', codebaseTools: true } } });

    it('is saved when provided', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      expect((await put({ agent: { codebaseTools: false } })).status).toBe(200);
      expect(vi.mocked(saveConfig).mock.calls[0][0].dashboard?.agent?.codebaseTools).toBe(false);
    });

    it('survives a provider/model save that omits it', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      await put({ agent: { provider: 'anthropic', model: 'x' } });
      const saved = vi.mocked(saveConfig).mock.calls[0][0].dashboard?.agent;
      expect(saved?.provider).toBe('anthropic');
      expect(saved?.codebaseTools).toBe(true);
    });

    it('is returned by GET', async () => {
      mockConfig = base();
      const body = await (await createApp().request('/api/config/llm')).json() as any;
      expect(body.agent.codebaseTools).toBe(true);
    });
  });

  describe('POST /api/config/llm/test', () => {
    it('returns 400 when no LLM config exists and no body is provided', async () => {
      // loadLLMConfig mock returns null; no body in request
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.error).toBeTruthy();
    });

    it('returns 200 when body provides a valid config', async () => {
      // testLLMConfig mock resolves to { success: true }
      const app = createApp();
      const res = await app.request('/api/config/llm/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'ollama', model: 'llama3' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
    });
  });

  describe('GET /api/config/llm/ollama-models', () => {
    it('returns empty models array when no Ollama models are discovered', async () => {
      // discoverOllamaModels mock resolves to []
      const app = createApp();
      const res = await app.request('/api/config/llm/ollama-models');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.models).toEqual([]);
    });
  });
});
