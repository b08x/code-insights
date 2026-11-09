import { describe, it, expect } from 'vitest';
import { batchPrice, listPrice } from '../pricing.js';

describe('batch pricing', () => {
  it('prices a model from the provider table and halves it for batch', () => {
    // gpt-4o-mini: $0.15 in / $0.60 out per 1M tokens
    expect(listPrice('openai', 'gpt-4o-mini', 1_000_000, 1_000_000)).toBe(0.75);
    expect(batchPrice('openai', 'gpt-4o-mini', 1_000_000, 1_000_000)).toBe(0.375);
  });

  it.each([
    ['mistral', 'mistral-small-latest'],
    ['openrouter', 'meta-llama/llama-3.3-70b-instruct'],
    ['mistral', 'not-a-model'],
    ['nobody', 'x'],
  ])('%s/%s has no price: undefined, never 0', (provider, model) => {
    expect(listPrice(provider, model, 1000, 1000)).toBeUndefined();
    expect(batchPrice(provider, model, 1000, 1000)).toBeUndefined();
  });
});
