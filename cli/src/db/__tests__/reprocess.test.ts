import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import {
  reprocessSessionSteps,
  reprocessDecisionAttribution,
  reprocessFrictionAttribution,
  reprocessDatabase,
} from '../reprocess.js';

describe('Local Database Reprocess', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    db.exec(`
      INSERT INTO projects (id, name, path, last_activity)
      VALUES ('p1', 'test-project', '/tmp/test', datetime('now'));

      INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at)
      VALUES ('s1', 'p1', 'test-project', '/tmp/test', datetime('now'), datetime('now'));
    `);
  });

  afterEach(() => {
    db.close();
  });

  describe('reprocessSessionSteps', () => {
    it('unpacks step_matrix from summary insights into session_steps with inferred flags', () => {
      const stepMatrix = [
        {
          step: 'Inspect configuration file',
          turn_ref: 'User#1',
          driver: 'User_Decide',
          target: 'Target_Config',
          state: 'State_Success',
        },
        {
          step: 'Run unit test suite with vitest',
          turn_ref: 'Assistant#2',
          driver: 'LLM_Decide',
          target: 'Target_Test',
          state: 'State_Success',
        },
        {
          step: 'Fix regression in parser',
          turn_ref: 'Assistant#3',
          driver: 'LLM_Decide',
          target: 'Target_SrcCode',
          state: 'State_Success',
        },
      ];

      db.prepare(`
        INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, metadata, timestamp, created_at, scope, analysis_version)
        VALUES ('ins-summary-1', 's1', 'p1', 'test-project', 'summary', 'Session Summary', 'content', 'summary', 0.9, 'llm', ?, datetime('now'), datetime('now'), 'session', '3.0.0')
      `).run(JSON.stringify({ outcome: 'success', step_matrix: stepMatrix }));

      const result = reprocessSessionSteps(db);
      expect(result.sessionsProcessed).toBe(1);
      expect(result.stepsInserted).toBe(3);

      const steps = db.prepare('SELECT * FROM session_steps WHERE session_id = ? ORDER BY idx ASC').all('s1') as any[];
      expect(steps).toHaveLength(3);

      // Step 1: Config
      expect(steps[0].label).toBe('Inspect configuration file');
      expect(steps[0].driver).toBe('User_Decide');
      expect(steps[0].ran_tests).toBe(0);

      // Step 2: Test run (inferred ran_tests = 1)
      expect(steps[1].label).toBe('Run unit test suite with vitest');
      expect(steps[1].ran_tests).toBe(1);
      expect(steps[1].used_tools).toBe(1);

      // Step 3: Fix regression (inferred has_course_correction = 1)
      expect(steps[2].label).toBe('Fix regression in parser');
      expect(steps[2].has_course_correction).toBe(1);
    });

    it('respects dryRun option without modifying session_steps', () => {
      const stepMatrix = [
        {
          step: 'Deploy build',
          turn_ref: 'User#1',
          driver: 'User_Decide',
          target: 'Target_Config',
          state: 'State_Success',
        },
      ];

      db.prepare(`
        INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, metadata, timestamp, created_at, scope, analysis_version)
        VALUES ('ins-summary-2', 's1', 'p1', 'test-project', 'summary', 'Session Summary', 'content', 'summary', 0.9, 'llm', ?, datetime('now'), datetime('now'), 'session', '3.0.0')
      `).run(JSON.stringify({ outcome: 'success', step_matrix: stepMatrix }));

      const result = reprocessSessionSteps(db, { dryRun: true });
      expect(result.sessionsProcessed).toBe(1);
      expect(result.stepsInserted).toBe(1);

      const steps = db.prepare('SELECT * FROM session_steps WHERE session_id = ?').all('s1');
      expect(steps).toHaveLength(0);
    });
  });

  describe('reprocessDecisionAttribution', () => {
    it('attributes legacy decisions using text heuristics', () => {
      // User decision
      db.prepare(`
        INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, metadata, timestamp, created_at, scope, analysis_version)
        VALUES ('dec-1', 's1', 'p1', 'test-project', 'decision', 'Switch to pnpm', 'User requested switching to pnpm for workspaces', 'Switch to pnpm', 0.9, 'llm', ?, datetime('now'), datetime('now'), 'session', '1.0.0')
      `).run(JSON.stringify({ situation: 'User requested switching package manager' }));

      // Agent decision
      db.prepare(`
        INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, metadata, timestamp, created_at, scope, analysis_version)
        VALUES ('dec-2', 's1', 'p1', 'test-project', 'decision', 'Use LRU Cache', 'Agent decided to use an LRU cache internally', 'Use LRU Cache', 0.9, 'llm', ?, datetime('now'), datetime('now'), 'session', '1.0.0')
      `).run(JSON.stringify({ reasoning: 'Agent chose LRU cache for memory safety' }));

      // Default collaborative
      db.prepare(`
        INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, source, metadata, timestamp, created_at, scope, analysis_version)
        VALUES ('dec-3', 's1', 'p1', 'test-project', 'decision', 'Modularize helpers', 'Split helpers into separate files', 'Modularize helpers', 0.9, 'llm', ?, datetime('now'), datetime('now'), 'session', '1.0.0')
      `).run(JSON.stringify({ choice: 'Split into smaller modules' }));

      const result = reprocessDecisionAttribution(db);
      expect(result.updatedCount).toBe(3);
      expect(result.byAttribution.user).toBe(1);
      expect(result.byAttribution.agent).toBe(1);
      expect(result.byAttribution.collaborative).toBe(1);

      const d1 = JSON.parse((db.prepare('SELECT metadata FROM insights WHERE id = ?').get('dec-1') as any).metadata);
      expect(d1.decided_by).toBe('user');

      const d2 = JSON.parse((db.prepare('SELECT metadata FROM insights WHERE id = ?').get('dec-2') as any).metadata);
      expect(d2.decided_by).toBe('agent');

      const d3 = JSON.parse((db.prepare('SELECT metadata FROM insights WHERE id = ?').get('dec-3') as any).metadata);
      expect(d3.decided_by).toBe('collaborative');
    });
  });

  describe('reprocessFrictionAttribution', () => {
    it('sets default attribution for legacy friction points', () => {
      db.prepare(`
        INSERT INTO session_facets (session_id, outcome_satisfaction, friction_points, effective_patterns, extracted_at, analysis_version)
        VALUES ('s1', 'high', ?, '[]', datetime('now'), '1.0.0')
      `).run(JSON.stringify([{ description: 'Command timeout' }]));

      const result = reprocessFrictionAttribution(db);
      expect(result.updatedCount).toBe(1);

      const row = db.prepare('SELECT friction_points FROM session_facets WHERE session_id = ?').get('s1') as any;
      const points = JSON.parse(row.friction_points);
      expect(points[0].attribution).toBe('agent');
    });
  });

  describe('reprocessDatabase', () => {
    it('runs all reprocessing tasks successfully', () => {
      const result = reprocessDatabase(db);
      expect(result.sessionSteps).toBeDefined();
      expect(result.decisions).toBeDefined();
      expect(result.facets).toBeDefined();
      expect(result.ftsRebuilt).toBe(true);
    });
  });
});
