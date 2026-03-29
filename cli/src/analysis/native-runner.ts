/**
 * ClaudeNativeRunner — executes analysis via `claude -p` (non-interactive mode).
 *
 * Uses execFileSync (NOT exec) to prevent shell injection: arguments are passed
 * as an array, never interpolated into a shell command string.
 *
 * Token counts are 0 because native-mode tokens are counted as part of the
 * overall Claude Code session — Code Insights incurs no separate cost.
 */

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';

export class ClaudeNativeRunner implements AnalysisRunner {
  readonly name = 'claude-code-native';

  /**
   * Validate that the `claude` CLI is available in PATH.
   * Call this once before running analysis to give the user a clear error
   * instead of a cryptic ENOENT from execFileSync.
   */
  static validate(): void {
    try {
      execFileSync('claude', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'claude CLI not found in PATH. --native requires Claude Code to be installed.\n' +
        'Install it from: https://claude.ai/download'
      );
    }
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();
    const ts = Date.now();

    // Write system prompt to a temp file — claude -p reads it via --append-system-prompt-file.
    // Temp file avoids command-line length limits and shell escaping issues.
    const promptFile = join(tmpdir(), `ci-prompt-${ts}.txt`);
    writeFileSync(promptFile, params.systemPrompt, 'utf-8');

    let schemaFile: string | undefined;
    if (params.jsonSchema) {
      schemaFile = join(tmpdir(), `ci-schema-${ts}.json`);
      writeFileSync(schemaFile, JSON.stringify(params.jsonSchema), 'utf-8');
    }

    try {
      const args = [
        '-p',
        '--output-format', 'json',
        '--append-system-prompt-file', promptFile,
        '--bare',
      ];
      if (schemaFile) {
        args.push('--json-schema', schemaFile);
      }

      const rawOutput = execFileSync('claude', args, {
        input: params.userPrompt,
        encoding: 'utf-8',
        timeout: 120_000,    // 2-minute hard limit per analysis call
        maxBuffer: 10 * 1024 * 1024,  // 10 MB
      });

      return {
        rawJson: rawOutput,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        model: 'claude-native',
        provider: 'claude-code-native',
      };
    } finally {
      // Always clean up temp files, even if execFileSync throws.
      try { unlinkSync(promptFile); } catch { /* ignore — file may not exist */ }
      if (schemaFile) {
        try { unlinkSync(schemaFile); } catch { /* ignore */ }
      }
    }
  }
}
