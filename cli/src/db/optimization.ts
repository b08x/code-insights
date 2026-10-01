/**
 * Persistence for the prompt optimization engine (v20 tables).
 *
 * Plain typed functions over better-sqlite3, db first (same shape as db/labels.ts). No engine
 * logic lives here: the promote gate, scoring and scheduling build on these. The only rules
 * enforced at this layer are storage invariants: an active version must exist and belong to the
 * same (target, identity) it is activated for, a round and its per-session scores are written
 * atomically, and a restart can never leave a run "running" forever.
 *
 * JSON columns are parsed on read and serialized on write; callers deal in typed objects.
 */

import { createHash, randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './client.js';
import { ANALYSIS_VERSION } from '../analysis/analysis-db.js';
import type { GuidanceComponents } from '../analysis/prompts.js';
import { SPLITS, type Split } from '../optimization/splits.js';

export class OptimizationError extends Error {
  constructor(public code: 'not_found' | 'version_mismatch', message: string) {
    super(message);
    this.name = 'OptimizationError';
  }
}

const now = () => new Date().toISOString();
const toJson = (v: unknown) => JSON.stringify(v);
const toJsonOrNull = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
function fromJson<T>(raw: string | null): T | null {
  return raw === null || raw === undefined ? null : (JSON.parse(raw) as T);
}

// ── Runs ────────────────────────────────────────────────────────────────────

/**
 * queued/running are in-process states and are failed by markStaleRunsFailed after a restart.
 * awaiting_batch survives restarts: its provider batches are persisted in batch_jobs and polling resumes.
 */
export type RunStatus = 'queued' | 'running' | 'awaiting_batch' | 'completed' | 'failed' | 'cancelled';
const TERMINAL_STATUSES: readonly RunStatus[] = ['completed', 'failed', 'cancelled'];

export interface OptimizationRun {
  id: string;
  target: string;
  identityKey: string;
  teacher: string;
  judgeModel: string;
  mode: string;
  status: RunStatus;
  caps: Record<string, unknown>;
  estimate: Record<string, unknown> | null;
  bestCandidateId: string | null;
  /** Per-split labels hash at run start (carry-forward 5). */
  labelsHash: Partial<Record<Split, string>> | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

interface RunRow {
  id: string; target: string; identity_key: string; teacher: string; judge_model: string; mode: string;
  status: string; caps_json: string; estimate_json: string | null; best_candidate_id: string | null;
  labels_hash_json: string | null; error: string | null; started_at: string; finished_at: string | null;
}

function toRun(r: RunRow): OptimizationRun {
  return {
    id: r.id, target: r.target, identityKey: r.identity_key, teacher: r.teacher, judgeModel: r.judge_model,
    mode: r.mode, status: r.status as RunStatus, caps: fromJson(r.caps_json) ?? {},
    estimate: fromJson(r.estimate_json), bestCandidateId: r.best_candidate_id,
    labelsHash: fromJson(r.labels_hash_json), error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
  };
}

export interface CreateRunInput {
  id?: string;
  target: string;
  identityKey: string;
  teacher: string;
  judgeModel: string;
  mode: string;
  caps?: Record<string, unknown>;
  estimate?: Record<string, unknown> | null;
  labelsHash?: Partial<Record<Split, string>> | null;
}

export function createRun(db: Database.Database = getDb(), input: CreateRunInput): OptimizationRun {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO optimization_runs (id, target, identity_key, teacher, judge_model, mode, status, caps_json, estimate_json, labels_hash_json, started_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`
  ).run(id, input.target, input.identityKey, input.teacher, input.judgeModel, input.mode,
    toJson(input.caps ?? {}), toJsonOrNull(input.estimate), toJsonOrNull(input.labelsHash), now());
  return getRun(db, id)!;
}

export function getRun(db: Database.Database = getDb(), id: string): OptimizationRun | null {
  const row = db.prepare('SELECT * FROM optimization_runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}

export interface RunPatch {
  status?: RunStatus;
  estimate?: Record<string, unknown> | null;
  bestCandidateId?: string | null;
  labelsHash?: Partial<Record<Split, string>> | null;
  error?: string | null;
  /** Defaults to now when status becomes terminal and the run has none. */
  finishedAt?: string | null;
}

export function updateRun(db: Database.Database = getDb(), id: string, patch: RunPatch): OptimizationRun {
  const existing = getRun(db, id);
  if (!existing) throw new OptimizationError('not_found', `Optimization run not found: ${id}`);
  const status = patch.status ?? existing.status;
  let finishedAt = patch.finishedAt !== undefined ? patch.finishedAt : existing.finishedAt;
  if (finishedAt === null && TERMINAL_STATUSES.includes(status)) finishedAt = now();
  db.prepare(
    `UPDATE optimization_runs SET status = ?, estimate_json = ?, best_candidate_id = ?, labels_hash_json = ?, error = ?, finished_at = ? WHERE id = ?`
  ).run(
    status,
    toJsonOrNull(patch.estimate !== undefined ? patch.estimate : existing.estimate),
    patch.bestCandidateId !== undefined ? patch.bestCandidateId : existing.bestCandidateId,
    toJsonOrNull(patch.labelsHash !== undefined ? patch.labelsHash : existing.labelsHash),
    patch.error !== undefined ? patch.error : existing.error,
    finishedAt,
    id,
  );
  return getRun(db, id)!;
}

export function listRuns(
  db: Database.Database = getDb(),
  opts: { target?: string; identityKey?: string; status?: RunStatus; limit?: number } = {},
): OptimizationRun[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.target) { where.push('target = ?'); params.push(opts.target); }
  if (opts.identityKey) { where.push('identity_key = ?'); params.push(opts.identityKey); }
  if (opts.status) { where.push('status = ?'); params.push(opts.status); }
  const sql = `SELECT * FROM optimization_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY started_at DESC, rowid DESC LIMIT ?`;
  params.push(opts.limit ?? 100);
  return (db.prepare(sql).all(...params) as RunRow[]).map(toRun);
}

/**
 * Boot recovery: runs execute in-process, so any queued/running row at startup belongs to a
 * process that no longer exists. Marks them failed (awaiting_batch runs are left for resume).
 * Returns the number of runs failed.
 */
export function markStaleRunsFailed(db: Database.Database = getDb()): number {
  return db.prepare(
    `UPDATE optimization_runs SET status = 'failed', error = 'interrupted: the process stopped before this run finished', finished_at = ?
     WHERE status IN ('queued', 'running')`
  ).run(now()).changes;
}

// ── Rounds and per-session scores ───────────────────────────────────────────

export interface SessionScoreInput {
  sessionId: string;
  scores: Record<string, number>;
  scalar?: number | null;
}

export interface AppendRoundInput {
  id?: string;
  runId: string;
  round: number;
  candidateId: string;
  parentCandidateId?: string | null;
  components: Record<string, string>;
  scores: Record<string, number>;
  scalar?: number | null;
  accepted?: boolean;
  rationales?: unknown;
  tokens?: number;
  costUsd?: number | null;
  /** Per-session, per-objective scores for this candidate (carry-forward 4). */
  sessionScores?: SessionScoreInput[];
}

export interface OptimizationRound {
  id: string;
  runId: string;
  round: number;
  candidateId: string;
  parentCandidateId: string | null;
  components: Record<string, string>;
  scores: Record<string, number>;
  scalar: number | null;
  accepted: boolean;
  rationales: unknown;
  tokens: number;
  costUsd: number | null;
  createdAt: string;
}

interface RoundRow {
  id: string; run_id: string; round: number; candidate_id: string; parent_candidate_id: string | null;
  components_json: string; scores_json: string; scalar: number | null; accepted: number;
  rationales_json: string | null; tokens: number; cost_usd: number | null; created_at: string;
}

function toRound(r: RoundRow): OptimizationRound {
  return {
    id: r.id, runId: r.run_id, round: r.round, candidateId: r.candidate_id, parentCandidateId: r.parent_candidate_id,
    components: fromJson(r.components_json) ?? {}, scores: fromJson(r.scores_json) ?? {}, scalar: r.scalar,
    accepted: r.accepted === 1, rationales: fromJson(r.rationales_json), tokens: r.tokens, costUsd: r.cost_usd,
    createdAt: r.created_at,
  };
}

/** Writes the round and its per-session scores in one transaction. */
export function appendRound(db: Database.Database = getDb(), input: AppendRoundInput): OptimizationRound {
  const id = input.id ?? randomUUID();
  const createdAt = now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO optimization_rounds (id, run_id, round, candidate_id, parent_candidate_id, components_json, scores_json, scalar, accepted, rationales_json, tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, input.runId, input.round, input.candidateId, input.parentCandidateId ?? null,
      toJson(input.components), toJson(input.scores), input.scalar ?? null, input.accepted ? 1 : 0,
      toJsonOrNull(input.rationales), input.tokens ?? 0, input.costUsd ?? null, createdAt);
    const ins = db.prepare(
      `INSERT INTO candidate_session_scores (round_id, candidate_id, session_id, scores_json, scalar, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const s of input.sessionScores ?? []) ins.run(id, input.candidateId, s.sessionId, toJson(s.scores), s.scalar ?? null, createdAt);
  })();
  return toRound(db.prepare('SELECT * FROM optimization_rounds WHERE id = ?').get(id) as RoundRow);
}

export function listRounds(db: Database.Database = getDb(), runId: string): OptimizationRound[] {
  return (db.prepare('SELECT * FROM optimization_rounds WHERE run_id = ? ORDER BY round, rowid').all(runId) as RoundRow[]).map(toRound);
}

export interface CandidateSessionScore {
  roundId: string;
  candidateId: string;
  sessionId: string;
  scores: Record<string, number>;
  scalar: number | null;
  createdAt: string;
}

export function listSessionScores(
  db: Database.Database = getDb(),
  opts: { roundId?: string; runId?: string; candidateId?: string },
): CandidateSessionScore[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.roundId) { where.push('s.round_id = ?'); params.push(opts.roundId); }
  if (opts.runId) { where.push('r.run_id = ?'); params.push(opts.runId); }
  if (opts.candidateId) { where.push('s.candidate_id = ?'); params.push(opts.candidateId); }
  const rows = db.prepare(
    `SELECT s.* FROM candidate_session_scores s JOIN optimization_rounds r ON r.id = s.round_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.round, r.rowid, s.session_id`
  ).all(...params) as Array<{ round_id: string; candidate_id: string; session_id: string; scores_json: string; scalar: number | null; created_at: string }>;
  return rows.map(s => ({
    roundId: s.round_id, candidateId: s.candidate_id, sessionId: s.session_id,
    scores: fromJson(s.scores_json) ?? {}, scalar: s.scalar, createdAt: s.created_at,
  }));
}

