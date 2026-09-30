/**
 * Validation for `dashboard.analysis.runner`, shared by the CLI (runner selection) and the
 * server (config route). Model and variant values reach CLI argv (execFileSync, no shell), so a
 * value may never start with '-' (it would be read as a flag) and is limited to the characters
 * model ids actually use. '|' is excluded because it separates identity-key components.
 */

import { ANALYSIS_RUNNER_NAMES, type AnalysisRunnerName } from '../types.js';

export { ANALYSIS_RUNNER_NAMES, type AnalysisRunnerName };

export const RUNNER_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
export const RUNNER_VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;

export function isRunnerName(value: unknown): value is AnalysisRunnerName {
  return typeof value === 'string' && (ANALYSIS_RUNNER_NAMES as readonly string[]).includes(value);
}

export function isValidRunnerModel(value: unknown): value is string {
  return typeof value === 'string' && RUNNER_MODEL_RE.test(value);
}

export function isValidRunnerVariant(value: unknown): value is string {
  return typeof value === 'string' && RUNNER_VARIANT_RE.test(value);
}
