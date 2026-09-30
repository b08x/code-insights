import { describe, expect, it } from 'vitest';
import {
  applyChatStreamEvent,
  createPendingTurn,
  parseChatStreamEvent,
  pendingTurnToMessages,
  type ChatStreamEvent,
} from '../chat-stream';
import { parseSSEStream } from '../sse';
import { describePageContext, getSuggestedPrompts } from '../chat-prompts';

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe('chat SSE contract', () => {
  it('folds a full stream (split across chunk boundaries) into a done turn', async () => {
    const raw = [
      frame('start', { conversationId: 'c1', userMessageId: 'u1', assistantMessageId: 'a1' }),
      frame('tool_call', { name: 'searchSessions', args: { query: 'auth' }, ok: true, ms: 12 }),
      frame('citation', { sessionId: 's1' }),
      frame('citation', { sessionId: 's1' }),
      frame('draft', { kind: 'note', title: 'Auth learning', content: 'Use refresh tokens', sessionId: 's1' }),
      frame('token', { text: 'Hello ' }),
      frame('token', { text: 'world\nline two' }),
      frame('done', {
        messageId: 'a1', content: 'Hello world\nline two', citations: ['s1'],
        toolCalls: [{ name: 'searchSessions', args: { query: 'auth' }, ok: true, ms: 12 }],
        drafts: [{ kind: 'note', title: 'Auth learning', content: 'Use refresh tokens', sessionId: 's1' }],
      }),
    ].join('');
    // Split mid-frame to exercise buffering.
    const chunks = [raw.slice(0, 37), raw.slice(37, 150), raw.slice(150)];

    let turn = createPendingTurn('c1', 'summarize this session', { page: 'session', sessionId: 's1' });
    const seen: string[] = [];
    for await (const r of parseSSEStream(sseBody(chunks))) {
      const ev = parseChatStreamEvent(r);
      expect(ev).not.toBeNull();
      seen.push(ev!.event);
      turn = applyChatStreamEvent(turn, ev!);
    }

    expect(seen).toEqual(['start', 'tool_call', 'citation', 'citation', 'draft', 'token', 'token', 'done']);
    expect(turn.status).toBe('done');
    expect(turn.userMessageId).toBe('u1');
    expect(turn.content).toBe('Hello world\nline two');
    expect(turn.citations).toEqual(['s1']);
    expect(turn.toolCalls).toHaveLength(1);
    expect(turn.drafts[0].title).toBe('Auth learning');

    const [user, assistant] = pendingTurnToMessages(turn);
    expect(user).toMatchObject({ id: 'u1', role: 'user', context: { sessionId: 's1' } });
    expect(assistant).toMatchObject({ id: 'a1', role: 'assistant', toolCalls: { citations: ['s1'] } });
  });

  it('accumulates tokens and records errors', () => {
    let turn = createPendingTurn('c1', 'hi', null);
    const events: ChatStreamEvent[] = [
      { event: 'start', data: { conversationId: 'c1', userMessageId: 'u', assistantMessageId: 'a' } },
      { event: 'token', data: { text: 'part' } },
      { event: 'error', data: { error: 'LLM timeout' } },
    ];
    for (const ev of events) turn = applyChatStreamEvent(turn, ev);
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('LLM timeout');
    expect(turn.content).toBe('part');
  });

  it('ignores unknown and malformed events', () => {
    expect(parseChatStreamEvent({ event: 'progress', data: '{}' })).toBeNull();
    expect(parseChatStreamEvent({ event: 'token', data: '{not json' })).toBeNull();
  });

  it('omits the assistant message when nothing was produced', () => {
    const turn = createPendingTurn('c1', 'hi', null);
    expect(pendingTurnToMessages(turn)).toHaveLength(1);
  });
});

describe('suggested prompts', () => {
  it('returns page-specific prompts and falls back to defaults', () => {
    expect(getSuggestedPrompts({ page: 'session', sessionId: 'x' })).toContain('Summarize this session');
    expect(getSuggestedPrompts({ page: 'unknown-page' }).length).toBeGreaterThan(0);
    expect(getSuggestedPrompts(null).length).toBeGreaterThan(0);
  });

  it('describes context with a short id', () => {
    expect(describePageContext({ page: 'session', sessionId: 'abcdef1234567' })).toBe('Session abcdef12');
    expect(describePageContext({ page: 'insights' })).toBe('Insights');
    expect(describePageContext({})).toBeNull();
  });
});