// ── Prompt versions ─────────────────────────────────────────────────────────

export interface PromptVersion {
  id: string;
  target: string;
  identityKey: string;
  components: GuidanceComponents;
  parentVersionId: string | null;
  sourceRunId: string | null;
  judgeModel: string | null;
  weights: Record<string, number> | null;
  testScores: Record<string, unknown> | null;
  /** ANALYSIS_VERSION the version was tuned against. */
  analysisVersion: string | null;
  createdAt: string;
}

interface VersionRow {
  id: string; target: string; identity_key: string; components_json: string; parent_version_id: string | null;
  source_run_id: string | null; judge_model: string | null; weights_json: string | null;
  test_scores_json: string | null; analysis_version: string | null; created_at: string;
}

function toVersion(r: VersionRow): PromptVersion {
  return {
    id: r.id, target: r.target, identityKey: r.identity_key, components: JSON.parse(r.components_json) as GuidanceComponents,
    parentVersionId: r.parent_version_id, sourceRunId: r.source_run_id, judgeModel: r.judge_model,
    weights: fromJson(r.weights_json), testScores: fromJson(r.test_scores_json),
    analysisVersion: r.analysis_version, createdAt: r.created_at,
  };
}

export interface CreateVersionInput {
  id?: string;
  target: string;
  identityKey: string;
  components: GuidanceComponents;
  parentVersionId?: string | null;
  sourceRunId?: string | null;
  judgeModel?: string | null;
  weights?: Record<string, number> | null;
  testScores?: Record<string, unknown> | null;
  /** Defaults to the current ANALYSIS_VERSION. */
  analysisVersion?: string | null;
}

