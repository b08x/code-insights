// Pure state and payload logic for the labeling page (label-3, label-4).
//
// The page reviews the current production analysis item by item:
//   keep    -> the item's claim becomes a key point the analysis must cover
//   wrong   -> the item's claim becomes a forbidden claim the analysis must not make
//   trivial -> the item is skipped (neither)
// Missed key points are typed in separately. Outcome and categories come from canonical lists.

import { parseJsonField, type Insight, type LabelInput, type SessionLabel } from './types';

export type ItemDecision = 'keep' | 'wrong' | 'trivial';

export type AnalysisItemKind = 'summary' | 'decision' | 'learning' | 'technique' | 'friction' | 'pattern';

export interface AnalysisItem {
  /** Stable within one page load: insight id / facet index based. */
  id: string;
  kind: AnalysisItemKind;
  /** The claim text written into keyPoints / forbiddenClaims. */
  text: string;
  /** Canonical category for friction/pattern items, used to pre-toggle pickers on keep. */
  category?: string;
}

export interface LabelFormState {
  decisions: Record<string, ItemDecision>;
  extraKeyPoints: string[];
  outcome: string | null;
  frictionCategories: string[];
  patternCategories: string[];
  note: string;
}

export const EMPTY_LABEL_FORM: LabelFormState = {
  decisions: {},
  extraKeyPoints: [],
  outcome: null,
  frictionCategories: [],
  patternCategories: [],
  note: '',
};

export type LabelFormAction =
  | { type: 'decide'; item: AnalysisItem; decision: ItemDecision }
  | { type: 'addKeyPoint'; text: string }
  | { type: 'removeKeyPoint'; index: number }
  | { type: 'setOutcome'; outcome: string }
  | { type: 'toggleFriction'; category: string }
  | { type: 'togglePattern'; category: string }
  | { type: 'setNote'; note: string }
  | { type: 'reset'; state: LabelFormState };

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
const sameText = (a: string, b: string) => norm(a).toLowerCase() === norm(b).toLowerCase();

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function labelFormReducer(state: LabelFormState, action: LabelFormAction): LabelFormState {
  switch (action.type) {
    case 'decide': {
      const { item, decision } = action;
      const current = state.decisions[item.id];
      const decisions = { ...state.decisions };
      // Pressing the active decision again clears it (undecided).
      if (current === decision) delete decisions[item.id];
      else decisions[item.id] = decision;

      let { frictionCategories, patternCategories } = state;
      // Keeping a friction/pattern item implies its category applies; the user can still untoggle it.
      if (decisions[item.id] === 'keep' && item.category) {
        if (item.kind === 'friction' && !frictionCategories.includes(item.category)) {
          frictionCategories = [...frictionCategories, item.category];
        }
        if (item.kind === 'pattern' && !patternCategories.includes(item.category)) {
          patternCategories = [...patternCategories, item.category];
        }
      }
      return { ...state, decisions, frictionCategories, patternCategories };
    }
    case 'addKeyPoint': {
      const text = norm(action.text);
      if (!text || state.extraKeyPoints.some((k) => sameText(k, text))) return state;
      return { ...state, extraKeyPoints: [...state.extraKeyPoints, text] };
    }
    case 'removeKeyPoint':
      return { ...state, extraKeyPoints: state.extraKeyPoints.filter((_, i) => i !== action.index) };
    case 'setOutcome':
      return { ...state, outcome: action.outcome };
    case 'toggleFriction':
      return { ...state, frictionCategories: toggle(state.frictionCategories, action.category) };
    case 'togglePattern':
      return { ...state, patternCategories: toggle(state.patternCategories, action.category) };
    case 'setNote':
      return { ...state, note: action.note };
    case 'reset':
      return action.state;
  }
}

/** Case/whitespace-insensitive de-duplication, first spelling wins. */
function dedupe(items: string[]): string[] {
  const out: string[] = [];
  for (const raw of items) {
    const t = norm(raw);
    if (t && !out.some((o) => sameText(o, t))) out.push(t);
  }
  return out;
}

export type BuildPayloadResult = { ok: true; value: LabelInput } | { ok: false; errors: string[] };

/** Build the PUT /api/labels/:sessionId body. The split is never sent: the server assigns it. */
export function buildLabelPayload(items: AnalysisItem[], state: LabelFormState): BuildPayloadResult {
  const errors: string[] = [];
  if (!state.outcome) errors.push('Pick an outcome');

  const kept = items.filter((i) => state.decisions[i.id] === 'keep').map((i) => i.text);
  const wrong = items.filter((i) => state.decisions[i.id] === 'wrong').map((i) => i.text);
  const keyPoints = dedupe([...kept, ...state.extraKeyPoints]);
  const forbiddenClaims = dedupe(wrong).filter((w) => !keyPoints.some((k) => sameText(k, w)));

  if (keyPoints.length === 0) errors.push('Keep at least one item or add a key point');
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    value: {
      outcome: state.outcome!,
      frictionCategories: [...state.frictionCategories],
      patternCategories: [...state.patternCategories],
      keyPoints,
      forbiddenClaims,
      note: norm(state.note) ? state.note.trim() : null,
    },
  };
}

/**
 * Rebuild form state from a saved label: items whose text matches a key point are "keep",
 * a forbidden claim "wrong"; key points matching no current item become typed key points.
 * Items not mentioned stay undecided (the analysis may have changed since the label was saved).
 */
