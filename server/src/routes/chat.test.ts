import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AxMockAIService } from '@ax-llm/ax';
import { runMigrations } from '@code-insights/cli/db/schema';

let testDb: Database.Database;

vi.mock('@code-insights/cli/db/client', () => ({
  getDb: () => testDb,
  closeDb: () => {},
}));
vi.mock('@code-insights/cli/utils/telemetry', () => ({
  trackEvent: vi.fn(),
  captureError: vi.fn(),
}));

const { createChatRouter } = await import('./chat.js');
const { createApp } = await import('../index.js');
const { toolRegistry, ToolRegistry } = await import('../agent/tools.js');
const { buildForwardInputs, runChatAgent, extractSessionIds } = await import('../agent/agent.js');

import type { AgentEvent, RunChatAgentParams } from '../agent/agent.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

const fakeLLM = {} as never;

function makeApp(runAgent: (p: RunChatAgentParams) => AsyncGenerator<AgentEvent>) {
  const app = new Hono();
  app.route('/api/chat', createChatRouter({ resolveLLM: () => ({ llm: fakeLLM }), runAgent }));
  return app;
}

async function createConversation(app: Hono, title?: string): Promise<string> {
  const res = await app.request('/api/chat/conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(title ? { title } : {}),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { conversation: { id: string } }).conversation.id;
}

function parseSSE(text: string): Array<{ event: string; data: any }> {
  return text.split('\n\n').filter(Boolean).map(block => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return { event, data: data ? JSON.parse(data) : null };
  });
}

