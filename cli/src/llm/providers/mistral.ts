// Mistral provider implementation (server-side)

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { flattenContent } from '../types.js';

export function createMistralClient(apiKey: string, model: string): LLMClient {
  return {
    provider: 'mistral',
    model,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        signal: options?.signal,
        body: JSON.stringify({
          model,
          messages: messages.map(m => ({ role: m.role, content: flattenContent(m.content) })),
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({})) as { message?: string };
        const detail = error.message;
        if (response.status === 401 || response.status === 403) {
          throw new Error(`Invalid API key for Mistral.${detail ? ` (${detail})` : ''}`);
        }
        throw new Error(detail || `Mistral API error (HTTP ${response.status})`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
        usage?: { prompt_tokens: number; completion_tokens: number };
      };

      return {
        content: data.choices[0]?.message?.content || '',
        usage: data.usage ? {
          inputTokens: data.usage.prompt_tokens,
          outputTokens: data.usage.completion_tokens,
        } : undefined,
      };
    },

    estimateTokens(text: string): number {
      return Math.ceil(text.length / 4);
    },
  };
}
