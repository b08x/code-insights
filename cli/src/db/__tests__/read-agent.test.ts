import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import {
  ANALYTICAL_TABLES,
  validateReadOnlySql,
  executeReadOnlySql,
  searchSessionSnippets,
  getSessionWindow,
  SNIPPET_MAX_CHARS,
} from '../read-agent.js';

let db: Database.Database;

function addSession(id: string, over: Record<string, unknown> = {}) {
  const row = {
    id,
    project_id: 'p1',
    project_name: 'Proj',
    project_path: '/proj',
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    summary: null,
    generated_title: `Title ${id}`,
    message_count: 0,
    tool_call_count: 0,
    source_tool: 'claude-code',
    estimated_cost_usd: 1,
    total_input_tokens: 10,
    total_output_tokens: 5,
    parent_session_id: null,
    agent_type: null,
    git_branch: 'main',
    session_character: 'feature_build',
    ...over,
  };
  db.prepare(`INSERT INTO sessions (
    id, project_id, project_name, project_path, started_at, ended_at, summary,
    generated_title, message_count, tool_call_count, source_tool, estimated_cost_usd,
    total_input_tokens, total_output_tokens, parent_session_id, agent_type, git_branch, session_character
  ) VALUES (
    @id,@project_id,@project_name,@project_path,@started_at,@ended_at,@summary,
    @generated_title,@message_count,@tool_call_count,@source_tool,@estimated_cost_usd,
    @total_input_tokens,@total_output_tokens,@parent_session_id,@agent_type,@git_branch,@session_character
  )`).run(row);
}

function addMessage(sessionId: string, n: number, type: string, content: string) {
  db.prepare('INSERT INTO messages (id, session_id, type, content, timestamp) VALUES (?,?,?,?,?)')
    .run(`${sessionId}-m${n}`, sessionId, type, content, `2026-11-15T00:00:${String(n).padStart(2, '0')}Z`);
}

function addFacet(sessionId: string, over: Record<string, unknown> = {}) {
  const row = {
    session_id: sessionId,
    outcome_satisfaction: 'high',
    workflow_pattern: 'test-driven',
    had_course_correction: 0,
    friction_points: JSON.stringify([{ category: 'tooling-failure', severity: 'medium', description: 'flaky test', resolution: 'resolved' }]),
    effective_patterns: JSON.stringify([{ category: 'verification-workflow', description: 'ran suite', confidence: 90 }]),
    ...over,
  };
  db.prepare(`INSERT INTO session_facets (
    session_id, outcome_satisfaction, workflow_pattern, had_course_correction, friction_points, effective_patterns
  ) VALUES (@session_id,@outcome_satisfaction,@workflow_pattern,@had_course_correction,@friction_points,@effective_patterns)`).run(row);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO projects (id, name, path, last_activity) VALUES ('p1','Proj','/proj','2026-11-15')").run();
});
afterEach(() => db.close());

describe('validateReadOnlySql', () => {
  it('allows SELECT, WITH CTEs, json_each, messages_fts, and main.* analytical tables', () => {
    const simple = validateReadOnlySql('SELECT id, project_name FROM sessions WHERE deleted_at IS NULL;');
    expect(simple.ok).toBe(true);
    if (simple.ok) {
      expect(simple.sql).toBe('SELECT id, project_name FROM sessions WHERE deleted_at IS NULL');
      expect(simple.tables).toEqual(['sessions']);
    }

    const cte = validateReadOnlySql(`
      \`\`\`sql
      WITH recent AS (
        SELECT id FROM main.sessions WHERE deleted_at IS NULL
      )
      SELECT r.id, json_extract(f.value, '$.category') AS cat
      FROM recent r
      JOIN session_facets sf ON sf.session_id = r.id,
      json_each(sf.friction_points) f
      WHERE sf.had_course_correction = 1
      \`\`\`
    `);
    expect(cte.ok).toBe(true);
    if (cte.ok) {
      expect(cte.tables.sort()).toEqual(['session_facets', 'sessions']);
    }

    const fts = validateReadOnlySql('SELECT m.session_id FROM messages_fts f JOIN messages m ON m.rowid = f.rowid WHERE messages_fts MATCH \'auth\'');
    expect(fts.ok).toBe(true);
  });

  it('allows REPLACE() scalar function inside SELECT while blocking REPLACE INTO', () => {
    expect(validateReadOnlySql("SELECT REPLACE(summary, 'a', 'b') FROM sessions").ok).toBe(true);
    expect(validateReadOnlySql("REPLACE INTO sessions (id) VALUES ('x')").ok).toBe(false);
  });

  it('blocks mutations, pragmas, multi-statements, comments hiding mutations, and non-analytical tables', () => {
    const blocked = [
      'DELETE FROM sessions',
      'UPDATE sessions SET summary = "x"',
      'INSERT INTO projects (id, name, path, last_activity) VALUES ("x","x","/x","now")',
      'DROP TABLE sessions',
      'PRAGMA table_info(sessions)',
      "ATTACH DATABASE '/tmp/x.db' AS x",
      'SELECT * FROM sessions; DELETE FROM sessions',
      '/* DELETE */ SELECT * FROM chat_messages',
      'SELECT * FROM chat_conversations',
      'SELECT * FROM sqlite_master',
      'SELECT * FROM vec_insights',
      'SELECT * FROM temp.sessions',
      'WITH x AS (SELECT * FROM chat_messages) SELECT * FROM x',
      'SELECT (SELECT COUNT(*) FROM chat_messages) FROM sessions',
      'SELECT * FROM pragma_table_info(\'sessions\')',
      '',
    ];
    for (const sql of blocked) {
      const res = validateReadOnlySql(sql);
      expect(res.ok, `Expected blocked: ${sql}`).toBe(false);
    }
    expect(ANALYTICAL_TABLES.has('chat_messages')).toBe(false);
  });
});

