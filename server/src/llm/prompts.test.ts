import { describe, it, expect } from 'vitest';
import {
  formatMessagesForAnalysis,
  generateSessionAnalysisPrompt,
  parseAnalysisResponse,
  parsePromptQualityResponse,
  SESSION_ANALYSIS_SYSTEM_PROMPT,
  PROMPT_QUALITY_SYSTEM_PROMPT,
  type SQLiteMessageRow,
} from './prompts.js';

// ──────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────

function makeMessage(overrides: Partial<SQLiteMessageRow> = {}): SQLiteMessageRow {
  return {
    id: 'msg-1',
    session_id: 'sess-1',
    type: 'user',
    content: 'Hello world',
    thinking: null,
    tool_calls: '',
    tool_results: '',
    usage: null,
    timestamp: '2025-06-15T10:00:00Z',
    parent_id: null,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────
// formatMessagesForAnalysis
// ──────────────────────────────────────────────────────

describe('formatMessagesForAnalysis', () => {
  it('produces readable text with role labels', () => {
    const messages = [
      makeMessage({ type: 'user', content: 'Fix the bug' }),
      makeMessage({ id: 'msg-2', type: 'assistant', content: 'Done!' }),
    ];
    const result = formatMessagesForAnalysis(messages);
    expect(result).toContain('### User#0:');
    expect(result).toContain('Fix the bug');
    expect(result).toContain('### Assistant#0:');
    expect(result).toContain('Done!');
  });

  it('increments user and assistant indices independently', () => {
    const messages = [
      makeMessage({ type: 'user', content: 'msg 1' }),
      makeMessage({ id: 'msg-2', type: 'assistant', content: 'msg 2' }),
      makeMessage({ id: 'msg-3', type: 'user', content: 'msg 3' }),
      makeMessage({ id: 'msg-4', type: 'assistant', content: 'msg 4' }),
    ];
    const result = formatMessagesForAnalysis(messages);
    expect(result).toContain('User#0');
    expect(result).toContain('Assistant#0');
    expect(result).toContain('User#1');
    expect(result).toContain('Assistant#1');
  });

  it('includes tool call names when present', () => {
    const messages = [
      makeMessage({
        type: 'assistant',
        content: 'Let me read the file',
        tool_calls: JSON.stringify([{ name: 'Read' }, { name: 'Write' }]),
      }),
    ];
    const result = formatMessagesForAnalysis(messages);
    expect(result).toContain('[Tools used: Read, Write]');
  });

  it('includes thinking content when present', () => {
    const messages = [
      makeMessage({
        type: 'assistant',
        content: 'The answer is 42',
        thinking: 'I need to calculate this carefully',
      }),
    ];
    const result = formatMessagesForAnalysis(messages);
    expect(result).toContain('[Thinking: I need to calculate this carefully]');
  });

  it('includes tool results when present', () => {
    const messages = [
      makeMessage({
        type: 'assistant',
        content: 'Read the file',
        tool_results: JSON.stringify([{ output: 'file contents here' }]),
      }),
    ];
    const result = formatMessagesForAnalysis(messages);
    expect(result).toContain('[Tool results: file contents here]');
  });

  it('handles empty messages array', () => {
    const result = formatMessagesForAnalysis([]);
    expect(result).toBe('');
  });

  it('handles malformed JSON in tool_calls gracefully', () => {
    const messages = [
      makeMessage({
        type: 'assistant',
        content: 'oops',
        tool_calls: 'not valid json',
      }),
    ];
    // Should not throw
    const result = formatMessagesForAnalysis(messages);
    expect(result).toContain('oops');
    // No [Tools used:] since parse failed
    expect(result).not.toContain('[Tools used:');
  });
});

// ──────────────────────────────────────────────────────
// generateSessionAnalysisPrompt
// ──────────────────────────────────────────────────────

describe('generateSessionAnalysisPrompt', () => {
  it('includes project name in the prompt', () => {
    const result = generateSessionAnalysisPrompt('my-app', null, 'conversation text');
    expect(result).toContain('Project: my-app');
  });

  it('includes session summary when provided', () => {
    const result = generateSessionAnalysisPrompt('my-app', 'Fixed a critical bug', 'conversation text');
    expect(result).toContain('Session Summary: Fixed a critical bug');
  });

  it('omits session summary line when null', () => {
    const result = generateSessionAnalysisPrompt('my-app', null, 'conversation text');
    expect(result).not.toContain('Session Summary:');
  });

  it('includes the formatted messages', () => {
    const result = generateSessionAnalysisPrompt('my-app', null, '### User#0:\nHello');
    expect(result).toContain('### User#0:\nHello');
  });
});

// ──────────────────────────────────────────────────────
// parseAnalysisResponse
// ──────────────────────────────────────────────────────

describe('parseAnalysisResponse', () => {
  it('parses valid JSON in <json> tags', () => {
    const response = `<json>
{
  "summary": {
    "title": "Implemented auth",
    "content": "Added login and logout",
    "bullets": ["Login flow", "Logout flow"]
  },
  "decisions": [],
  "learnings": []
}
</json>`;
    const result = parseAnalysisResponse(response);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary.title).toBe('Implemented auth');
    expect(result.data.summary.bullets).toHaveLength(2);
    expect(result.data.decisions).toEqual([]);
    expect(result.data.learnings).toEqual([]);
  });

  it('parses raw JSON without tags', () => {
    const response = `{
  "summary": { "title": "Test", "content": "Content", "bullets": [] },
  "decisions": [],
  "learnings": []
}`;
    const result = parseAnalysisResponse(response);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.summary.title).toBe('Test');
  });

  it('returns error for completely malformed response', () => {
    const result = parseAnalysisResponse('This is not JSON at all');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.error_type).toBe('no_json_found');
  });

  it('returns error for JSON missing required summary.title', () => {
    const response = '<json>{ "summary": { "content": "no title" }, "decisions": [], "learnings": [] }</json>';
    const result = parseAnalysisResponse(response);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.error_type).toBe('invalid_structure');
  });

  it('defaults decisions and learnings to empty arrays when missing', () => {
    const response = '<json>{ "summary": { "title": "Test", "content": "c", "bullets": [] } }</json>';
    const result = parseAnalysisResponse(response);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.decisions).toEqual([]);
    expect(result.data.learnings).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────
// parsePromptQualityResponse
// ──────────────────────────────────────────────────────

describe('parsePromptQualityResponse', () => {
  it('parses valid prompt quality response', () => {
    const response = `<json>{
      "efficiencyScore": 85,
      "potentialMessageReduction": 2,
      "overallAssessment": "Good prompting style",
      "wastedTurns": [],
      "antiPatterns": [],
      "tips": ["Be more specific"]
    }</json>`;
    const result = parsePromptQualityResponse(response);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.efficiencyScore).toBe(85);
    expect(result.data.tips).toHaveLength(1);
  });

  it('clamps efficiency score to 0-100 range', () => {
    const response = '<json>{ "efficiencyScore": 150, "wastedTurns": [], "antiPatterns": [], "tips": [] }</json>';
    const result = parsePromptQualityResponse(response);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.efficiencyScore).toBe(100);
  });

  it('returns error for missing efficiencyScore', () => {
    const response = '<json>{ "overallAssessment": "no score" }</json>';
    const result = parsePromptQualityResponse(response);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.error_type).toBe('invalid_structure');
  });

  it('returns error for completely invalid response', () => {
    const result = parsePromptQualityResponse('not json');
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.error_type).toBe('no_json_found');
  });
});

// ──────────────────────────────────────────────────────
// System prompt constants
// ──────────────────────────────────────────────────────

describe('System prompt constants', () => {
  it('SESSION_ANALYSIS_SYSTEM_PROMPT is a non-empty string', () => {
    expect(typeof SESSION_ANALYSIS_SYSTEM_PROMPT).toBe('string');
    expect(SESSION_ANALYSIS_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });

  it('PROMPT_QUALITY_SYSTEM_PROMPT is a non-empty string', () => {
    expect(typeof PROMPT_QUALITY_SYSTEM_PROMPT).toBe('string');
    expect(PROMPT_QUALITY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
