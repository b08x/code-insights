/**
 * Gold labels for prompt optimization (label-1..label-7).
 *
 * A label is output-independent ground truth for one session: outcome, friction categories,
 * pattern categories, key points the analysis must cover, and forbidden claims it must not make.
 * `split` is assigned once (see optimization/splits.ts) and never changes; the v19 trigger backs
 * this up at the storage layer and the upsert below never writes split on update.
 *
 * Category validation uses the same canonical lists the analysis prompts and normalizers use, so
 * a label can never contain a category the pipeline cannot produce.
 */

import type Database from 'better-sqlite3';
import { getDb } from './client.js';
import { CANONICAL_FRICTION_CATEGORIES, CANONICAL_PATTERN_CATEGORIES } from '../analysis/prompt-constants.js';
import { assignSplit, DEFAULT_SPLIT_SEED, type Split, type SplitAssignment } from '../optimization/splits.js';
import { lengthBucket, LENGTH_BUCKETS, type LengthBucket, type QueueSession } from '../optimization/label-queue.js';

/** Mirrors OutcomeSatisfaction in types.ts (session_facets.outcome_satisfaction). */
export const CANONICAL_OUTCOMES = ['high', 'medium', 'low', 'abandoned'] as const;

const MAX_ITEMS = 50;
const MAX_TEXT = 2000;

export const LABEL_TARGET = 'session-analysis';

/** Coverage targets the progress view measures against. Small on purpose: the test split needs ~6 labels. */
export const COVERAGE_TARGETS = {
  totalLabels: 30,
  perProject: 3,
  perLengthBucket: 5,
} as const;

export interface LabelInput {
  outcome: string;
  frictionCategories: string[];
  patternCategories: string[];
  keyPoints: string[];
  forbiddenClaims: string[];
  note: string | null;
}

export interface SessionLabel extends LabelInput {
  sessionId: string;
  target: string;
  split: Split;
  createdAt: string;
  updatedAt: string;
}

export class LabelError extends Error {
  constructor(public code: 'session_not_found', message: string) {
    super(message);
    this.name = 'LabelError';
  }
}

export type ValidationResult = { ok: true; value: LabelInput } | { ok: false; errors: string[] };

function textList(raw: unknown, field: string, errors: string[]): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) { errors.push(`${field} must be an array of strings`); return []; }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') { errors.push(`${field} must contain only strings`); return []; }
    const t = item.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  if (out.length > MAX_ITEMS) errors.push(`${field} has more than ${MAX_ITEMS} items`);
  if (out.some(t => t.length > MAX_TEXT)) errors.push(`${field} items must be at most ${MAX_TEXT} characters`);
  return out;
}

function categoryList(raw: unknown, field: string, allowed: readonly string[], errors: string[]): string[] {
  const items = textList(raw, field, errors);
  const bad = items.filter(i => !allowed.includes(i));
  if (bad.length) errors.push(`${field} has non-canonical values: ${bad.join(', ')}`);
  return items;
}

export function validateLabelInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['body must be an object'] };
  const r = raw as Record<string, unknown>;
  const errors: string[] = [];

  if (typeof r.outcome !== 'string' || !(CANONICAL_OUTCOMES as readonly string[]).includes(r.outcome)) {
    errors.push(`outcome must be one of: ${CANONICAL_OUTCOMES.join(', ')}`);
  }
  const frictionCategories = categoryList(r.frictionCategories, 'frictionCategories', CANONICAL_FRICTION_CATEGORIES, errors);
  const patternCategories = categoryList(r.patternCategories, 'patternCategories', CANONICAL_PATTERN_CATEGORIES, errors);
  const keyPoints = textList(r.keyPoints, 'keyPoints', errors);
  const forbiddenClaims = textList(r.forbiddenClaims, 'forbiddenClaims', errors);

  let note: string | null = null;
  if (r.note !== undefined && r.note !== null) {
    if (typeof r.note !== 'string') errors.push('note must be a string');
    else if (r.note.length > MAX_TEXT * 5) errors.push('note is too long');
    else note = r.note.trim() || null;
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { outcome: r.outcome as string, frictionCategories, patternCategories, keyPoints, forbiddenClaims, note } };
}