export function createVersion(db: Database.Database = getDb(), input: CreateVersionInput): PromptVersion {
  const id = input.id ?? randomUUID();
  db.prepare(
    `INSERT INTO prompt_versions (id, target, identity_key, components_json, parent_version_id, source_run_id, judge_model, weights_json, test_scores_json, analysis_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.target, input.identityKey, toJson(input.components), input.parentVersionId ?? null,
    input.sourceRunId ?? null, input.judgeModel ?? null, toJsonOrNull(input.weights), toJsonOrNull(input.testScores),
    input.analysisVersion === undefined ? ANALYSIS_VERSION : input.analysisVersion, now());
  return getVersion(db, id)!;
}

export function getVersion(db: Database.Database = getDb(), id: string): PromptVersion | null {
  const row = db.prepare('SELECT * FROM prompt_versions WHERE id = ?').get(id) as VersionRow | undefined;
  return row ? toVersion(row) : null;
}

/** Replaces a version's stored test-gate summary (the gate re-runs overwrite it). */
export function setVersionTestScores(db: Database.Database = getDb(), versionId: string, testScores: Record<string, unknown> | null): PromptVersion {
  const res = db.prepare('UPDATE prompt_versions SET test_scores_json = ? WHERE id = ?').run(toJsonOrNull(testScores), versionId);
  if (res.changes === 0) throw new OptimizationError('not_found', `Prompt version not found: ${versionId}`);
  return getVersion(db, versionId)!;
}

/** Newest first. */
export function listVersions(
  db: Database.Database = getDb(),
  opts: { target?: string; identityKey?: string } = {},
): PromptVersion[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.target) { where.push('target = ?'); params.push(opts.target); }
  if (opts.identityKey) { where.push('identity_key = ?'); params.push(opts.identityKey); }
  return (db.prepare(
    `SELECT * FROM prompt_versions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC`
  ).all(...params) as VersionRow[]).map(toVersion);
}

/** The version, then its parent, then the parent's parent... Stops at a missing parent or a cycle. */
export function getLineage(db: Database.Database = getDb(), versionId: string): PromptVersion[] {
  const chain: PromptVersion[] = [];
  const seen = new Set<string>();
  let next: string | null = versionId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const v = getVersion(db, next);
    if (!v) break;
    chain.push(v);
    next = v.parentVersionId;
  }
  return chain;
}

// ── Test-gate session scores ────────────────────────────────────────────────

export type GateSubject = 'candidate' | 'baseline';

export interface GateSessionScore {
  versionId: string;
  subject: GateSubject;
  sessionId: string;
  /** The baseline this row was compared against; null = built-in prompt. */
  baselineVersionId: string | null;
  scores: Record<string, number>;
  scalar: number | null;
  /** The compact analysis the judge saw (side-by-side view); null when the pipeline failed. */
  analysis: unknown;
  error: string | null;
  createdAt: string;
}

export type GateSessionScoreInput = Omit<GateSessionScore, 'versionId' | 'createdAt'>;

/** Replaces every gate row of a version in one transaction: a gate is a complete snapshot, never a merge. */
export function replaceGateScores(db: Database.Database = getDb(), versionId: string, rows: GateSessionScoreInput[]): void {
  db.transaction(() => {
    db.prepare('DELETE FROM gate_session_scores WHERE version_id = ?').run(versionId);
    const ins = db.prepare(
      `INSERT INTO gate_session_scores (version_id, subject, session_id, baseline_version_id, scores_json, scalar, analysis_json, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const ts = now();
    for (const r of rows) {
      ins.run(versionId, r.subject, r.sessionId, r.baselineVersionId, toJson(r.scores), r.scalar, toJsonOrNull(r.analysis), r.error, ts);
    }
  })();
}

