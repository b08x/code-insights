// LLM client factory — server-side.
// Config is loaded from ~/.code-insights/config.json via the CLI config system.
// API keys are resolved from environment variables first, then session-only stored keys.
// No localStorage or browser APIs used here.

import { loadConfig } from '@code-insights/cli/utils/config';
import type { LLMClient } from './types.js';
import type { LLMProviderConfig, LLMProvider } from './types.js';
import { createOpenAIClient } from './providers/openai.js';
import { createAnthropicClient } from './providers/anthropic.js';
import { createGeminiClient } from './providers/gemini.js';
import { createOllamaClient } from './providers/ollama.js';
import { createOpenRouterClient } from './providers/openrouter.js';
import { createMistralClient } from './providers/mistral.js';

/**
 * Mapping from provider ID to its standard API key environment variable.
 */
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai:     'OPENAI_API_KEY',
  anthropic:  'ANTHROPIC_API_KEY',
  gemini:     'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral:    'MISTRAL_API_KEY',
};

/**
 * Resolve the API key for a provider.
 *
 * Priority:
 *  1. Environment variable (e.g. OPENAI_API_KEY) — always checked first
 *  2. Previously-stored session key (passed as `storedKey`) — kept in memory only,
 *     never written to disk by saveConfig
 *  3. undefined — ollama does not use API keys
 */
function resolveApiKey(provider: LLMProvider, storedKey?: string): string | undefined {
  if (provider === 'ollama') return undefined;
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar && process.env[envVar]) {
    return process.env[envVar];
  }
  return storedKey;
}

/**
 * Load LLM config from the CLI config file.
 */
export function loadLLMConfig(): LLMProviderConfig | null {
  const config = loadConfig();
  return config?.dashboard?.llm ?? null;
}

/**
 * Check if LLM is configured.
 */
export function isLLMConfigured(): boolean {
  const llm = loadLLMConfig();
  if (!llm) return false;
  if (llm.provider === 'ollama') return !!llm.model;
  return !!resolveApiKey(llm.provider, llm.apiKey) && !!llm.model;
}

/**
 * Create an LLM client from the current config.
 * Throws if LLM is not configured.
 */
export function createLLMClient(): LLMClient {
  const config = loadLLMConfig();
  if (!config) {
    throw new Error('LLM not configured. Run `code-insights config llm` to configure a provider.');
  }
  return createClientFromConfig(config);
}

/**
 * Create an LLM client from a specific config object (used for testing).
 */
export function createClientFromConfig(config: LLMProviderConfig): LLMClient {
  const apiKey = resolveApiKey(config.provider, config.apiKey);
  switch (config.provider) {
    case 'openai':
      return createOpenAIClient(apiKey ?? '', config.model);
    case 'anthropic':
      return createAnthropicClient(apiKey ?? '', config.model);
    case 'gemini':
      return createGeminiClient(apiKey ?? '', config.model);
    case 'ollama':
      return createOllamaClient(config.model, config.baseUrl);
    case 'openrouter':
      return createOpenRouterClient(apiKey ?? '', config.model);
    case 'mistral':
      return createMistralClient(apiKey ?? '', config.model);
    default:
      throw new Error(`Unknown LLM provider: ${config.provider}`);
  }
}

/**
 * Test LLM connectivity with the given config.
 */
export async function testLLMConfig(config: LLMProviderConfig): Promise<{ success: boolean; error?: string }> {
  try {
    const client = createClientFromConfig(config);
    await client.chat([{ role: 'user', content: 'Say "ok" and nothing else.' }]);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
