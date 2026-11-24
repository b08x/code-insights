import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMigrations } from '@code-insights/cli/db/schema';

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

const {
  buildSqlAgentSystemPrompt,
  parseSqlAgentResponse,
  runSqlSubAgent,
} = await import('./sql-agent.js');
const { resolveSqlRunner, execCliAsync } = await import('./sql-runner.js');
import type { SqlSubAgentBackend } from './sql-runner.js';

let db: Database.Database;

function seedBasicData() {
  db.prepare("INSERT INTO projects (id, name, path, last_activity) VALUES ('p1','Code Insights','/repo','2026-11-19')").run();
  db.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, generated_title, source_tool, message_count, estimated_cost_usd)
    VALUES ('parent-nov', 'p1', 'Code Insights', '/repo', '2026-11-18T10:00:00.000Z', '2026-11-18T10:30:00.000Z', 'Recent parent session', 'opencode', 12, 0.25)`).run();
  db.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, generated_title, source_tool, parent_session_id, agent_type, message_count, estimated_cost_usd)
    VALUES ('child-nov', 'p1', 'Code Insights', '/repo', '2026-11-18T10:05:00.000Z', '2026-11-18T10:15:00.000Z', 'Subagent run', 'opencode', 'parent-nov', 'verifier', 4, 0.05)`).run();
  db.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, generated_title, source_tool, message_count, estimated_cost_usd)
    VALUES ('old-mar', 'p1', 'Code Insights', '/repo', '2026-03-30T10:00:00.000Z', '2026-03-30T10:30:00.000Z', 'Old March session', 'claude-code', 8, 0.10)`).run();
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  seedBasicData();
  spawnMock.mockReset();
});

afterEach(() => {
  db.close();
});

describe('buildSqlAgentSystemPrompt', () => {
  it('injects exact UTC time and ISO-8601 window cutoffs', () => {
    const now = new Date('2026-11-20T06:00:00.000Z');
    const prompt = buildSqlAgentSystemPrompt(now);
    expect(prompt).toContain('2026-11-20T06:00:00.000Z');
    expect(prompt).toContain('2026-11-13T06:00:00.000Z');
    expect(prompt).toContain('2026-10-21T06:00:00.000Z');
    expect(prompt).toContain('session_facets');
    expect(prompt).toContain('session_steps');
  });
});

describe('parseSqlAgentResponse', () => {
  it('parses fenced JSON, jsonrepair-able JSON, and fenced SQL fallbacks', () => {
    expect(parseSqlAgentResponse('```json\n{"sql": "SELECT 1", "explanation": "one"}\n```')).toEqual({
      sql: 'SELECT 1',
      explanation: 'one',
    });
    expect(parseSqlAgentResponse('```sql\nSELECT id FROM sessions LIMIT 5\n```')).toEqual({
      sql: 'SELECT id FROM sessions LIMIT 5',
      explanation: '',
    });
    expect(parseSqlAgentResponse("{'sql': 'SELECT 2', 'explanation': 'two'}")).toEqual({
      sql: 'SELECT 2',
      explanation: 'two',
    });
    expect('error' in parseSqlAgentResponse('I cannot answer that.')).toBe(true);
  });
});

describe('runSqlSubAgent', () => {
  it('executes valid generated SQL and rolls child citations up to parent session', async () => {
    const backend: SqlSubAgentBackend = {
      label: 'mock-runner',
      generate: vi.fn().mockResolvedValue(JSON.stringify({
        sql: "SELECT id AS session_id, generated_title FROM sessions WHERE deleted_at IS NULL AND started_at >= '2026-11-13T00:00:00.000Z' ORDER BY started_at DESC",
        explanation: 'Lists recent sessions from the past 7 days.',
      })),
    };

    const res = await runSqlSubAgent({
      db,
      backend,
      question: 'Summarize my sessions from the last week',
      timeRange: '7d',
      now: new Date('2026-11-20T00:00:00.000Z'),
    });

    expect(res.ok).toBe(true);
    expect(res.retried).toBe(false);
    expect(res.runner).toBe('mock-runner');
    expect(res.rowCount).toBe(2);
    expect(res.referencedSessionIds).toEqual(['parent-nov']);
    expect(res.explanation).toBe('Lists recent sessions from the past 7 days.');
  });

  it('self-repairs once when the first SQL fails validation or SQLite execution', async () => {
    const generate = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        sql: 'SELECT id, bad_column FROM chat_messages',
        explanation: 'Bad first attempt',
      }))
      .mockResolvedValueOnce(JSON.stringify({
        sql: "SELECT id AS session_id, generated_title FROM sessions WHERE deleted_at IS NULL AND parent_session_id IS NULL AND started_at >= '2026-11-13T00:00:00.000Z'",
        explanation: 'Repaired query over sessions',
      }));

    const res = await runSqlSubAgent({
      db,
      backend: { label: 'mock-runner', generate },
      question: 'List recent sessions',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].userPrompt).toContain("Table 'chat_messages' is not allowed");
    expect(res.ok).toBe(true);
    expect(res.retried).toBe(true);
    expect(res.referencedSessionIds).toEqual(['parent-nov']);
  });

  it('returns structured failure after 2 bad SQL attempts without throwing', async () => {
    const generate = vi.fn().mockResolvedValue(JSON.stringify({
      sql: 'SELECT missing_col FROM sessions',
      explanation: 'broken',
    }));

    const res = await runSqlSubAgent({
      db,
      backend: { label: 'mock-runner', generate },
      question: 'broken query',
    });

    expect(generate).toHaveBeenCalledTimes(2);
    expect(res.ok).toBe(false);
    expect(res.retried).toBe(true);
    expect(res.error).toMatch(/missing_col/);
  });
});

describe('resolveSqlRunner', () => {
  it('defaults to provider -> agent and respects explicit dashboard.agent.sqlRunner', () => {
    const autoProvider = resolveSqlRunner({
      sync: { claudeDir: '', excludeProjects: [] },
      dashboard: {
        llm: { provider: 'ollama', model: 'qwen3' },
        agent: { provider: 'mistral', model: 'mistral-small-latest', apiKey: 'k' },
      },
    });
    expect('backend' in autoProvider && autoProvider.backend.label).toBe('provider (ollama/qwen3)');

    const autoAgentFallback = resolveSqlRunner({
      sync: { claudeDir: '', excludeProjects: [] },
      dashboard: {
        agent: { provider: 'ollama', model: 'llama3' },
      },
    });
    expect('backend' in autoAgentFallback && autoAgentFallback.backend.label).toBe('agent (ollama/llama3)');

    const explicitCli = resolveSqlRunner({
      sync: { claudeDir: '', excludeProjects: [] },
      dashboard: {
        llm: { provider: 'ollama', model: 'qwen3' },
        agent: {
          provider: 'ollama',
          model: 'llama3',
          sqlRunner: { name: 'opencode', model: 'openrouter/qwen/qwen3-coder', variant: 'high' },
        },
      },
    });
    expect('backend' in explicitCli && explicitCli.backend.label).toBe('opencode (openrouter/qwen/qwen3-coder)');

    const none = resolveSqlRunner(null);
    expect('error' in none).toBe(true);
  });
});

describe('execCliAsync', () => {
  function makeMockChild() {
    const child = new EventEmitter() as any;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), {
      write: vi.fn(),
      end: vi.fn(),
    });
    child.kill = vi.fn();
    return child;
  }

  it('runs non-blocking spawn with stdin and resolves stdout', async () => {
    const child = makeMockChild();
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('{"ok":true}'));
        child.emit('close', 0);
      });
      return child;
    });

    const out = await execCliAsync('opencode', ['run', '--format', 'json'], { input: 'hello' });
    expect(out.stdout).toBe('{"ok":true}');
    expect(child.stdin.write).toHaveBeenCalledWith('hello');
    expect(child.stdin.end).toHaveBeenCalled();
    expect(spawnMock.mock.calls[0][2]).toMatchObject({ shell: false });
  });

  it('kills child process on AbortSignal', async () => {
    const child = makeMockChild();
    spawnMock.mockReturnValue(child);
    const ac = new AbortController();

    const p = execCliAsync('claude', ['-p'], { signal: ac.signal });
    ac.abort();

    await expect(p).rejects.toThrow(/aborted/i);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('parseSqlAgentResponse non-string guard', () => {
  it('returns an error object instead of throwing when given non-string input', () => {
    expect(parseSqlAgentResponse([{ type: 'text', text: 'SELECT 1' }] as unknown as string)).toEqual({
      error: 'SQL sub-agent returned non-string output (array)',
    });
    expect(parseSqlAgentResponse(null as unknown as string)).toEqual({
      error: 'SQL sub-agent returned non-string output (null)',
    });
  });
});
