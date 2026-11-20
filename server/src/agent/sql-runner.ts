// Non-blocking async runner bridge for the SQL sub-agent.
// Keeps CLI runner invocations off the event loop (spawn + AbortSignal) while reusing
// the pure output parsers from @code-insights/cli.

import { spawn } from 'child_process';
import { writeFile, readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ClaudeInsightConfig, LLMProviderConfig, SqlRunnerName, SqlRunnerSetting } from '@code-insights/cli/types';
import { createProviderClient, resolveApiKey, PROVIDER_API_KEY_ENV } from '@code-insights/cli/llm/client';
import { isSqlRunnerName, isValidRunnerModel, isValidRunnerVariant } from '@code-insights/cli/utils/runner-setting';
import { extractResultFromEnvelope } from '@code-insights/cli/analysis/native-runner';
import { parseOpenCodeEvents } from '@code-insights/cli/analysis/opencode-runner';
import { toStrictOpenAiSchema } from '@code-insights/cli/analysis/openai-schema';
import { extractJsonPayload } from '@code-insights/cli/analysis/response-parsers';

const DEFAULT_CLI_TIMEOUT_MS = 60_000;
const MAX_CLI_BUFFER_BYTES = 10 * 1024 * 1024;

export interface SqlSubAgentBackend {
  readonly label: string;
  generate(params: {
    systemPrompt: string;
    userPrompt: string;
    jsonSchema: object;
    signal?: AbortSignal;
  }): Promise<string>;
}

export interface ExecCliAsyncOptions {
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class CliExecError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
  ) {
    super(message);
    this.name = 'CliExecError';
  }
}

/**
 * Spawn a CLI subprocess asynchronously without shell interpolation, supporting AbortSignal
 * and bounded stdout/stderr buffers so server SSE turns never block the event loop.
 */
