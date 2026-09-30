import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TARGETS, enabledTargets, type TargetRegistry } from '../targets.js';
import {
  resolveAnalysisPrompt, setActivePromptLookup, type ActivePromptLookup, type ActivePromptVersion,
} from '../resolve-prompt.js';
import { identityKey, type StudentIdentity } from '../identity.js';
import {
  buildSessionAnalysisInstructions, buildPromptQualityInstructions,
} from '../../analysis/prompts.js';
import { FRICTION_CLASSIFICATION_GUIDANCE } from '../../analysis/prompt-constants.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const student: StudentIdentity = { runner: 'provider:mistral', model: 'mistral-small', variant: null };
const other: StudentIdentity = { runner: 'provider:openai', model: 'gpt-4.1', variant: null };

/** Fake lookup backed by a map keyed like the real tables will be: (target, identity key). */
function fakeLookup(versions: Array<{ target: 'session-analysis' | 'prompt-quality'; identity: StudentIdentity; version: Omit<ActivePromptVersion, 'identityKey'> }>): ActivePromptLookup {
  return (target, key) => {
    const hit = versions.find(v => v.target === target && identityKey(v.identity) === key);
    return hit ? { ...hit.version, identityKey: key } : null;
  };
}

describe('target registry', () => {
  it('session-analysis is the only enabled target', () => {
    expect(enabledTargets().map(t => t.id)).toEqual(['session-analysis']);
    expect(TARGETS['prompt-quality'].enabled).toBe(false);
  });

  it('describes mutable components with built-in text, frozen parts, builder, parser, normalizers and schema file', () => {
    for (const def of Object.values(TARGETS)) {
      expect(def.mutable.length).toBeGreaterThan(0);
      for (const c of def.mutable) expect(c.builtIn.length).toBeGreaterThan(50);
      expect(def.frozen).toEqual(expect.arrayContaining(['json-schema', 'canonical-categories', 'output-format']));
      expect(typeof def.builder).toBe('function');
      expect(typeof def.parser).toBe('function');
      expect(def.normalizers.length).toBeGreaterThan(0);
      expect(existsSync(join(REPO_ROOT, def.schemaFile))).toBe(true);
    }
    expect(TARGETS['session-analysis'].mutable.map(c => c.key)).toEqual(['frictionGuidance', 'patternGuidance']);
  });

  it('built-in component text is what the builders emit by default', () => {
    const prompt = buildSessionAnalysisInstructions('proj', null);
    for (const c of TARGETS['session-analysis'].mutable) expect(prompt).toContain(c.builtIn);
    const pq = buildPromptQualityInstructions('proj', { humanMessageCount: 2, assistantMessageCount: 2, toolExchangeCount: 0 });
    for (const c of TARGETS['prompt-quality'].mutable) expect(pq).toContain(c.builtIn);
  });
});

describe('resolveAnalysisPrompt', () => {
  const version = { versionId: 'pv-1', components: { frictionGuidance: 'TUNED-FRICTION' } };

  it('no active version: built-in (empty components, null id), byte-identical prompt text', () => {
    const resolved = resolveAnalysisPrompt('session-analysis', student, { lookup: fakeLookup([]) });
    expect(resolved).toEqual({ components: {}, versionId: null });
    expect(buildSessionAnalysisInstructions('p', 's', undefined, undefined, undefined, resolved.components))
      .toBe(buildSessionAnalysisInstructions('p', 's'));
  });

  it('default lookup (tables not built yet) and missing identity resolve the built-in prompt', () => {
    expect(resolveAnalysisPrompt('session-analysis', student)).toEqual({ components: {}, versionId: null });
    const lookup = fakeLookup([{ target: 'session-analysis', identity: student, version }]);
    expect(resolveAnalysisPrompt('session-analysis', undefined, { lookup })).toEqual({ components: {}, versionId: null });
  });

  it('active version for this identity: its components and id', () => {
    const lookup = fakeLookup([{ target: 'session-analysis', identity: student, version }]);
    const resolved = resolveAnalysisPrompt('session-analysis', student, { lookup });
    expect(resolved).toEqual({ components: { frictionGuidance: 'TUNED-FRICTION' }, versionId: 'pv-1' });
    const text = buildSessionAnalysisInstructions('p', 's', undefined, undefined, undefined, resolved.components);
    expect(text).toContain('TUNED-FRICTION');
    expect(text).not.toContain(FRICTION_CLASSIFICATION_GUIDANCE);
  });

  it('active version for another identity is ignored (runner, model and variant each matter)', () => {
    const lookup = fakeLookup([{ target: 'session-analysis', identity: other, version }]);
    expect(resolveAnalysisPrompt('session-analysis', student, { lookup })).toEqual({ components: {}, versionId: null });
    const tuned = fakeLookup([{ target: 'session-analysis', identity: student, version }]);
    for (const changed of [{ ...student, model: 'x' }, { ...student, variant: 'high' }, { ...student, runner: 'provider:x' }]) {
      expect(resolveAnalysisPrompt('session-analysis', changed, { lookup: tuned }).versionId).toBeNull();
    }
  });

  it('ignores a lookup that returns a version tuned for a different identity', () => {
    const sloppy: ActivePromptLookup = () => ({ ...version, identityKey: identityKey(other) });
    expect(resolveAnalysisPrompt('session-analysis', student, { lookup: sloppy })).toEqual({ components: {}, versionId: null });
  });

  it('drops keys that are not mutable for the target', () => {
    const lookup = fakeLookup([{
      target: 'session-analysis', identity: student,
      version: { versionId: 'pv-2', components: { frictionGuidance: 'F', promptQualityGuidance: 'PQ-NOT-MINE' } },
    }]);
    expect(resolveAnalysisPrompt('session-analysis', student, { lookup }).components).toEqual({ frictionGuidance: 'F' });
  });

  it('disabled target never consults the lookup', () => {
    let calls = 0;
    const lookup: ActivePromptLookup = () => { calls++; return null; };
    expect(resolveAnalysisPrompt('prompt-quality', student, { lookup }).versionId).toBeNull();
    expect(calls).toBe(0);
  });

  it('enabling prompt-quality needs only a registry entry', () => {
    const registry: TargetRegistry = { ...TARGETS, 'prompt-quality': { ...TARGETS['prompt-quality'], enabled: true } };
    const lookup = fakeLookup([{
      target: 'prompt-quality', identity: student,
      version: { versionId: 'pq-1', components: { promptQualityGuidance: 'TUNED-PQ' } },
    }]);
    expect(enabledTargets(registry).map(t => t.id)).toEqual(['session-analysis', 'prompt-quality']);
    expect(resolveAnalysisPrompt('prompt-quality', student, { lookup, registry }))
      .toEqual({ components: { promptQualityGuidance: 'TUNED-PQ' }, versionId: 'pq-1' });
    // Same lookup, shipped registry: still built-in.
    expect(resolveAnalysisPrompt('prompt-quality', student, { lookup }).versionId).toBeNull();
  });

  it('setActivePromptLookup installs and clears the default lookup', () => {
    const lookup = fakeLookup([{ target: 'session-analysis', identity: student, version }]);
    setActivePromptLookup(lookup);
    try {
      expect(resolveAnalysisPrompt('session-analysis', student).versionId).toBe('pv-1');
    } finally {
      setActivePromptLookup(null);
    }
    expect(resolveAnalysisPrompt('session-analysis', student).versionId).toBeNull();
  });
});
