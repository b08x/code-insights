// OpenRouter provider implementation (server-side)

import type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '../types.js';
import { flattenContent } from '../types.js';

export function createOpenRouterClient(apiKey: string, model: string): LLMClient {
  return {
    provider: 'openrouter',
    model,

    async chat(messages: LLMMessage[], options?: ChatOptions): Promise<LLMResponse> {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'http://localhost:7890',
          'X-Title': 'Code Insights',
        },
        signal: options?.signal,
        body: JSON.stringify({
          model,
          messages: messages.map(m => ({ role: m.role, content: flattenContent(m.content) })),
          temperature: 0.7,
        }),
      });

      if (!response.ok) {
        let detail = '';
        const errorData = await response.json().catch(() => ({})) as any;
        
        if (errorData?.error) {
          detail = errorData.error.message || '';
          
          // OpenRouter nests upstream provider errors inside metadata.raw
          if (errorData.error.metadata?.raw) {
            try {
              const rawObj = JSON.parse(errorData.error.metadata.raw);
              if (rawObj.error?.message) {
                detail = rawObj.error.message;
              } else if (typeof rawObj.error === 'string') {
                detail = rawObj.error;
              } else {
                detail = errorData.error.metadata.raw;
              }
            } catch {
              detail = errorData.error.metadata.raw;
            }
          }
        }

        if (response.status === 401 || response.status === 403) {
          throw new Error(`Invalid API key for OpenRouter.${detail ? ` (${detail})` : ''}`);
        }
        if (response.status === 402) {
          throw new Error(`Insufficient OpenRouter credits.${detail ? ` (${detail})` : ''}`);
        }
        if (detail === 'Provider returned error') {
            throw new Error(`Upstream provider error. Ensure you have access to the selected model and sufficient credits.`);
        }
        throw new Error(detail || `OpenRouter API error (HTTP ${response.status})`);
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
