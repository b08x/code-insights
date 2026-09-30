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

  it('GET unknown label is 404; DELETE removes', async () => {
    seedSessions([{ id: 's1', project: 'a' }]);
    expect((await app.request('/api/labels/s1')).status).toBe(404);
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
});