export function formStateFromLabel(items: AnalysisItem[], label: SessionLabel | null): LabelFormState {
  if (!label) return EMPTY_LABEL_FORM;
  const decisions: Record<string, ItemDecision> = {};
  for (const item of items) {
    if (label.keyPoints.some((k) => sameText(k, item.text))) decisions[item.id] = 'keep';
    else if (label.forbiddenClaims.some((f) => sameText(f, item.text))) decisions[item.id] = 'wrong';
  }
  const extraKeyPoints = label.keyPoints.filter((k) => !items.some((i) => sameText(i.text, k)));
  return {
    decisions,
    extraKeyPoints,
    outcome: label.outcome,
    frictionCategories: [...label.frictionCategories],
    patternCategories: [...label.patternCategories],
    note: label.note ?? '',
  };
}

/** Whether the form differs from what was last loaded/saved. */
export function isFormDirty(a: LabelFormState, b: LabelFormState): boolean {
  return JSON.stringify(a) !== JSON.stringify(b);
}

export interface DecisionCounts { keep: number; wrong: number; trivial: number; undecided: number }

export function countDecisions(items: AnalysisItem[], state: LabelFormState): DecisionCounts {
  const counts: DecisionCounts = { keep: 0, wrong: 0, trivial: 0, undecided: 0 };
  for (const item of items) counts[state.decisions[item.id] ?? 'undecided']++;
  return counts;
}

// ── Analysis items ───────────────────────────────────────────────────────────

interface FacetsLike {
  friction_points: string;
  effective_patterns: string;
}

interface FacetItem { category?: unknown; description?: unknown }

/** Only canonical categories may pre-toggle a picker: the server rejects anything else. */
function canonicalOrUndefined(value: unknown, allowed: readonly string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (allowed && !allowed.includes(value)) return undefined;
  return value;
}

const INSIGHT_KINDS: ReadonlySet<string> = new Set(['summary', 'decision', 'learning', 'technique']);

function insightClaim(insight: Insight): string {
  const title = norm(insight.title ?? '');
  const summary = norm(insight.summary ?? '');
  if (!summary || sameText(summary, title)) return title || norm(insight.content ?? '');
  if (!title) return summary;
  return `${title}: ${summary}`;
}

/**
 * Flatten the session's current production analysis into reviewable claims.
 * Summary insights contribute one item per bullet (fallback: the summary itself);
 * decisions/learnings/techniques one item each; facets one item per friction point and effective pattern.
 * Prompt-quality insights are a different target and are excluded.
 */
export function deriveAnalysisItems(
  insights: Insight[],
  facets: FacetsLike | null | undefined,
  canonical?: { friction: readonly string[]; pattern: readonly string[] },
): AnalysisItem[] {
  const items: AnalysisItem[] = [];
  const seen: string[] = [];
  const push = (item: AnalysisItem) => {
    if (!item.text || seen.some((s) => sameText(s, item.text))) return;
    seen.push(item.text);
    items.push(item);
  };

  const ordered = [...insights]
    .filter((i) => INSIGHT_KINDS.has(i.type))
    .sort((a, b) => (a.type === 'summary' ? -1 : 0) - (b.type === 'summary' ? -1 : 0));

  for (const insight of ordered) {
    if (insight.type === 'summary') {
      const parsed = parseJsonField<unknown>(insight.bullets, []);
      const bullets = Array.isArray(parsed) ? parsed.filter((b): b is string => typeof b === 'string' && !!b.trim()) : [];
      if (bullets.length) {
        bullets.forEach((b, i) => push({ id: `${insight.id}#${i}`, kind: 'summary', text: norm(b) }));
        continue;
      }
    }
    push({ id: insight.id, kind: insight.type as AnalysisItemKind, text: insightClaim(insight) });
  }

  if (facets) {
    const facetItems = (json: string): FacetItem[] => {
      const parsed = parseJsonField<unknown>(json, []);
      return Array.isArray(parsed) ? parsed.filter((f): f is FacetItem => !!f && typeof f === 'object') : [];
    };
    facetItems(facets.friction_points).forEach((f, i) => {
      const category = canonicalOrUndefined(f.category, canonical?.friction);
      const description = typeof f.description === 'string' ? norm(f.description) : '';
      if (description) push({ id: `friction#${i}`, kind: 'friction', text: description, category });
    });
    facetItems(facets.effective_patterns).forEach((p, i) => {
      const category = canonicalOrUndefined(p.category, canonical?.pattern);
      const description = typeof p.description === 'string' ? norm(p.description) : '';
      if (description) push({ id: `pattern#${i}`, kind: 'pattern', text: description, category });
    });
  }
  return items;
}

// ── Progress ─────────────────────────────────────────────────────────────────

/** Ratio for a meter, clamped to [0, 1]; a zero target counts as met. */
export function coverageRatio(labeled: number, target: number): number {
  if (target <= 0) return 1;
  return Math.max(0, Math.min(1, labeled / target));
}

/** Split shares the server assigns (60/20/20); used to show per-split targets. */
export const SPLIT_SHARES = { train: 0.6, validation: 0.2, test: 0.2 } as const;

export function splitTargets(totalTarget: number): Record<keyof typeof SPLIT_SHARES, number> {
  return {
    train: Math.round(totalTarget * SPLIT_SHARES.train),
    validation: Math.round(totalTarget * SPLIT_SHARES.validation),
    test: Math.round(totalTarget * SPLIT_SHARES.test),
  };
}

/** First queued session other than the current one. */
export function nextQueuedSession(queue: Array<{ sessionId: string }>, currentId: string | undefined): string | null {
  return queue.find((q) => q.sessionId !== currentId)?.sessionId ?? null;
}
