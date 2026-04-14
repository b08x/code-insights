import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { type AnalysisRunner, type RunAnalysisParams, type RunAnalysisResult } from './runner-types.js';

/**
 * GeminiNativeRunner — executes analysis via `gemini -p` (non-interactive mode).
 */
export class GeminiNativeRunner implements AnalysisRunner {
  readonly name = 'gemini-native';

  /**
   * Validate that the `gemini` CLI is available in PATH.
   */
  static validate(): void {
    try {
      execFileSync('gemini', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'gemini CLI not found in PATH. Fallback requires Gemini CLI to be installed.'
      );
    }
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();
    
    // Combine system + user prompt
    const fullPrompt = `${params.systemPrompt}\n\nUSER INSTRUCTIONS:\n${params.userPrompt}`;
    
    try {
      const args = [
        '-p', '-',
        '-o', 'json',
        '--approval-mode', 'plan', // Read-only mode
      ];

      let rawOutput: string;
      try {
        rawOutput = execFileSync('gemini', args, {
          input: fullPrompt,
          encoding: 'utf-8',
          timeout: 120_000,    // 2-minute hard limit
          maxBuffer: 10 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'], // Capture stdout and stderr
        });
      } catch (err: any) {
        const stdout = err.stdout?.toString() || '';
        const stderr = err.stderr?.toString() || '';
        
        if (stdout.includes('rateLimitExceeded') || stderr.includes('rateLimitExceeded') || 
            stdout.includes('RESOURCE_EXHAUSTED') || stderr.includes('RESOURCE_EXHAUSTED')) {
          throw new Error('Gemini CLI usage limit reached (rate limit or capacity).');
        }
        
        throw new Error(`gemini -p command failed: ${err.message}${stderr ? `\nStderr: ${stderr}` : ''}`);
      }

      // gemini -o json may include informational text before the JSON block
      const jsonMatch = rawOutput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`gemini -p returned non-JSON output. Output preview: ${rawOutput.slice(0, 200)}`);
      }

      const data = JSON.parse(jsonMatch[0]);
      
      if (data.error) {
        throw new Error(`gemini -p reported an error: ${data.error.message || JSON.stringify(data.error)}`);
      }

      let rawJson = data.response || '';
      
      // Strip <json> tags if present
      rawJson = rawJson.replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();

      // Extract usage if available
      let inputTokens = 0;
      let outputTokens = 0;
      if (data.stats?.models) {
        for (const model of Object.values(data.stats.models) as any[]) {
          inputTokens += model.tokens?.input || 0;
          outputTokens += model.tokens?.candidates || 0;
        }
      }

      return {
        rawJson,
        durationMs: Date.now() - start,
        inputTokens,
        outputTokens,
        model: 'gemini-native',
        provider: 'gemini-native',
      };
    } catch (err: any) {
      if (err.message.includes('usage limit reached')) {
        throw err;
      }
      throw new Error(`Gemini analysis failed: ${err.message}`);
    }
  }
}
