/**
 * Prompt resolution (plan step 10).
 *
 * `resolveAnalysisPrompt` is called in exactly one place: analyzeSessionPipeline. For an enabled
 * target it asks an injected lookup for the active prompt version of (target, student identity)
 * and returns that version's components plus its id. Everything else returns the built-in
 * prompt: empty components (the builders default each field to the built-in constant, so text is
 * byte-identical to before) and `versionId: null`.
 *
 * The prompt_versions / active_prompt_versions tables arrive with the optimization engine
 * (migration v20). Until then the default lookup returns null; the engine installs a real one
 * with setActivePromptLookup. A version stored for another identity is never consulted because
 * the lookup is keyed by identityKey(identity).
 */

import type { GuidanceComponents } from '../analysis/prompts.js';
import { identityKey, type StudentIdentity } from './identity.js';
import { TARGETS, type AnalysisTarget, type TargetRegistry } from './targets.js';

export type { AnalysisTarget } from './targets.js';

export interface ResolvedPrompt {
  components: GuidanceComponents;
  /** null = built-in prompt. */
  versionId: string | null;
}

/** A caller-supplied prompt (GEPA candidate evaluation); bypasses resolution. */
export type PromptOverride = ResolvedPrompt;

export interface ActivePromptVersion {
  versionId: string;
  /** Identity the version was tuned for; the resolver re-checks it against the caller's. */
  identityKey: string;
  components: GuidanceComponents;
}

/** Returns the active version for exactly this (target, identity key), or null. */
export type ActivePromptLookup = (target: AnalysisTarget, key: string) => ActivePromptVersion | null;

const noActiveVersions: ActivePromptLookup = () => null;
let defaultLookup: ActivePromptLookup = noActiveVersions;

export function setActivePromptLookup(lookup: ActivePromptLookup | null): void {
  defaultLookup = lookup ?? noActiveVersions;
}

export interface ResolveDeps {
  lookup?: ActivePromptLookup;
  registry?: TargetRegistry;
}

export function resolveAnalysisPrompt(
  target: AnalysisTarget,
  identity?: StudentIdentity,
  deps: ResolveDeps = {},
): ResolvedPrompt {
  const builtIn: ResolvedPrompt = { components: {}, versionId: null };
  const def = (deps.registry ?? TARGETS)[target];
  if (!def?.enabled || !identity) return builtIn;

  const key = identityKey(identity);
  const version = (deps.lookup ?? defaultLookup)(target, key);
  // Belt and braces: never apply a version tuned for another identity, whatever the lookup returns.
  if (!version || version.identityKey !== key) return builtIn;

  // Only mutable keys survive: a stored version can never override frozen parts.
  const components: GuidanceComponents = {};
  for (const { key } of def.mutable) {
    const text = version.components[key];
    if (typeof text === 'string') components[key] = text;
  }
  return { components, versionId: version.versionId };
}
