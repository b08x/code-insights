import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import {
  validateLabelInput, upsertLabel, getLabel, listLabels, deleteLabel,
  getLabelQueueInputs, getLabelProgress, LabelError, COVERAGE_TARGETS,
} from '../labels.js';

function seed(db: Database.Database, sessions: Array<{ id: string; project: string; tool?: string; msgs?: number; deleted?: boolean }>) {
  const projects = new Set(sessions.map(s => s.project));
  for (const p of projects) {
    db.prepare(`INSERT INTO projects (id, name, path, last_activity) VALUES (?, ?, ?, '2026-01-01')`).run(p, `Project ${p}`, `/${p}`);
  }
  for (const s of sessions) {
    db.prepare(
      `INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count, source_tool, deleted_at)
       VALUES (?, ?, ?, ?, '2026-01-01', '2026-01-01', ?, ?, ?)`
    ).run(s.id, s.project, `Project ${s.project}`, `/${s.project}`, s.msgs ?? 30, s.tool ?? 'claude-code', s.deleted ? '2026-02-01' : null);
  }
}

const valid = {
  outcome: 'high',
  frictionCategories: ['wrong-approach'],
  patternCategories: ['structured-planning'],
  keyPoints: ['Fixed the bug'],
  forbiddenClaims: ['Deployed to prod'],
  note: 'n',
};

