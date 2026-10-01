/**
 * Optimizable program wrapper (plan step 21; engine-2, carry-forward 4).
 *
 * AxGEPA discovers what it may mutate by calling `getOptimizableComponents()` on the program it is
 * given, proposes new text per component, and broadcasts results through
 * `applyOptimizedComponents()` / `applyOptimization()`. This wrapper exposes exactly the
 * registry-mutable components of one target (targets.ts `mutable`) and nothing else: the JSON
 * schema, canonical categories, output format, task instructions and system prompt are frozen and
 * absent here, so no candidate can name them. Anything outside the mutable allowlist is rejected,
 * not ignored, so a bug cannot silently drop or smuggle a component.
 *
 * Component ids are `<target>::<GuidanceComponents key>`. The wrapper has no forward(): scoring
 * goes through the adapter (adapter.ts), which runs the real analysis pipeline. If AxGEPA ever
 * falls back to program.forward (it does when an adapter call throws), the missing method fails
 * loudly instead of scoring against a toy program.
 *
 * Each component has a `maxChars` cap: GEPA is told via `maxLength` + `validate` (so its
 * reflection loop re-rolls an over-long proposal), and this wrapper rejects an over-long value on
 * apply. The adapter also rejects over-long candidates before spending any call.
 */

import type { AxOptimizableComponent } from '@ax-llm/ax';
import type { GuidanceComponents } from '../analysis/prompts.js';
import { TARGETS, type AnalysisTarget, type MutableComponent, type TargetRegistry } from './targets.js';

export class ProgramError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProgramError';
  }
}

export const componentId = (target: AnalysisTarget, key: string): string => `${target}::${key}`;

/** The shape of AxGEPA's result.optimizedProgram that this wrapper consumes. */
export interface OptimizedProgramLike {
  componentMap?: Readonly<Record<string, string>>;
  demos?: unknown;
  modelConfig?: unknown;
}

export interface ComponentMapValidation {
  ok: boolean;
  errors: string[];
}

function mutableFor(target: AnalysisTarget, registry: TargetRegistry): readonly MutableComponent[] {
  const def = registry[target];
  if (!def) throw new ProgramError(`Unknown optimization target "${target}".`);
  return def.mutable;
}

/** Check a candidate component map against the allowlist and length caps. Never throws. */
export function validateComponentMap(
  target: AnalysisTarget,
  map: Readonly<Record<string, string>>,
  registry: TargetRegistry = TARGETS,
): ComponentMapValidation {
  const mutable = mutableFor(target, registry);
  const byId = new Map(mutable.map(c => [componentId(target, c.key), c]));
  const errors: string[] = [];
  for (const [id, text] of Object.entries(map)) {
    const c = byId.get(id);
    if (!c) { errors.push(`"${id}" is not an optimizable component (frozen or unknown).`); continue; }
    if (typeof text !== 'string' || text.trim() === '') { errors.push(`"${id}" must be non-empty text.`); continue; }
    if (text.length > c.maxChars) errors.push(`"${id}" is ${text.length} characters; the limit is ${c.maxChars}.`);
  }
  return { ok: errors.length === 0, errors };
}

/** Candidate map -> the GuidanceComponents the prompt builders and promptOverride take. */
export function toGuidanceComponents(
  target: AnalysisTarget,
  map: Readonly<Record<string, string>>,
  registry: TargetRegistry = TARGETS,
): GuidanceComponents {
  const check = validateComponentMap(target, map, registry);
  if (!check.ok) throw new ProgramError(check.errors.join(' '));
  const out: GuidanceComponents = {};
  for (const c of mutableFor(target, registry)) {
    const text = map[componentId(target, c.key)];
    if (text !== undefined) out[c.key] = text;
  }
  return out;
}

export class OptimizableProgram {
  private readonly values = new Map<string, string>();

  constructor(
    readonly target: AnalysisTarget = 'session-analysis',
    private readonly registry: TargetRegistry = TARGETS,
    /** Starting text per component key; absent keys start at the built-in text. */
    initial: GuidanceComponents = {},
  ) {
    const check = validateComponentMap(
      target,
      Object.fromEntries(
        mutableFor(target, registry).flatMap(c => (initial[c.key] !== undefined ? [[componentId(target, c.key), initial[c.key]!]] : [])),
      ),
      registry,
    );
    if (!check.ok) throw new ProgramError(check.errors.join(' '));
    for (const c of mutableFor(target, registry)) this.values.set(componentId(target, c.key), initial[c.key] ?? c.builtIn);
  }

  getOptimizableComponents(): AxOptimizableComponent[] {
    return mutableFor(this.target, this.registry).map(c => {
      const id = componentId(this.target, c.key);
      return {
        key: id,
        kind: 'instruction',
        current: this.values.get(id)!,
        description: c.description,
        constraints:
          'Plain guidance text for an analyst. Keep the existing XML-style section structure and the canonical ' +
          'category names; do not add output-format or JSON instructions.',
        maxLength: c.maxChars,
        validate: (value: string) =>
          value.trim() === '' ? 'must not be empty' : value.length > c.maxChars ? `must be at most ${c.maxChars} characters` : true,
      };
    });
  }

  /** Rejects the whole update when any entry is frozen/unknown/empty/over-long; nothing is applied then. */
  applyOptimizedComponents(updates: Readonly<Record<string, string>>): void {
    const check = validateComponentMap(this.target, updates, this.registry);
    if (!check.ok) throw new ProgramError(check.errors.join(' '));
    for (const [id, text] of Object.entries(updates)) this.values.set(id, text);
  }

  /** AxGEPA's `program.applyOptimization(result.optimizedProgram)`: only componentMap is meaningful here. */
  applyOptimization(optimized: OptimizedProgramLike): void {
    if (optimized.componentMap && Object.keys(optimized.componentMap).length > 0) {
      this.applyOptimizedComponents(optimized.componentMap);
    }
  }

  /** Demos are never used (the prompt is guidance text only); GEPA calls this only with `bootstrap`. */
  setDemos(): void {}

  /** Current text by component id; what AxGEPA stores as `optimizedProgram.componentMap`. */
  componentMap(): Record<string, string> {
    return Object.fromEntries(this.values);
  }

  /** Current text as GuidanceComponents (versions store this; promptOverride takes it). */
  guidanceComponents(): GuidanceComponents {
    return toGuidanceComponents(this.target, this.componentMap(), this.registry);
  }

  /** The built-in seed candidate, keyed by component id. */
  builtInMap(): Record<string, string> {
    return Object.fromEntries(mutableFor(this.target, this.registry).map(c => [componentId(this.target, c.key), c.builtIn]));
  }
}
