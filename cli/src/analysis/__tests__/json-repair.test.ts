import { describe, it, expect } from 'vitest';
import { jsonrepair } from 'jsonrepair';
import { preProcessJson } from '../response-parsers.js';

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
