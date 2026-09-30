// Pure state transitions for one in-flight agent chat turn.
// Kept free of React so the SSE contract can be unit-tested in isolation.

import type { ChatDraft, ChatMessage, ChatToolCall, PageContext } from '@/lib/types';

export type PendingStatus = 'connecting' | 'streaming' | 'done' | 'error' | 'aborted';

/** The turn currently being streamed: the user's message plus the partial assistant reply. */
export interface PendingTurn {
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string | null;
  userContent: string;
  pageContext: PageContext | null;
  content: string;
  toolCalls: ChatToolCall[];
  citations: string[];
  drafts: ChatDraft[];
  status: PendingStatus;
  error: string | null;
  startedAt: string;
}

export type ChatStreamEvent =
  | { event: 'start'; data: { conversationId: string; userMessageId: string; assistantMessageId: string } }
  | { event: 'tool_call'; data: ChatToolCall }
  | { event: 'citation'; data: { sessionId: string } }
  | { event: 'draft'; data: ChatDraft }
  | { event: 'token'; data: { text: string } }
  | { event: 'done'; data: { messageId: string; content: string; citations: string[]; toolCalls: ChatToolCall[]; drafts: ChatDraft[] } }
  | { event: 'error'; data: { error: string } };

const KNOWN_EVENTS = new Set(['start', 'tool_call', 'citation', 'draft', 'token', 'done', 'error']);

/** Parse a raw `{event, data}` pair from parseSSEStream. Returns null for unknown or malformed events. */
export function parseChatStreamEvent(raw: { event: string; data: string }): ChatStreamEvent | null {
  if (!KNOWN_EVENTS.has(raw.event)) return null;
  try {
    return { event: raw.event, data: JSON.parse(raw.data) } as ChatStreamEvent;
  } catch {
    return null;
  }
}

export function createPendingTurn(
  conversationId: string,
  userContent: string,
  pageContext: PageContext | null,
): PendingTurn {
  return {
    conversationId,
    userMessageId: null,
    assistantMessageId: null,
    userContent,
    pageContext,
    content: '',
    toolCalls: [],
    citations: [],
    drafts: [],
    status: 'connecting',
    error: null,
    startedAt: new Date().toISOString(),
  };
}

export function applyChatStreamEvent(turn: PendingTurn, ev: ChatStreamEvent): PendingTurn {
  switch (ev.event) {
    case 'start':
      return {
        ...turn,
        userMessageId: ev.data.userMessageId,
        assistantMessageId: ev.data.assistantMessageId,
        status: 'streaming',
      };
    case 'tool_call':
      return { ...turn, toolCalls: [...turn.toolCalls, ev.data], status: 'streaming' };
    case 'citation':
      return turn.citations.includes(ev.data.sessionId)
        ? turn
        : { ...turn, citations: [...turn.citations, ev.data.sessionId] };
    case 'draft':
      return { ...turn, drafts: [...turn.drafts, ev.data] };
    case 'token':
      return { ...turn, content: turn.content + ev.data.text, status: 'streaming' };
    case 'done':
      return {
        ...turn,
        assistantMessageId: ev.data.messageId ?? turn.assistantMessageId,
        content: ev.data.content ?? turn.content,
        citations: ev.data.citations ?? turn.citations,
        toolCalls: ev.data.toolCalls ?? turn.toolCalls,
        drafts: ev.data.drafts ?? turn.drafts,
        status: 'done',
      };
    case 'error':
      return { ...turn, status: 'error', error: ev.data.error || 'Agent error' };
  }
}

/**
 * Convert a pending turn into the two persisted-shape messages so it can be
 * merged into the React Query cache after `done` without a visible flicker.
 */
export function pendingTurnToMessages(turn: PendingTurn): ChatMessage[] {
  const out: ChatMessage[] = [{
    id: turn.userMessageId ?? `pending-user-${turn.startedAt}`,
    conversationId: turn.conversationId,
    role: 'user',
    content: turn.userContent,
    context: turn.pageContext,
    toolCalls: null,
    createdAt: turn.startedAt,
  }];
  if (turn.content || turn.toolCalls.length > 0) {
    out.push({
      id: turn.assistantMessageId ?? `pending-assistant-${turn.startedAt}`,
      conversationId: turn.conversationId,
      role: 'assistant',
      content: turn.content,
      context: null,
      toolCalls: { toolCalls: turn.toolCalls, citations: turn.citations, drafts: turn.drafts },
      createdAt: new Date().toISOString(),
    });
  }
  return out;
}
