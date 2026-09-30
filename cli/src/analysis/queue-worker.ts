/**
 * Queue worker — processes analysis_queue items one at a time.
 *
 * Called as a detached subprocess spawned by `session-end` after enqueue.
 * Resets stale processing items first, then claims and runs pending items
 * until the queue is empty.
 *
 * Worker spawned with CODE_INSIGHTS_HOOK_ACTIVE=1 in env so that
 * ClaudeNativeRunner does not re-trigger this hook recursively.
 */

import chalk from 'chalk';
import { claimNext, markCompleted, markFailed, resetStale } from '../db/queue.js';
import { analyzeSessionPipeline, pipelineFailureToError } from './pipeline.js';
import { FallbackNativeRunner } from './native-fallback.js';
import { ProviderRunner } from './provider-runner.js';
import { ClaudeNativeRunner } from './native-runner.js';
import { CodexNativeRunner } from './codex-runner.js';
import { AntigravityNativeRunner } from './antigravity-runner.js';
import { MistralVibeRunner } from './mistral-vibe-runner.js';
import { OpenCodeRunner } from './opencode-runner.js';
import type { AnalysisRunner } from './runner-types.js';
import { configuredRunner, explicitRunnerName, runnerConfigFor } from './runner-selection.js';
import { loadConfig } from '../utils/config.js';

export interface ProcessQueueOptions {
  quiet?: boolean;
  /** Runner type to use — 'native' uses claude -p, anything else uses configured provider */
  runnerType?: string;
  /** Explicitly use codex if 'native' runner is requested */
  useCodex?: boolean;
  /** Explicitly use claude if 'native' runner is requested */
  useClaude?: boolean;
  /** Explicitly use antigravity if 'native' runner is requested */
  useAntigravity?: boolean;
  /** Explicitly use vibe if 'native' runner is requested */
  useVibe?: boolean;
  /** Explicitly use opencode if 'native' runner is requested */
  useOpencode?: boolean;
}

/**
 * Process all pending queue items until the queue is empty.
 * Returns the number of items processed successfully.
 */
