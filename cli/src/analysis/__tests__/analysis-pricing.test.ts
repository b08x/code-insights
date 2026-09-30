import { describe, it, expect } from 'vitest';
import { calculateAnalysisCost } from '../analysis-pricing.js';

describe('calculateAnalysisCost', () => {
  it('ollama and unknown providers are free', () => {
    expect(calculateAnalysisCost('ollama', 'llama3', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
    expect(calculateAnalysisCost('nonexistent', 'x', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });

  it('anthropic applies cache multipliers (create 1.25x, read 0.10x of input price)', () => {
    const base = calculateAnalysisCost('anthropic', 'claude-sonnet-4-20250514', { inputTokens: 1_000_000, outputTokens: 0 });
    expect(base).toBeGreaterThan(0);
    expect(calculateAnalysisCost('anthropic', 'claude-sonnet-4-20250514', { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 1_000_000 }))
      .toBeCloseTo(base * 1.25, 6);
    expect(calculateAnalysisCost('anthropic', 'claude-sonnet-4-20250514', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }))
      .toBeCloseTo(base * 0.1, 6);
  });

  it('model without pricing data costs 0', () => {
    expect(calculateAnalysisCost('openai', 'no-such-model', { inputTokens: 1e6, outputTokens: 1e6 })).toBe(0);
  });
});
