/**
 * Native runner fallback chain used by `--native` and the queue worker.
 */

import chalk from 'chalk';
import { ClaudeNativeRunner } from './native-runner.js';
import { AntigravityNativeRunner } from './antigravity-runner.js';
import { MistralVibeRunner } from './mistral-vibe-runner.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';

// ── Native runner fallback chain ──────────────────────────────────────────────

/**
 * Plain `--native` fallback: Codex -> Claude -> Antigravity -> Vibe when a runner reports
 * "usage limit reached" (or cannot run). CLI-specific (the server has no native runners), so it
 * wraps the chosen runner instead of living in the pipeline, which sees one runner.
 */
export class FallbackNativeRunner implements AnalysisRunner {
  readonly name: string;

  constructor(
    private readonly primary: AnalysisRunner,
    private readonly log: (message: string) => void,
  ) {
    this.name = primary.name;
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const runner = this.primary;
    try {
      return await runner.runAnalysis(params);
    } catch (err: any) {
      // Fallback 1: Codex -> Claude
      if (runner.name === 'codex-native' && err.message.includes('usage limit reached')) {
        this.log(chalk.yellow(`[Code Insights] Codex usage limit reached, falling back to Claude...`));
        try {
          ClaudeNativeRunner.validate();
          return await new ClaudeNativeRunner().runAnalysis(params);
        } catch (fallbackErr: any) {
          this.log(chalk.yellow(`[Code Insights] Fallback to Claude failed: ${fallbackErr.message}. Trying Antigravity...`));
        }
      }

      // Fallback 2: (Codex OR Claude) -> Antigravity
      if (runner.name === 'codex-native' || runner.name === 'claude-code-native') {
        try {
          AntigravityNativeRunner.validate();
          return await new AntigravityNativeRunner().runAnalysis(params);
        } catch (fallbackErr: any) {
          this.log(chalk.yellow(`[Code Insights] Fallback to Antigravity failed: ${fallbackErr.message}. Trying Mistral Vibe...`));
        }
      }

      // Fallback 3: (Codex OR Claude OR Antigravity) -> Vibe
      if (runner.name === 'codex-native' || runner.name === 'claude-code-native' || runner.name === 'antigravity-native') {
        try {
          MistralVibeRunner.validate();
          return await new MistralVibeRunner().runAnalysis(params);
        } catch (fallbackErr: any) {
          throw new Error(`Fallback system exhausted. Original error: ${err.message}. Last fallback error: ${fallbackErr.message}`);
        }
      }
      throw err;
    }
  }
}
