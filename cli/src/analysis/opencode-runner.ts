/**
 * OpenCodeRunner — executes analysis via `opencode run --format json`.
 *
 * The composed system+user prompt is piped on stdin (opencode appends piped stdin to the message),
 * because session prompts routinely exceed the ~128 KB single-argv limit on Linux.
 * `--format json` emits NDJSON events; the answer is the concatenated `text` parts of the last
 * assistant message. OpenCode has no schema-enforcement flag, so the schema is injected into the
 * prompt (same approach as the agy and vibe runners) and validity is left to response-parsers.
 *
 * Limitation: opencode runs its own agent (system prompt, tools), so input token counts include
 * that overhead. Tokens are taken from `step_finish` events; cost is reported as 0 (subscription
 * or free-tier billing is opaque to us).
 */

import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult, RunnerConfig } from './runner-types.js';

interface OpenCodeEvent {
  type?: string;
  part?: {
    messageID?: string;
    type?: string;
    text?: string;
    tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
  };
  error?: { name?: string; data?: { message?: string } };
}

export interface OpenCodeParsed {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** Parse `opencode run --format json` NDJSON stdout into the final assistant text + token usage. */
export function parseOpenCodeEvents(stdout: string): OpenCodeParsed {
  const textByMessage = new Map<string, string[]>();
  const order: string[] = [];
  const usage = { input: 0, output: 0, read: 0, write: 0 };

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let ev: OpenCodeEvent;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      continue; // tolerate interleaved non-JSON log lines
    }
    if (ev.type === 'error') {
      const msg = ev.error?.data?.message ?? ev.error?.name ?? 'unknown error';
      throw new Error(`opencode reported an error: ${msg}`);
    }
    if (ev.type === 'text' && ev.part?.type === 'text' && typeof ev.part.text === 'string') {
      const id = ev.part.messageID ?? '';
      if (!textByMessage.has(id)) {
        textByMessage.set(id, []);
        order.push(id);
      }
      textByMessage.get(id)!.push(ev.part.text);
    } else if (ev.type === 'step_finish' && ev.part?.tokens) {
      const t = ev.part.tokens;
      usage.input += t.input ?? 0;
      usage.output += t.output ?? 0;
      usage.read += t.cache?.read ?? 0;
      usage.write += t.cache?.write ?? 0;
    }
  }

  if (order.length === 0) {
    throw new Error(`opencode output contained no assistant text. Output preview: ${stdout.slice(0, 200)}`);
  }
  // Earlier messages are tool-use narration; only the final assistant message is the answer.
  const text = textByMessage.get(order[order.length - 1])!.join('').trim()
    .replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();
  return {
    text,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.read,
    cacheCreationTokens: usage.write,
  };
}

export class OpenCodeRunner implements AnalysisRunner {
  readonly name = 'opencode';
  readonly model: string;
  readonly variant?: string;

  /** @param config.model `provider/model` as accepted by `opencode -m`; omitted = opencode default. */
  constructor(private readonly config: RunnerConfig = {}) {
    this.model = config.model || 'opencode-default';
    this.variant = config.variant || undefined;
  }

  static validate(): void {
    try {
      execFileSync('opencode', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error('opencode CLI not found in PATH. Install it from: https://opencode.ai');
    }
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();

    let fullPrompt = `${params.systemPrompt}\n\nUSER INSTRUCTIONS:\n${params.userPrompt}`;
    if (params.jsonSchema) {
      fullPrompt += `\n\nSTRICT JSON SCHEMA:\n${JSON.stringify(params.jsonSchema, null, 2)}`;
    }

    const args = ['run', '--format', 'json'];
    if (this.config.model) args.push('-m', this.config.model);
    if (this.config.variant) args.push('--variant', this.config.variant);

    let stdout: string;
    try {
      stdout = execFileSync('opencode', args, {
        input: fullPrompt,
        encoding: 'utf-8',
        timeout: 300_000,
        maxBuffer: 30 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: tmpdir(), // keep opencode from picking up project context/AGENTS.md
      });
    } catch (err: any) {
      const stderr = err.stderr?.toString() || '';
      const out = err.stdout?.toString() || '';
      if (/rate.?limit|RESOURCE_EXHAUSTED|429/i.test(`${stderr}\n${out}`)) {
        throw new Error('OpenCode usage limit reached (rate limit or capacity).');
      }
      throw new Error(`opencode run failed: ${err.message}${stderr ? `\nStderr: ${stderr}` : ''}`);
    }

    const parsed = parseOpenCodeEvents(stdout);
    return {
      rawJson: parsed.text,
      durationMs: Date.now() - start,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      cacheReadTokens: parsed.cacheReadTokens,
      cacheCreationTokens: parsed.cacheCreationTokens,
      model: this.model,
      provider: 'opencode',
    };
  }
}
