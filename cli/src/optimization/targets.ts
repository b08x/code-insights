/**
 * Optimization target registry (plan step 10).
 *
 * A target describes one analysis prompt the optimizer may tune: which guidance components are
 * mutable (and their built-in text), which parts are frozen, and the builder / parser /
 * normalizers / schema file that evaluation must go through. `session-analysis` is the only
 * enabled target. Enabling `prompt-quality` is a one-line change to `enabled` below: resolution,
 * persistence and the pipeline already handle it, so no engine code changes.
 *
 * Frozen parts are listed for documentation and for the optimizer to refuse to mutate them;
 * `mutable` is also the allowlist resolveAnalysisPrompt applies to stored versions.
 */

import {
  buildSessionAnalysisInstructions,
  buildPromptQualityInstructions,
  type GuidanceComponents,
} from '../analysis/prompts.js';
import {
  FRICTION_CLASSIFICATION_GUIDANCE,
  EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE,
  PROMPT_QUALITY_CLASSIFICATION_GUIDANCE,
} from '../analysis/prompt-constants.js';
import { parseAnalysisResponse, parsePromptQualityResponse } from '../analysis/response-parsers.js';
import { normalizeFrictionCategory } from '../analysis/friction-normalize.js';
import { normalizePatternCategory } from '../analysis/pattern-normalize.js';
import { normalizePromptQualityCategory } from '../analysis/prompt-quality-normalize.js';

export type AnalysisTarget = 'session-analysis' | 'prompt-quality';

export type MutableComponentKey = keyof GuidanceComponents;

export interface MutableComponent {
  /** Key in GuidanceComponents that the builder reads. */
  key: MutableComponentKey;
  /** What the component is, for the optimizer's reflection prompt. */
  description: string;
  /** Built-in text; the optimizer's seed candidate. */
  builtIn: string;
  /**
   * Hard length cap (characters) for any stored or candidate text. Guards the prompt budget: an
   * unbounded reflective rewrite could otherwise push every analysis past the chunking threshold.
   * Candidates over the cap are rejected by the adapter; stored versions over it are ignored by
   * resolveAnalysisPrompt (that component falls back to the built-in text).
   */
  maxChars: number;
}

export interface TargetDefinition {
  id: AnalysisTarget;
  enabled: boolean;
  mutable: readonly MutableComponent[];
  /** Parts no candidate may change. */
  frozen: readonly string[];
  /** Prompt instruction builder; accepts GuidanceComponents as its last argument. */
  builder: (...args: never[]) => string;
  parser: (response: string) => { success: boolean };
  normalizers: ReadonlyArray<(category: string | null | undefined) => string>;
  /** JSON schema the runner is constrained to, relative to the repo root. */
  schemaFile: string;
}

export type TargetRegistry = Record<AnalysisTarget, TargetDefinition>;

export const TARGETS: TargetRegistry = {
  'session-analysis': {
    id: 'session-analysis',
    enabled: true,
    mutable: [
      {
        key: 'frictionGuidance',
        description: 'Analyst guidance for classifying friction points.',
        builtIn: FRICTION_CLASSIFICATION_GUIDANCE,
        maxChars: 8000,
      },
      {
        key: 'patternGuidance',
        description: 'Analyst guidance for classifying effective workflow patterns.',
        builtIn: EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE,
        maxChars: 6000,
      },
    ],
    frozen: ['json-schema', 'canonical-categories', 'output-format', 'task-instructions', 'system-prompt'],
    builder: buildSessionAnalysisInstructions as TargetDefinition['builder'],
    parser: parseAnalysisResponse,
    normalizers: [normalizeFrictionCategory, normalizePatternCategory],
    schemaFile: 'cli/src/analysis/schemas/session-analysis.json',
  },
  // Defined so the optimizer can grow to it by flipping `enabled`; not optimized today.
  'prompt-quality': {
    id: 'prompt-quality',
    enabled: false,
    mutable: [
      {
        key: 'promptQualityGuidance',
        description: 'Analyst guidance for classifying prompt-quality findings.',
        builtIn: PROMPT_QUALITY_CLASSIFICATION_GUIDANCE,
        maxChars: 6000,
      },
    ],
    frozen: ['json-schema', 'canonical-categories', 'output-format', 'task-instructions', 'system-prompt'],
    builder: buildPromptQualityInstructions as TargetDefinition['builder'],
    parser: parsePromptQualityResponse,
    normalizers: [normalizePromptQualityCategory],
    schemaFile: 'cli/src/analysis/schemas/prompt-quality.json',
  },
};

export function enabledTargets(registry: TargetRegistry = TARGETS): TargetDefinition[] {
  return Object.values(registry).filter(t => t.enabled);
}
