import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import { CURRENT_SCHEMA_VERSION } from '../schema.js';

const cols = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
const indexes = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map(i => i.name);

describe('SQLite Migration v20: optimization tables', () => {
  let db: Database.Database;
  beforeEach(() => { db = new Database(':memory:'); });
  afterEach(() => { db.close(); });

  it('CURRENT_SCHEMA_VERSION is 20', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(20);
  });

  it('creates every table with the planned columns on a fresh database', () => {
    const result = runMigrations(db);
    expect(result.v20Applied).toBe(true);
    expect(cols(db, 'prompt_versions')).toEqual([
      'id', 'target', 'identity_key', 'components_json', 'parent_version_id', 'source_run_id',
      'judge_model', 'weights_json', 'test_scores_json', 'analysis_version', 'created_at',
    ]);
    expect(cols(db, 'active_prompt_versions')).toEqual(['target', 'identity_key', 'version_id', 'promoted_at']);
    expect(cols(db, 'optimization_runs')).toEqual([
      'id', 'target', 'identity_key', 'teacher', 'judge_model', 'mode', 'status', 'caps_json',
      'estimate_json', 'best_candidate_id', 'labels_hash_json', 'error', 'started_at', 'finished_at',
    ]);
    expect(cols(db, 'optimization_rounds')).toEqual([
      'id', 'run_id', 'round', 'candidate_id', 'parent_candidate_id', 'components_json', 'scores_json',
      'scalar', 'accepted', 'rationales_json', 'tokens', 'cost_usd', 'created_at',
    ]);
    expect(cols(db, 'candidate_session_scores')).toEqual([
      'round_id', 'candidate_id', 'session_id', 'scores_json', 'scalar', 'created_at',
    ]);
    expect(cols(db, 'judge_cache')).toEqual([
      'output_hash', 'key_points_hash', 'judge_model', 'result_json', 'created_at',
    ]);
    expect(cols(db, 'judge_audits')).toEqual([
      'id', 'round_id', 'session_id', 'item', 'judge_decision', 'human_decision', 'created_at',
    ]);
    expect(cols(db, 'batch_jobs')).toEqual([
      'job_id', 'provider', 'model', 'owner_kind', 'owner_id', 'custom_ids_json', 'status',
      'submitted_at', 'updated_at',
    ]);
  });

  it('creates the carry-forward-6 indexes', () => {
    runMigrations(db);
    expect(indexes(db, 'prompt_versions')).toContain('idx_prompt_versions_target_identity');
    expect(indexes(db, 'optimization_rounds')).toContain('idx_optimization_rounds_run');
    expect(indexes(db, 'insights')).toContain('idx_insights_prompt_version');
    const partial = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'idx_insights_prompt_version'`).get() as { sql: string };
    expect(partial.sql).toMatch(/WHERE prompt_version_id IS NOT NULL/);
  });

  it('active_prompt_versions is keyed by (target, identity_key)', () => {
    runMigrations(db);
    db.prepare(`INSERT INTO prompt_versions (id, target, identity_key, components_json) VALUES ('v1','session-analysis','k','{}')`).run();
    db.prepare(`INSERT INTO prompt_versions (id, target, identity_key, components_json) VALUES ('v2','session-analysis','k','{}')`).run();
    const ins = db.prepare(`INSERT INTO active_prompt_versions (target, identity_key, version_id) VALUES ('session-analysis','k',?)`);
    ins.run('v1');
    expect(() => ins.run('v2')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('cascades rounds and per-session scores when a run is deleted (FK on)', () => {
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO optimization_runs (id, target, identity_key, teacher, judge_model, mode, status) VALUES ('r1','session-analysis','k','t','j','sync','running')`).run();
    db.prepare(`INSERT INTO optimization_rounds (id, run_id, round, candidate_id, components_json, scores_json) VALUES ('rd1','r1',0,'c0','{}','{}')`).run();
    db.prepare(`INSERT INTO candidate_session_scores (round_id, candidate_id, session_id, scores_json) VALUES ('rd1','c0','s1','{}')`).run();
    db.prepare(`DELETE FROM optimization_runs WHERE id = 'r1'`).run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM optimization_rounds').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM candidate_session_scores').get()).toEqual({ n: 0 });
  });

  it('migrates a v19 database without touching existing rows', () => {
    runMigrations(db);
    db.exec(`
      DROP TABLE candidate_session_scores; DROP TABLE judge_audits; DROP TABLE optimization_rounds;
      DROP TABLE optimization_runs; DROP TABLE judge_cache; DROP TABLE batch_jobs;
      DROP TABLE active_prompt_versions; DROP TABLE prompt_versions;
      DROP INDEX idx_insights_prompt_version;
      INSERT INTO projects (id, name, path, last_activity) VALUES ('p1','P','/p','2026-01-01');
      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
        VALUES ('s1','p1','P','/p','2026-01-01','2026-01-01');
      INSERT INTO session_labels (session_id, outcome, split) VALUES ('s1','high','train');
      DELETE FROM schema_version WHERE version >= 20;
    `);
    const result = runMigrations(db);
    expect(result.v20Applied).toBe(true);
    expect(result.v19Applied).toBe(false);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(20);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM session_labels').get()).toEqual({ n: 1 });
    expect(cols(db, 'prompt_versions')).toContain('analysis_version');
  });

  it('is idempotent', () => {
    runMigrations(db);
    expect(runMigrations(db).v20Applied).toBe(false);
    db.prepare('DELETE FROM schema_version WHERE version = 20').run();
    expect(() => runMigrations(db)).not.toThrow();
  });

  it('applies column defaults', () => {
    runMigrations(db);
    db.prepare(`INSERT INTO optimization_runs (id, target, identity_key, teacher, judge_model, mode) VALUES ('r1','session-analysis','k','t','j','sync')`).run();
    const run = db.prepare('SELECT * FROM optimization_runs WHERE id = ?').get('r1') as Record<string, unknown>;
    expect(run.status).toBe('queued');
    expect(run.caps_json).toBe('{}');
    expect(run.error).toBeNull();
    expect(run.finished_at).toBeNull();
    expect(typeof run.started_at).toBe('string');
    db.prepare(`INSERT INTO optimization_rounds (id, run_id, round, candidate_id, components_json, scores_json) VALUES ('rd1','r1',1,'c1','{}','{}')`).run();
    const round = db.prepare('SELECT * FROM optimization_rounds WHERE id = ?').get('rd1') as Record<string, unknown>;
    expect(round.accepted).toBe(0);
    expect(round.tokens).toBe(0);
    expect(round.cost_usd).toBeNull();
  });

  it('creates gate_session_scores keyed (version_id, subject, session_id)', () => {
    runMigrations(db);
    expect(cols(db, 'gate_session_scores')).toEqual([
      'version_id', 'subject', 'session_id', 'baseline_version_id', 'scores_json', 'scalar',
      'analysis_json', 'error', 'created_at',
    ]);
    const ins = db.prepare(`INSERT INTO gate_session_scores (version_id, subject, session_id, scores_json) VALUES ('v1', ?, 's1', '{}')`);
    ins.run('candidate');
    ins.run('baseline');
    expect(() => ins.run('candidate')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins.run('other')).toThrow(/CHECK/);
  });

  it('repairs a database that applied the pre-gate v20 (no gate_session_scores)', () => {
    runMigrations(db);
    db.exec('DROP TABLE gate_session_scores');
    const result = runMigrations(db);
    expect(result.v20Applied).toBe(false);
    expect(cols(db, 'gate_session_scores')).toContain('analysis_json');
    // and a second run changes nothing
    expect(() => runMigrations(db)).not.toThrow();
  });
});
