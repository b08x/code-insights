import Database from 'better-sqlite3';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@code-insights/cli/db/schema';

let testDb: Database.Database;

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));

vi.mock('@code-insights/cli/utils/telemetry', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
  isTelemetryEnabled: () => false,
  getStableMachineId: () => 'test-id',
}));

const preanalyzeMock = vi.fn();
vi.mock('@code-insights/cli/optimization/preanalyze', async (orig) => ({
  ...(await orig<typeof import('@code-insights/cli/optimization/preanalyze')>()),
  preanalyzeSessions: (...args: unknown[]) => preanalyzeMock(...args),
}));
const enqueueMock = vi.fn();
vi.mock('@code-insights/cli/db/queue', () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }));
const configMock = vi.fn();
vi.mock('@code-insights/cli/utils/config', async (orig) => ({
  ...(await orig<typeof import('@code-insights/cli/utils/config')>()),
  loadConfig: () => configMock(),
}));
vi.mock('@code-insights/cli/analysis/provider-runner', () => ({
  ProviderRunner: class { name = 'mistral'; },
}));

const { createApp } = await import('../index.js');

function seedSessions(rows: Array<{ id: string; project: string; msgs?: number; tool?: string }>) {
  for (const p of new Set(rows.map(r => r.project))) {
    testDb.prepare(`INSERT OR IGNORE INTO projects (id, name, path, last_activity) VALUES (?, ?, ?, datetime('now'))`)
      .run(p, `Project ${p}`, `/${p}`);
  }
  for (const r of rows) {
    testDb.prepare(
      `INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count, source_tool)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', ?, ?)`
    ).run(r.id, r.project, `Project ${r.project}`, `/${r.project}`, r.msgs ?? 30, r.tool ?? 'claude-code');
  }
}

const body = {
  outcome: 'high',
  frictionCategories: ['wrong-approach'],
  patternCategories: ['structured-planning'],
  keyPoints: ['Fixed the bug'],
  forbiddenClaims: ['Deployed'],
  note: null,
};

