// Chat API: persistent conversations + SSE-streamed agent turns.
//
//   POST   /api/chat/conversations                     create   -> 201 { conversation }
//   GET    /api/chat/conversations                     list     -> { conversations }
//   GET    /api/chat/conversations/:id                 get      -> { conversation, messages }
//   DELETE /api/chat/conversations/:id                 delete   -> { success: true }
//   POST   /api/chat/conversations/:id/messages        send     -> SSE (see below)
//
// SSE events for POST .../messages (payloads are JSON):
//   start      { conversationId, userMessageId, assistantMessageId }
//   tool_call  { name, args, ok, ms }            (after each tool finishes)
//   citation   { sessionId }                     (once per session seen in tool results)
//   draft      { kind, title, content, sessionId? }  (UI renders a Save button; nothing is saved)
//   token      { text }                          (reply text delta)
//   done       { messageId, content, citations: string[], toolCalls: [...], drafts: [...] }
//   error      { error }
// The user message is persisted before streaming; the assistant message is persisted when the
// turn ends (also with partial text if the LLM errors or the client disconnects).

import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { getDb } from '@code-insights/cli/db/client';
import { captureError } from '@code-insights/cli/utils/telemetry';
import {
  runChatAgent,
  resolveAgentLLM,
  type AgentEvent,
  type HistoryMessage,
  type PageContext,
  type RunChatAgentParams,
} from '../agent/agent.js';
import { streamEvents, type SSEMessage } from './route-helpers.js';
import type { DraftPayload } from '../agent/tools.js';

const HISTORY_LIMIT = 20;
const MAX_CONTENT_CHARS = 8000;
const DEFAULT_TITLE = 'New conversation';

export interface ChatDeps {
  resolveLLM: typeof resolveAgentLLM;
  runAgent: (params: RunChatAgentParams) => AsyncGenerator<AgentEvent>;
}

interface ConversationRow { id: string; title: string; created_at: string; updated_at: string }
interface MessageRow {
  id: string; conversation_id: string; role: string; content: string;
  context_json: string | null; tool_calls_json: string | null; created_at: string;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function toMessage(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    context: parseJson(row.context_json),
    // Shape: { toolCalls, citations, drafts } for assistant messages.
    toolCalls: parseJson(row.tool_calls_json),
    createdAt: row.created_at,
  };
}

