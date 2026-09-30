import { describe, expect, it } from 'vitest';
import {
  EMPTY_LABEL_FORM,
  buildLabelPayload,
  countDecisions,
  coverageRatio,
  deriveAnalysisItems,
  formStateFromLabel,
  isFormDirty,
  labelFormReducer,
  nextQueuedSession,
  splitTargets,
  type AnalysisItem,
  type LabelFormState,
} from '../label-form';
import type { Insight, SessionLabel } from '../types';

const items: AnalysisItem[] = [
  { id: 'a', kind: 'summary', text: 'Added a retry wrapper around the fetch client' },
  { id: 'b', kind: 'decision', text: 'Chose SQLite over Postgres: local-first' },
  { id: 'c', kind: 'friction', text: 'Agent assumed an outdated API', category: 'stale-assumptions' },
  { id: 'd', kind: 'pattern', text: 'Ran the tests after each change', category: 'verification-workflow' },
];
const byId = (id: string) => items.find((i) => i.id === id)!;

function apply(state: LabelFormState, ...actions: Parameters<typeof labelFormReducer>[1][]): LabelFormState {
  return actions.reduce(labelFormReducer, state);
}

describe('labelFormReducer', () => {
  it('records keep / wrong / trivial and clears on repeat', () => {
    let s = apply(EMPTY_LABEL_FORM,
      { type: 'decide', item: byId('a'), decision: 'keep' },
      { type: 'decide', item: byId('b'), decision: 'wrong' },
      { type: 'decide', item: byId('c'), decision: 'trivial' },
    );
    expect(s.decisions).toEqual({ a: 'keep', b: 'wrong', c: 'trivial' });
    s = labelFormReducer(s, { type: 'decide', item: byId('a'), decision: 'keep' });
    expect(s.decisions.a).toBeUndefined();
    s = labelFormReducer(s, { type: 'decide', item: byId('b'), decision: 'keep' });
    expect(s.decisions.b).toBe('keep');
  });

  it('keeping a friction/pattern item toggles its category on, once', () => {
    const s = apply(EMPTY_LABEL_FORM,
      { type: 'decide', item: byId('c'), decision: 'keep' },
      { type: 'decide', item: byId('d'), decision: 'keep' },
      { type: 'decide', item: byId('c'), decision: 'keep' },
      { type: 'decide', item: byId('c'), decision: 'keep' },
    );
    expect(s.frictionCategories).toEqual(['stale-assumptions']);
    expect(s.patternCategories).toEqual(['verification-workflow']);
  });

  it('marking a friction item wrong does not add its category', () => {
    const s = labelFormReducer(EMPTY_LABEL_FORM, { type: 'decide', item: byId('c'), decision: 'wrong' });
    expect(s.frictionCategories).toEqual([]);
  });

  it('adds typed key points trimmed and de-duplicated; removes by index', () => {
    let s = apply(EMPTY_LABEL_FORM,
      { type: 'addKeyPoint', text: '  Fixed the flaky test  ' },
      { type: 'addKeyPoint', text: 'fixed the   flaky TEST' },
      { type: 'addKeyPoint', text: '   ' },
      { type: 'addKeyPoint', text: 'Second point' },
    );
    expect(s.extraKeyPoints).toEqual(['Fixed the flaky test', 'Second point']);
    s = labelFormReducer(s, { type: 'removeKeyPoint', index: 0 });
    expect(s.extraKeyPoints).toEqual(['Second point']);
  });

  it('toggles categories and sets outcome / note', () => {
    const s = apply(EMPTY_LABEL_FORM,
      { type: 'toggleFriction', category: 'rage-loop' },
      { type: 'toggleFriction', category: 'scope-creep' },
      { type: 'toggleFriction', category: 'rage-loop' },
      { type: 'togglePattern', category: 'self-correction' },
      { type: 'setOutcome', outcome: 'high' },
      { type: 'setNote', note: 'hi' },
    );
    expect(s.frictionCategories).toEqual(['scope-creep']);
    expect(s.patternCategories).toEqual(['self-correction']);
    expect(s.outcome).toBe('high');
    expect(s.note).toBe('hi');
  });
});

describe('buildLabelPayload', () => {
  it('maps keep -> keyPoints, wrong -> forbiddenClaims, trivial -> nothing, and never sends split', () => {
    const s = apply(EMPTY_LABEL_FORM,
      { type: 'decide', item: byId('a'), decision: 'keep' },
      { type: 'decide', item: byId('b'), decision: 'wrong' },
      { type: 'decide', item: byId('d'), decision: 'trivial' },
      { type: 'addKeyPoint', text: 'Missed: user asked for dark mode' },
      { type: 'setOutcome', outcome: 'medium' },
      { type: 'setNote', note: '   ' },
    );
    const r = buildLabelPayload(items, s);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({
      outcome: 'medium',
      frictionCategories: [],
      patternCategories: [],
      keyPoints: ['Added a retry wrapper around the fetch client', 'Missed: user asked for dark mode'],
      forbiddenClaims: ['Chose SQLite over Postgres: local-first'],
      note: null,
    });
    expect(r.value).not.toHaveProperty('split');
  });

  it('de-duplicates a typed key point that repeats a kept item', () => {
    const s = apply(EMPTY_LABEL_FORM,
      { type: 'decide', item: byId('a'), decision: 'keep' },
      { type: 'addKeyPoint', text: 'added a retry wrapper around the fetch client' },
      { type: 'setOutcome', outcome: 'high' },
    );
    const r = buildLabelPayload(items, s);
    expect(r.ok && r.value.keyPoints).toEqual(['Added a retry wrapper around the fetch client']);
  });

  it('requires an outcome and at least one key point', () => {
    const r = buildLabelPayload(items, EMPTY_LABEL_FORM);
    expect(r).toEqual({ ok: false, errors: ['Pick an outcome', 'Keep at least one item or add a key point'] });
  });
});

