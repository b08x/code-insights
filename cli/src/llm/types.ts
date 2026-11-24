// LLM abstraction types for the server-side LLM engine.
// Provider metadata (PROVIDERS constant) lives in cli/src/constants/llm-providers.ts.
// LLMProvider, LLMProviderConfig, ProviderInfo are imported from CLI types (single source of truth).

export type { LLMProvider, LLMProviderConfig, ProviderInfo, ProviderModelOption } from '../types.js';

/**
 * A structured content block for LLM messages.
 * Used to enable prompt caching (Anthropic ephemeral cache) and structured multi-part messages.
 * The `cache_control` field instructs Anthropic to cache everything up to and including this block.
 */
export interface ContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/**
 * Flatten a ContentBlock array to a plain string by joining all block texts.
 * Used by non-Anthropic providers (OpenAI, Gemini, Ollama) that don't support content blocks natively.
 * If content is already a string, returns it unchanged.
 */
export function flattenContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.map(b => b.text).join('');
}

/**
 * Normalize an OpenAI-compatible `message.content` field (plain string, null, or array of
 * content/thinking chunks as returned by newer Mistral/reasoning models) into a plain string.
 */
export function extractTextContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object') {
        const record = part as { type?: unknown; text?: unknown };
        if (typeof record.text === 'string' && (record.type === undefined || record.type === 'text')) {
          return record.text;
        }
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    /** Anthropic: tokens written to the prompt cache (incurs 25% surcharge). */
    cacheCreationTokens?: number;
    /** Anthropic: tokens read from the prompt cache (90% discount vs normal input). */
    cacheReadTokens?: number;
  };
}

export interface ChatOptions {
  signal?: AbortSignal;
}

export interface LLMClient {
  chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse>;
  estimateTokens(text: string): number;
  readonly provider: string;
  readonly model: string;
}

/**
 * The one request input budget (estimated tokens) shared by the analysis pipeline, the provider
 * runner and Ollama's context window. Leaves room for the response.
 */
export const DEFAULT_MAX_INPUT_TOKENS = 80_000;

/** Tokens reserved for the model's answer on top of the input budget (Ollama num_ctx). */
export const RESPONSE_TOKEN_RESERVE = 8_192;