export function listGateScores(db: Database.Database = getDb(), versionId: string, opts: { subject?: GateSubject } = {}): GateSessionScore[] {
  const rows = db.prepare(
    `SELECT * FROM gate_session_scores WHERE version_id = ? ${opts.subject ? 'AND subject = ?' : ''} ORDER BY session_id, subject`
  ).all(...(opts.subject ? [versionId, opts.subject] : [versionId])) as Array<{
    version_id: string; subject: GateSubject; session_id: string; baseline_version_id: string | null;
    scores_json: string; scalar: number | null; analysis_json: string | null; error: string | null; created_at: string;
  }>;
  return rows.map(r => ({
    versionId: r.version_id, subject: r.subject, sessionId: r.session_id, baselineVersionId: r.baseline_version_id,
    scores: fromJson(r.scores_json) ?? {}, scalar: r.scalar, analysis: fromJson(r.analysis_json), error: r.error, createdAt: r.created_at,
  }));
}

// ── Active versions ─────────────────────────────────────────────────────────

export interface ActiveVersionRef {
  target: string;
  identityKey: string;
  versionId: string;
  promotedAt: string;
}

export function getActivePromptVersion(db: Database.Database = getDb(), target: string, identityKey: string): PromptVersion | null {
  const row = db.prepare(
    `SELECT v.* FROM active_prompt_versions a JOIN prompt_versions v ON v.id = a.version_id
     WHERE a.target = ? AND a.identity_key = ?`
  ).get(target, identityKey) as VersionRow | undefined;
  return row ? toVersion(row) : null;
}