describe('formStateFromLabel', () => {
  const label: SessionLabel = {
    sessionId: 's1', target: 'session-analysis', split: 'test', createdAt: '', updatedAt: '',
    outcome: 'low',
    frictionCategories: ['stale-assumptions'],
    patternCategories: [],
    keyPoints: ['added a retry wrapper around the fetch client', 'Typed by hand'],
    forbiddenClaims: ['Chose SQLite over Postgres: local-first'],
    note: 'n',
  };

  it('round-trips decisions and typed key points', () => {
    const s = formStateFromLabel(items, label);
    expect(s.decisions).toEqual({ a: 'keep', b: 'wrong' });
    expect(s.extraKeyPoints).toEqual(['Typed by hand']);
    expect(s.outcome).toBe('low');
    const r = buildLabelPayload(items, s);
    expect(r.ok && r.value.keyPoints).toEqual(['Added a retry wrapper around the fetch client', 'Typed by hand']);
    expect(r.ok && r.value.forbiddenClaims).toEqual(['Chose SQLite over Postgres: local-first']);
  });

  it('returns the empty form without a label and tracks dirtiness', () => {
    const s = formStateFromLabel(items, null);
    expect(s).toEqual(EMPTY_LABEL_FORM);
    expect(isFormDirty(s, labelFormReducer(s, { type: 'setOutcome', outcome: 'high' }))).toBe(true);
    expect(isFormDirty(s, formStateFromLabel(items, null))).toBe(false);
  });

  it('counts decisions', () => {
    expect(countDecisions(items, formStateFromLabel(items, label))).toEqual({ keep: 1, wrong: 1, trivial: 0, undecided: 2 });
  });
});

describe('deriveAnalysisItems', () => {
  const base = {
    session_id: 's1', project_id: 'p', project_name: 'p', content: '', confidence: 1, source: 'llm' as const,
    metadata: '{}', timestamp: '', created_at: '', scope: 'session', analysis_version: '1', linked_insight_ids: null,
  };
  const insights = [
    { ...base, id: 'd1', type: 'decision', title: 'Use SQLite', summary: 'Local-first storage', bullets: '[]' },
    { ...base, id: 's', type: 'summary', title: 'Summary', summary: 'x', bullets: '["First bullet","Second bullet"]' },
    { ...base, id: 'pq', type: 'prompt_quality', title: 'PQ', summary: 'ignored', bullets: '[]' },
    { ...base, id: 'l1', type: 'learning', title: 'Same', summary: 'same', bullets: '[]' },
  ] as unknown as Insight[];
  const facets = {
    friction_points: JSON.stringify([
      { category: 'stale-assumptions', description: 'Old API' },
      { category: 'made-up', description: 'Invented category' },
      { category: 'rage-loop', description: '' },
    ]),
    effective_patterns: JSON.stringify([{ category: 'self-correction', description: 'Caught its own bug' }]),
  };

  it('puts summary bullets first, skips prompt quality, keeps canonical categories only', () => {
    const out = deriveAnalysisItems(insights, facets, {
      friction: ['stale-assumptions', 'rage-loop'],
      pattern: ['self-correction'],
    });
    expect(out.map((i) => [i.id, i.kind, i.text, i.category])).toEqual([
      ['s#0', 'summary', 'First bullet', undefined],
      ['s#1', 'summary', 'Second bullet', undefined],
      ['d1', 'decision', 'Use SQLite: Local-first storage', undefined],
      ['l1', 'learning', 'Same', undefined],
      ['friction#0', 'friction', 'Old API', 'stale-assumptions'],
      ['friction#1', 'friction', 'Invented category', undefined],
      ['pattern#0', 'pattern', 'Caught its own bug', 'self-correction'],
    ]);
  });

  it('tolerates missing facets and malformed JSON', () => {
    expect(deriveAnalysisItems([], null)).toEqual([]);
    expect(deriveAnalysisItems([], { friction_points: 'not json', effective_patterns: '{}' })).toEqual([]);
  });
});

describe('progress helpers', () => {
  it('clamps coverage ratio and treats zero target as met', () => {
    expect(coverageRatio(3, 6)).toBe(0.5);
    expect(coverageRatio(9, 6)).toBe(1);
    expect(coverageRatio(0, 0)).toBe(1);
  });

  it('derives 60/20/20 split targets', () => {
    expect(splitTargets(30)).toEqual({ train: 18, validation: 6, test: 6 });
  });

  it('picks the next queued session that is not the current one', () => {
    const q = [{ sessionId: 'a' }, { sessionId: 'b' }];
    expect(nextQueuedSession(q, 'a')).toBe('b');
    expect(nextQueuedSession(q, undefined)).toBe('a');
    expect(nextQueuedSession([{ sessionId: 'a' }], 'a')).toBeNull();
  });
});