export async function execCliAsync(
  cmd: string,
  args: string[],
  opts: ExecCliAsyncOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  if (opts.signal?.aborted) {
    throw new Error('SQL sub-agent aborted');
  }

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

    const killChild = () => {
      try {
        child.kill('SIGTERM');
      } catch {
        return;
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Process already exited.
        }
      }, 2000);
      forceKillTimer.unref();
    };

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAbort = () => {
      aborted = true;
      killChild();
      finishError(new Error('SQL sub-agent aborted'));
    };

    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutMs = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_CLI_BUFFER_BYTES) {
        killChild();
        finishError(new Error(`${cmd} stdout exceeded ${MAX_CLI_BUFFER_BYTES} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_CLI_BUFFER_BYTES) {
        killChild();
        finishError(new Error(`${cmd} stderr exceeded ${MAX_CLI_BUFFER_BYTES} bytes`));
        return;
      }
      stderrChunks.push(chunk);
    });

    child.on('error', (err) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      finishError(new CliExecError(`${cmd} failed to start: ${err.message}`, stdout, stderr, null));
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();

      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      const stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (aborted) {
        reject(new Error('SQL sub-agent aborted'));
        return;
      }
      if (timedOut) {
        reject(new CliExecError(`${cmd} timed out after ${timeoutMs}ms`, stdout, stderr, code));
        return;
      }
      if (code !== 0) {
        reject(new CliExecError(`${cmd} exited with code ${code}${stderr ? `: ${stderr.slice(0, 300)}` : ''}`, stdout, stderr, code));
        return;
      }
      resolve({ stdout, stderr });
    });

    if (child.stdin) {
      child.stdin.on('error', () => {
        // Ignore EPIPE if process exited early before consuming stdin.
      });
      if (opts.input !== undefined) {
        child.stdin.write(opts.input);
      }
      child.stdin.end();
    }
  });
}

function buildCombinedPrompt(systemPrompt: string, userPrompt: string, jsonSchema?: object): string {
  let full = `${systemPrompt}\n\nUSER INSTRUCTIONS:\n${userPrompt}`;
  if (jsonSchema) {
    full += `\n\nSTRICT JSON SCHEMA:\n${JSON.stringify(jsonSchema, null, 2)}`;
  }
  return full;
}

function createApiBackend(
  source: 'provider' | 'agent',
  cfg: LLMProviderConfig,
  apiKey: string | undefined,
): SqlSubAgentBackend {
  const client = createProviderClient(cfg, apiKey);
  return {
    label: `${source} (${cfg.provider}/${cfg.model})`,
    async generate({ systemPrompt, userPrompt, signal }) {
      const response = await client.chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        { signal },
      );
      return response.content;
    },
  };
}

function createClaudeCliBackend(model?: string, variant?: string): SqlSubAgentBackend {
  return {
    label: model ? `claude (${model})` : 'claude (default)',
    async generate({ systemPrompt, userPrompt, jsonSchema, signal }) {
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const promptFile = join(tmpdir(), `ci-sql-prompt-${fileId}.txt`);
      const schemaFile = join(tmpdir(), `ci-sql-schema-${fileId}.json`);
      await writeFile(promptFile, systemPrompt, 'utf8');
      await writeFile(schemaFile, JSON.stringify(jsonSchema), 'utf8');

      try {
        const args = [
          '-p',
          '--output-format', 'json',
          '--append-system-prompt-file', promptFile,
          '--no-session-persistence',
          '--disable-slash-commands',
          '--tools', '""',
          '--json-schema', schemaFile,
        ];
        if (model) args.push('--model', model);
        if (variant) args.push('--effort', variant);

        try {
          const { stdout } = await execCliAsync('claude', args, { input: userPrompt, signal });
          return extractResultFromEnvelope(stdout);
        } catch (err) {
          if (err instanceof CliExecError && err.stdout) {
            return extractResultFromEnvelope(err.stdout);
          }
          throw err;
        }
      } finally {
        await unlink(promptFile).catch(() => {});
        await unlink(schemaFile).catch(() => {});
      }
    },
  };
}

function createCodexCliBackend(model?: string, variant?: string): SqlSubAgentBackend {
  return {
    label: model ? `codex (${model})` : 'codex (default)',
    async generate({ systemPrompt, userPrompt, jsonSchema, signal }) {
      const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const outputFile = join(tmpdir(), `codex-sql-out-${fileId}.txt`);
      const schemaFile = join(tmpdir(), `codex-sql-schema-${fileId}.json`);
      await writeFile(schemaFile, JSON.stringify(toStrictOpenAiSchema(jsonSchema)), 'utf8');

      try {
        const args = [
          'exec',
          '--ephemeral',
          '--sandbox', 'read-only',
          '--skip-git-repo-check',
          '--output-last-message', outputFile,
          '--output-schema', schemaFile,
        ];
        if (model) args.push('-m', model);
        if (variant) args.push('-c', `model_reasoning_effort="${variant}"`);

        const fullPrompt = `${systemPrompt}\n\nUSER INSTRUCTIONS:\n${userPrompt}`;
        await execCliAsync('codex', args, { input: fullPrompt, signal });
        const raw = await readFile(outputFile, 'utf8');
        return raw.trim().replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();
      } finally {
        await unlink(outputFile).catch(() => {});
        await unlink(schemaFile).catch(() => {});
      }
    },
  };
}

function createOpenCodeCliBackend(model?: string, variant?: string): SqlSubAgentBackend {
  return {
    label: model ? `opencode (${model})` : 'opencode (default)',
    async generate({ systemPrompt, userPrompt, jsonSchema, signal }) {
      const args = ['run', '--format', 'json'];
      if (model) args.push('-m', model);
      if (variant) args.push('--variant', variant);

      const fullPrompt = buildCombinedPrompt(systemPrompt, userPrompt, jsonSchema);
      const { stdout } = await execCliAsync('opencode', args, {
        input: fullPrompt,
        cwd: tmpdir(),
        signal,
      });
      return parseOpenCodeEvents(stdout).text;
    },
  };
}

function createVibeCliBackend(model?: string): SqlSubAgentBackend {
  return {
    label: model ? `vibe (${model})` : 'vibe (default)',
    async generate({ systemPrompt, userPrompt, jsonSchema, signal }) {
      const args = ['-p', '--output', 'json', '--trust', '--auto-approve'];
      const fullPrompt = buildCombinedPrompt(systemPrompt, userPrompt, jsonSchema);
      const env = model ? { ...process.env, VIBE_ACTIVE_MODEL: model } : undefined;

      const { stdout } = await execCliAsync('vibe', args, {
        input: fullPrompt,
        env,
        signal,
      });

      const data = JSON.parse(stdout.trim());
      if (!Array.isArray(data)) {
        throw new Error('vibe -p returned non-array JSON output');
      }
      const assistantMsg = [...data].reverse().find((m: any) => m?.role === 'assistant');
      if (!assistantMsg) {
        throw new Error('vibe -p output contained no assistant message');
      }

      let raw = '';
      if (typeof assistantMsg.content === 'string') {
        raw = assistantMsg.content;
      } else if (Array.isArray(assistantMsg.content)) {
        raw = assistantMsg.content
          .filter((p: any) => p?.type === 'text' && p?.text)
          .map((p: any) => p.text)
          .join('\n');
      }
      return raw.replace(/^<json>\n?/, '').replace(/\n?<\/json>$/, '').trim();
    },
  };
}

function createAntigravityCliBackend(model?: string): SqlSubAgentBackend {
  return {
    label: model ? `antigravity (${model})` : 'antigravity (default)',
    async generate({ systemPrompt, userPrompt, jsonSchema, signal }) {
      const fullPrompt = buildCombinedPrompt(systemPrompt, userPrompt, jsonSchema);
      const args = ['-p', fullPrompt, '--dangerously-skip-permissions'];
      if (model) args.push('--model', model);

      const { stdout } = await execCliAsync('agy', args, {
        cwd: tmpdir(),
        signal,
      });
      return extractJsonPayload(stdout) || stdout.trim();
    },
  };
}

function resolveProviderConfig(
  source: 'provider' | 'agent',
  config: ClaudeInsightConfig | null | undefined,
): { backend: SqlSubAgentBackend } | { error: string } {
  const agent = config?.dashboard?.agent;
  const agentLlm = agent?.provider && agent?.model
    ? (agent as LLMProviderConfig)
    : undefined;
  const cfg = source === 'provider'
    ? config?.dashboard?.llm
    : (agentLlm ?? config?.dashboard?.llm);

  if (!cfg?.provider || !cfg?.model) {
    return {
      error: source === 'provider'
        ? 'Background Analysis Provider is not configured.'
        : 'Interactive Knowledge Agent LLM is not configured.',
    };
  }

  const apiKey = resolveApiKey(cfg.provider, cfg.apiKey);
  if (cfg.provider !== 'ollama' && !apiKey) {
    const envVar = PROVIDER_API_KEY_ENV[cfg.provider];
    return {
      error: `LLM provider '${cfg.provider}' requires an API key${envVar ? ` (${envVar})` : ''}.`,
    };
  }

  return { backend: createApiBackend(source, cfg, apiKey) };
}

function buildSqlBackend(
  name: SqlRunnerName,
  setting: Partial<SqlRunnerSetting>,
  config: ClaudeInsightConfig | null | undefined,
): { backend: SqlSubAgentBackend } | { error: string } {
  if (name === 'provider') return resolveProviderConfig('provider', config);
  if (name === 'agent') return resolveProviderConfig('agent', config);

  const rawModel = typeof setting.model === 'string' ? setting.model.trim() : undefined;
  const rawVariant = typeof setting.variant === 'string' ? setting.variant.trim() : undefined;
  const model = isValidRunnerModel(rawModel) ? rawModel : undefined;
  const variant = isValidRunnerVariant(rawVariant) ? rawVariant : undefined;

  switch (name) {
    case 'claude':
      return { backend: createClaudeCliBackend(model, variant) };
    case 'codex':
      return { backend: createCodexCliBackend(model, variant) };
    case 'opencode':
      return { backend: createOpenCodeCliBackend(model, variant) };
    case 'vibe':
      return { backend: createVibeCliBackend(model) };
    case 'antigravity':
      return { backend: createAntigravityCliBackend(model) };
  }
}

/**
 * Resolve the SQL sub-agent backend.
 * Uses explicit `dashboard.agent.sqlRunner` when set; otherwise defaults to
 * `provider` (dashboard.llm) -> `agent` (dashboard.agent) for fast interactive latency.
 */
export function resolveSqlRunner(
  config: ClaudeInsightConfig | null | undefined,
): { backend: SqlSubAgentBackend } | { error: string } {
  const configured = config?.dashboard?.agent?.sqlRunner;
  if (configured && isSqlRunnerName(configured.name)) {
    return buildSqlBackend(configured.name, configured, config);
  }

  const fromProvider = resolveProviderConfig('provider', config);
  if ('backend' in fromProvider) return fromProvider;

  const fromAgent = resolveProviderConfig('agent', config);
  if ('backend' in fromAgent) return fromAgent;

  return {
    error: 'No SQL sub-agent runner available. Configure an LLM provider or select a SQL runner in Settings.',
  };
}
