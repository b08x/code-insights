import { describe, it, expect } from 'vitest';
import { jsonrepair } from 'jsonrepair';

// Ported from cli/src/analysis/response-parsers.ts for testing
function preProcessJson(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;
  let lastSignificantChar = '';

  for (let i = 0; i < json.length; i++) {
    const char = json[i];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      if (inString) {
        let nextNonWhitespace = -1;
        for (let j = i + 1; j < json.length; j++) {
          if (!/\s/.test(json[j])) {
            nextNonWhitespace = j;
            break;
          }
        }

        const nextChar = nextNonWhitespace !== -1 ? json[nextNonWhitespace] : '';

        let isLikelyEnd = false;
        if ([',', '}', ']'].includes(nextChar) || nextNonWhitespace === -1) {
          isLikelyEnd = true;
        } else if (nextChar === ':') {
          if (['{', ',', '['].includes(lastSignificantChar)) {
            isLikelyEnd = true;
          }
        }

        if (isLikelyEnd) {
          inString = false;
          result += char;
          lastSignificantChar = '"';
        } else {
          result += '\\"';
        }
      } else {
        inString = true;
        result += char;
      }
    } else {
      result += char;
      if (!/\s/.test(char)) {
        if (!inString) {
          lastSignificantChar = char;
        }
      }
    }
  }
  return result;
}

describe('JSON Repair with pre-processing', () => {
  it('should handle unescaped quotes with colons', () => {
    const json = '{"key": "value with a "nested": "key-like" quote"}';
    const preProcessed = preProcessJson(json);
    const repaired = jsonrepair(preProcessed);
    const parsed = JSON.parse(repaired);
    expect(parsed.key).toContain('nested": "key-like" quote');
  });

  it('should handle unescaped quotes in arrays', () => {
    const json = '{"evidence": ["User#1: "Some "nested" quote""] }';
    const preProcessed = preProcessJson(json);
    const repaired = jsonrepair(preProcessed);
    const parsed = JSON.parse(repaired);
    expect(parsed.evidence[0]).toContain('Some "nested" quote');
  });

  it('should NOT break normal keys', () => {
    const json = '{"normal_key": "normal_value", "another": 123}';
    const preProcessed = preProcessJson(json);
    const repaired = jsonrepair(preProcessed);
    expect(JSON.parse(repaired)).toEqual({ normal_key: 'normal_value', another: 123 });
  });

  it('should handle multiple nested quotes', () => {
    const json = '{"text": "A "quote" and "another" and even "one with : colon" end"}';
    const preProcessed = preProcessJson(json);
    const repaired = jsonrepair(preProcessed);
    const parsed = JSON.parse(repaired);
    expect(parsed.text).toBe('A "quote" and "another" and even "one with : colon" end');
  });
});
