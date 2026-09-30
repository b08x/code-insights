/**
 * Suggested labeling queue (label-7, label-8).
 *
 * Ranks unlabeled sessions so that labels spread across project x session-length bucket x source
 * tool. Selection is greedy: after a session is picked its cell counts are incremented, so the
 * next pick favors a different cell and the queue stays diverse rather than listing one project.
 *
 * After at least one completed optimization run, an active-learning term is added: sessions where
 * candidates disagreed most, or the test-gate score was lowest, rank higher. The optimization
 * tables do not exist yet (v20), so the signal arrives through an injected provider; today's
 * provider returns nothing and the term is zero.
 *
 * Pure: no DB access, no embeddings (label-11).
 */

export type LengthBucket = 'short' | 'medium' | 'long';

export const LENGTH_BUCKETS: readonly LengthBucket[] = ['short', 'medium', 'long'];

/** Bucket boundaries on message_count. */
export function lengthBucket(messageCount: number): LengthBucket {
  if (messageCount < 20) return 'short';
  if (messageCount < 80) return 'medium';
  return 'long';
}

export interface QueueSession {
  sessionId: string;
  projectId: string;
  sourceTool: string;
  messageCount: number;
  startedAt: string;
}

/** Per-session signal from completed optimization runs. All fields optional, 0..1. */
export interface ActiveLearningSignal {
  sessionId: string;
  /** How much candidate outputs disagreed on this session (higher = more disagreement). */
  disagreement?: number;
  /** Test-gate score for this session (lower = worse, so more worth labeling). */
  gateScore?: number;
}

/** Returns signals for sessions; an empty array means "no completed run yet". */
export type ActiveLearningSignalProvider = () => ActiveLearningSignal[];

export const noActiveLearningSignal: ActiveLearningSignalProvider = () => [];

export interface RankedQueueItem {
  sessionId: string;
  projectId: string;
  sourceTool: string;
  bucket: LengthBucket;
  score: number;
  /** Portion of score that came from the active-learning term (0 when no signal). */
  activeLearning: number;
}

export interface RankLabelQueueInput {
  /** Unlabeled sessions eligible for labeling. */
  candidates: readonly QueueSession[];
  /** Already-labeled sessions; used only for coverage counts. */
  labeled: readonly QueueSession[];
  signal: ActiveLearningSignalProvider;
  limit?: number;
}

const W_CELL = 2;
const W_PROJECT = 1.5;
const W_BUCKET = 0.5;
const W_TOOL = 0.5;
/** Comparable to a fully uncovered cell, so a strong signal can outrank coverage. */
const W_ACTIVE = 3;

class Counter {
  private m = new Map<string, number>();
  get(k: string): number { return this.m.get(k) ?? 0; }
  inc(k: string): void { this.m.set(k, this.get(k) + 1); }
}

function activeTerm(sig: ActiveLearningSignal | undefined): number {
  if (!sig) return 0;
  const d = sig.disagreement ?? 0;
  const g = sig.gateScore === undefined ? 0 : 1 - sig.gateScore;
  return Math.max(0, Math.min(1, Math.max(d, g)));
}

export function rankLabelQueue(input: RankLabelQueueInput): RankedQueueItem[] {
  const { candidates, labeled, signal } = input;
  const limit = input.limit ?? 50;

  const signals = new Map<string, ActiveLearningSignal>();
  for (const sig of signal()) signals.set(sig.sessionId, sig);

  const cells = new Counter();
  const projects = new Counter();
  const buckets = new Counter();
  const tools = new Counter();
  const bump = (x: QueueSession) => {
    const b = lengthBucket(x.messageCount);
    cells.inc(`${x.projectId}|${b}|${x.sourceTool}`);
    projects.inc(x.projectId);
    buckets.inc(b);
    tools.inc(x.sourceTool);
  };
  for (const l of labeled) bump(l);

  // Deterministic regardless of input order: recency desc, then id.
  const remaining = [...candidates].sort((a, b) =>
    a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : a.sessionId < b.sessionId ? -1 : 1);

  const out: RankedQueueItem[] = [];
  while (remaining.length > 0 && out.length < limit) {
    let bestIdx = -1;
    let best: RankedQueueItem | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const b = lengthBucket(c.messageCount);
      const coverage =
        W_CELL / (1 + cells.get(`${c.projectId}|${b}|${c.sourceTool}`)) +
        W_PROJECT / (1 + projects.get(c.projectId)) +
        W_BUCKET / (1 + buckets.get(b)) +
        W_TOOL / (1 + tools.get(c.sourceTool));
      const active = W_ACTIVE * activeTerm(signals.get(c.sessionId));
      const score = coverage + active;
      // Strict > keeps the earlier (more recent, then lower id) candidate on ties.
      if (!best || score > best.score + 1e-9) {
        bestIdx = i;
        best = { sessionId: c.sessionId, projectId: c.projectId, sourceTool: c.sourceTool, bucket: b, score, activeLearning: active };
      }
    }
    out.push(best!);
    bump(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return out;
}
