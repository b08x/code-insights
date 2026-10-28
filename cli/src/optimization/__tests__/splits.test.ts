import { describe, it, expect } from 'vitest';
import { assignSplit, SPLIT_RATIOS, type Split, type SplitAssignment } from '../splits.js';

/** Label `n` sessions per project sequentially (round-robin across projects), returning assignments. */
function simulate(projects: string[], perProject: number, seed: string): SplitAssignment[] {
  const existing: SplitAssignment[] = [];
  for (let i = 0; i < perProject; i++) {
    for (const p of projects) {
      const sessionId = `${p}-s${i}`;
      existing.push({ sessionId, projectId: p, split: assignSplit({ sessionId, projectId: p, seed, existing }) });
    }
  }
  return existing;
}

const count = (rows: SplitAssignment[], split: Split) => rows.filter(r => r.split === split).length;

describe('assignSplit', () => {
  it('ratios sum to 1 and are 60/20/20', () => {
    expect(SPLIT_RATIOS).toEqual({ train: 0.6, validation: 0.2, test: 0.2 });
  });

  it('produces ~60/20/20 globally and per project', () => {
    const projects = ['a', 'b', 'c', 'd', 'e'];
    const rows = simulate(projects, 20, 'seed-1');
    expect(rows).toHaveLength(100);
    expect(Math.abs(count(rows, 'train') - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(count(rows, 'validation') - 20)).toBeLessThanOrEqual(2);
    expect(Math.abs(count(rows, 'test') - 20)).toBeLessThanOrEqual(2);
    for (const p of projects) {
      const mine = rows.filter(r => r.projectId === p);
      expect(Math.abs(count(mine, 'train') - 12)).toBeLessThanOrEqual(2);
      expect(Math.abs(count(mine, 'validation') - 4)).toBeLessThanOrEqual(2);
      expect(Math.abs(count(mine, 'test') - 4)).toBeLessThanOrEqual(2);
    }
  });

  it('does not starve validation/test when every project is tiny', () => {
    const projects = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const rows = simulate(projects, 1, 'seed-tiny');
    expect(count(rows, 'validation')).toBeGreaterThanOrEqual(4);
    expect(count(rows, 'test')).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic for a given (seed, existing assignments)', () => {
    const a = simulate(['a', 'b', 'c'], 10, 'same');
    const b = simulate(['a', 'b', 'c'], 10, 'same');
    expect(a).toEqual(b);
  });

  it('a different seed can change tie-breaks', () => {
    const a = simulate(['a', 'b', 'c'], 10, 'seed-x').map(r => r.split).join();
    const b = simulate(['a', 'b', 'c'], 10, 'seed-y').map(r => r.split).join();
    expect(a).not.toBe(b);
  });

  it('never reassigns an already-labeled session', () => {
    const existing: SplitAssignment[] = [{ sessionId: 's1', projectId: 'p', split: 'test' }];
    for (const seed of ['x', 'y', 'z']) {
      expect(assignSplit({ sessionId: 's1', projectId: 'p', seed, existing })).toBe('test');
    }
  });

  it('is not affected by the order of existing assignments', () => {
    const rows = simulate(['a', 'b'], 8, 's');
    const next = { sessionId: 'new', projectId: 'a', seed: 's' };
    expect(assignSplit({ ...next, existing: rows })).toBe(assignSplit({ ...next, existing: [...rows].reverse() }));
  });
});
