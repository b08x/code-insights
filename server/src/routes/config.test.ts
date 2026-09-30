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

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execFile: execFileMock,
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

    it("returns 400 when the model contains '|' (identity-key separator)", async () => {
      const res = await createApp().request('/api/config/llm', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', model: 'gpt|4o' }),
      });
      expect(res.status).toBe(400);
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

  describe('analysis runner setting', () => {
    afterEach(() => { mockConfig = null; });
    const put = (body: unknown) => createApp().request('/api/config/llm', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const base = () => ({
      sync: { claudeDir: '', excludeProjects: [] },
      dashboard: {
        llm: { provider: 'openai', model: 'gpt-4o' },
        analysis: {
          runner: { name: 'opencode', model: 'openrouter/qwen/qwen3-coder', variant: 'high' },
          retrieval: { enabled: true, topK: 3 },
        },
      },
    });
    const saved = () => vi.mocked(saveConfig).mock.calls[0][0].dashboard?.analysis;

    it('round-trips name/model/variant through PUT and GET', async () => {
      mockConfig = { sync: { claudeDir: '', excludeProjects: [] } };
      vi.mocked(saveConfig).mockClear();
      const res = await put({ runner: { name: 'claude', model: 'claude-sonnet-4-6', variant: 'high' } });
      expect(res.status).toBe(200);
      expect(saved()?.runner).toEqual({ name: 'claude', model: 'claude-sonnet-4-6', variant: 'high' });

      mockConfig = vi.mocked(saveConfig).mock.calls[0][0];
      const body = await (await createApp().request('/api/config/llm')).json() as any;
      expect(body.runner).toEqual({ name: 'claude', model: 'claude-sonnet-4-6', variant: 'high' });
    });

    it('is preserved (with retrieval) when a save omits it', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      await put({ provider: 'anthropic', model: 'claude-x' });
      expect(saved()?.runner).toEqual({ name: 'opencode', model: 'openrouter/qwen/qwen3-coder', variant: 'high' });
      expect(saved()?.retrieval).toEqual({ enabled: true, topK: 3 });
    });

    it('keeps omitted fields for the same runner and drops them when switching runner', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      await put({ runner: { variant: 'max' } });
      expect(saved()?.runner).toEqual({ name: 'opencode', model: 'openrouter/qwen/qwen3-coder', variant: 'max' });

      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      await put({ runner: { name: 'codex' } });
      expect(saved()?.runner).toEqual({ name: 'codex' });
    });

    it('clears with null and keeps retrieval', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      expect((await put({ runner: null })).status).toBe(200);
      expect(saved()?.runner).toBeUndefined();
      expect(saved()?.retrieval).toEqual({ enabled: true, topK: 3 });
    });

    it('rejects an unknown runner name', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      const res = await put({ runner: { name: 'bash' } });
      expect(res.status).toBe(400);
      expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
    });

    it('rejects a model that could be read as a CLI flag', async () => {
      mockConfig = base();
      vi.mocked(saveConfig).mockClear();
      expect((await put({ runner: { name: 'claude', model: '--dangerously-skip-permissions' } })).status).toBe(400);
      expect((await put({ runner: { name: 'claude', variant: 'high; rm -rf /' } })).status).toBe(400);
      expect(vi.mocked(saveConfig)).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/config/models', () => {
    const get = (q: string) => createApp().request(`/api/config/models${q}`);
    beforeEach(() => { execFileMock.mockReset(); });

    it('shells opencode models with fixed argv and a timeout, and parses one model per line', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'anthropic/claude-sonnet-4-6\nopenrouter/qwen/qwen3-coder:free\n\n', ''));
      const res = await get('?runner=opencode');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ models: ['anthropic/claude-sonnet-4-6', 'openrouter/qwen/qwen3-coder:free'] });
      const [cmd, args, opts] = execFileMock.mock.calls[0];
      expect(cmd).toBe('opencode');
      expect(args).toEqual(['models']);
      expect(opts.timeout).toBeGreaterThan(0);
    });

    it('shells agy models for antigravity', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, 'Available models:\n- gemini-3-pro  (default)\n- gemini-3-flash\n', ''));
      const body = await (await get('?runner=antigravity')).json();
      expect(execFileMock.mock.calls[0][0]).toBe('agy');
      expect(body).toEqual({ models: ['gemini-3-pro', 'gemini-3-flash'] });
    });

    it('rejects an unknown or missing runner without shelling', async () => {
      expect((await get('?runner=rm')).status).toBe(400);
      expect((await get('?runner=opencode%20--help')).status).toBe(400);
      expect((await get('')).status).toBe(400);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns an empty list on timeout', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
        cb(Object.assign(new Error('Command timed out'), { killed: true, signal: 'SIGTERM' }), '', ''));
      expect(await (await get('?runner=opencode')).json()).toEqual({ models: [] });
    });

    it('returns an empty list when the CLI is missing', async () => {
      execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }), '', ''));
      expect(await (await get('?runner=antigravity')).json()).toEqual({ models: [] });
    });

    it('returns an empty list for runners without a model list command', async () => {
      for (const runner of ['claude', 'codex', 'vibe', 'provider']) {
        expect(await (await get(`?runner=${runner}`)).json()).toEqual({ models: [] });
      }
      expect(execFileMock).not.toHaveBeenCalled();
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
