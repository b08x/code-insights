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
import { runInsightsCommand } from '../commands/insights.js';
import { ClaudeNativeRunner } from './native-runner.js';
import { CodexNativeRunner } from './codex-runner.js';
import { AntigravityNativeRunner } from './antigravity-runner.js';
import { MistralVibeRunner } from './mistral-vibe-runner.js';
import type { AnalysisRunner } from './runner-types.js';

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
  
  let currentNativeType: 'claude' | 'codex' | 'antigravity' | 'vibe' = 
    options.useVibe ? 'vibe' : (options.useAntigravity ? 'antigravity' : (options.useCodex ? 'codex' : 'claude'));

  const getNativeRunner = (): AnalysisRunner | undefined => {
    if (currentNativeType === 'vibe') {
      if (!vibeRunner) {
        try {
          MistralVibeRunner.validate();
          vibeRunner = new MistralVibeRunner();
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
          antigravityRunner = new AntigravityNativeRunner();
        } catch { return undefined; }
      }
      return antigravityRunner;
    }

    if (currentNativeType === 'codex') {
      if (!codexRunner) {
        try {
          CodexNativeRunner.validate();
          codexRunner = new CodexNativeRunner();
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
        claudeRunner = new ClaudeNativeRunner();
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

    const isNative = item.runner_type === 'native';
    const runner = isNative ? getNativeRunner() : undefined;

    try {
      await runInsightsCommand({
        sessionId: item.session_id,
        native: isNative && currentNativeType === 'claude',
        codex: isNative && currentNativeType === 'codex',
        antigravity: isNative && currentNativeType === 'antigravity',
        vibe: isNative && currentNativeType === 'vibe',
        quiet,
        _runner: runner,
      });
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