const put = (app: ReturnType<typeof createApp>, id: string, b: unknown) =>
  app.request(`/api/labels/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

describe('/api/labels', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    app = createApp();
  });
  afterEach(() => { testDb.close(); });

  it('PUT creates a label with a split, GET reads it back', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    const res = await put(app, 's1', body);
    expect(res.status).toBe(200);
    const { label } = await res.json() as { label: { split: string; sessionId: string } };
    expect(['train', 'validation', 'test']).toContain(label.split);

    const got = await app.request('/api/labels/s1');
    expect(got.status).toBe(200);
    expect((await got.json() as { label: unknown }).label).toEqual(label);
  });

  it('PUT edits keep the split', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    const first = (await (await put(app, 's1', body)).json() as { label: { split: string } }).label;
    const edited = (await (await put(app, 's1', { ...body, outcome: 'low' })).json() as { label: { split: string; outcome: string } }).label;
    expect(edited.split).toBe(first.split);
    expect(edited.outcome).toBe('low');
  });

  it('ignores a client-supplied split', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    const first = (await (await put(app, 's1', body)).json() as { label: { split: string } }).label;
    const other = first.split === 'test' ? 'train' : 'test';
    const res = (await (await put(app, 's1', { ...body, split: other })).json() as { label: { split: string } }).label;
    expect(res.split).toBe(first.split);
  });

  it('rejects non-canonical categories with 400', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    const res = await put(app, 's1', { ...body, outcome: 'great', frictionCategories: ['bogus'] });
    expect(res.status).toBe(400);
    const j = await res.json() as { error: string; details: string[] };
    expect(j.details.join(' ')).toMatch(/outcome/);
    expect(j.details.join(' ')).toMatch(/bogus/);
  });

  it('rejects a non-JSON body with 400 and unknown sessions with 404', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    const bad = await app.request('/api/labels/s1', { method: 'PUT', body: 'not json' });
    expect(bad.status).toBe(400);
    expect((await put(app, 'missing', body)).status).toBe(404);
  });

  it('GET unlabeled session is 200 {label:null}; DELETE removes', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    const none = await app.request('/api/labels/s1');
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ label: null });
    await put(app, 's1', body);
    expect((await app.request('/api/labels/s1', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/api/labels/s1', { method: 'DELETE' })).status).toBe(404);
  });

  it('lists labels, filterable by split and project; rejects a bad split filter', async () => {
    seedSessions([{ id: 's1', project: 'a' }, { id: 's2', project: 'b' }]);
    await put(app, 's1', body);
    await put(app, 's2', body);
    const all = await (await app.request('/api/labels')).json() as { labels: Array<{ sessionId: string; split: string }> };
    expect(all.labels).toHaveLength(2);
    const byProject = await (await app.request('/api/labels?project=a')).json() as { labels: unknown[] };
    expect(byProject.labels).toHaveLength(1);
    const bySplit = await (await app.request(`/api/labels?split=${all.labels[0].split}`)).json() as { labels: unknown[] };
    expect(bySplit.labels.length).toBeGreaterThanOrEqual(1);
    expect((await app.request('/api/labels?split=holdout')).status).toBe(400);
  });

  it('GET /queue ranks unlabeled sessions for coverage and excludes labeled ones', async () => {
    seedSessions([
      { id: 'a1', project: 'a' }, { id: 'a2', project: 'a' }, { id: 'b1', project: 'b' },
    ]);
    await put(app, 'a1', body);
    const res = await app.request('/api/labels/queue?limit=5');
    expect(res.status).toBe(200);
    const { queue } = await res.json() as { queue: Array<{ sessionId: string; projectName: string; bucket: string }> };
    expect(queue.map(q => q.sessionId)).toEqual(['b1', 'a2']);
    expect(queue[0].projectName).toBe('Project b');
  });

  it('GET /progress reports splits, projects and length buckets', async () => {
    seedSessions([{ id: 's1', project: 'a', msgs: 5 }, { id: 's2', project: 'a', msgs: 100 }]);
    await put(app, 's1', body);
    const p = await (await app.request('/api/labels/progress')).json() as {
      total: number;
      splits: Record<string, number>;
      byProject: Array<{ projectId: string; labeled: number; available: number; target: number }>;
      byLengthBucket: Array<{ bucket: string; labeled: number }>;
      targets: { totalLabels: number };
    };
    expect(p.total).toBe(1);
    expect(Object.values(p.splits).reduce((a, b) => a + b, 0)).toBe(1);
    expect(p.byProject[0]).toMatchObject({ projectId: 'a', labeled: 1, available: 2 });
    expect(p.byLengthBucket.find(b => b.bucket === 'short')!.labeled).toBe(1);
    expect(p.targets.totalLabels).toBeGreaterThan(0);
  });

  it('GET /categories exposes the canonical lists', async () => {
    const c = await (await app.request('/api/labels/categories')).json() as Record<string, string[]>;
    expect(c.outcomes).toContain('abandoned');
    expect(c.frictionCategories).toContain('rage-loop');
    expect(c.patternCategories).toContain('self-correction');
  });

  describe('preanalyze', () => {
    const post = (b: unknown) =>
      app.request('/api/labels/preanalyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const mistral = { dashboard: { llm: { provider: 'mistral', model: 'mistral-small', apiKey: 'k' } } };
    beforeEach(() => {
      preanalyzeMock.mockReset();
      enqueueMock.mockReset();
      configMock.mockReset();
      seedSessions([{ id: 's1', project: 'a' }, { id: 's2', project: 'a' }]);
    });

    it('validates input', async () => {
      expect((await post({})).status).toBe(400);
      expect((await post({ sessionIds: [] })).status).toBe(400);
      expect((await post({ sessionIds: [1] })).status).toBe(400);
      expect((await post({ sessionIds: Array.from({ length: 501 }, (_, i) => `x${i}`) })).status).toBe(400);
      const unknown = await post({ sessionIds: ['s1', 'nope'] });
      expect(unknown.status).toBe(400);
      expect((await unknown.json() as { unknownSessionIds: string[] }).unknownSessionIds).toEqual(['nope']);
    });

    it('rejects tombstoned sessions', async () => {
      testDb.prepare(`INSERT INTO deleted_sessions (id) VALUES ('s2')`).run();
      expect((await post({ sessionIds: ['s2'] })).status).toBe(400);
    });

    it('enqueues when the provider cannot batch', async () => {
      configMock.mockReturnValue({ dashboard: { llm: { provider: 'openai', model: 'gpt', apiKey: 'k' } } });
      const res = await post({ sessionIds: ['s1', 's2', 's1'] });
      expect(await res.json()).toEqual({ mode: 'queue', submitted: 2, enqueued: 2 });
      expect(enqueueMock).toHaveBeenCalledTimes(2);
      expect(preanalyzeMock).not.toHaveBeenCalled();
    });

    it('enqueues when no LLM config exists', async () => {
      configMock.mockReturnValue(null);
      expect(await (await post({ sessionIds: ['s1'] })).json()).toEqual({ mode: 'queue', submitted: 1, enqueued: 1 });
    });

    it('runs a batch job in the background and exposes status', async () => {
      configMock.mockReturnValue(mistral);
      preanalyzeMock.mockResolvedValue({
        mode: 'batch',
        sessions: [{ sessionId: 's1', status: 'analyzed' }, { sessionId: 's2', status: 'failed', error: 'x' }],
        batch: { costUsd: 0.5 },
      });
      const res = await post({ sessionIds: ['s1', 's2'] });
      expect(res.status).toBe(202);
      const started = await res.json() as { jobId: string; mode: string; submitted: number };
      expect(started).toMatchObject({ mode: 'batch', submitted: 2 });
      await vi.waitFor(async () => {
        const job = await (await app.request(`/api/labels/preanalyze/${started.jobId}`)).json() as Record<string, unknown>;
        expect(job).toMatchObject({ status: 'completed', analyzed: 1, failed: 1, costUsd: 0.5 });
      });
      expect(preanalyzeMock.mock.calls[0][0]).toEqual(['s1', 's2']);
    });

    it('captures a job error instead of rejecting', async () => {
      configMock.mockReturnValue(mistral);
      preanalyzeMock.mockRejectedValue(new Error('boom'));
      const { jobId } = await (await post({ sessionIds: ['s1'] })).json() as { jobId: string };
      await vi.waitFor(async () => {
        const job = await (await app.request(`/api/labels/preanalyze/${jobId}`)).json() as Record<string, unknown>;
        expect(job).toMatchObject({ status: 'failed', error: 'boom' });
      });
    });

    it('reports fellBackToQueue and 404s unknown jobs', async () => {
      configMock.mockReturnValue(mistral);
      preanalyzeMock.mockResolvedValue({
        mode: 'batch', sessions: [{ sessionId: 's1', status: 'enqueued' }],
        batch: { costUsd: 0, fellBackToQueue: 'timeout' },
      });
      const { jobId } = await (await post({ sessionIds: ['s1'] })).json() as { jobId: string };
      await vi.waitFor(async () => {
        const job = await (await app.request(`/api/labels/preanalyze/${jobId}`)).json() as Record<string, unknown>;
        expect(job).toMatchObject({ status: 'completed', enqueued: 1, fellBackToQueue: 'timeout' });
      });
      expect((await app.request('/api/labels/preanalyze/nope')).status).toBe(404);
    });
  });
});
