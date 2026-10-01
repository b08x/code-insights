/**
 * Test gate, promotion and adoption with a fake student and judge (see engine-fixtures.ts).
 * The fake student analyzes well only when the candidate guidance contains GOOD (and "revision 3"
 * for the pattern categories), so a GOOD version beats the built-in prompt.
 */
import type Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createVersion, getActivePromptVersion, getVersion, listActiveVersions, listGateScores, setActiveVersion,
} from '../../db/optimization.js';
import {
  adoptForIdentity, checkPromotion, GateError, promoteVersion, readGate, runGate, type GateDeps,
} from '../gate.js';
import { providerIdentity, identityKey, type StudentIdentity } from '../identity.js';
import {
  S, fakeBackend, fakeJudgeFactory, fakeStudent, memoryDb, nativeStudent, noSleep, seedLabels, student, addLabel, type Splits,
} from './engine-fixtures.js';

const KEY = identityKey(student);
const GOOD_COMPONENTS = { frictionGuidance: 'GOOD friction guidance', patternGuidance: 'GOOD guidance revision 3' };
const PLAIN_COMPONENTS = { frictionGuidance: 'plain friction guidance', patternGuidance: 'plain pattern guidance' };

let db: Database.Database;
let splits: Splits;
beforeEach(() => { db = memoryDb(); splits = seedLabels(db); });
afterEach(() => db.close());

/** Deps for a fake student of `studentIdentity` (default: the provider:mistral student). */
function gateDeps(over: Partial<GateDeps> = {}, studentIdentity?: StudentIdentity) {
  const st = fakeStudent({ identity: studentIdentity });
  const judge = fakeJudgeFactory().createJudge({ get: () => null, put: () => {} });
  const deps: GateDeps = { runner: st.runner, judge, pipeline: st.pipeline as never, concurrency: 1, sleep: noSleep, retry: { baseDelayMs: 0, sleep: noSleep }, ...over };
  return { st, deps };
}

const version = (components = GOOD_COMPONENTS, identity = KEY) => createVersion(db, { target: S, identityKey: identity, components });

