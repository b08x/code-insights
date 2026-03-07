import { describe, it, expect } from 'vitest';
import { normalizeFrictionCategory } from './friction-normalize.js';

// ──────────────────────────────────────────────────────
// normalizeFrictionCategory
// ──────────────────────────────────────────────────────

describe('normalizeFrictionCategory', () => {
  // ────────────────────────────────────────────────────
  // Rule 1: Exact match (case-insensitive)
  // ────────────────────────────────────────────────────

  it('returns canonical for exact match', () => {
    expect(normalizeFrictionCategory('type-error')).toBe('type-error');
    expect(normalizeFrictionCategory('wrong-approach')).toBe('wrong-approach');
    expect(normalizeFrictionCategory('race-condition')).toBe('race-condition');
  });

  it('matches case-insensitively', () => {
    expect(normalizeFrictionCategory('Type-Error')).toBe('type-error');
    expect(normalizeFrictionCategory('WRONG-APPROACH')).toBe('wrong-approach');
    expect(normalizeFrictionCategory('Missing-Dependency')).toBe('missing-dependency');
  });

  // ────────────────────────────────────────────────────
  // Rule 2: Levenshtein distance <= 2
  // ────────────────────────────────────────────────────

  it('normalizes typos within Levenshtein distance 2', () => {
    expect(normalizeFrictionCategory('type-eror')).toBe('type-error');       // distance 1
    expect(normalizeFrictionCategory('tpye-error')).toBe('type-error');      // distance 2 (transposition)
    expect(normalizeFrictionCategory('wrong-aproach')).toBe('wrong-approach'); // distance 1
    expect(normalizeFrictionCategory('stale-cach')).toBe('stale-cache');     // distance 1
  });

  it('does not match when Levenshtein distance > 2', () => {
    // "typo-error" is distance 3 from "type-error" — too far
    const result = normalizeFrictionCategory('completely-different-thing');
    expect(result).toBe('completely-different-thing');
  });

  // ────────────────────────────────────────────────────
  // Rule 3: Substring match (significant portion)
  // ────────────────────────────────────────────────────

  it('matches when canonical is a significant substring', () => {
    // "config-drift-issue" contains "config-drift" (12 chars, 12/18 = 0.67 > 0.5)
    expect(normalizeFrictionCategory('config-drift-issue')).toBe('config-drift');
  });

  it('does not match short substrings (< 5 chars)', () => {
    // Very short overlaps should not trigger substring match
    const result = normalizeFrictionCategory('abc');
    expect(result).toBe('abc');
  });

  // ────────────────────────────────────────────────────
  // Rule 1.5: Explicit alias match
  // ────────────────────────────────────────────────────

  it('resolves all agent-orchestration alias variants to the cluster target', () => {
    expect(normalizeFrictionCategory('agent-lifecycle-issue')).toBe('agent-orchestration-failure');
    expect(normalizeFrictionCategory('agent-communication-failure')).toBe('agent-orchestration-failure');
    expect(normalizeFrictionCategory('agent-communication-breakdown')).toBe('agent-orchestration-failure');
    expect(normalizeFrictionCategory('agent-lifecycle-management')).toBe('agent-orchestration-failure');
    expect(normalizeFrictionCategory('agent-shutdown-failure')).toBe('agent-orchestration-failure');
  });

  it('resolves all rate-limit alias variants to the cluster target', () => {
    expect(normalizeFrictionCategory('api-rate-limit')).toBe('rate-limit-hit');
    expect(normalizeFrictionCategory('rate-limiting')).toBe('rate-limit-hit');
    expect(normalizeFrictionCategory('rate-limited')).toBe('rate-limit-hit');
  });

  it('resolves aliases case-insensitively', () => {
    expect(normalizeFrictionCategory('Agent-Lifecycle-Issue')).toBe('agent-orchestration-failure');
    expect(normalizeFrictionCategory('API-RATE-LIMIT')).toBe('rate-limit-hit');
  });

  it('does not further normalize non-canonical alias targets via Levenshtein', () => {
    // "agent-orchestration-failure" is NOT in CANONICAL_FRICTION_CATEGORIES,
    // but when returned as an alias target it should be returned as-is (not mangled by Levenshtein).
    // Here we test the target itself — it should pass through as a novel category since it
    // doesn't match any canonical via Levenshtein and isn't in the alias map as a key.
    const result = normalizeFrictionCategory('agent-orchestration-failure');
    // Not canonical, not an alias key → returned as novel category (original casing)
    expect(result).toBe('agent-orchestration-failure');
  });

  it('does not further normalize "rate-limit-hit" target when passed directly', () => {
    // Same as above — "rate-limit-hit" is not canonical, so if someone passes it directly
    // it comes back as-is (novel category).
    const result = normalizeFrictionCategory('rate-limit-hit');
    expect(result).toBe('rate-limit-hit');
  });

  // ────────────────────────────────────────────────────
  // Rule 4: Novel category (no match)
  // ────────────────────────────────────────────────────

  it('returns original for novel categories', () => {
    expect(normalizeFrictionCategory('database-deadlock')).toBe('database-deadlock');
    expect(normalizeFrictionCategory('memory-leak')).toBe('memory-leak');
    expect(normalizeFrictionCategory('flaky-ci')).toBe('flaky-ci');
  });

  it('preserves original casing for novel categories', () => {
    expect(normalizeFrictionCategory('Custom-Category')).toBe('Custom-Category');
  });

  // ────────────────────────────────────────────────────
  // All canonical categories are recognized
  // ────────────────────────────────────────────────────

  it('recognizes all 15 canonical categories', () => {
    const canonicals = [
      'wrong-approach', 'missing-dependency', 'config-drift', 'test-failure',
      'type-error', 'api-misunderstanding', 'stale-cache', 'version-mismatch',
      'permission-issue', 'incomplete-requirements', 'circular-dependency',
      'race-condition', 'environment-mismatch', 'documentation-gap', 'tooling-limitation',
    ];
    for (const cat of canonicals) {
      expect(normalizeFrictionCategory(cat)).toBe(cat);
    }
  });
});
