/**
 * AnalysisRunner interface — the abstraction between the `insights` command
 * and the actual LLM backend (native claude -p, or configured provider).
 *
 * Adding a new runner (e.g. CursorNativeRunner) requires only implementing
 * this interface — no changes to the `insights` command.
 */

import type { ContentBlock } from '../llm/types.js';

/** Optional model/variant selection for CLI runners; unset fields keep the CLI's own defaults. */
export interface RunnerConfig {
  model?: string;
  /** Provider-specific reasoning effort (e.g. 'high'); only runners whose CLI supports it use it. */
  variant?: string;
}

export interface AnalysisRunner {
  readonly name: string;
  runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult>;
  /**
   * LLM provider id (e.g. 'anthropic') when the runner is backed by the shared LLM transport.
   * Drives two pipeline decisions: Anthropic gets cache_control content blocks, and cost is
   * computed from provider + model. Native CLI runners leave it undefined (cost 0, plain string).
   */
  readonly provider?: string;
  /**
   * Model id. Provider runners: the model used for cost computation (set with `provider`).
   * Native runners: the configured model, or the runner's legacy label when the CLI picks its
   * own default. Must equal the `model` every successful call reports, so the identity used for
   * prompt resolution matches the identity recorded afterwards.
   */
  readonly model?: string;
  /**
   * Variant (reasoning effort) actually passed to the CLI. Undefined when unset or when the
   * runner's CLI has no such flag (the configured value is then not part of the identity).
   */
  readonly variant?: string;
  /**
   * Input token budget for one request. The pipeline chunks + merges when a prompt exceeds it.
   * Undefined means "no chunking": native CLI runners manage their own context window.
   */
  readonly maxInputTokens?: number;
  /** Token estimator matching the runner's transport; the pipeline falls back to chars/4. */
  estimateTokens?(text: string): number;
  /** Default timeout for the prompt-quality call; undefined = none (native runners cannot honor it). */
  readonly timeoutMs?: number;
}

export interface RunAnalysisParams {
  systemPrompt: string;
  userPrompt: string;
  /** JSON schema file content for structured output (used by native mode via --json-schema). */
  jsonSchema?: object;
  /**
   * The same prompt as `userPrompt`, split into content blocks (block 0 carries cache_control).
   * Set only for Anthropic-backed runners; flattening the blocks yields exactly `userPrompt`.
   * Runners that cannot use blocks ignore it.
   */
  userContent?: ContentBlock[];
  /** Cancellation/timeout signal. Native runners (execFileSync) cannot honor it and ignore it. */
  signal?: AbortSignal;
}

export interface RunAnalysisResult {
  rawJson: string;
  durationMs: number;
  /**
   * Token counts.
   * Native mode: always 0 — tokens are counted as part of the overall Claude Code session.
   * Provider mode: actual token counts from the LLM API response.
   */
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  model: string;
  provider: string;
  /**
   * Authoritative cost of this call when the transport knows it (e.g. batch API pricing).
   * When every call of a pass reports it, the pipeline records the sum instead of computing
   * cost from provider + model list prices.
   */
  costUsd?: number;
}
