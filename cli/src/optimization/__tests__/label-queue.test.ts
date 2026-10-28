import { describe, it, expect } from 'vitest';
import {
  rankLabelQueue, lengthBucket, noActiveLearningSignal,
  type QueueSession, type ActiveLearningSignalProvider,
} from '../label-queue.js';

const s = (id: string, projectId: string, sourceTool: string, messageCount: number, startedAt = '2026-01-01'): QueueSession =>
  ({ sessionId: id, projectId, sourceTool, messageCount, startedAt });

describe('lengthBucket', () => {
  it('buckets by message count', () => {
    expect(lengthBucket(1)).toBe('short');
    expect(lengthBucket(19)).toBe('short');
    expect(lengthBucket(20)).toBe('medium');
    expect(lengthBucket(79)).toBe('medium');
    expect(lengthBucket(80)).toBe('long');
  });
});

describe('rankLabelQueue coverage', () => {
  it('prefers under-covered projects over projects that already have labels', () => {
    const labeled = [s('l1', 'a', 'claude-code', 30), s('l2', 'a', 'claude-code', 30)];
    const candidates = [s('c1', 'a', 'claude-code', 30), s('c2', 'b', 'claude-code', 30)];
    const ranked = rankLabelQueue({ candidates, labeled, signal: noActiveLearningSignal });
    expect(ranked[0].sessionId).toBe('c2');
  });

  it('prefers an unseen length bucket and source tool', () => {
    const labeled = Array.from({ length: 4 }, (_, i) => s(`l${i}`, 'a', 'claude-code', 30));
    const candidates = [s('same', 'a', 'claude-code', 30), s('long-cursor', 'a', 'cursor', 200)];
    const ranked = rankLabelQueue({ candidates, labeled, signal: noActiveLearningSignal });
    expect(ranked[0].sessionId).toBe('long-cursor');
  });

  it('diversifies the queue greedily instead of returning one cell repeatedly', () => {
    const candidates = [
      s('a1', 'a', 'claude-code', 30), s('a2', 'a', 'claude-code', 30), s('a3', 'a', 'claude-code', 30),
      s('b1', 'b', 'claude-code', 30),
    ];
    const ranked = rankLabelQueue({ candidates, labeled: [], signal: noActiveLearningSignal });
    expect(ranked.slice(0, 2).map(r => r.sessionId.charAt(0)).sort()).toEqual(['a', 'b']);
  });

  it('is deterministic and respects limit', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => s(`c${i}`, 'a', 'claude-code', 30, `2026-01-0${i}`));
    const a = rankLabelQueue({ candidates, labeled: [], signal: noActiveLearningSignal, limit: 3 });
    const b = rankLabelQueue({ candidates: [...candidates].reverse(), labeled: [], signal: noActiveLearningSignal, limit: 3 });
    expect(a).toHaveLength(3);
    expect(a.map(r => r.sessionId)).toEqual(b.map(r => r.sessionId));
  });

  it('reports the bucket and no active-learning term when the provider returns nothing', () => {
    const [r] = rankLabelQueue({ candidates: [s('c', 'a', 't', 100)], labeled: [], signal: noActiveLearningSignal });
    expect(r.bucket).toBe('long');
    expect(r.activeLearning).toBe(0);
  });
});

describe('rankLabelQueue active-learning term (label-8)', () => {
  const labeled = [s('l1', 'a', 'claude-code', 30), s('l2', 'b', 'claude-code', 30)];
  const candidates = [s('easy', 'a', 'claude-code', 30), s('hard', 'b', 'claude-code', 30)];

  it('ranks high-disagreement sessions first once the provider reports signal', () => {
    const signal: ActiveLearningSignalProvider = () => [{ sessionId: 'hard', disagreement: 0.9 }];
    const ranked = rankLabelQueue({ candidates, labeled, signal });
    expect(ranked[0].sessionId).toBe('hard');
    expect(ranked[0].activeLearning).toBeGreaterThan(0);
  });

  it('treats a low test-gate score as signal', () => {
    const signal: ActiveLearningSignalProvider = () => [
      { sessionId: 'easy', gateScore: 0.95 },
      { sessionId: 'hard', gateScore: 0.1 },
    ];
    expect(rankLabelQueue({ candidates, labeled, signal })[0].sessionId).toBe('hard');
  });

  it('without signal, falls back to coverage order (ties by recency then id)', () => {
    const ranked = rankLabelQueue({ candidates, labeled, signal: noActiveLearningSignal });
    expect(ranked.every(r => r.activeLearning === 0)).toBe(true);
  });
});
