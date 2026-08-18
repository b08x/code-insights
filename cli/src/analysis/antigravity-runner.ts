import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { type AnalysisRunner, type RunAnalysisParams, type RunAnalysisResult } from './runner-types.js';
import { extractJsonPayload } from './response-parsers.js';

/**
 * AntigravityNativeRunner — executes analysis via `agy -p` (non-interactive mode).
 */
export class AntigravityNativeRunner implements AnalysisRunner {
  readonly name = 'antigravity-native';

  /**
   * Validate that the `agy` CLI is available in PATH.
   */
  static validate(): void {
    try {
      execFileSync('agy', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'agy CLI not found in PATH. Fallback requires Antigravity CLI to be installed.'
      );
    }
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();
    
    // Combine system + user prompt. If a formal JSON schema is provided,
    // inject it into the instructions to ensure structural compliance.
    let fullPrompt = `${params.systemPrompt}\n\nUSER INSTRUCTIONS:\n${params.userPrompt}`;
    if (params.jsonSchema) {
      fullPrompt += `\n\nSTRICT JSON SCHEMA:\n${JSON.stringify(params.jsonSchema, null, 2)}`;
    }
    
    try {
      const args = [
        '-p', fullPrompt,
        '--dangerously-skip-permissions',
      ];

      let rawOutput: string;
      try {
        rawOutput = execFileSync('agy', args, {
          encoding: 'utf-8',
          timeout: 300_000,    // 5-minute hard limit
          maxBuffer: 30 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'], // Capture stdout and stderr
          cwd: tmpdir(),
        });
      } catch (err: any) {
        const stdout = err.stdout?.toString() || '';
        const stderr = err.stderr?.toString() || '';
        
        if (stdout.includes('rateLimitExceeded') || stderr.includes('rateLimitExceeded') || 
            stdout.includes('RESOURCE_EXHAUSTED') || stderr.includes('RESOURCE_EXHAUSTED')) {
          throw new Error('Antigravity CLI usage limit reached (rate limit or capacity).');
        }
        
        throw new Error(`agy -p command failed: ${err.message}${stderr ? `\nStderr: ${stderr}` : ''}`);
      }

      // Extract JSON using the robust parser
      const extracted = extractJsonPayload(rawOutput);
      const rawJson = extracted || rawOutput.trim();

      // For antigravity, we don't have token usage details easily parsed from standard stdout,
      // but we can estimate based on character counts or keep it as 0.
      let inputTokens = 0;
      let outputTokens = 0;

      return {
        rawJson,
        durationMs: Date.now() - start,
        inputTokens,
        outputTokens,
        model: 'antigravity-native',
        provider: 'antigravity-native',
      };
    } catch (err: any) {
      if (err.message.includes('usage limit reached')) {
        throw err;
      }
      throw new Error(`Antigravity analysis failed: ${err.message}`);
    }
  }
}