describe('runGate', () => {
  it('scores the candidate and the built-in baseline on the test split only and stores the result', async () => {
    const v = version();
    const { st, deps } = gateDeps();
    const gate = await runGate(db, v.id, deps);

    // Test split only: every analyzed session is a test session, twice (candidate + baseline).
    expect(new Set(st.analyzed)).toEqual(new Set(splits.test));
    expect(st.analyzed).toHaveLength(splits.test.length * 2);
    expect(gate.summary.sessions).toBe(splits.test.length);
    expect(gate.summary.indicative).toBe(true);
    expect(gate.summary.baseline.versionId).toBeNull();
    expect(gate.summary.candidate.scalar).toBeGreaterThan(gate.summary.baseline.scalar);
    expect(gate.summary.beatsBaseline).toBe(true);
    expect(gate.summary.delta).toBeCloseTo(gate.summary.candidate.scalar - gate.summary.baseline.scalar, 5);
    expect(gate.summary.judgeModel).toBe('fake-judge');
    expect(gate.summary.mode).toBe('sync');

    // Per-session rows for both subjects, with the analysis the judge saw, and the summary on the version.
    expect(listGateScores(db, v.id)).toHaveLength(splits.test.length * 2);
    expect(gate.sessions.map(s => s.sessionId)).toEqual([...splits.test].sort());
    for (const s of gate.sessions) {
      expect(s.delta).toBeGreaterThan(0);
      expect(s.candidate.analysis).toMatchObject({ friction_points: expect.any(Array) });
    }
    expect(getVersion(db, v.id)!.testScores).toMatchObject({ beatsBaseline: true, sessions: splits.test.length });
    expect(readGate(db, v.id)!.summary).toEqual(gate.summary);
  });

  it('uses the active version as the baseline, and the built-in prompt when the candidate is the active one', async () => {
    const active = version(PLAIN_COMPONENTS);
    setActiveVersion(db, S, KEY, active.id);
    const candidate = version();
    const g1 = await runGate(db, candidate.id, gateDeps().deps);
    expect(g1.summary.baseline.versionId).toBe(active.id);
    expect(listGateScores(db, candidate.id).every(r => r.baselineVersionId === active.id)).toBe(true);

    const g2 = await runGate(db, active.id, gateDeps().deps);
    expect(g2.summary.baseline.versionId).toBeNull();
  });

  it('replaces the previous gate rows when run again', async () => {
    const v = version();
    await runGate(db, v.id, gateDeps().deps);
    addLabel(db, 'te-extra', 'test');
    await runGate(db, v.id, gateDeps().deps);
    expect(listGateScores(db, v.id)).toHaveLength((splits.test.length + 1) * 2);
    expect(readGate(db, v.id)!.summary.sessions).toBe(splits.test.length + 1);
  });

  it('runs both evaluations through the batch API when a backend is given', async () => {
    const v = version();
    const fb = fakeBackend();
    const { deps } = gateDeps({ batch: fb.backend, pollIntervalMs: 1 });
    const gate = await runGate(db, v.id, deps);
    expect(gate.summary.mode).toBe('batch');
    expect(fb.jobs()).toBeGreaterThanOrEqual(2);
    expect(gate.summary.candidate.scalar).toBeGreaterThan(gate.summary.baseline.scalar);
  });

  it('refuses without test labels, for an unknown version, a mismatched runner or an unusable version', async () => {
    const empty = memoryDb();
    seedLabels(empty, { train: 2, validation: 2, test: 0 });
    const v0 = createVersion(empty, { target: S, identityKey: KEY, components: GOOD_COMPONENTS });
    await expect(runGate(empty, v0.id, gateDeps().deps)).rejects.toMatchObject({ code: 'no_test_labels' });
    empty.close();

    await expect(runGate(db, 'nope', gateDeps().deps)).rejects.toMatchObject({ code: 'not_found' });
    const native = version(GOOD_COMPONENTS, identityKey(nativeStudent));
    await expect(runGate(db, native.id, gateDeps().deps)).rejects.toMatchObject({ code: 'identity_mismatch' });
    const tooLong = version({ frictionGuidance: 'x'.repeat(9000) });
    await expect(runGate(db, tooLong.id, gateDeps().deps)).rejects.toMatchObject({ code: 'invalid_version' });
  });

  it('stores nothing when cancelled or stopped on a cap', async () => {
    const v = version();
    const controller = new AbortController();
    const aborting = gateDeps({ signal: controller.signal });
    const original = aborting.st.runner.runAnalysis;
    aborting.st.runner.runAnalysis = async p => { controller.abort(); return original(p); };
    await expect(runGate(db, v.id, aborting.deps)).rejects.toMatchObject({ code: 'aborted' });
    expect(getVersion(db, v.id)!.testScores).toBeNull();
    expect(listGateScores(db, v.id)).toHaveLength(0);

    await expect(runGate(db, v.id, gateDeps({ caps: { maxTokens: 1000 } }).deps)).rejects.toMatchObject({ code: 'incomplete' });
    expect(getVersion(db, v.id)!.testScores).toBeNull();
  });

  it('allows gating a native-label identity (it just cannot be promoted)', async () => {
    const native = version(GOOD_COMPONENTS, identityKey(nativeStudent));
    const gate = await runGate(db, native.id, gateDeps({}, nativeStudent).deps);
    expect(gate.summary.mode).toBe('cli');
    expect(() => promoteVersion(db, native.id, { override: true })).toThrow(/CLI's own default model/);
  });
});

describe('promoteVersion', () => {
  it('promotes a version that beats the baseline and records the replaced one', async () => {
    const old = version(PLAIN_COMPONENTS);
    setActiveVersion(db, S, KEY, old.id);
    const v = version();
    await runGate(db, v.id, gateDeps().deps);

    const check = checkPromotion(db, v.id);
    expect(check).toMatchObject({ ok: true, blockers: [], activeVersionId: old.id });
    const result = promoteVersion(db, v.id);
    expect(result).toMatchObject({ versionId: v.id, previousVersionId: old.id, overridden: false });
    expect(getActivePromptVersion(db, S, KEY)!.id).toBe(v.id);
    expect(listActiveVersions(db)).toHaveLength(1);
  });

  it('rejects a version whose weighted score does not beat the baseline unless override is true', async () => {
    const v = version(PLAIN_COMPONENTS);
    await runGate(db, v.id, gateDeps().deps);
    expect(readGate(db, v.id)!.summary.beatsBaseline).toBe(false); // equal to the built-in: not strictly better

    const check = checkPromotion(db, v.id);
    expect(check).toMatchObject({ ok: false, overridable: true });
    expect(check.blockers.map(b => b.code)).toEqual(['not_better']);
    expect(() => promoteVersion(db, v.id)).toThrow(GateError);
    expect(() => promoteVersion(db, v.id)).toThrow(expect.objectContaining({ code: 'not_better' }));
    expect(getActivePromptVersion(db, S, KEY)).toBeNull();

    const result = promoteVersion(db, v.id, { override: true });
    expect(result.overridden).toBe(true);
    expect(result.overriddenReasons[0]).toMatch(/does not beat/);
    expect(getActivePromptVersion(db, S, KEY)!.id).toBe(v.id);
  });

  it('rejects a version that was never gated, even with override', () => {
    const v = version();
    expect(() => promoteVersion(db, v.id, { override: true })).toThrow(expect.objectContaining({ code: 'not_gated' }));
    expect(() => checkPromotion(db, 'nope')).toThrow(expect.objectContaining({ code: 'not_found' }));
  });

  it('rejects a stale gate: the active version changed, or the test labels changed', async () => {
    const a = version();
    const b = version({ frictionGuidance: 'GOOD other', patternGuidance: 'GOOD guidance revision 4' });
    await runGate(db, a.id, gateDeps().deps);
    await runGate(db, b.id, gateDeps().deps);
    promoteVersion(db, a.id);
    // b was gated against the built-in prompt, but a is active now.
    expect(checkPromotion(db, b.id).blockers.map(x => x.code)).toEqual(['stale_gate']);
    expect(() => promoteVersion(db, b.id)).toThrow(expect.objectContaining({ code: 'stale_gate' }));
    expect(promoteVersion(db, b.id, { override: true }).overridden).toBe(true);

    // Rollback: a gated earlier version needs the override too (it was gated against the built-in prompt).
    expect(promoteVersion(db, a.id, { override: true }).previousVersionId).toBe(b.id);

    const c = version();
    await runGate(db, c.id, gateDeps().deps);
    db.prepare(`UPDATE session_labels SET outcome = 'low' WHERE session_id = ?`).run(splits.test[0]);
    expect(checkPromotion(db, c.id).blockers.map(x => x.code)).toContain('stale_gate');
  });
});

describe('adoptForIdentity', () => {
  const large = providerIdentity('mistral', 'mistral-large-latest');

  it('creates a child version for the new identity, gates it there and allows promotion without a GEPA run', async () => {
    const source = version();
    const { st, deps } = gateDeps({}, large);
    const result = await adoptForIdentity(db, source.id, large, deps);

    expect(result.created).toBe(true);
    expect(result.version).toMatchObject({ identityKey: identityKey(large), parentVersionId: source.id, sourceRunId: null, components: source.components });
    expect(result.gate.summary.candidate.scalar).toBeGreaterThan(result.gate.summary.baseline.scalar);
    expect(new Set(st.analyzed)).toEqual(new Set(splits.test));
    // The source's own identity is untouched; the child can be promoted for the new identity.
    expect(getActivePromptVersion(db, S, KEY)).toBeNull();
    promoteVersion(db, result.version.id);
    expect(getActivePromptVersion(db, S, identityKey(large))!.id).toBe(result.version.id);
  });

  it('reuses an earlier adoption and re-gates it', async () => {
    const source = version();
    const first = await adoptForIdentity(db, source.id, large, gateDeps({}, large).deps);
    const second = await adoptForIdentity(db, source.id, large, gateDeps({}, large).deps);
    expect(second.created).toBe(false);
    expect(second.version.id).toBe(first.version.id);
  });

  it('refuses the same identity, a label identity, a mismatched runner and an unknown version', async () => {
    const source = version();
    await expect(adoptForIdentity(db, source.id, student, gateDeps().deps)).rejects.toMatchObject({ code: 'same_identity' });
    await expect(adoptForIdentity(db, source.id, nativeStudent, gateDeps().deps)).rejects.toMatchObject({ code: 'unstable_identity' });
    await expect(adoptForIdentity(db, source.id, large, gateDeps().deps)).rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(adoptForIdentity(db, 'nope', large, gateDeps().deps)).rejects.toMatchObject({ code: 'not_found' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM prompt_versions').get()).toEqual({ n: 1 });
  });
});