export function listActiveVersions(db: Database.Database = getDb()): ActiveVersionRef[] {
  return (db.prepare('SELECT * FROM active_prompt_versions ORDER BY target, identity_key').all() as Array<{
    target: string; identity_key: string; version_id: string; promoted_at: string;
  }>).map(r => ({ target: r.target, identityKey: r.identity_key, versionId: r.version_id, promotedAt: r.promoted_at }));
}

/**
 * Storage-level promote: makes `versionId` the active version for (target, identityKey).
 * Rejects an unknown version, and a version whose own (target, identity) differs, because the
 * resolver would never apply it (carrying a version to a new student means creating a child
 * version for that identity). Whether promotion is *allowed* (test gate) is decided elsewhere.
 * Rollback is promoting the previous version.
 */
export function setActiveVersion(db: Database.Database = getDb(), target: string, identityKey: string, versionId: string): void {
  const v = getVersion(db, versionId);
  if (!v) throw new OptimizationError('not_found', `Prompt version not found: ${versionId}`);
  if (v.target !== target || v.identityKey !== identityKey) {
    throw new OptimizationError(
      'version_mismatch',
      `Version ${versionId} belongs to (${v.target}, ${v.identityKey}), not (${target}, ${identityKey}).`,
    );
  }
  db.prepare(
    `INSERT INTO active_prompt_versions (target, identity_key, version_id, promoted_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(target, identity_key) DO UPDATE SET version_id = excluded.version_id, promoted_at = excluded.promoted_at`
  ).run(target, identityKey, versionId, now());
}

/** Back to the built-in prompt for this (target, identity). Returns whether a version was active. */
export function clearActiveVersion(db: Database.Database = getDb(), target: string, identityKey: string): boolean {
  return db.prepare('DELETE FROM active_prompt_versions WHERE target = ? AND identity_key = ?').run(target, identityKey).changes > 0;
}

// ── Judge cache and audits ──────────────────────────────────────────────────

