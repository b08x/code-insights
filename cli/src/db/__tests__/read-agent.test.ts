import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate.js';
import {
  searchSessionSnippets,
  getSessionWindow,
  listInsights,
  getAnalyticsSummary,
  SNIPPET_MAX_CHARS,
} from '../read-agent.js';

let db: Database.Database;

function addSession(id: string, over: Record<string, unknown> = {}) {
  const row = {
    id, project_id: 'p1', project_name: 'Proj', project_path: '/proj',
    started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
    summary: null, generated_title: `Title ${id}`, message_count: 0, tool_call_count: 0,
    source_tool: 'claude-code', estimated_cost_usd: 1, total_input_tokens: 10, total_output_tokens: 5,
    ...over,
  };
  db.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, summary,
    generated_title, message_count, tool_call_count, source_tool, estimated_cost_usd, total_input_tokens, total_output_tokens)
    VALUES (@id,@project_id,@project_name,@project_path,@started_at,@ended_at,@summary,@generated_title,@message_count,@tool_call_count,@source_tool,@estimated_cost_usd,@total_input_tokens,@total_output_tokens)`).run(row);
}

function addMessage(sessionId: string, n: number, type: string, content: string) {
  db.prepare('INSERT INTO messages (id, session_id, type, content, timestamp) VALUES (?,?,?,?,?)')
    .run(`${sessionId}-m${n}`, sessionId, type, content, `2026-01-01T00:00:${String(n).padStart(2, '0')}Z`);
}

function addInsight(id: string, sessionId: string, type: string, confidence = 0.8) {
  db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, timestamp)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, sessionId, 'p1', 'Proj', type, `T ${id}`, 'c'.repeat(2000), 'sum', confidence, '2026-01-01T00:00:00Z');
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO projects (id, name, path, last_activity) VALUES ('p1','Proj','/proj','2026-01-01')").run();
});
afterEach(() => db.close());

describe('searchSessionSnippets', () => {
  it('returns ranked snippets with session ids, never whole transcripts', () => {
    addSession('s1');
    addMessage('s1', 1, 'user', 'zebrafish ' + 'x'.repeat(5000));
    addSession('s2');
    addMessage('s2', 1, 'user', 'unrelated content');
    const res = searchSessionSnippets(db, 'zebrafish', {}, 5);
    expect(res.map(r => r.sessionId)).toEqual(['s1']);
    expect(res[0].snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
    expect(res[0].snippet).toContain('zebrafish');
  });

  it('caps snippet length for session summaries matched via LIKE', () => {
    addSession('s1', { summary: 'quokka ' + 'y'.repeat(4000) });
    const res = searchSessionSnippets(db, 'quokka', {}, 5);
    expect(res).toHaveLength(1);
    expect(res[0].snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS);
  });

  it('respects limit and project filter and skips soft-deleted sessions', () => {
    for (let i = 0; i < 4; i++) { addSession(`s${i}`); addMessage(`s${i}`, 1, 'user', 'needle'); }
    addSession('gone', { }); addMessage('gone', 1, 'user', 'needle');
    db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id='gone'").run();
    db.prepare("INSERT INTO projects (id, name, path, last_activity) VALUES ('p2','Other','/o','2026-01-01')").run();
    addSession('other', { project_id: 'p2', project_name: 'Other' }); addMessage('other', 1, 'user', 'needle');

    const limited = searchSessionSnippets(db, 'needle', {}, 2);
    expect(limited).toHaveLength(2);
    const all = searchSessionSnippets(db, 'needle', { projectId: 'p1' }, 10).map(r => r.sessionId);
    expect(all).not.toContain('gone');
    expect(all).not.toContain('other');
    expect(all).toHaveLength(4);
  });

  it('treats % and _ in the query literally in metadata LIKE matching', () => {
    addSession('lit', { summary: 'progress at 100% done' });
    addSession('decoy', { summary: 'progress at 1000 done' });
    addSession('under', { summary: 'snake_case naming' });
    addSession('under-decoy', { summary: 'snakeXcase naming' });
    expect(searchSessionSnippets(db, '100%', {}, 10).map(r => r.sessionId)).toEqual(['lit']);
    expect(searchSessionSnippets(db, 'snake_case', {}, 10).map(r => r.sessionId)).toEqual(['under']);
  });

  it('survives FTS-hostile input and empty queries', () => {
    addSession('s1'); addMessage('s1', 1, 'user', 'hello');
    expect(() => searchSessionSnippets(db, '"AND (', {}, 5)).not.toThrow();
    expect(searchSessionSnippets(db, '   ', {}, 5)).toEqual([]);
  });
});

describe('getSessionWindow', () => {
  beforeEach(() => {
    addSession('s1', { message_count: 10 });
    for (let i = 0; i < 10; i++) addMessage('s1', i, i % 2 ? 'assistant' : 'user', `msg${i} ` + 'z'.repeat(5000));
  });

  it('returns the requested inclusive turn range with capped content', () => {
    const w = getSessionWindow(db, 's1', 2, 4)!;
    expect(w.totalTurns).toBe(10);
    expect(w.turns.map(t => t.turn)).toEqual([2, 3, 4]);
    expect(w.turns[0].content.startsWith('msg2')).toBe(true);
    expect(w.turns[0].content.length).toBeLessThanOrEqual(1500 + 20);
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

describe('listInsights', () => {
  it('filters by session/type, orders by confidence, and caps content', () => {
    addSession('s1');
    addInsight('i1', 's1', 'decision', 0.5);
    addInsight('i2', 's1', 'learning', 0.9);
    const all = listInsights(db, { sessionId: 's1' });
    expect(all.map(i => i.id)).toEqual(['i2', 'i1']);
    expect(all[0].content.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS * 2);
    expect(listInsights(db, { type: 'decision' }).map(i => i.id)).toEqual(['i1']);
    expect(listInsights(db, { limit: 1 })).toHaveLength(1);
  });
});

describe('getAnalyticsSummary', () => {
  it('aggregates non-deleted sessions for the range', () => {
    addSession('s1', { estimated_cost_usd: 2 });
    addSession('s2', { estimated_cost_usd: 3 });
    addSession('old', { started_at: '2020-01-01T00:00:00Z' });
    addSession('gone');
    db.prepare("UPDATE sessions SET deleted_at = datetime('now') WHERE id='gone'").run();
    const week = getAnalyticsSummary(db, '7d');
    expect(week.sessionCount).toBe(2);
    expect(week.estimatedCostUsd).toBe(5);
    expect(getAnalyticsSummary(db, 'all').sessionCount).toBe(3);
    expect(getAnalyticsSummary(db, 'all').bySourceTool).toEqual([{ sourceTool: 'claude-code', sessionCount: 3 }]);
  });
});