describe('validateLabelInput', () => {
  it('accepts canonical values and normalizes text', () => {
    const r = validateLabelInput({ ...valid, keyPoints: ['  Fixed the bug ', 'Fixed the bug', ''] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.keyPoints).toEqual(['Fixed the bug']);
      expect(r.value.note).toBe('n');
    }
  });

  it('rejects non-canonical outcome, friction and pattern categories', () => {
    const r = validateLabelInput({ ...valid, outcome: 'great', frictionCategories: ['nope'], patternCategories: ['wrong-approach'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join(' ')).toMatch(/outcome/);
      expect(r.errors.join(' ')).toMatch(/frictionCategories.*nope/);
      expect(r.errors.join(' ')).toMatch(/patternCategories.*wrong-approach/);
    }
  });

  it('rejects wrong shapes', () => {
    expect(validateLabelInput(null).ok).toBe(false);
    expect(validateLabelInput({ ...valid, keyPoints: 'x' }).ok).toBe(false);
    expect(validateLabelInput({ ...valid, forbiddenClaims: [1] }).ok).toBe(false);
    expect(validateLabelInput({ outcome: 'high' }).ok).toBe(true);
  });
});

describe('label storage', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); });
  afterEach(() => { db.close(); });

  it('creates a label with an assigned split and reads it back', () => {
    seed(db, [{ id: 's1', project: 'a' }]);
    const created = upsertLabel(db, 's1', validate(valid));
    expect(['train', 'validation', 'test']).toContain(created.split);
    expect(getLabel(db, 's1')).toEqual(created);
    expect(created.keyPoints).toEqual(['Fixed the bug']);
    expect(created.frictionCategories).toEqual(['wrong-approach']);
  });

  it('keeps the split and created_at when a label is edited', () => {
    seed(db, [{ id: 's1', project: 'a' }]);
    const first = upsertLabel(db, 's1', validate(valid));
    const second = upsertLabel(db, 's1', validate({ ...valid, outcome: 'low', keyPoints: ['Other'] }));
    expect(second.split).toBe(first.split);
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.outcome).toBe('low');
    expect(second.keyPoints).toEqual(['Other']);
  });

  it('never reassigns a split even with a different seed', () => {
    seed(db, [{ id: 's1', project: 'a' }]);
    const first = upsertLabel(db, 's1', validate(valid), { seed: 'one' });
    for (const seedName of ['two', 'three', 'four']) {
      expect(upsertLabel(db, 's1', validate(valid), { seed: seedName }).split).toBe(first.split);
    }
  });

  it('throws LabelError for a missing or soft-deleted session', () => {
    seed(db, [{ id: 'gone', project: 'a', deleted: true }]);
    expect(() => upsertLabel(db, 'nope', validate(valid))).toThrow(LabelError);
    expect(() => upsertLabel(db, 'gone', validate(valid))).toThrow(LabelError);
  });

  it('spreads splits across many labels', () => {
    seed(db, Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, project: `p${i % 5}` })));
    for (let i = 0; i < 50; i++) upsertLabel(db, `s${i}`, validate(valid));
    const all = listLabels(db);
    expect(all).toHaveLength(50);
    expect(listLabels(db, { split: 'test' }).length).toBeGreaterThanOrEqual(8);
    expect(listLabels(db, { split: 'validation' }).length).toBeGreaterThanOrEqual(8);
    expect(listLabels(db, { projectId: 'p0' })).toHaveLength(10);
  });

  it('deletes labels', () => {
    seed(db, [{ id: 's1', project: 'a' }]);
    upsertLabel(db, 's1', validate(valid));
    expect(deleteLabel(db, 's1')).toBe(true);
    expect(deleteLabel(db, 's1')).toBe(false);
    expect(getLabel(db, 's1')).toBeNull();
  });

  it('delete then re-label restores the original split', () => {
    seed(db, Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, project: 'a' })));
    for (let i = 0; i < 12; i++) upsertLabel(db, `s${i}`, validate(valid));
    const before = getLabel(db, 's3')!;
    expect(deleteLabel(db, 's3')).toBe(true);
    expect(getLabel(db, 's3')).toBeNull();
    expect(listLabels(db).map(l => l.sessionId)).not.toContain('s3');
    expect(deleteLabel(db, 's3')).toBe(false);
    const relabeled = upsertLabel(db, 's3', validate({ ...valid, outcome: 'low' }), { seed: 'different-seed' });
    expect(relabeled.split).toBe(before.split);
    expect(relabeled.outcome).toBe('low');
    expect(getLabel(db, 's3')).not.toBeNull();
  });

  it('a soft-deleted label is excluded from queue labeled set and progress', () => {
    seed(db, [{ id: 's1', project: 'a' }, { id: 's2', project: 'a' }]);
    upsertLabel(db, 's1', validate(valid));
    deleteLabel(db, 's1');
    const q = getLabelQueueInputs(db);
    expect(q.labeled).toEqual([]);
    expect(q.candidates.map(x => x.sessionId).sort()).toEqual(['s1', 's2']);
    expect(getLabelProgress(db).total).toBe(0);
  });

  it('usableOnly excludes labels whose session was purged or soft-deleted, orders by session_id', () => {
    seed(db, [{ id: 'c', project: 'a' }, { id: 'a', project: 'a' }, { id: 'b', project: 'a' }, { id: 'd', project: 'a' }]);
    for (const id of ['c', 'a', 'b', 'd']) upsertLabel(db, id, validate(valid));
    db.prepare('DELETE FROM sessions WHERE id = ?').run('b');                       // purged: row gone
    db.prepare(`UPDATE sessions SET deleted_at = datetime('now') WHERE id = 'd'`).run(); // soft-deleted
    expect(listLabels(db).map(l => l.sessionId).sort()).toEqual(['a', 'b', 'c', 'd']); // orphans stay stored
    expect(listLabels(db, { usableOnly: true }).map(l => l.sessionId)).toEqual(['a', 'c']);
    const bySplit = (['train', 'validation', 'test'] as const).flatMap(split => listLabels(db, { split, usableOnly: true }));
    expect(bySplit.map(l => l.sessionId).sort()).toEqual(['a', 'c']);
  });

  it('progress split counts use the usable set, consistent with project and bucket counts', () => {
    seed(db, [{ id: 's1', project: 'a', msgs: 5 }, { id: 's2', project: 'a', msgs: 5 }, { id: 's3', project: 'a', msgs: 5 }]);
    for (const id of ['s1', 's2', 's3']) upsertLabel(db, id, validate(valid));
    db.prepare('DELETE FROM sessions WHERE id = ?').run('s1');
    const p = getLabelProgress(db);
    expect(p.total).toBe(2);
    expect(p.splits.train + p.splits.validation + p.splits.test).toBe(2);
    expect(p.byProject.reduce((n, x) => n + x.labeled, 0)).toBe(2);
    expect(p.byLengthBucket.reduce((n, x) => n + x.labeled, 0)).toBe(2);
  });

  it('empty buckets are not reported as complete (0/0)', () => {
    seed(db, [{ id: 's1', project: 'a', msgs: 5 }]);
    const long = getLabelProgress(db).byLengthBucket.find(b => b.bucket === 'long')!;
    expect(long.available).toBe(0);
    expect(long.target).toBeGreaterThan(long.labeled);
  });

  it('queue inputs split sessions into labeled and unlabeled, excluding deleted', () => {
    seed(db, [{ id: 's1', project: 'a' }, { id: 's2', project: 'a' }, { id: 's3', project: 'b', deleted: true }]);
    upsertLabel(db, 's1', validate(valid));
    const q = getLabelQueueInputs(db);
    expect(q.labeled.map(x => x.sessionId)).toEqual(['s1']);
    expect(q.candidates.map(x => x.sessionId)).toEqual(['s2']);
  });

  it('progress counts per split, project and length bucket against targets', () => {
    seed(db, [
      { id: 's1', project: 'a', msgs: 5 }, { id: 's2', project: 'a', msgs: 50 },
      { id: 's3', project: 'b', msgs: 200 },
    ]);
    upsertLabel(db, 's1', validate(valid));
    upsertLabel(db, 's3', validate(valid));
    const p = getLabelProgress(db);
    expect(p.total).toBe(2);
    expect(p.splits.train + p.splits.validation + p.splits.test).toBe(2);
    expect(p.targets).toEqual(COVERAGE_TARGETS);
    const a = p.byProject.find(x => x.projectId === 'a')!;
    expect(a).toMatchObject({ labeled: 1, available: 2 });
    expect(a.target).toBe(Math.min(COVERAGE_TARGETS.perProject, 2));
    expect(p.byLengthBucket.find(x => x.bucket === 'short')).toMatchObject({ labeled: 1, available: 1 });
    expect(p.byLengthBucket.find(x => x.bucket === 'medium')).toMatchObject({ labeled: 0, available: 1 });
    expect(p.byLengthBucket.find(x => x.bucket === 'long')).toMatchObject({ labeled: 1, available: 1 });
  });
});

function validate(input: unknown) {
  const r = validateLabelInput(input);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.value;
}
