/**
 * ProviderRunner — delegates analysis to the configured LLM provider
 * (OpenAI, Anthropic, Gemini, or Ollama).
 *
 * Design note: The CLI cannot import from @code-insights/server (server depends
 * on CLI — importing in the other direction would create a circular dependency).
 * All LLM providers use only Node.js built-in `fetch` (Node 18+), so this module
 * inlines the minimal provider dispatch that mirrors server/src/llm/client.ts.
 * If the server LLM client grows substantially (new providers, streaming, etc.),
 * that work is tracked in Issue #240.
 */

import { loadConfig } from '../utils/config.js';
import type { LLMProviderConfig, LLMProvider } from '../types.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from './runner-types.js';

/**
 * Mapping from provider ID to its standard API key environment variable.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai:    'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini:    'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral:   'MISTRAL_API_KEY',
};

/**
 * Resolve the API key for a provider.
 *
 * Priority:
 *  1. Environment variable (e.g. OPENAI_API_KEY) — always checked first
 *  2. Previously-stored session key (passed as `storedKey`) — kept in memory only,
 *     never written to disk by saveConfig
 *  3. undefined — ollama does not use API keys
 *
 * @param provider   Provider identifier
 * @param storedKey  Key previously entered in this session (not persisted to disk)
 */
function resolveApiKey(provider: LLMProvider, storedKey?: string): string | undefined {
  if (provider === 'ollama') return undefined;
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }
  return storedKey;
}

// ── Minimal LLM types (mirrors server/src/llm/types.ts) ──────────────────────

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  // Intentionally narrower than server/src/llm/types.ts LLMMessage (which allows ContentBlock[]).
  // ProviderRunner always sends plain strings — prompt caching via ContentBlock[] is a
  // dashboard/API concern. The insights CLI command builds simple system+user pairs.
  content: string;
}

interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
  };
}

type LLMChatFn = (messages: LLMMessage[]) => Promise<LLMResponse>;

// ── Provider implementations ──────────────────────────────────────────────────

function makeOpenAIChat(apiKey: string, model: string): LLMChatFn {
  return async (messages) => {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 8192 }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(err.error?.message || `OpenAI API error (HTTP ${response.status})`);
    }
    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: data.choices[0]?.message?.content || '',
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  };
}

function makeAnthropicChat(apiKey: string, model: string): LLMChatFn {
  return async (messages) => {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: systemMsg?.content,
        messages: chatMsgs.map(m => ({ role: m.role, content: m.content })),
      }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(err.error?.message || `Anthropic API error (HTTP ${response.status})`);
    }
    const data = await response.json() as {
      content: Array<{ text: string }>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
    };
    return {
      content: data.content[0]?.text || '',
      usage: data.usage ? {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
        ...(data.usage.cache_creation_input_tokens !== undefined && {
          cacheCreationTokens: data.usage.cache_creation_input_tokens,
        }),
        ...(data.usage.cache_read_input_tokens !== undefined && {
          cacheReadTokens: data.usage.cache_read_input_tokens,
        }),
      } : undefined,
    };
  };
}

function makeGeminiChat(apiKey: string, model: string): LLMChatFn {
  return async (messages) => {
    const systemMsg = messages.find(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');
    const body: Record<string, unknown> = {
      contents: chatMsgs.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { temperature: 0.7, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    };
    if (systemMsg) {
      body.systemInstruction = { parts: [{ text: systemMsg.content }] };
    }
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: { message?: string } };
      throw new Error(err.error?.message || `Gemini API error (HTTP ${response.status})`);
    }
    const data = await response.json() as {
      candidates: Array<{ content: { parts: Array<{ text: string }> } }>;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    };
    return {
      content: data.candidates[0]?.content?.parts[0]?.text || '',
      usage: data.usageMetadata ? {
        inputTokens: data.usageMetadata.promptTokenCount,
        outputTokens: data.usageMetadata.candidatesTokenCount,
      } : undefined,
    };
  };
}

function makeOllamaChat(model: string, baseUrl?: string): LLMChatFn {
  const url = baseUrl || 'http://localhost:11434';
  return async (messages) => {
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: false, options: { temperature: 0.7 } }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Ollama API error (HTTP ${response.status})${detail ? ` - ${detail}` : ''}`);
    }
    const data = await response.json() as {
      message?: { content: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      content: data.message?.content || '',
      usage: { inputTokens: data.prompt_eval_count || 0, outputTokens: data.eval_count || 0 },
    };
  };
}

function makeOpenRouterChat(apiKey: string, model: string): LLMChatFn {
  return async (messages) => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'http://localhost:7890',
        'X-Title': 'Code Insights',
      },
      body: JSON.stringify({ model, messages, temperature: 0.7 }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { error?: { message?: string; metadata?: { raw?: string } } };
      let detail = err.error?.message || `OpenRouter API error (HTTP ${response.status})`;
      // OpenRouter nests upstream provider errors inside metadata.raw
      if (err.error?.metadata?.raw) {
        try {
          const rawObj = JSON.parse(err.error.metadata.raw);
          if (rawObj.error?.message) {
            detail = rawObj.error.message;
          }
        } catch {
          // falls through to the raw string as-is
        }
      }
      throw new Error(detail);
    }
    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: data.choices[0]?.message?.content || '',
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  };
}

function makeMistralChat(apiKey: string, model: string): LLMChatFn {
  return async (messages) => {
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, temperature: 0.7 }),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(err.message || `Mistral API error (HTTP ${response.status})`);
    }
    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
    return {
      content: data.choices[0]?.message?.content || '',
      usage: data.usage
        ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
        : undefined,
    };
  };
}

function makeChatFn(config: LLMProviderConfig, resolvedApiKey: string | undefined): LLMChatFn {
  switch (config.provider) {
    case 'openai':    return makeOpenAIChat(resolvedApiKey ?? '', config.model);
    case 'anthropic': return makeAnthropicChat(resolvedApiKey ?? '', config.model);
    case 'gemini':    return makeGeminiChat(resolvedApiKey ?? '', config.model);
    case 'ollama':     return makeOllamaChat(config.model, config.baseUrl);
    case 'openrouter': return makeOpenRouterChat(resolvedApiKey ?? '', config.model);
    case 'mistral':    return makeMistralChat(resolvedApiKey ?? '', config.model);
    default:           throw new Error(`Unknown LLM provider: ${(config as LLMProviderConfig).provider}`);
  }
}

// ── ProviderRunner ────────────────────────────────────────────────────────────

export class ProviderRunner implements AnalysisRunner {
  readonly name: string;
  private readonly chat: LLMChatFn;
  private readonly _model: string;
  private readonly _provider: string;

  constructor(config: LLMProviderConfig, resolvedApiKey: string | undefined) {
    this.name = config.provider;
    this._model = config.model;
    this._provider = config.provider;
    this.chat = makeChatFn(config, resolvedApiKey);
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

    const response = await this.chat(messages);

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
