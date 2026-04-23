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

// `claude -p --output-format json` returns a JSON array of typed event objects.
// We care only about the final result event.
interface ClaudeEvent {
  type: string;
  subtype?: string;
}

interface ClaudeResultEvent extends ClaudeEvent {
  type: 'result';
  subtype: 'success' | 'error_max_turns' | 'error_during_execution';
  result: string;
  is_error: boolean;
}

function isResultEvent(e: ClaudeEvent): e is ClaudeResultEvent {
  return e.type === 'result';
}

/**
 * Extract the LLM text payload from a `claude -p --output-format json` response.
 *
 * Depending on the version and flags, Claude Code may return:
 * 1. An array of event objects (streaming style)
 * 2. A single result object (simple style)
 */
function extractResultFromEnvelope(rawOutput: string): string {
  let data: any;
  try {
    data = JSON.parse(rawOutput);
  } catch {
    throw new Error(
      `claude -p returned non-JSON output. Output preview: ${rawOutput.slice(0, 200)}`
    );
  }

  let result: string | undefined;
  let isError = false;

  if (Array.isArray(data)) {
    // Format 1: Array of events
    const resultEvent = data.find((e: any) => e.type === 'result');
    if (!resultEvent) {
      throw new Error('claude -p output contained no result event.');
    }
    result = resultEvent.result;
    isError = !!resultEvent.is_error;
  } else if (data && typeof data === 'object') {
    // Format 2: Single result object
    if (data.type === 'result') {
      result = data.result;
      isError = !!data.is_error;
    }
  }

  if (result === undefined) {
    throw new Error('Could not extract result from claude -p output.');
  }

  if (isError) {
    if (result.includes("You've hit your limit")) {
      throw new Error(`Claude Code usage limit reached. ${result}`);
    }
    throw new Error(`claude -p reported an error: ${result}`);
  }

  // Claude Code often wraps JSON results in <json>...</json> tags.
  // We strip these to ensure the caller gets clean JSON.
  return result.replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();
}

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
    // Include a random suffix to avoid collisions if two analyses run concurrently.
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write system prompt to a temp file — claude -p reads it via --append-system-prompt-file.
    // Temp file avoids command-line length limits and shell escaping issues.
    const promptFile = join(tmpdir(), `ci-prompt-${fileId}.txt`);
    writeFileSync(promptFile, params.systemPrompt, 'utf-8');

    let schemaFile: string | undefined;
    if (params.jsonSchema) {
      schemaFile = join(tmpdir(), `ci-schema-${fileId}.json`);
      writeFileSync(schemaFile, JSON.stringify(params.jsonSchema), 'utf-8');
    }

    try {
      const args = [
        '-p',
        '--output-format', 'json',
        '--append-system-prompt-file', promptFile,
        '--no-session-persistence',
        '--disable-slash-commands',
        '--tools', '""',
      ];
      if (schemaFile) {
        args.push('--json-schema', schemaFile);
      }

      let rawOutput: string;
      try {
        rawOutput = execFileSync('claude', args, {
          input: params.userPrompt,
          encoding: 'utf-8',
          timeout: 300_000,    // 5-minute hard limit per analysis call
          maxBuffer: 30 * 1024 * 1024,  // 30 MB
          stdio: ['pipe', 'pipe', 'pipe'], // Capture stdout/stderr separately
        });
      } catch (err: any) {
        // If execFileSync fails, stdout might still contain the JSON error envelope.
        if (err.stdout) {
          try {
            return {
              rawJson: extractResultFromEnvelope(err.stdout.toString()),
              durationMs: Date.now() - start,
              inputTokens: 0,
              outputTokens: 0,
              model: 'claude-native',
              provider: 'claude-code-native',
            };
          } catch (innerErr: any) {
            throw new Error(`claude -p failed: ${innerErr.message}`);
          }
        }
        
        const stderr = err.stderr?.toString() || '';
        if (stderr.includes('Not logged in')) {
          throw new Error('Claude Code is not logged in. Run `claude login`.');
        }
        throw new Error(`claude -p command failed: ${err.message}${stderr ? `\nStderr: ${stderr}` : ''}`);
      }

      // Extract the actual LLM text from the result field.
      const rawJson = extractResultFromEnvelope(rawOutput);

      return {
        rawJson,
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