export async function processQueue(options: ProcessQueueOptions = {}): Promise<number> {
  const { quiet = false } = options;
  const log = quiet ? () => {} : console.log.bind(console);

  // Reset any items stuck in 'processing' from a previous crashed worker
  const staleCount = resetStale();
  if (staleCount > 0) {
    log(chalk.yellow(`[Code Insights] Reset ${staleCount} stale processing item(s) to pending`));
  }

  let successCount = 0;

  // Runners are built lazily or reused
  let claudeRunner: ClaudeNativeRunner | undefined;
  let codexRunner: CodexNativeRunner | undefined;
  let antigravityRunner: AntigravityNativeRunner | undefined;
  let vibeRunner: MistralVibeRunner | undefined;
  let opencodeRunner: OpenCodeRunner | undefined;
  
  // Explicit runner flags win; else the runner saved in Settings applies to native items; else
  // Claude. Saved model/variant apply only to the saved runner (runnerConfigFor), so a
  // usage-limit switch to another runner runs it with its CLI defaults.
  const config = loadConfig();
  const explicit = explicitRunnerName({
    claude: options.useClaude, codex: options.useCodex, antigravity: options.useAntigravity,
    vibe: options.useVibe, opencode: options.useOpencode,
  });
  const saved = explicit ? null : configuredRunner(config);
  /** Settings chose the provider: native items use it too (items queued as 'provider' always do). */
  const nativeItemsUseProvider = saved?.name === 'provider';
  let currentNativeType: 'claude' | 'codex' | 'antigravity' | 'vibe' | 'opencode' =
    explicit && explicit !== 'provider' ? explicit
    : saved && saved.name !== 'provider' ? saved.name
    : 'claude';

  const getNativeRunner = (): AnalysisRunner | undefined => {
    // OpenCode is opt-in only: not part of the fallback chain (see native-fallback.ts), so a
    // missing CLI is a hard failure rather than a silent switch to a different model.
    if (currentNativeType === 'opencode') {
      if (!opencodeRunner) {
        try {
          OpenCodeRunner.validate();
          opencodeRunner = new OpenCodeRunner(runnerConfigFor('opencode', config));
        } catch { return undefined; }
      }
      return opencodeRunner;
    }

    if (currentNativeType === 'vibe') {
      if (!vibeRunner) {
        try {
          MistralVibeRunner.validate();
          vibeRunner = new MistralVibeRunner(runnerConfigFor('vibe', config));
        } catch {
          // If vibe fails, try Antigravity as next fallback
          log(chalk.yellow(`[Code Insights] Mistral Vibe not found, trying Antigravity fallback...`));
          currentNativeType = 'antigravity';
          return getNativeRunner();
        }
      }
      return vibeRunner;
    }

    if (currentNativeType === 'antigravity') {
      if (!antigravityRunner) {
        try {
          AntigravityNativeRunner.validate();
          antigravityRunner = new AntigravityNativeRunner(runnerConfigFor('antigravity', config));
        } catch { return undefined; }
      }
      return antigravityRunner;
    }

    if (currentNativeType === 'codex') {
      if (!codexRunner) {
        try {
          CodexNativeRunner.validate();
          codexRunner = new CodexNativeRunner(runnerConfigFor('codex', config));
        } catch { 
          // If codex fails, try Antigravity as final fallback
          log(chalk.yellow(`[Code Insights] Codex not found, trying Antigravity fallback...`));
          currentNativeType = 'antigravity';
          return getNativeRunner();
        }
      }
      return codexRunner;
    }

    // Default: Claude
    if (!claudeRunner) {
      try {
        ClaudeNativeRunner.validate();
        claudeRunner = new ClaudeNativeRunner(runnerConfigFor('claude', config));
      } catch {
        // Fallback to Codex if Claude not found
        log(chalk.yellow(`[Code Insights] Claude not found, trying Codex fallback...`));
        currentNativeType = 'codex';
        return getNativeRunner();
      }
    }
    return claudeRunner;
  };

  while (true) {
    const item = claimNext();
    if (!item) break; // Queue empty

    log(chalk.dim(`[Code Insights] Analyzing session ${item.session_id} (attempt ${item.attempt_count + 1}/${item.max_attempts})...`));

    const isNative = item.runner_type === 'native' && !nativeItemsUseProvider;

    try {
      let runner: AnalysisRunner;
      if (isNative) {
        const native = getNativeRunner();
        if (!native) throw new Error(`No native runner available (tried ${currentNativeType}).`);
        // Claude items get the usage-limit fallback chain, as `insights --native` does.
        runner = currentNativeType === 'claude' ? new FallbackNativeRunner(native, log) : native;
      } else {
        runner = ProviderRunner.fromConfig();
      }

      const result = await analyzeSessionPipeline(item.session_id, { runner });
      if (!result.success) throw pipelineFailureToError(result);
      markCompleted(item.session_id);
      successCount++;
      log(chalk.green(`[Code Insights] Session ${item.session_id} analyzed successfully`));
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Multi-level fallback triggered by usage limits
      if (isNative && errorMessage.includes('usage limit reached')) {
        if (currentNativeType === 'claude') {
          log(chalk.yellow(`[Code Insights] Claude limit reached during queue processing. Switching to Codex...`));
          currentNativeType = 'codex';
        } else if (currentNativeType === 'codex') {
          log(chalk.yellow(`[Code Insights] Codex limit reached during queue processing. Switching to Antigravity...`));
          currentNativeType = 'antigravity';
        } else if (currentNativeType === 'antigravity') {
          log(chalk.yellow(`[Code Insights] Antigravity limit reached during queue processing. Switching to Mistral Vibe...`));
          currentNativeType = 'vibe';
        }
      }

      markFailed(item.session_id, errorMessage);
      if (!quiet) {
        console.error(chalk.red(`[Code Insights] Analysis failed for ${item.session_id}: ${errorMessage}`));
      }
    }
  }

  return successCount;
}