function toConversation(row: ConversationRow) {
  return { id: row.id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

const CONTEXT_KEYS = ['page', 'sessionId', 'runId', 'versionId'] as const;
const CONTEXT_VALUE_MAX = 200;

/** Whitelist + length-cap client-supplied page context; it is persisted and fed to the model. */
export function sanitizePageContext(v: unknown): PageContext | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const out: PageContext = {};
  for (const k of CONTEXT_KEYS) {
    const val = (v as Record<string, unknown>)[k];
    if (typeof val === 'string' && val) out[k] = val.slice(0, CONTEXT_VALUE_MAX);
  }
  return out;
}

export function createChatRouter(deps: Partial<ChatDeps> = {}): Hono {
  const resolveLLM = deps.resolveLLM ?? resolveAgentLLM;
  const runAgent = deps.runAgent ?? runChatAgent;
  const app = new Hono();

  app.post('/conversations', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: unknown };
    const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : DEFAULT_TITLE;
    const id = randomUUID();
    const now = new Date().toISOString();
    getDb().prepare('INSERT INTO chat_conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, title, now, now);
    return c.json({ conversation: { id, title, createdAt: now, updatedAt: now } }, 201);
  });

  app.get('/conversations', (c) => {
    const rows = getDb().prepare('SELECT id, title, created_at, updated_at FROM chat_conversations ORDER BY updated_at DESC LIMIT 100')
      .all() as ConversationRow[];
    return c.json({ conversations: rows.map(toConversation) });
  });

  app.get('/conversations/:id', (c) => {
    const db = getDb();
    const conv = db.prepare('SELECT id, title, created_at, updated_at FROM chat_conversations WHERE id = ?')
      .get(c.req.param('id')) as ConversationRow | undefined;
    if (!conv) return c.json({ error: 'Conversation not found' }, 404);
    const rows = db.prepare('SELECT * FROM chat_messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(conv.id) as MessageRow[];
    return c.json({ conversation: toConversation(conv), messages: rows.map(toMessage) });
  });

  app.delete('/conversations/:id', (c) => {
    const db = getDb();
    const id = c.req.param('id');
    // Explicit child delete: SQLite only enforces ON DELETE CASCADE when foreign_keys is on.
    db.prepare('DELETE FROM chat_messages WHERE conversation_id = ?').run(id);
    const res = db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(id);
    if (res.changes === 0) return c.json({ error: 'Conversation not found' }, 404);
    return c.json({ success: true });
  });

  app.post('/conversations/:id/messages', async (c) => {
    const db = getDb();
    const conversationId = c.req.param('id');
    const conv = db.prepare('SELECT id, title FROM chat_conversations WHERE id = ?').get(conversationId) as { id: string; title: string } | undefined;
    if (!conv) return c.json({ error: 'Conversation not found' }, 404);

    const body = await c.req.json().catch(() => null) as { content?: unknown; pageContext?: unknown } | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'Invalid JSON in request body' }, 400);
    const content = typeof body.content === 'string' ? body.content.trim() : '';
    if (!content) return c.json({ error: 'content is required' }, 400);
    if (content.length > MAX_CONTENT_CHARS) return c.json({ error: `content exceeds ${MAX_CONTENT_CHARS} characters` }, 400);
    const pageContext = sanitizePageContext(body.pageContext);

    const resolved = resolveLLM();
    if ('error' in resolved) return c.json({ error: resolved.error }, 400);

    // History = prior turns (before persisting this message), oldest first.
    const history = (db.prepare(`
      SELECT role, content FROM (
        SELECT role, content, created_at, rowid AS rid FROM chat_messages WHERE conversation_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, rid ASC
    `).all(conversationId, HISTORY_LIMIT) as HistoryMessage[]);

    const userMessageId = randomUUID();
    const assistantMessageId = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO chat_messages (id, conversation_id, role, content, context_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(userMessageId, conversationId, 'user', content, pageContext ? JSON.stringify(pageContext) : null, now);
    if (conv.title === DEFAULT_TITLE) {
      db.prepare('UPDATE chat_conversations SET title = ? WHERE id = ?').run(content.replace(/\s+/g, ' ').slice(0, 60), conversationId);
    }
    db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

    return streamEvents(c, async function* (signal): AsyncGenerator<SSEMessage> {
      let reply = '';
      const citations: string[] = [];
      const toolCalls: Array<{ name: string; args: unknown; ok: boolean; ms: number }> = [];
      const drafts: DraftPayload[] = [];
      let failed: string | null = null;

      yield { event: 'start', data: { conversationId, userMessageId, assistantMessageId } };

      try {
        for await (const ev of runAgent({ llm: resolved.llm, userQuery: content, pageContext, history, signal })) {
          if (signal.aborted) break;
          switch (ev.type) {
            case 'text': reply += ev.text; yield { event: 'token', data: { text: ev.text } }; break;
            case 'tool_call': {
              const { type: _t, ...rest } = ev;
              toolCalls.push(rest);
              yield { event: 'tool_call', data: rest };
              break;
            }
            case 'citation': citations.push(ev.sessionId); yield { event: 'citation', data: { sessionId: ev.sessionId } }; break;
            case 'draft': drafts.push(ev.draft); yield { event: 'draft', data: ev.draft }; break;
          }
        }
      } catch (err) {
        failed = err instanceof Error ? err.message : 'Agent error';
        captureError(err, { type: 'chat_turn' });
      } finally {
        // Persist whatever was produced so a reload restores the conversation (agent-6),
        // including partial replies after an error or client disconnect.
        if (reply || toolCalls.length > 0) {
          try {
            db.prepare('INSERT INTO chat_messages (id, conversation_id, role, content, tool_calls_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
              .run(assistantMessageId, conversationId, 'assistant', reply, JSON.stringify({ toolCalls, citations, drafts }), new Date().toISOString());
            db.prepare('UPDATE chat_conversations SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), conversationId);
          } catch (e) {
            captureError(e, { type: 'chat_persist' });
          }
        }
      }

      if (failed) {
        yield { event: 'error', data: { error: failed } };
      } else {
        yield { event: 'done', data: { messageId: assistantMessageId, content: reply, citations, toolCalls, drafts } };
      }
    });
  });

  return app;
}

export default createChatRouter();