async function send(app: Hono, id: string, body: unknown) {
  return app.request(`/api/chat/conversations/${id}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
});
afterEach(() => testDb.close());

// ─── tool registry (agent-2, agent-4, agent-10, agent-11) ─────────────────────

describe('agent tool registry', () => {
  const names = (cfg: any) => toolRegistry.list(cfg).map(t => t.id);

  it('exposes the four read tools plus draft by default (agent-2)', () => {
    expect(names(null)).toEqual(expect.arrayContaining(['searchSessions', 'getSession', 'listInsights', 'getAnalytics', 'proposeDraft']));
  });

  it('omits codebase.* tools unless dashboard.agent.codebaseTools === true (agent-4)', () => {
    const off = names({ dashboard: { agent: { provider: 'openai', model: 'm' } } });
    expect(off.filter(n => n.startsWith('codebase.'))).toEqual([]);
    expect(names({ dashboard: { agent: { provider: 'openai', model: 'm', codebaseTools: false } } }).some(n => n.startsWith('codebase.'))).toBe(false);

    const on = names({ dashboard: { agent: { provider: 'openai', model: 'm', codebaseTools: true } } });
    expect(on).toEqual(expect.arrayContaining(['codebase.listProjects', 'codebase.getArchitecture', 'codebase.tracePath']));
  });

  it('registers no tool that writes labels, promotes versions, or starts runs (agent-10)', () => {
    const all = toolRegistry.list({ dashboard: { agent: { provider: 'openai', model: 'm', codebaseTools: true } } } as any);
    const writeLike = /^(save|write|create|update|delete|promote|start|run|set|apply)/i;
    const offenders = all.filter(t => t.group !== 'codebase' && writeLike.test(t.fn.name)).map(t => t.id);
    expect(offenders).toEqual([]);
  });

  it('lets later phases append tools (agent-11)', () => {
    const reg = new ToolRegistry();
    const fnDef = { name: 'listRuns', description: 'd', func: async () => ({}) };
    reg.register({ id: 'listRuns', group: 'optimization', fn: fnDef });
    expect(reg.list(null).map(t => t.id)).toEqual(['listRuns']);
    expect(() => reg.register({ id: 'listRuns', group: 'optimization', fn: fnDef })).toThrow(/already registered/);
    reg.register({ id: 'gated', group: 'optimization', enabled: () => false, fn: { ...fnDef, name: 'gated' } });
    expect(reg.functions(null)).toHaveLength(1);
  });
});

// ─── agent internals (agent-8, agent-5) ───────────────────────────────────────

describe('chat agent', () => {
  it('buildForwardInputs passes pageContext and history into the forward inputs (agent-8)', () => {
    const inputs = buildForwardInputs({ userQuery: 'summarize this session', pageContext: { page: 'session', sessionId: 's1' }, history: [{ role: 'user', content: 'hi' }] });
    expect(inputs).toEqual({ userQuery: 'summarize this session', pageContext: { page: 'session', sessionId: 's1' }, history: [{ role: 'user', content: 'hi' }] });
  });

  it('sends pageContext to the model and streams the reply', async () => {
    const requests: any[] = [];
    const llm = new AxMockAIService({
      features: { functions: true, streaming: false },
      chatResponse: async (req: any) => {
        requests.push(req);
        return { results: [{ index: 0, content: 'Reply: {"x":1}', finishReason: 'stop' }] } as any;
      },
    });
    const events: AgentEvent[] = [];
    for await (const ev of runChatAgent({
      llm: llm as any, userQuery: 'summarize this session', pageContext: { page: 'session', sessionId: 'sess-ctx-42' }, tools: [],
    })) events.push(ev);
    expect(JSON.stringify(requests[0])).toContain('sess-ctx-42');
    expect(events.filter(e => e.type === 'text').length).toBeGreaterThan(0);
  });

  it('extractSessionIds finds IDs nested in tool results (agent-5)', () => {
    const ids = extractSessionIds({ results: [{ sessionId: 'a' }, { sessionId: 'b', x: { sessionId: 'c' } }] });
    expect([...ids].sort()).toEqual(['a', 'b', 'c']);
    expect([...extractSessionIds(JSON.stringify({ insights: [{ sessionId: 'z' }] }))]).toEqual(['z']);
    expect(extractSessionIds('not json').size).toBe(0);
  });
});

// ─── routes (agent-6, agent-8, agent-10) ──────────────────────────────────────

describe('chat routes', () => {
  it('creates, lists, gets and deletes conversations', async () => {
    const app = makeApp(async function* () {});
    const id = await createConversation(app, 'Hello');
    const list = await (await app.request('/api/chat/conversations')).json() as any;
    expect(list.conversations.map((c: any) => c.id)).toEqual([id]);
    const got = await (await app.request(`/api/chat/conversations/${id}`)).json() as any;
    expect(got.conversation.title).toBe('Hello');
    expect(got.messages).toEqual([]);
    expect((await app.request(`/api/chat/conversations/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/chat/conversations/${id}`)).status).toBe(404);
    expect((await app.request(`/api/chat/conversations/${id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('streams events, passes pageContext + history to the agent, and persists both messages (agent-6, agent-8)', async () => {
    const calls: RunChatAgentParams[] = [];
    const app = makeApp(async function* (params) {
      calls.push(params);
      yield { type: 'tool_call', name: 'searchSessions', args: { query: 'x' }, ok: true, ms: 3 };
      yield { type: 'citation', sessionId: 'sess-1' };
      yield { type: 'text', text: 'Hello ' };
      yield { type: 'text', text: 'world' };
    });
    const id = await createConversation(app);
    const ctx = { page: 'session', sessionId: 'sess-1' };

    const res = await send(app, id, { content: 'summarize this session', pageContext: ctx });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSSE(await res.text());
    expect(events.map(e => e.event)).toEqual(['start', 'tool_call', 'citation', 'token', 'token', 'done']);
    const done = events.at(-1)!.data;
    expect(done.content).toBe('Hello world');
    expect(done.citations).toEqual(['sess-1']);
    expect(done.toolCalls[0].name).toBe('searchSessions');

    expect(calls[0].pageContext).toEqual(ctx);
    expect(calls[0].userQuery).toBe('summarize this session');
    expect(calls[0].history).toEqual([]);

    // Reload restores the conversation
    const got = await (await app.request(`/api/chat/conversations/${id}`)).json() as any;
    expect(got.messages.map((m: any) => [m.role, m.content])).toEqual([['user', 'summarize this session'], ['assistant', 'Hello world']]);
    expect(got.messages[0].context).toEqual(ctx);
    expect(got.messages[1].toolCalls.citations).toEqual(['sess-1']);
    expect(got.conversation.title).toBe('summarize this session');

    // Second turn sees first turn as history
    await (await send(app, id, { content: 'and now?' })).text();
    expect(calls[1].history.map(h => h.role)).toEqual(['user', 'assistant']);
    expect(calls[1].pageContext).toBeNull();
  });

  it('emits a typed draft event and does not write anything else (agent-10)', async () => {
    testDb.prepare("INSERT INTO projects (id, name, path, last_activity) VALUES ('p','P','/p','2026-01-01')").run();
    const app = makeApp(async function* () {
      yield { type: 'draft', draft: { kind: 'label', title: 'Outcome label', content: 'success', sessionId: 's1' } };
      yield { type: 'text', text: 'Drafted.' };
    });
    const id = await createConversation(app);
    const events = parseSSE(await (await send(app, id, { content: 'draft a label' })).text());
    const draft = events.find(e => e.event === 'draft')!.data;
    expect(draft).toEqual({ kind: 'label', title: 'Outcome label', content: 'success', sessionId: 's1' });
    const tables = (testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    // Only chat tables are written to by the chat route.
    expect(tables.filter(t => /label|optimization|prompt_version/.test(t))).toEqual([]);
    const got = await (await app.request(`/api/chat/conversations/${id}`)).json() as any;
    expect(got.messages[1].toolCalls.drafts).toHaveLength(1);
  });

  it('reports agent errors as an error event and keeps partial text', async () => {
    const app = makeApp(async function* () {
      yield { type: 'text', text: 'partial' };
      throw new Error('llm exploded');
    });
    const id = await createConversation(app);
    const events = parseSSE(await (await send(app, id, { content: 'hi' })).text());
    expect(events.at(-1)).toEqual({ event: 'error', data: { error: 'llm exploded' } });
    const got = await (await app.request(`/api/chat/conversations/${id}`)).json() as any;
    expect(got.messages.at(-1).content).toBe('partial');
  });

  it('validates input and unknown conversations', async () => {
    const app = makeApp(async function* () {});
    const id = await createConversation(app);
    expect((await send(app, id, { content: '   ' })).status).toBe(400);
    expect((await send(app, 'nope', { content: 'hi' })).status).toBe(404);
  });

  it('returns 400 when no LLM is configured', async () => {
    const app = new Hono();
    app.route('/api/chat', createChatRouter({ resolveLLM: () => ({ error: 'No API key' }), runAgent: async function* () {} }));
    const id = await createConversation(app);
    const res = await send(app, id, { content: 'hi' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe('No API key');
  });
});

describe('app wiring', () => {
  it('mounts /api/chat and no longer serves /api/agent', async () => {
    const app = createApp();
    expect((await app.request('/api/chat/conversations')).status).toBe(200);
    expect((await app.request('/api/agent', { method: 'POST', body: '{}' })).status).toBe(404);
  });
});
