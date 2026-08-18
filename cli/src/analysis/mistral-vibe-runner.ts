import { execFileSync } from 'child_process';
import { type AnalysisRunner, type RunAnalysisParams, type RunAnalysisResult } from './runner-types.js';
import chalk from 'chalk';

export class MistralVibeRunner implements AnalysisRunner {
  readonly name = 'mistral-vibe-cli';

  /**
   * Validate that the `vibe` CLI is available in PATH.
   */
  static validate(): void {
    try {
      execFileSync('vibe', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error(
        'vibe CLI not found in PATH. Fallback requires Mistral Vibe CLI to be installed.'
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

    const args = [
      '-p',
      '--output', 'json',
      '--trust',
      '--auto-approve'
    ];

    const maxAttempts = 5;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;
      try {
        const rawOutput = execFileSync('vibe', args, {
          input: fullPrompt,
          encoding: 'utf-8',
          timeout: 300_000,    // 5-minute hard limit
          maxBuffer: 30 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'pipe'], // Capture stdout and stderr
        });

        // parse the programmatic JSON output (array of message objects)
        let data: any;
        try {
          data = JSON.parse(rawOutput.trim());
        } catch {
          throw new Error(
            `vibe -p returned non-JSON output. Output preview: ${rawOutput.slice(0, 200)}`
          );
        }

        if (!Array.isArray(data)) {
          throw new Error('vibe -p returned non-array JSON output.');
        }

        const assistantMessage = [...data].reverse().find(msg => msg.role === 'assistant');
        if (!assistantMessage) {
          throw new Error('vibe -p output contained no assistant message.');
        }

        let rawJson = '';
        if (typeof assistantMessage.content === 'string') {
          rawJson = assistantMessage.content;
        } else if (Array.isArray(assistantMessage.content)) {
          // Extract text from parts array if it's structured content
          rawJson = assistantMessage.content
            .filter((p: any) => p.type === 'text' && p.text)
            .map((p: any) => p.text)
            .join('\n');
        } else {
          rawJson = String(assistantMessage.content || '');
        }

        // Strip <json> tags if present
        rawJson = rawJson.replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();

        return {
          rawJson,
          durationMs: Date.now() - start,
          inputTokens: 0,
          outputTokens: 0,
          model: 'mistral-vibe',
          provider: 'mistral-vibe-cli',
        };

      } catch (err: any) {
        const stdout = err.stdout?.toString() || '';
        const stderr = err.stderr?.toString() || '';
        const errorMsg = err.message || '';
        const combinedError = `${errorMsg}\nStdout: ${stdout}\nStderr: ${stderr}`;

        // Check for rate limiting / usage limits
        if (
          combinedError.includes('rateLimitExceeded') ||
          combinedError.includes('RESOURCE_EXHAUSTED') ||
          combinedError.includes('too many requests') ||
          combinedError.includes('limit reached') ||
          err.status === 429
        ) {
          throw new Error('Mistral Vibe usage limit reached (rate limit or capacity).');
        }

        // Check for SSL or connection errors that are transient and should be retried
        const isSslOrConnError = /ssl|cert|handshake|connection|connecterror|unable to get issuer/i.test(combinedError);

        if (isSslOrConnError && attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
          console.warn(
            chalk.yellow(
              `[Code Insights] Mistral Vibe encountered SSL/connection error. Retrying in ${delay}ms... (attempt ${attempt}/${maxAttempts})`
            )
          );
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        // Permanent error or ran out of attempts
        throw new Error(`vibe command failed: ${err.message}${stderr ? `\nStderr: ${stderr}` : ''}`);
      }
    }

    throw new Error(`Mistral Vibe failed after ${maxAttempts} attempts due to persistent SSL/connection errors.`);
  }
}
