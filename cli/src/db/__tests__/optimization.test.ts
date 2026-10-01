import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import {
  createRun, updateRun, getRun, listRuns, markStaleRunsFailed,
  appendRound, listRounds, listSessionScores,
  createVersion, getVersion, listVersions, getLineage,
  getActivePromptVersion, setActiveVersion, clearActiveVersion, listActiveVersions,
  getJudgeCache, putJudgeCache,
  addJudgeAudit, setHumanDecision, listJudgeAudits, judgeAgreement,
  createBatchJob, getBatchJob, updateBatchJob, listBatchJobs, deleteBatchJob,
  labelsHash, labelsHashes, OptimizationError,
  setVersionTestScores, replaceGateScores, listGateScores,
} from '../optimization.js';
import { ANALYSIS_VERSION } from '../../analysis/analysis-db.js';
import { upsertLabel } from '../labels.js';
import { createDbPromptLookup } from '../../optimization/db-lookup.js';
import { resolveAnalysisPrompt } from '../../optimization/resolve-prompt.js';
import { identityKey, providerIdentity } from '../../optimization/identity.js';

const T = 'session-analysis';
const K = 'provider:mistral|m1|';

describe('db/optimization', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); runMigrations(db); db.pragma('foreign_keys = ON'); });
  afterEach(() => { db.close(); });

  const run = (over: Partial<Parameters<typeof createRun>[1]> = {}) =>
    createRun(db, { target: T, identityKey: K, teacher: 'teacher-m', judgeModel: 'judge-m', mode: 'sync', ...over });
  const version = (over: Partial<Parameters<typeof createVersion>[1]> = {}) =>
    createVersion(db, { target: T, identityKey: K, components: { frictionGuidance: 'g' }, ...over });

  describe('runs', () => {
    it('creates a queued run with parsed json fields', () => {
      const r = run({ caps: { maxMetricCalls: 50 }, estimate: { calls: 10 }, labelsHash: { train: 'a' } });
      expect(r.status).toBe('queued');
      expect(r.caps).toEqual({ maxMetricCalls: 50 });
      expect(r.estimate).toEqual({ calls: 10 });
      expect(r.labelsHash).toEqual({ train: 'a' });
      expect(r.finishedAt).toBeNull();
      expect(getRun(db, r.id)).toEqual(r);
      expect(getRun(db, 'nope')).toBeNull();
    });

    it('updates status and stamps finished_at on terminal states', () => {
      const r = run();
      expect(updateRun(db, r.id, { status: 'running' }).finishedAt).toBeNull();
      const done = updateRun(db, r.id, { status: 'completed', bestCandidateId: 'c3' });
      expect(done.bestCandidateId).toBe('c3');
      expect(done.finishedAt).not.toBeNull();
      expect(updateRun(db, r.id, { status: 'failed', error: 'boom' }).error).toBe('boom');
    });

    it('throws not_found when updating a missing run', () => {
      expect(() => updateRun(db, 'nope', { status: 'running' })).toThrow(OptimizationError);
    });

    it('lists newest first with filters', () => {
      const a = run(); const b = run({ identityKey: 'other' });
      db.prepare(`UPDATE optimization_runs SET started_at = '2026-01-01T00:00:00Z' WHERE id = ?`).run(a.id);
      db.prepare(`UPDATE optimization_runs SET started_at = '2026-01-02T00:00:00Z' WHERE id = ?`).run(b.id);
      expect(listRuns(db).map(r => r.id)).toEqual([b.id, a.id]);
      expect(listRuns(db, { identityKey: K }).map(r => r.id)).toEqual([a.id]);
      expect(listRuns(db, { status: 'running' })).toEqual([]);
      expect(listRuns(db, { limit: 1 })).toHaveLength(1);
    });

    it('markStaleRunsFailed fails queued/running runs, leaves awaiting_batch and terminal runs', () => {
      const q = run(); const r = run(); const w = run(); const d = run();
      updateRun(db, r.id, { status: 'running' });
      updateRun(db, w.id, { status: 'awaiting_batch' });
      updateRun(db, d.id, { status: 'completed' });
      expect(markStaleRunsFailed(db)).toBe(2);
      expect(getRun(db, q.id)).toMatchObject({ status: 'failed' });
      expect(getRun(db, q.id)!.error).toMatch(/interrupted/);
      expect(getRun(db, q.id)!.finishedAt).not.toBeNull();
      expect(getRun(db, r.id)!.status).toBe('failed');
      expect(getRun(db, w.id)!.status).toBe('awaiting_batch');
      expect(getRun(db, d.id)!.status).toBe('completed');
      expect(markStaleRunsFailed(db)).toBe(0);
    });
  });

  describe('rounds and per-session scores', () => {
    it('appends a round with per-session scores atomically and reads them back', () => {
      const r = run();
      const round = appendRound(db, {
        runId: r.id, round: 1, candidateId: 'c1', parentCandidateId: 'c0',
        components: { frictionGuidance: 'x' }, scores: { outcome: 0.5 }, scalar: 0.4, accepted: true,
        rationales: ['too vague'], tokens: 120, costUsd: 0.01,
        sessionScores: [
          { sessionId: 's1', scores: { outcome: 1 }, scalar: 0.9 },
          { sessionId: 's2', scores: { outcome: 0 }, scalar: 0.1 },
        ],
      });
      expect(round.accepted).toBe(true);
      expect(listRounds(db, r.id)).toEqual([round]);
      expect(round.rationales).toEqual(['too vague']);
      const scores = listSessionScores(db, { roundId: round.id });
      expect(scores.map(s => s.sessionId).sort()).toEqual(['s1', 's2']);
      expect(scores.every(s => s.candidateId === 'c1')).toBe(true);
      expect(listSessionScores(db, { runId: r.id })).toHaveLength(2);
      expect(listSessionScores(db, { runId: r.id, candidateId: 'zzz' })).toHaveLength(0);
    });

    it('rolls back the round when a session score insert fails', () => {
      const r = run();
      expect(() => appendRound(db, {
        runId: r.id, round: 1, candidateId: 'c1', components: {}, scores: {},
        sessionScores: [{ sessionId: 's1', scores: {} }, { sessionId: 's1', scores: {} }],
      })).toThrow();
      expect(listRounds(db, r.id)).toEqual([]);
    });

    it('orders rounds by round number', () => {
      const r = run();
      for (const n of [2, 0, 1]) appendRound(db, { runId: r.id, round: n, candidateId: `c${n}`, components: {}, scores: {} });
      expect(listRounds(db, r.id).map(x => x.round)).toEqual([0, 1, 2]);
    });
  });

  describe('versions', () => {
    it('stores a version with the current ANALYSIS_VERSION by default', () => {
      const v = version({ judgeModel: 'j', weights: { outcome: 1 }, testScores: { weighted: 0.7 } });
      expect(v.analysisVersion).toBe(ANALYSIS_VERSION);
      expect(v.components).toEqual({ frictionGuidance: 'g' });
      expect(v.weights).toEqual({ outcome: 1 });
      expect(v.testScores).toEqual({ weighted: 0.7 });
      expect(getVersion(db, v.id)).toEqual(v);
      expect(version({ analysisVersion: '0.0.1' }).analysisVersion).toBe('0.0.1');
    });

    it('lists newest first per (target, identity) and walks lineage root-last', () => {
      const a = version(); const b = version({ parentVersionId: a.id }); const c = version({ parentVersionId: b.id });
      version({ identityKey: 'other' });
      db.prepare(`UPDATE prompt_versions SET created_at = ? WHERE id = ?`).run('2026-01-01T00:00:00Z', a.id);
      db.prepare(`UPDATE prompt_versions SET created_at = ? WHERE id = ?`).run('2026-01-02T00:00:00Z', b.id);
      db.prepare(`UPDATE prompt_versions SET created_at = ? WHERE id = ?`).run('2026-01-03T00:00:00Z', c.id);
      expect(listVersions(db, { target: T, identityKey: K }).map(v => v.id)).toEqual([c.id, b.id, a.id]);
      expect(getLineage(db, c.id).map(v => v.id)).toEqual([c.id, b.id, a.id]);
      expect(getLineage(db, 'nope')).toEqual([]);
    });

    it('lineage stops at a dangling parent and survives cycles', () => {
      const a = version({ parentVersionId: 'gone' });
      expect(getLineage(db, a.id).map(v => v.id)).toEqual([a.id]);
      const b = version(); const c = version({ parentVersionId: b.id });
      db.prepare('UPDATE prompt_versions SET parent_version_id = ? WHERE id = ?').run(c.id, b.id);
      expect(getLineage(db, c.id)).toHaveLength(2);
    });
  });

  describe('active version (storage-level promote invariants)', () => {
    it('is null until set, then promote replaces and clear removes', () => {
      expect(getActivePromptVersion(db, T, K)).toBeNull();
      const a = version(); const b = version();
      setActiveVersion(db, T, K, a.id);
      expect(getActivePromptVersion(db, T, K)!.id).toBe(a.id);
      setActiveVersion(db, T, K, b.id);
      expect(getActivePromptVersion(db, T, K)!.id).toBe(b.id);
      expect(listActiveVersions(db)).toEqual([{ target: T, identityKey: K, versionId: b.id, promotedAt: expect.any(String) }]);
      expect(clearActiveVersion(db, T, K)).toBe(true);
      expect(clearActiveVersion(db, T, K)).toBe(false);
      expect(getActivePromptVersion(db, T, K)).toBeNull();
    });

    it('rejects an unknown version', () => {
      expect(() => setActiveVersion(db, T, K, 'nope')).toThrowError(expect.objectContaining({ code: 'not_found' }));
    });

    it('rejects a version tuned for another identity or target', () => {
      const other = version({ identityKey: 'other' });
      expect(() => setActiveVersion(db, T, K, other.id)).toThrowError(expect.objectContaining({ code: 'version_mismatch' }));
      expect(() => setActiveVersion(db, 'prompt-quality', 'other', other.id)).toThrowError(expect.objectContaining({ code: 'version_mismatch' }));
      expect(getActivePromptVersion(db, T, K)).toBeNull();
    });

    it('rollback is promoting the previous version', () => {
      const a = version(); const b = version({ parentVersionId: a.id });
      setActiveVersion(db, T, K, b.id);
      setActiveVersion(db, T, K, a.id);
      expect(getActivePromptVersion(db, T, K)!.id).toBe(a.id);
    });
  });

  describe('judge cache', () => {
    it('round-trips and is keyed by output, key points and judge model', () => {
      expect(getJudgeCache(db, 'o', 'k', 'j1')).toBeNull();
      putJudgeCache(db, 'o', 'k', 'j1', { covered: [true] });
      expect(getJudgeCache(db, 'o', 'k', 'j1')).toEqual({ covered: [true] });
      expect(getJudgeCache(db, 'o', 'k', 'j2')).toBeNull();
      expect(getJudgeCache(db, 'o', 'k2', 'j1')).toBeNull();
      putJudgeCache(db, 'o', 'k', 'j1', { covered: [false] });
      expect(getJudgeCache(db, 'o', 'k', 'j1')).toEqual({ covered: [false] });
    });
  });

  describe('judge audits', () => {
    it('records decisions, human review and agreement rate', () => {
      expect(judgeAgreement(db)).toEqual({ reviewed: 0, agreed: 0, rate: null });
      const a1 = addJudgeAudit(db, { sessionId: 's1', item: 'kp1', judgeDecision: 'covered' });
      const a2 = addJudgeAudit(db, { sessionId: 's1', item: 'kp2', judgeDecision: 'violated' });
      addJudgeAudit(db, { sessionId: 's2', item: 'kp3', judgeDecision: 'covered' });
      expect(listJudgeAudits(db, { unreviewedOnly: true })).toHaveLength(3);
      setHumanDecision(db, a1.id, 'covered');
      setHumanDecision(db, a2.id, 'not_violated');
      expect(listJudgeAudits(db, { unreviewedOnly: true })).toHaveLength(1);
      expect(judgeAgreement(db)).toEqual({ reviewed: 2, agreed: 1, rate: 0.5 });
      expect(() => setHumanDecision(db, 'nope', 'covered')).toThrow(OptimizationError);
    });

    it('filters by round', () => {
      const r = run();
      const round = appendRound(db, { runId: r.id, round: 0, candidateId: 'c0', components: {}, scores: {} });
      addJudgeAudit(db, { roundId: round.id, sessionId: 's1', item: 'x', judgeDecision: 'covered' });
      addJudgeAudit(db, { sessionId: 's1', item: 'y', judgeDecision: 'covered' });
      expect(listJudgeAudits(db, { roundId: round.id })).toHaveLength(1);
      expect(judgeAgreement(db, { roundId: round.id }).reviewed).toBe(0);
    });
  });

  describe('batch jobs', () => {
    it('supports create, update, list by owner/open status, delete', () => {
      const j = createBatchJob(db, { jobId: 'job1', provider: 'mistral', model: 'm', ownerKind: 'run', ownerId: 'r1', customIds: ['a', 'b'] });
      expect(j.status).toBe('submitted');
      expect(j.customIds).toEqual(['a', 'b']);
      createBatchJob(db, { jobId: 'job2', provider: 'openrouter', model: 'm', ownerKind: 'preanalyze', ownerId: 'p1', customIds: [] });
      expect(listBatchJobs(db, { ownerKind: 'run', ownerId: 'r1' }).map(x => x.jobId)).toEqual(['job1']);
      const u = updateBatchJob(db, 'job1', { status: 'completed' });
      expect(u.status).toBe('completed');
      expect(listBatchJobs(db, { openOnly: true }).map(x => x.jobId)).toEqual(['job2']);
      expect(getBatchJob(db, 'job1')!.status).toBe('completed');
      expect(deleteBatchJob(db, 'job1')).toBe(true);
      expect(getBatchJob(db, 'job1')).toBeNull();
      expect(() => updateBatchJob(db, 'job1', { status: 'failed' })).toThrow(OptimizationError);
    });
  });

  describe('labelsHash', () => {
    const seed = () => {
      db.prepare(`INSERT INTO projects (id, name, path, last_activity) VALUES ('p','P','/p','2026-01-01')`).run();
      for (const id of ['s1', 's2']) {
        db.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count)
          VALUES (?, 'p','P','/p','2026-01-01','2026-01-01', 30)`).run(id);
      }
    };
    const input = { outcome: 'high', frictionCategories: [], patternCategories: [], keyPoints: ['a'], forbiddenClaims: [], note: null };

    it('is stable, content-sensitive, and ignores other splits, notes and soft-deleted rows', () => {
      seed();
      const empty = labelsHash(db, 'test');
      const l1 = upsertLabel(db, 's1', input);
      const split = l1.split;
      const other = (['train', 'validation', 'test'] as const).find(s => s !== split)!;
      const h1 = labelsHash(db, split);
      expect(h1).not.toBe(labelsHash(db, other));
      expect(labelsHash(db, split)).toBe(h1);
      expect(labelsHash(db, other)).toBe(labelsHash(db, other));
      upsertLabel(db, 's1', { ...input, note: 'only a note' });
      expect(labelsHash(db, split)).toBe(h1);
      upsertLabel(db, 's1', { ...input, keyPoints: ['a', 'b'] });
      const h2 = labelsHash(db, split);
      expect(h2).not.toBe(h1);
      db.prepare(`UPDATE session_labels SET deleted_at = '2026-02-01' WHERE session_id = 's1'`).run();
      expect(labelsHash(db, split)).toBe(labelsHash(db, other));
      expect(empty).toBe(labelsHash(db, other));
      expect(Object.keys(labelsHashes(db)).sort()).toEqual(['test', 'train', 'validation']);
    });
  });

  describe('DB-backed prompt lookup', () => {
    const student = providerIdentity('mistral', 'm1');
    const key = identityKey(student);

    it('resolves the active version for exactly (target, identity)', () => {
      const lookup = createDbPromptLookup(() => db);
      expect(resolveAnalysisPrompt(T, student, { lookup })).toEqual({ components: {}, versionId: null });
      const v = createVersion(db, { target: T, identityKey: key, components: { frictionGuidance: 'tuned' } });
      expect(resolveAnalysisPrompt(T, student, { lookup }).versionId).toBeNull();
      setActiveVersion(db, T, key, v.id);
      const resolved = resolveAnalysisPrompt(T, student, { lookup });
      expect(resolved.versionId).toBe(v.id);
      const otherStudent = providerIdentity('mistral', 'm2');
      expect(resolveAnalysisPrompt(T, otherStudent, { lookup }).versionId).toBeNull();
      clearActiveVersion(db, T, key);
      expect(resolveAnalysisPrompt(T, student, { lookup }).versionId).toBeNull();
    });

    it('returns null when no db is available or components_json is corrupt', () => {
      expect(createDbPromptLookup(() => null)(T, key)).toBeNull();
      const v = createVersion(db, { target: T, identityKey: key, components: {} });
      setActiveVersion(db, T, key, v.id);
      db.prepare(`UPDATE prompt_versions SET components_json = '{oops' WHERE id = ?`).run(v.id);
      expect(createDbPromptLookup(() => db)(T, key)).toBeNull();
    });

    it('returns null on a database that predates v20', () => {
      const old = new Database(':memory:');
      expect(createDbPromptLookup(() => old)(T, key)).toBeNull();
      old.close();
    });
  });

  describe('gate scores', () => {
    const row = (subject: 'candidate' | 'baseline', sessionId: string, scalar: number) => ({
      subject, sessionId, baselineVersionId: null, scores: { outcome: scalar }, scalar, analysis: { summary: sessionId }, error: null,
    });

    it('stores a version summary and replaces gate rows as a complete snapshot', () => {
      const v = createVersion(db, { target: T, identityKey: K, components: {} });
      expect(setVersionTestScores(db, v.id, { candidate: { scalar: 0.5 } }).testScores).toEqual({ candidate: { scalar: 0.5 } });
      expect(() => setVersionTestScores(db, 'nope', {})).toThrow(OptimizationError);

      replaceGateScores(db, v.id, [row('candidate', 's1', 0.9), row('baseline', 's1', 0.4), row('candidate', 's2', 0.5)]);
      expect(listGateScores(db, v.id)).toHaveLength(3);
      expect(listGateScores(db, v.id, { subject: 'baseline' }).map(r => r.sessionId)).toEqual(['s1']);
      expect(listGateScores(db, v.id)[0].analysis).toEqual({ summary: 's1' });

      replaceGateScores(db, v.id, [row('candidate', 's9', 1)]);
      expect(listGateScores(db, v.id).map(r => r.sessionId)).toEqual(['s9']);
    });
  });
});