interface LabelRow {
  session_id: string; target: string; outcome: string;
  friction_categories_json: string; pattern_categories_json: string;
  key_points_json: string; forbidden_claims_json: string;
  note: string | null; split: Split; created_at: string; updated_at: string;
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function toLabel(row: LabelRow): SessionLabel {
  return {
    sessionId: row.session_id,
    target: row.target,
    outcome: row.outcome,
    frictionCategories: parseList(row.friction_categories_json),
    patternCategories: parseList(row.pattern_categories_json),
    keyPoints: parseList(row.key_points_json),
    forbiddenClaims: parseList(row.forbidden_claims_json),
    note: row.note,
    split: row.split,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getLabel(db: Database.Database = getDb(), sessionId: string): SessionLabel | null {
  const row = db.prepare('SELECT * FROM session_labels WHERE session_id = ? AND deleted_at IS NULL').get(sessionId) as LabelRow | undefined;
  return row ? toLabel(row) : null;
}

export function listLabels(
  db: Database.Database = getDb(),
  opts: { split?: Split; projectId?: string; usableOnly?: boolean } = {},
): SessionLabel[] {
  const where: string[] = ['l.deleted_at IS NULL'];
  const params: string[] = [];
  if (opts.split) { where.push('l.split = ?'); params.push(opts.split); }
  if (opts.projectId) { where.push('s.project_id = ?'); params.push(opts.projectId); }
  // usableOnly: the session still exists (a purge removes the row) and is not soft-deleted.
  // Orphaned labels stay stored but are not usable for optimization or progress.
  if (opts.usableOnly) where.push('s.id IS NOT NULL AND s.deleted_at IS NULL');
  const rows = db.prepare(
    `SELECT l.* FROM session_labels l LEFT JOIN sessions s ON s.id = l.session_id
     WHERE ${where.join(' AND ')}
     ORDER BY ${opts.usableOnly ? 'l.session_id' : 'l.updated_at DESC, l.session_id'}`
  ).all(...params) as LabelRow[];
  return rows.map(toLabel);
}

/** Soft delete: the row (and its split) is kept so a later re-label restores the same split. */
export function deleteLabel(db: Database.Database = getDb(), sessionId: string): boolean {
  return db.prepare(
    `UPDATE session_labels SET deleted_at = datetime('now'), updated_at = datetime('now')
     WHERE session_id = ? AND deleted_at IS NULL`
  ).run(sessionId).changes > 0;
}

/**
 * Create or edit a label. On first write the split is assigned from the existing assignments;
 * on later writes split and created_at are untouched.
 */
export function upsertLabel(
  db: Database.Database = getDb(),
  sessionId: string,
  input: LabelInput,
  opts: { seed?: string } = {},
): SessionLabel {
  const session = db.prepare('SELECT project_id FROM sessions WHERE id = ? AND deleted_at IS NULL')
    .get(sessionId) as { project_id: string } | undefined;
  if (!session) throw new LabelError('session_not_found', `Session not found: ${sessionId}`);

  const write = db.transaction(() => {
    const existingRows = db.prepare(
      `SELECT l.session_id AS sessionId, COALESCE(s.project_id, '') AS projectId, l.split AS split
       FROM session_labels l LEFT JOIN sessions s ON s.id = l.session_id`
    ).all() as SplitAssignment[];
    const split = assignSplit({
      sessionId, projectId: session.project_id, seed: opts.seed ?? DEFAULT_SPLIT_SEED, existing: existingRows,
    });
    // existingRows deliberately includes soft-deleted labels: their splits still count and a
    // re-label of the same session keeps its original split.
    // split is deliberately absent from the DO UPDATE list: it is write-once.
    db.prepare(
      `INSERT INTO session_labels
         (session_id, target, outcome, friction_categories_json, pattern_categories_json,
          key_points_json, forbidden_claims_json, note, split)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         outcome = excluded.outcome,
         friction_categories_json = excluded.friction_categories_json,
         pattern_categories_json = excluded.pattern_categories_json,
         key_points_json = excluded.key_points_json,
         forbidden_claims_json = excluded.forbidden_claims_json,
         note = excluded.note,
         updated_at = datetime('now'),
         deleted_at = NULL`
    ).run(
      sessionId, LABEL_TARGET, input.outcome,
      JSON.stringify(input.frictionCategories), JSON.stringify(input.patternCategories),
      JSON.stringify(input.keyPoints), JSON.stringify(input.forbiddenClaims), input.note, split,
    );
  });
  write();
  return getLabel(db, sessionId)!;
}

interface QueueRow {
  sessionId: string; projectId: string; sourceTool: string; messageCount: number; startedAt: string; labeled: number;
}

function loadSessionRows(db: Database.Database): QueueRow[] {
  return db.prepare(
    `SELECT s.id AS sessionId, s.project_id AS projectId, s.source_tool AS sourceTool,
            s.message_count AS messageCount, s.started_at AS startedAt,
            CASE WHEN l.session_id IS NULL THEN 0 ELSE 1 END AS labeled
     FROM sessions s LEFT JOIN session_labels l ON l.session_id = s.id AND l.deleted_at IS NULL
     WHERE s.deleted_at IS NULL`
  ).all() as QueueRow[];
}

/** Inputs for rankLabelQueue: unlabeled candidates and already-labeled sessions. */
export function getLabelQueueInputs(db: Database.Database = getDb()): { candidates: QueueSession[]; labeled: QueueSession[] } {
  const candidates: QueueSession[] = [];
  const labeled: QueueSession[] = [];
  for (const { labeled: isLabeled, ...q } of loadSessionRows(db)) {
    (isLabeled ? labeled : candidates).push(q);
  }
  return { candidates, labeled };
}

export interface CoverageRow { labeled: number; available: number; target: number }

export interface LabelProgress {
  total: number;
  splits: Record<Split, number>;
  targets: typeof COVERAGE_TARGETS;
  byProject: Array<CoverageRow & { projectId: string; projectName: string }>;
  byLengthBucket: Array<CoverageRow & { bucket: LengthBucket }>;
}

export function getLabelProgress(db: Database.Database = getDb()): LabelProgress {
  const splits: Record<Split, number> = { train: 0, validation: 0, test: 0 };
  // Same usable set as the project/bucket counts below: live label on a live session.
  for (const r of db.prepare(
    `SELECT l.split AS split, COUNT(*) AS n FROM session_labels l
     JOIN sessions s ON s.id = l.session_id AND s.deleted_at IS NULL
     WHERE l.deleted_at IS NULL GROUP BY l.split`
  ).all() as Array<{ split: Split; n: number }>) {
    splits[r.split] = r.n;
  }

  const names = new Map(
    (db.prepare('SELECT id, name FROM projects').all() as Array<{ id: string; name: string }>).map(p => [p.id, p.name]),
  );
  const projects = new Map<string, { labeled: number; available: number }>();
  const buckets = new Map<LengthBucket, { labeled: number; available: number }>(
    LENGTH_BUCKETS.map(b => [b, { labeled: 0, available: 0 }]),
  );
  for (const row of loadSessionRows(db)) {
    const p = projects.get(row.projectId) ?? { labeled: 0, available: 0 };
    const b = buckets.get(lengthBucket(row.messageCount))!;
    p.available++; b.available++;
    if (row.labeled) { p.labeled++; b.labeled++; }
    projects.set(row.projectId, p);
  }

  return {
    total: splits.train + splits.validation + splits.test,
    splits,
    targets: COVERAGE_TARGETS,
    byProject: [...projects.entries()]
      .map(([projectId, v]) => ({
        projectId, projectName: names.get(projectId) ?? projectId, ...v,
        target: Math.min(COVERAGE_TARGETS.perProject, v.available),
      }))
      .sort((a, b) => b.available - a.available || a.projectId.localeCompare(b.projectId)),
    byLengthBucket: LENGTH_BUCKETS.map(bucket => {
      const v = buckets.get(bucket)!;
      // Uncapped: a bucket with no sessions shows 0/target (a coverage gap), never 0/0.
      return { bucket, ...v, target: COVERAGE_TARGETS.perLengthBucket };
    }),
  };
}
