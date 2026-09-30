/**
 * Runner selection shared by `insights`, `insights check`, and the queue worker (plan step 11).
 *
 * Precedence: an explicit runner flag (--claude, --codex, ...) wins; otherwise the runner saved in
 * Settings (`dashboard.analysis.runner`); otherwise the caller's own default. The saved model and
 * variant apply only when the selected runner is the saved runner, because model ids are
 * runner-specific (a flag that picks a different runner runs it with its CLI defaults).
 */

import { ANALYSIS_RUNNER_NAMES, type AnalysisRunnerName, type ClaudeInsightConfig } from '../types.js';
import { ClaudeNativeRunner } from './native-runner.js';
import { CodexNativeRunner } from './codex-runner.js';
import { AntigravityNativeRunner } from './antigravity-runner.js';
import { MistralVibeRunner } from './mistral-vibe-runner.js';
import { OpenCodeRunner } from './opencode-runner.js';
import { ProviderRunner } from './provider-runner.js';
import type { AnalysisRunner, RunnerConfig } from './runner-types.js';

export { ANALYSIS_RUNNER_NAMES, type AnalysisRunnerName };

export function isRunnerName(value: unknown): value is AnalysisRunnerName {
  return typeof value === 'string' && (ANALYSIS_RUNNER_NAMES as readonly string[]).includes(value);
}

/** Runner flags as the commands receive them. `native` alone is the caller's native default. */
export interface RunnerFlags {
  native?: boolean;
  claude?: boolean;
  codex?: boolean;
  antigravity?: boolean;
  vibe?: boolean;
  opencode?: boolean;
}

export interface RunnerSelection {
  name: AnalysisRunnerName;
  runnerConfig: RunnerConfig;
  source: 'flag' | 'config';
}

/** The runner named by a specific flag, in the precedence `insights` has always used. */
export function explicitRunnerName(flags: RunnerFlags): AnalysisRunnerName | null {
  if (flags.opencode) return 'opencode';
  if (flags.vibe) return 'vibe';
  if (flags.antigravity) return 'antigravity';
  if (flags.claude) return 'claude';
  if (flags.codex) return 'codex';
  return null;
}

/** The saved runner, or null when unset or invalid (an unknown name is ignored, not fatal). */
export function configuredRunner(config: ClaudeInsightConfig | null | undefined): RunnerSelection | null {
  const saved = config?.dashboard?.analysis?.runner;
  if (!saved || !isRunnerName(saved.name)) return null;
  return { name: saved.name, runnerConfig: runnerConfigFor(saved.name, config), source: 'config' };
}

/** Saved model/variant for `name`; empty when the saved runner is a different one. */
export function runnerConfigFor(name: AnalysisRunnerName, config: ClaudeInsightConfig | null | undefined): RunnerConfig {
  const saved = config?.dashboard?.analysis?.runner;
  if (!saved || saved.name !== name) return {};
  const model = saved.model?.trim();
  const variant = saved.variant?.trim();
  return { ...(model ? { model } : {}), ...(variant ? { variant } : {}) };
}

/**
 * Select a runner: explicit flag, else saved runner. Returns null when the caller's default
 * applies: plain `--native` (its own Codex -> Claude chain), or nothing flagged or saved.
 */
export function selectRunner(flags: RunnerFlags, config: ClaudeInsightConfig | null | undefined): RunnerSelection | null {
  const explicit = explicitRunnerName(flags);
  if (explicit) return { name: explicit, runnerConfig: runnerConfigFor(explicit, config), source: 'flag' };
  if (flags.native) return null;
  return configuredRunner(config);
}

/**
 * Validate and construct a runner. Throws when the CLI is missing or the provider is not
 * configured. The provider runner's model comes from `dashboard.llm`; `runnerConfig` is ignored.
 */
export function buildRunner(name: AnalysisRunnerName, runnerConfig: RunnerConfig = {}): AnalysisRunner {
  switch (name) {
    case 'claude':
      ClaudeNativeRunner.validate();
      return new ClaudeNativeRunner(runnerConfig);
    case 'codex':
      CodexNativeRunner.validate();
      return new CodexNativeRunner(runnerConfig);
    case 'antigravity':
      AntigravityNativeRunner.validate();
      return new AntigravityNativeRunner(runnerConfig);
    case 'vibe':
      MistralVibeRunner.validate();
      return new MistralVibeRunner(runnerConfig);
    case 'opencode':
      OpenCodeRunner.validate();
      return new OpenCodeRunner(runnerConfig);
    case 'provider':
      return ProviderRunner.fromConfig();
  }
}
