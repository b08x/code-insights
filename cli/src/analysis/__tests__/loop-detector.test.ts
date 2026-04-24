import { describe, it, expect } from 'vitest';
import { detectRageLoopHeuristic } from '../loop-detector.js';
import type { SQLiteMessageRow } from '../prompt-types.js';

describe('detectRageLoopHeuristic', () => {
  const mockMessage = (id: string, timestamp: string, usage: string, content: string = 'msg'): SQLiteMessageRow => ({
    id,
    session_id: 's1',
    type: 'user',
    content,
    thinking: null,
    tool_calls: '[]',
    tool_results: '[]',
    usage,
    timestamp,
    parent_id: null,
  });

  it('should detect a rage loop when token count is static and messages are rapid', () => {
    const messages: SQLiteMessageRow[] = [
      mockMessage('1', '2026-04-24T10:00:00Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('2', '2026-04-24T10:00:10Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('3', '2026-04-24T10:00:20Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('4', '2026-04-24T10:00:30Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('5', '2026-04-24T10:00:40Z', JSON.stringify({ inputTokens: 150000 })),
    ];

    // Add semantic repetition
    messages[3].content = 'repeat content';
    messages[4].content = 'repeat content';

    const result = detectRageLoopHeuristic(messages);
    expect(result.detected).toBe(true);
    expect(result.reasoning).toContain('static token count (150k)');
    expect(result.turnRange).toEqual(['Turn#0', 'Turn#4']);
  });

  it('should not detect a loop if token count is growing', () => {
    const messages: SQLiteMessageRow[] = [
      mockMessage('1', '2026-04-24T10:00:00Z', JSON.stringify({ inputTokens: 100000 })),
      mockMessage('2', '2026-04-24T10:00:10Z', JSON.stringify({ inputTokens: 110000 })),
      mockMessage('3', '2026-04-24T10:00:20Z', JSON.stringify({ inputTokens: 120000 })),
      mockMessage('4', '2026-04-24T10:00:30Z', JSON.stringify({ inputTokens: 130000 })),
      mockMessage('5', '2026-04-24T10:00:40Z', JSON.stringify({ inputTokens: 140000 })),
    ];

    const result = detectRageLoopHeuristic(messages);
    expect(result.detected).toBe(false);
  });

  it('should not detect a loop if messages are sparse in time', () => {
    const messages: SQLiteMessageRow[] = [
      mockMessage('1', '2026-04-24T10:00:00Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('2', '2026-04-24T10:10:00Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('3', '2026-04-24T10:20:00Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('4', '2026-04-24T10:30:00Z', JSON.stringify({ inputTokens: 150000 })),
      mockMessage('5', '2026-04-24T10:40:00Z', JSON.stringify({ inputTokens: 150000 })),
    ];

    const result = detectRageLoopHeuristic(messages);
    expect(result.detected).toBe(false);
  });
});
