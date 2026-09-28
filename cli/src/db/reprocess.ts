import type Database from 'better-sqlite3';
import { getDb } from './client.js';
import { saveSessionStepsToDb } from '../analysis/analysis-db.js';
import type { SemanticStep, FcaTarget } from '../types.js';

export interface ReprocessOptions {
  dryRun?: boolean;
  rebuildFts?: boolean;
}

export interface ReprocessResult {
  sessionSteps: { sessionsProcessed: number; stepsInserted: number };
  decisions: { updatedCount: number; byAttribution: Record<string, number> };
  facets: { updatedCount: number };
  ftsRebuilt: boolean;
}

/**
 * Backfill session_steps table from step_matrix stored in summary insights metadata.
 * Deterministically infers co-occurring action flags if not already present.
 */
export function reprocessSessionSteps(
  db: Database.Database,
  options: { dryRun?: boolean } = {}
): { sessionsProcessed: number; stepsInserted: number } {
  const rows = db.prepare(`
    SELECT s.id AS session_id, i.metadata, i.created_at
    FROM insights i
    JOIN sessions s ON s.id = i.session_id
    WHERE i.type = 'summary'
      AND i.metadata IS NOT NULL
      AND json_extract(i.metadata, '$.step_matrix') IS NOT NULL
    ORDER BY s.id, i.created_at DESC
  `).all() as Array<{ session_id: string; metadata: string; created_at: string }>;

  const seenSessions = new Set<string>();
  let sessionsProcessed = 0;
  let stepsInserted = 0;

  for (const row of rows) {
    if (seenSessions.has(row.session_id)) continue;
    seenSessions.add(row.session_id);

    try {
      const meta = JSON.parse(row.metadata);
      if (!Array.isArray(meta.step_matrix) || meta.step_matrix.length === 0) continue;

      const enrichedSteps: SemanticStep[] = meta.step_matrix.map((s: any, idx: number) => {
        const stepLabel = String(s.step || s.label || `Step ${idx + 1}`);
        const turnRef = String(s.turn_ref || `Turn#${idx + 1}`);
        const primaryTarget = (s.target || 'Target_SrcCode') as FcaTarget;
        const targets: FcaTarget[] = Array.isArray(s.targets) && s.targets.length > 0
          ? s.targets
          : [primaryTarget];

        const ran_tests = typeof s.ran_tests === 'boolean'
          ? s.ran_tests
          : /\b(test|tests|spec|specs|vitest|jest|pytest|lint|check|coverage)\b/i.test(stepLabel);

        const used_tools = typeof s.used_tools === 'boolean'
          ? s.used_tools
          : /\b(tool|tools|bash|command|run|terminal|exec|edit|write|read|file|patch)\b/i.test(stepLabel) || /Assistant#/i.test(turnRef);

        const has_course_correction = typeof s.has_course_correction === 'boolean'
          ? s.has_course_correction
          : /\b(fix|repair|correct|correction|retry|revert|rollback|debug|resolve)\b/i.test(stepLabel);

        return {
          step: stepLabel,
          turn_ref: turnRef,
          driver: s.driver || 'LLM_Decide',
          target: primaryTarget,
          state: s.state || 'State_Success',
          targets,
          ran_tests,
          used_tools,
          has_course_correction,
        };
      });

      if (!options.dryRun) {
        saveSessionStepsToDb(row.session_id, enrichedSteps, db);
      }
      sessionsProcessed++;
      stepsInserted += enrichedSteps.length;
    } catch {
      // Ignore malformed rows safely
    }
  }

  return { sessionsProcessed, stepsInserted };
}

/**
 * Attribute legacy decisions (decided_by = NULL) using deterministic text heuristics.
 */
export function reprocessDecisionAttribution(
  db: Database.Database,
  options: { dryRun?: boolean } = {}
): { updatedCount: number; byAttribution: Record<string, number> } {
  const rows = db.prepare(`
    SELECT id, title, content, summary, metadata
    FROM insights
    WHERE type = 'decision'
      AND (json_extract(metadata, '$.decided_by') IS NULL OR json_extract(metadata, '$.decided_by') = '')
  `).all() as Array<{ id: string; title: string; content: string; summary: string; metadata: string | null }>;

  const updateStmt = db.prepare(`
    UPDATE insights
    SET metadata = ?
    WHERE id = ?
  `);

  let updatedCount = 0;
  const byAttribution: Record<string, number> = {
    user: 0,
    agent: 0,
    collaborative: 0,
  };

  const USER_REGEX = /\b(user requested|user instructed|user specified|user wanted|user asked|per user|user prompt|human requested)\b/i;
  const AGENT_REGEX = /\b(autonomous|agent chose|agent decided|assistant proposed|internal choice|inferred|heuristic)\b/i;

  const runTx = db.transaction(() => {
    for (const row of rows) {
      let meta: Record<string, any> = {};
      try {
        if (row.metadata) {
          meta = JSON.parse(row.metadata);
        }
      } catch {
        meta = {};
      }

      const text = `${row.title || ''} ${row.content || ''} ${row.summary || ''} ${meta.situation || ''} ${meta.reasoning || ''}`;

      let attribution: 'user' | 'agent' | 'collaborative';
      if (USER_REGEX.test(text)) {
        attribution = 'user';
      } else if (AGENT_REGEX.test(text)) {
        attribution = 'agent';
      } else {
        attribution = 'collaborative';
      }

      meta.decided_by = attribution;
      byAttribution[attribution]++;

      if (!options.dryRun) {
        updateStmt.run(JSON.stringify(meta), row.id);
      }
      updatedCount++;
    }
  });

  runTx();

  return { updatedCount, byAttribution };
}

/**
 * Ensure all friction points in session_facets have attribution.
 */
export function reprocessFrictionAttribution(
  db: Database.Database,
  options: { dryRun?: boolean } = {}
): { updatedCount: number } {
  const rows = db.prepare(`
    SELECT session_id, friction_points
    FROM session_facets
    WHERE json_array_length(friction_points) > 0
  `).all() as Array<{ session_id: string; friction_points: string }>;

  const updateStmt = db.prepare(`
    UPDATE session_facets
    SET friction_points = ?
    WHERE session_id = ?
  `);

  let updatedCount = 0;
  const runTx = db.transaction(() => {
    for (const row of rows) {
      try {
        const points = JSON.parse(row.friction_points);
        if (!Array.isArray(points)) continue;

        let modified = false;
        for (const pt of points) {
          if (!pt.attribution) {
            pt.attribution = 'agent';
            modified = true;
          }
        }

        if (modified) {
          if (!options.dryRun) {
            updateStmt.run(JSON.stringify(points), row.session_id);
          }
          updatedCount++;
        }
      } catch {
        // Skip malformed rows
      }
    }
  });

  runTx();
  return { updatedCount };
}

/**
 * Rebuild the FTS5 virtual table for messages.
 */
export function rebuildMessagesFts(db: Database.Database): void {
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
}

/**
 * Execute the full local reprocessing workflow.
 */
export function reprocessDatabase(
  db: Database.Database = getDb(),
  options: ReprocessOptions = {}
): ReprocessResult {
  const sessionSteps = reprocessSessionSteps(db, options);
  const decisions = reprocessDecisionAttribution(db, options);
  const facets = reprocessFrictionAttribution(db, options);

  let ftsRebuilt = false;
  if (options.rebuildFts !== false && !options.dryRun) {
    try {
      rebuildMessagesFts(db);
      ftsRebuilt = true;
    } catch {
      ftsRebuilt = false;
    }
  }

  return {
    sessionSteps,
    decisions,
    facets,
    ftsRebuilt,
  };
}
