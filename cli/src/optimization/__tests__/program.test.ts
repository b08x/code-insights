import { describe, it, expect } from 'vitest';
import {
  OptimizableProgram,
  ProgramError,
  componentId,
  toGuidanceComponents,
  validateComponentMap,
} from '../program.js';
import { TARGETS, type TargetRegistry } from '../targets.js';
import { resolveAnalysisPrompt, type ActivePromptLookup } from '../resolve-prompt.js';

const S = 'session-analysis' as const;
const FRICTION = componentId(S, 'frictionGuidance');
const PATTERN = componentId(S, 'patternGuidance');
const max = (key: string) => TARGETS[S].mutable.find(c => c.key === key)!.maxChars;

describe('OptimizableProgram', () => {
  it('exposes exactly the registry-mutable components, none of the frozen parts', () => {
    const comps = new OptimizableProgram(S).getOptimizableComponents();
    expect(comps.map(c => c.key)).toEqual([FRICTION, PATTERN]);
    const keys = comps.map(c => c.key).join(' ');
    for (const frozen of TARGETS[S].frozen) expect(keys).not.toContain(frozen);
    expect(comps.every(c => c.kind === 'instruction' && c.current.length > 50)).toBe(true);
  });

  it('seeds components with the built-in text and tells GEPA each cap (maxLength + validate)', () => {
    const comps = new OptimizableProgram(S).getOptimizableComponents();
    expect(comps[0].current).toBe(TARGETS[S].mutable[0].builtIn);
    expect(comps[0].maxLength).toBe(max('frictionGuidance'));
    expect(comps[0].validate!('ok')).toBe(true);
    expect(comps[0].validate!('x'.repeat(max('frictionGuidance') + 1))).toMatch(/at most/);
    expect(comps[0].validate!('   ')).toMatch(/empty/);
  });

  it('the prompt-quality target exposes only promptQualityGuidance', () => {
    expect(new OptimizableProgram('prompt-quality').getOptimizableComponents().map(c => c.key)).toEqual(['prompt-quality::promptQualityGuidance']);
  });

  it('componentMap round trip: applyOptimizedComponents -> componentMap -> guidanceComponents', () => {
    const p = new OptimizableProgram(S);
    p.applyOptimizedComponents({ [FRICTION]: 'NEW FRICTION' });
    expect(p.componentMap()).toEqual({ [FRICTION]: 'NEW FRICTION', [PATTERN]: TARGETS[S].mutable[1].builtIn });
    expect(p.guidanceComponents()).toEqual({ frictionGuidance: 'NEW FRICTION', patternGuidance: TARGETS[S].mutable[1].builtIn });
    expect(p.getOptimizableComponents()[0].current).toBe('NEW FRICTION');
  });

  it('applyOptimization applies result.optimizedProgram.componentMap (and ignores demos)', () => {
    const p = new OptimizableProgram(S);
    const map = { [FRICTION]: 'A', [PATTERN]: 'B' };
    p.applyOptimization({ componentMap: map });
    expect(p.componentMap()).toEqual(map);
    expect(() => p.setDemos()).not.toThrow();
    p.applyOptimization({});
    expect(p.componentMap()).toEqual(map);
  });

  it('rejects frozen, unknown, empty and over-long updates, applying nothing', () => {
    const p = new OptimizableProgram(S);
    const before = p.componentMap();
    expect(() => p.applyOptimizedComponents({ [FRICTION]: 'fine', 'session-analysis::outputFormat': 'x' })).toThrow(ProgramError);
    expect(() => p.applyOptimizedComponents({ [FRICTION]: '  ' })).toThrow(/non-empty/);
    expect(() => p.applyOptimizedComponents({ [FRICTION]: 'x'.repeat(max('frictionGuidance') + 1) })).toThrow(/limit is/);
    expect(() => p.applyOptimizedComponents({ 'prompt-quality::promptQualityGuidance': 'wrong target' })).toThrow(/not an optimizable component/);
    expect(p.componentMap()).toEqual(before);
  });

  it('validates the initial components too', () => {
    expect(() => new OptimizableProgram(S, TARGETS, { frictionGuidance: 'x'.repeat(max('frictionGuidance') + 1) })).toThrow(ProgramError);
    expect(new OptimizableProgram(S, TARGETS, { frictionGuidance: 'seed' }).componentMap()[FRICTION]).toBe('seed');
  });

  it('builtInMap is the seed candidate GEPA starts from', () => {
    expect(new OptimizableProgram(S).builtInMap()).toEqual(new OptimizableProgram(S).componentMap());
  });
});

describe('validateComponentMap / toGuidanceComponents', () => {
  it('collects every error without throwing', () => {
    const r = validateComponentMap(S, { [FRICTION]: '', 'x::y': 'z' });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(2);
  });

  it('converts a partial map to GuidanceComponents', () => {
    expect(toGuidanceComponents(S, { [PATTERN]: 'only pattern' })).toEqual({ patternGuidance: 'only pattern' });
    expect(() => toGuidanceComponents(S, { bogus: 'x' })).toThrow(ProgramError);
  });

  it('honors a custom registry (maxChars per component)', () => {
    const registry: TargetRegistry = {
      ...TARGETS,
      [S]: { ...TARGETS[S], mutable: TARGETS[S].mutable.map(c => ({ ...c, maxChars: 10 })) },
    };
    expect(validateComponentMap(S, { [FRICTION]: 'x'.repeat(11) }, registry).ok).toBe(false);
    expect(validateComponentMap(S, { [FRICTION]: 'x'.repeat(10) }, registry).ok).toBe(true);
  });
});

describe('resolveAnalysisPrompt maxChars (carry-forward 4)', () => {
  const identity = { runner: 'provider:mistral', model: 'm', variant: null };
  const key = 'provider:mistral|m|';

  it('ignores an over-long stored component (built-in for that component) and keeps the rest', () => {
    const lookup: ActivePromptLookup = () => ({
      versionId: 'v1', identityKey: key,
      components: { frictionGuidance: 'x'.repeat(max('frictionGuidance') + 1), patternGuidance: 'short pattern' },
    });
    const r = resolveAnalysisPrompt(S, identity, { lookup });
    expect(r.versionId).toBe('v1');
    expect(r.components).toEqual({ patternGuidance: 'short pattern' });
  });
});