describe('executeReadOnlySql', () => {
  it('enforces row cap, cell cap, byte cap, and resolves parent-rolled-up session citations', () => {
    addSession('parent-1', { summary: 'x'.repeat(1000) });
    addSession('child-1', { parent_session_id: 'parent-1', agent_type: 'worker' });
    addSession('deleted-1');
    db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = 'deleted-1'").run();

    const res = executeReadOnlySql(
      db,
      "SELECT id, summary FROM sessions WHERE id IN ('parent-1', 'child-1', 'deleted-1') ORDER BY id",
    );
    expect(res.ok).toBe(true);
    expect(res.columns).toEqual(['id', 'summary']);
    expect(res.rowCount).toBe(3);
    const parentRow = res.rows.find(r => r.id === 'parent-1')!;
    expect((parentRow.summary as string).length).toBeLessThanOrEqual(400);
    // Both parent-1 and child-1 collapse to parent-1; deleted-1 is excluded.
    expect(res.referencedSessionIds).toEqual(['parent-1']);
  });

  it('does not treat project or insight ids as session citations when sessions table is absent', () => {
    addSession('s1');
    db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, timestamp)
      VALUES ('ins-1', 's1', 'p1', 'Proj', 'decision', 'T', 'C', 'S', 0.9, '2026-11-15T00:00:00Z')`).run();

    const projRes = executeReadOnlySql(db, 'SELECT id, name FROM projects');
    expect(projRes.ok).toBe(true);
    expect(projRes.referencedSessionIds).toEqual([]);

    const insRes = executeReadOnlySql(db, 'SELECT id, session_id FROM insights');
    expect(insRes.ok).toBe(true);
    expect(insRes.referencedSessionIds).toEqual(['s1']);
  });

  it('truncates rows at maxRows and reports SQLite runtime errors cleanly', () => {
    for (let i = 0; i < 60; i++) addSession(`s${i}`);
    const capped = executeReadOnlySql(db, 'SELECT id FROM sessions');
    expect(capped.ok).toBe(true);
    expect(capped.rowCount).toBe(50);
    expect(capped.truncated).toBe(true);

    const bad = executeReadOnlySql(db, 'SELECT nonexistent_col FROM sessions');
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/nonexistent_col/);
  });
});

describe('searchSessionSnippets', () => {
  it('returns ranked snippets with session ids and facets, never whole transcripts', () => {
    addSession('s1');
    addMessage('s1', 1, 'user', 'zebrafish ' + 'x'.repeat(5000));
    addFacet('s1');
    addSession('s2');
    addMessage('s2', 1, 'user', 'unrelated content');
    const res = searchSessionSnippets(db, 'zebrafish', {}, 5);
    expect(res.map(r => r.sessionId)).toEqual(['s1']);
    expect(res[0].snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(res[0].snippet).toContain('zebrafish');
    expect(res[0].facets).toEqual({
      outcomeSatisfaction: 'high',
      workflowPattern: 'test-driven',
      hadCourseCorrection: false,
      frictionCategories: ['tooling-failure'],
      effectivePatternCategories: ['verification-workflow'],
    });
  });

  it('filters by date range, projectName, and sourceTool BEFORE stage limit (no starvation)', () => {
    db.prepare("INSERT INTO projects (id, name, path, last_activity) VALUES ('p2','Beta','/beta','2026-11-19')").run();
    // Flood 25 older matches in p1 that would fill STAGE_LIMIT=20 if filtering happened post-LIMIT
    for (let i = 0; i < 25; i++) {
      addSession(`old-${i}`, { started_at: '2026-03-01T00:00:00.000Z', ended_at: '2026-03-01T00:10:00.000Z' });
      addMessage(`old-${i}`, 1, 'user', 'refactor pipeline');
    }
    addSession('recent-beta', {
      project_id: 'p2',
      project_name: 'Beta',
      source_tool: 'opencode',
      started_at: '2026-11-18T12:00:00.000Z',
      ended_at: '2026-11-18T12:30:00.000Z',
    });
    addMessage('recent-beta', 1, 'user', 'refactor pipeline');

    const res = searchSessionSnippets(db, 'refactor', {
      since: '2026-11-13T00:00:00.000Z',
      projectName: 'beta',
      sourceTool: 'opencode',
    }, 5);
    expect(res.map(r => r.sessionId)).toEqual(['recent-beta']);
  });

  it('rolls child subagent hits up to their parent session and skips deleted parents', () => {
    addSession('parent', { started_at: '2026-11-18T00:00:00Z' });
    addSession('child-a', { parent_session_id: 'parent', agent_type: 'verifier', started_at: '2026-11-18T00:01:00Z' });
    addMessage('child-a', 1, 'assistant', 'found rare-subagent-token in child');

    addSession('deleted-parent', { started_at: '2026-11-18T00:00:00Z' });
    db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id = 'deleted-parent'").run();
    addSession('orphan-child', { parent_session_id: 'deleted-parent', agent_type: 'worker', started_at: '2026-11-18T00:01:00Z' });
    addMessage('orphan-child', 1, 'assistant', 'found rare-subagent-token in deleted parent');

    const res = searchSessionSnippets(db, 'rare-subagent-token', {}, 5);
    expect(res).toHaveLength(1);
    expect(res[0].sessionId).toBe('parent');
    expect(res[0].childMatchCount).toBe(1);
    expect(res[0].snippet).toContain('[subagent:verifier]');
  });

  it('caps snippet length for session summaries matched via LIKE and escapes %/_', () => {
    addSession('s1', { summary: 'quokka ' + 'y'.repeat(4000) });
    const res = searchSessionSnippets(db, 'quokka', {}, 5);
    expect(res).toHaveLength(1);
    expect(res[0].snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);

    addSession('lit', { summary: 'progress at 100% done' });
    addSession('decoy', { summary: 'progress at 1000 done' });
    addSession('under', { summary: 'snake_case naming' });
    addSession('under-decoy', { summary: 'snakeXcase naming' });
    expect(searchSessionSnippets(db, '100%', {}, 10).map(r => r.sessionId)).toEqual(['lit']);
    expect(searchSessionSnippets(db, 'snake_case', {}, 10).map(r => r.sessionId)).toEqual(['under']);
  });

  it('survives FTS-hostile input and empty queries', () => {
    addSession('s1');
    addMessage('s1', 1, 'user', 'hello');
    expect(() => searchSessionSnippets(db, '"AND (', {}, 5)).not.toThrow();
    expect(searchSessionSnippets(db, '   ', {}, 5)).toEqual([]);
  });
});

describe('getSessionWindow', () => {
  beforeEach(() => {
    addSession('s1', { message_count: 10 });
    addFacet('s1');
    addSession('c1', { parent_session_id: 's1', agent_type: 'research', message_count: 4 });
    for (let i = 0; i < 10; i++) addMessage('s1', i, i % 2 ? 'assistant' : 'user', `msg${i} ` + 'z'.repeat(5000));
  });

  it('returns the requested inclusive turn range with capped content, facets, and subagents', () => {
    const w = getSessionWindow(db, 's1', 2, 4)!;
    expect(w.totalTurns).toBe(10);
    expect(w.turns.map(t => t.turn)).toEqual([2, 3, 4]);
    expect(w.turns[0].content.startsWith('msg2')).toBe(true);
    expect(w.turns[0].content.length).toBeLessThanOrEqual(1500 + 20);
    expect(w.facets?.outcomeSatisfaction).toBe('high');
    expect(w.subagents).toHaveLength(1);
    expect(w.subagents[0]).toMatchObject({ sessionId: 'c1', agentType: 'research', messageCount: 4 });
  });

  it('clamps out-of-range bounds and caps window size', () => {
    const w = getSessionWindow(db, 's1', -5, 999)!;
    expect(w.fromTurn).toBe(0);
    expect(w.toTurn).toBe(9);
    const small = getSessionWindow(db, 's1', 0, 9, { maxTurns: 3 })!;
    expect(small.turns).toHaveLength(3);
  });

  it('returns null for unknown or deleted sessions', () => {
    expect(getSessionWindow(db, 'nope', 0, 1)).toBeNull();
    db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id='s1'").run();
    expect(getSessionWindow(db, 's1', 0, 1)).toBeNull();
  });
});