/** Keyed by judge model too, so switching the judge never serves another model's verdicts. */
export function getJudgeCache<T = unknown>(
  db: Database.Database = getDb(), outputHash: string, keyPointsHash: string, judgeModel: string,
): T | null {
  const row = db.prepare(
    'SELECT result_json FROM judge_cache WHERE output_hash = ? AND key_points_hash = ? AND judge_model = ?'
  ).get(outputHash, keyPointsHash, judgeModel) as { result_json: string } | undefined;
  return row ? (JSON.parse(row.result_json) as T) : null;
}

export function putJudgeCache(
  db: Database.Database = getDb(), outputHash: string, keyPointsHash: string, judgeModel: string, result: unknown,
): void {
  db.prepare(
    `INSERT INTO judge_cache (output_hash, key_points_hash, judge_model, result_json, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(output_hash, key_points_hash, judge_model) DO UPDATE SET result_json = excluded.result_json, created_at = excluded.created_at`
  ).run(outputHash, keyPointsHash, judgeModel, toJson(result), now());
}

export interface JudgeAudit {
  id: string;
  roundId: string | null;
  sessionId: string;
  item: string;
  judgeDecision: string;
  /** Same vocabulary as judgeDecision; null until the user reviews it. */
  humanDecision: string | null;
  createdAt: string;
}

interface AuditRow {
  id: string; round_id: string | null; session_id: string; item: string; judge_decision: string;
  human_decision: string | null; created_at: string;
}

const toAudit = (r: AuditRow): JudgeAudit => ({
  id: r.id, roundId: r.round_id, sessionId: r.session_id, item: r.item, judgeDecision: r.judge_decision,
  humanDecision: r.human_decision, createdAt: r.created_at,
});

export function addJudgeAudit(
  db: Database.Database = getDb(),
  input: { roundId?: string | null; sessionId: string; item: string; judgeDecision: string },
): JudgeAudit {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO judge_audits (id, round_id, session_id, item, judge_decision, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, input.roundId ?? null, input.sessionId, input.item, input.judgeDecision, now());
  return toAudit(db.prepare('SELECT * FROM judge_audits WHERE id = ?').get(id) as AuditRow);
}

export function setHumanDecision(db: Database.Database = getDb(), id: string, humanDecision: string): JudgeAudit {
  const res = db.prepare('UPDATE judge_audits SET human_decision = ? WHERE id = ?').run(humanDecision, id);
  if (res.changes === 0) throw new OptimizationError('not_found', `Judge audit not found: ${id}`);
  return toAudit(db.prepare('SELECT * FROM judge_audits WHERE id = ?').get(id) as AuditRow);
}

export function listJudgeAudits(
  db: Database.Database = getDb(),
  opts: { roundId?: string; unreviewedOnly?: boolean; limit?: number } = {},
): JudgeAudit[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.roundId) { where.push('round_id = ?'); params.push(opts.roundId); }
  if (opts.unreviewedOnly) where.push('human_decision IS NULL');
  params.push(opts.limit ?? 500);
  return (db.prepare(
    `SELECT * FROM judge_audits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rowid LIMIT ?`
  ).all(...params) as AuditRow[]).map(toAudit);
}

/** Judge-vs-human agreement over reviewed audits; rate is null when nothing has been reviewed. */
export function judgeAgreement(
  db: Database.Database = getDb(), opts: { roundId?: string } = {},
): { reviewed: number; agreed: number; rate: number | null } {
  const row = db.prepare(
    `SELECT COUNT(*) AS reviewed, COALESCE(SUM(judge_decision = human_decision), 0) AS agreed
     FROM judge_audits WHERE human_decision IS NOT NULL ${opts.roundId ? 'AND round_id = ?' : ''}`
  ).get(...(opts.roundId ? [opts.roundId] : [])) as { reviewed: number; agreed: number };
  return { reviewed: row.reviewed, agreed: row.agreed, rate: row.reviewed ? row.agreed / row.reviewed : null };
}

// ── Batch jobs ──────────────────────────────────────────────────────────────

/** Open = still needs polling. */
const CLOSED_BATCH_STATUSES = ['completed', 'failed', 'cancelled', 'expired'] as const;

