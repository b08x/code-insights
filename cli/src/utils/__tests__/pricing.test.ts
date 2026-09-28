import { describe, it, expect } from 'vitest';
import { getModelPricing, calculateCost } from '../pricing.js';

describe('pricing utility', () => {
  describe('getModelPricing', () => {
    it('returns exact pricing for Gemini models', () => {
      const p = getModelPricing('gemini-2.0-flash');
      expect(p.input).toBe(0.1);
      expect(p.output).toBe(0.4);
    });

    it('matches Gemini prefixes with date stamps or variants', () => {
      const p = getModelPricing('gemini-2.5-flash-preview-0514');
      expect(p.input).toBe(0.1);
      expect(p.output).toBe(0.4);
    });

    it('returns pricing for Mistral models', () => {
      const p1 = getModelPricing('codestral');
      expect(p1.input).toBe(0.3);
      expect(p1.output).toBe(0.9);

      const p2 = getModelPricing('mistral-large-2407');
      expect(p2.input).toBe(2.0);
      expect(p2.output).toBe(6.0);
    });

    it('returns 0 pricing for local or free models', () => {
      expect(getModelPricing('ollama').input).toBe(0);
      expect(getModelPricing('llama-3.1').input).toBe(0);
      expect(getModelPricing('qwen-2.5').input).toBe(0);
      expect(getModelPricing('mimo').input).toBe(0);
    });
  });

  describe('calculateCost', () => {
    it('calculates Gemini Flash token costs accurately', () => {
      const cost = calculateCost([
        {
          model: 'gemini-2.0-flash',
          usage: {
            input_tokens: 1_000_000,   // $0.10
            output_tokens: 1_000_000,  // $0.40
          },
        },
      ]);
      expect(cost).toBe(0.5);
    });

    it('calculates cache read tokens at 10% of input rate', () => {
      const cost = calculateCost([
        {
          model: 'claude-3-5-sonnet-20241022',
          usage: {
            cache_read_input_tokens: 1_000_000, // 3 * 0.1 = $0.30
          },
        },
      ]);
      expect(cost).toBe(0.3);
    });
  });
});
