/**
 * ProviderRunner — thin AnalysisRunner over the shared LLM transport
 * (cli/src/llm/client.ts: OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Mistral).
 * The server uses the same transport via @code-insights/cli/llm/client.
 */

import { loadConfig } from '../utils/config.js';
import type { LLMProviderConfig } from '../types.js';
import { createProviderClient, resolveApiKey, PROVIDER_API_KEY_ENV } from '../llm/client.js';
import type { LLMClient, LLMMessage } from '../llm/types.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';

// ── ProviderRunner ────────────────────────────────────────────────────────────

export class ProviderRunner implements AnalysisRunner {
  readonly name: string;
  private readonly client: LLMClient;
  private readonly _model: string;
  private readonly _provider: string;

  constructor(config: LLMProviderConfig, resolvedApiKey: string | undefined) {
    this.name = config.provider;
    this._model = config.model;
    this._provider = config.provider;
    this.client = createProviderClient(config, resolvedApiKey);
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
      { role: 'user', content: params.userPrompt },
    ];

    const response = await this.client.chat(messages);

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
      model: this._model,
      provider: this._provider,
    };
  }
}
