/**
 * Prompt resolution seam (plan step 10 fills this in).
 *
 * `resolveAnalysisPrompt` is called in exactly one place: analyzeSessionPipeline. Today it always
 * returns the built-in prompt (no guidance overrides, version id null). Step 10 will look up the
 * active prompt version for (target, student identity) and return its components.
 */

import type { GuidanceComponents } from '../analysis/prompts.js';

export type AnalysisTarget = 'session-analysis' | 'prompt-quality';

/** Who is being prompted: runner + model + variant (plan step 8). */
export interface PromptIdentity {
  runner: string;
  model: string | null;
  variant: string | null;
}

export interface ResolvedPrompt {
  components: GuidanceComponents;
  /** null = built-in prompt. */
  versionId: string | null;
}

/** A caller-supplied prompt (GEPA candidate evaluation); bypasses resolution. */
export type PromptOverride = ResolvedPrompt;

export function resolveAnalysisPrompt(_target: AnalysisTarget, _identity?: PromptIdentity): ResolvedPrompt {
  return { components: {}, versionId: null };
}