export interface BatchJob {
  jobId: string;
  provider: string;
  model: string;
  /** What the job belongs to, e.g. 'run' | 'preanalyze' | 'gate'. */
  ownerKind: string;
  ownerId: string;
  customIds: string[];
  status: string;
  submittedAt: string;
  updatedAt: string;
}

interface BatchRow {
  job_id: string; provider: string; model: string; owner_kind: string; owner_id: string;
  custom_ids_json: string; status: string; submitted_at: string; updated_at: string;
}

const toBatch = (r: BatchRow): BatchJob => ({
  jobId: r.job_id, provider: r.provider, model: r.model, ownerKind: r.owner_kind, ownerId: r.owner_id,
  customIds: fromJson<string[]>(r.custom_ids_json) ?? [], status: r.status, submittedAt: r.submitted_at, updatedAt: r.updated_at,
});

export function createBatchJob(
  db: Database.Database = getDb(),
  input: { jobId: string; provider: string; model: string; ownerKind: string; ownerId: string; customIds: string[]; status?: string },
): BatchJob {
  const ts = now();
  db.prepare(
    `INSERT INTO batch_jobs (job_id, provider, model, owner_kind, owner_id, custom_ids_json, status, submitted_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(input.jobId, input.provider, input.model, input.ownerKind, input.ownerId, toJson(input.customIds), input.status ?? 'submitted', ts, ts);
  return getBatchJob(db, input.jobId)!;
}

export function getBatchJob(db: Database.Database = getDb(), jobId: string): BatchJob | null {
  const row = db.prepare('SELECT * FROM batch_jobs WHERE job_id = ?').get(jobId) as BatchRow | undefined;
  return row ? toBatch(row) : null;
}

export function updateBatchJob(db: Database.Database = getDb(), jobId: string, patch: { status: string }): BatchJob {
  const res = db.prepare('UPDATE batch_jobs SET status = ?, updated_at = ? WHERE job_id = ?').run(patch.status, now(), jobId);
  if (res.changes === 0) throw new OptimizationError('not_found', `Batch job not found: ${jobId}`);
  return getBatchJob(db, jobId)!;
}

export function listBatchJobs(
  db: Database.Database = getDb(),
  opts: { ownerKind?: string; ownerId?: string; openOnly?: boolean } = {},
): BatchJob[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.ownerKind) { where.push('owner_kind = ?'); params.push(opts.ownerKind); }
  if (opts.ownerId) { where.push('owner_id = ?'); params.push(opts.ownerId); }
  if (opts.openOnly) {
    where.push(`status NOT IN (${CLOSED_BATCH_STATUSES.map(() => '?').join(',')})`);
    params.push(...CLOSED_BATCH_STATUSES);
  }
  return (db.prepare(
    `SELECT * FROM batch_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY submitted_at, rowid`
  ).all(...params) as BatchRow[]).map(toBatch);
}

export function deleteBatchJob(db: Database.Database = getDb(), jobId: string): boolean {
  return db.prepare('DELETE FROM batch_jobs WHERE job_id = ?').run(jobId).changes > 0;
}

// ── Labels hash ─────────────────────────────────────────────────────────────

/**
 * Content hash of the live labels in one split. Labels are edited in place, so a run or gate
 * result records this to show which label state it was scored against. Covers only what scoring
 * reads (outcome, categories, key points, forbidden claims); notes and timestamps are ignored.
 */
export function labelsHash(db: Database.Database = getDb(), split: Split): string {
  const rows = db.prepare(
    `SELECT session_id, outcome, friction_categories_json, pattern_categories_json, key_points_json, forbidden_claims_json
     FROM session_labels WHERE split = ? AND deleted_at IS NULL ORDER BY session_id`
  ).all(split);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

export function labelsHashes(db: Database.Database = getDb()): Record<Split, string> {
  return Object.fromEntries(SPLITS.map(s => [s, labelsHash(db, s)])) as Record<Split, string>;
}
