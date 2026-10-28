/**
 * Train / validation / test assignment for labeled sessions (label-6).
 *
 * Assignment happens once, when a session is first labeled, and is stored in
 * session_labels.split (write-once). This function is pure: given the seed and the assignments
 * that already exist, the next session's split is deterministic. It never changes an existing
 * assignment.
 *
 * Method: "largest deficit first". For each split we measure how far the counts are below the
 * 60/20/20 target if this session is added, both within the session's project (stratification)
 * and globally, and pick the split with the largest combined deficit. The global term matters:
 * a project-only rule sends the first session of every small project to train and starves
 * validation/test when most projects have only a few labels. Ties are broken by a seeded hash
 * so the seed decides otherwise-equal choices.
 */

import { createHash } from 'crypto';

export type Split = 'train' | 'validation' | 'test';

export const SPLITS: readonly Split[] = ['train', 'validation', 'test'];

export const SPLIT_RATIOS: Readonly<Record<Split, number>> = { train: 0.6, validation: 0.2, test: 0.2 };

/** Seed used by the label write path unless a caller overrides it. */
export const DEFAULT_SPLIT_SEED = 'code-insights-labels-v1';

export interface SplitAssignment {
  sessionId: string;
  projectId: string;
  split: Split;
}

export interface AssignSplitInput {
  sessionId: string;
  projectId: string;
  seed: string;
  /** Every label assignment that already exists (all projects). */
  existing: readonly SplitAssignment[];
}

function tieBreak(seed: string, sessionId: string, split: Split): number {
  const digest = createHash('sha1').update(`${seed}\u0000${sessionId}\u0000${split}`).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

export function assignSplit(input: AssignSplitInput): Split {
  const { sessionId, projectId, seed, existing } = input;

  const already = existing.find(e => e.sessionId === sessionId);
  if (already) return already.split;

  const globalCounts: Record<Split, number> = { train: 0, validation: 0, test: 0 };
  const projectCounts: Record<Split, number> = { train: 0, validation: 0, test: 0 };
  let globalTotal = 0;
  let projectTotal = 0;
  for (const e of existing) {
    globalCounts[e.split]++;
    globalTotal++;
    if (e.projectId === projectId) {
      projectCounts[e.split]++;
      projectTotal++;
    }
  }

  let best: Split = 'train';
  let bestScore = -Infinity;
  let bestTie = -Infinity;
  for (const split of SPLITS) {
    const ratio = SPLIT_RATIOS[split];
    const score =
      (ratio * (projectTotal + 1) - projectCounts[split]) +
      (ratio * (globalTotal + 1) - globalCounts[split]);
    const tie = tieBreak(seed, sessionId, split);
    // Scores within 1e-9 are treated as equal (floating-point noise from the ratios).
    if (score > bestScore + 1e-9 || (Math.abs(score - bestScore) <= 1e-9 && tie > bestTie)) {
      best = split;
      bestScore = score;
      bestTie = tie;
    }
  }
  return best;
}
