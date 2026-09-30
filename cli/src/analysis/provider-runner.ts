/**
 * ProviderRunner — thin AnalysisRunner over the shared LLM transport
 * (cli/src/llm/client.ts: OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Mistral).
 * The server uses the same transport via @code-insights/cli/llm/client.
 */

import { loadConfig } from '../utils/config.js';
import type { LLMProviderConfig } from '../types.js';
import { createProviderClient, resolveApiKey, PROVIDER_API_KEY_ENV } from '../llm/client.js';
import { DEFAULT_MAX_INPUT_TOKENS } from '../llm/types.js';
import type { LLMClient, LLMMessage } from '../llm/types.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';

// ── ProviderRunner ────────────────────────────────────────────────────────────

export class ProviderRunner implements AnalysisRunner {
  readonly name: string;
  readonly provider: string;
  readonly model: string;
  readonly maxInputTokens = DEFAULT_MAX_INPUT_TOKENS;
  /** Prompt-quality calls abort after 2 minutes unless the caller overrides it. */
  readonly timeoutMs = 120_000;
  private readonly client: LLMClient;

  /** `client` lets callers that already hold a client (the server) skip a second construction. */
  constructor(config: LLMProviderConfig, resolvedApiKey: string | undefined, client?: LLMClient) {
    this.name = config.provider;
    this.model = config.model;
    this.provider = config.provider;
    this.client = client ?? createProviderClient(config, resolvedApiKey);
  }

  /** Wrap an existing LLMClient (provider/model are read from the client). */
  static fromClient(client: LLMClient): ProviderRunner {
    return new ProviderRunner(
      { provider: client.provider as LLMProviderConfig['provider'], model: client.model },
      undefined,
      client,
    );
  }

  estimateTokens(text: string): number {
    return this.client.estimateTokens(text);
  }

  /**
   * Create a ProviderRunner from the current CLI config.
   * API key is resolved from environment variables first, then falls back to
   * a session-only key stored in config (never persisted to disk).
   * Throws if LLM is not configured or no API key is available.
   */
  static fromConfig(): ProviderRunner {
    const config = loadConfig();
    const llm = config?.dashboard?.llm;
    if (!llm) {
      throw new Error('LLM not configured. Run `code-insights config llm` to configure a provider.');
    }
    const apiKey = resolveApiKey(llm.provider, llm.apiKey);
    if (llm.provider !== 'ollama' && !apiKey) {
      const envVar = PROVIDER_API_KEY_ENV[llm.provider];
      throw new Error(
        `LLM provider '${llm.provider}' requires an API key. ` +
        (envVar ? `Set the ${envVar} environment variable. ` : '') +
        `Run \`code-insights config llm\` to enter a session-only key.`
      );
    }
    return new ProviderRunner(llm, apiKey);
  }

  async runAnalysis(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const start = Date.now();

    const messages: LLMMessage[] = [
      { role: 'system', content: params.systemPrompt },
      { role: 'user', content: params.userContent ?? params.userPrompt },
    ];

    const response = await this.client.chat(messages, { signal: params.signal });

    return {
      rawJson: response.content,
      durationMs: Date.now() - start,
      inputTokens: response.usage?.inputTokens ?? 0,
      outputTokens: response.usage?.outputTokens ?? 0,
      ...(response.usage?.cacheCreationTokens !== undefined && {
        cacheCreationTokens: response.usage.cacheCreationTokens,
      }),
      ...(response.usage?.cacheReadTokens !== undefined && {
        cacheReadTokens: response.usage.cacheReadTokens,
      }),
      model: this.model,
      provider: this.provider,
    };
  }
}
