import { execFileSync } from 'child_process';
import { writeFileSync, readFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult, RunnerConfig } from './runner-types.js';

/**
 * CodexNativeRunner — executes analysis via `codex exec` (non-interactive mode).
 */
export class CodexNativeRunner implements AnalysisRunner {
  readonly name = 'codex-native';
  readonly model: string;

  constructor(private readonly config: RunnerConfig = {}) {
    // 'codex-native' is the legacy label when codex uses its own configured model.
    this.model = config.model ?? 'codex-native';
  }

  /**
   * Validate that the `codex` CLI is available in PATH.
   */
  static validate(): void {
    try {
      execFileSync('codex', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'codex CLI not found in PATH. Fallback requires Codex to be installed.'
      );
    }
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    
    // Codex doesn't have a direct --append-system-prompt-file flag like Claude.
    // We combine system + user prompt into one instruction for Codex.
    const fullPrompt = `${params.systemPrompt}\n\nUSER INSTRUCTIONS:\n${params.userPrompt}`;
    
    const outputFile = join(tmpdir(), `codex-out-${fileId}.txt`);
    let schemaFile: string | undefined;

    if (params.jsonSchema) {
      schemaFile = join(tmpdir(), `codex-schema-${fileId}.json`);
      writeFileSync(schemaFile, JSON.stringify(params.jsonSchema), 'utf-8');
    }

    try {
      const args = [
        'exec',
        '--ephemeral',
        '--sandbox', 'read-only',
        '--skip-git-repo-check',
        '--output-last-message', outputFile,
      ];

      if (schemaFile) {
        args.push('--output-schema', schemaFile);
      }
      if (this.config.model) args.push('-m', this.config.model);
      if (this.config.variant) args.push('-c', `model_reasoning_effort="${this.config.variant}"`);

      // Execute codex with prompt via stdin
      execFileSync('codex', args, {
        input: fullPrompt,
        encoding: 'utf-8',
        timeout: 300_000, // 5-minute limit
        maxBuffer: 30 * 1024 * 1024,
      });

      let rawJson = readFileSync(outputFile, 'utf-8').trim();
      
      // Codex might also wrap in <json> tags
      rawJson = rawJson.replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();

      return {
        rawJson,
        durationMs: Date.now() - start,
        inputTokens: 0,
        outputTokens: 0,
        model: this.model,
        provider: 'codex-native',
      };
    } finally {
      try { unlinkSync(outputFile); } catch {}
      if (schemaFile) {
        try { unlinkSync(schemaFile); } catch {}
      }
    }
  }
}
