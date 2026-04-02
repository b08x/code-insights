import { discoverOllamaModels } from './providers/ollama.js';
import type { LLMProvider } from '@code-insights/cli/types';

export interface DiscoveredModel {
  id: string;
  name: string;
}

export async function discoverModels(provider: LLMProvider, apiKey?: string, baseUrl?: string): Promise<DiscoveredModel[]> {
  if (provider === 'ollama') {
    const models = await discoverOllamaModels(baseUrl);
    return models.map(m => ({ id: m.name, name: m.name }));
  }

  if (!apiKey) {
    throw new Error('API key is required to fetch models for this provider.');
  }

  switch (provider) {
    case 'openai': {
      const res = await fetch('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('Failed to fetch OpenAI models');
      const data = await res.json() as any;
      return (data.data || []).map((m: any) => ({ id: m.id, name: m.id }));
    }
    case 'anthropic': {
      const res = await fetch('https://api.anthropic.com/v1/models', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      });
      if (!res.ok) throw new Error('Failed to fetch Anthropic models');
      const data = await res.json() as any;
      return (data.data || []).map((m: any) => ({ id: m.id, name: m.display_name || m.name || m.id }));
    }
    case 'gemini': {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
      if (!res.ok) throw new Error('Failed to fetch Gemini models');
      const data = await res.json() as any;
      return (data.models || [])
        .filter((m: any) => m.name.startsWith('models/'))
        .map((m: any) => ({ id: m.name.replace('models/', ''), name: m.displayName || m.name.replace('models/', '') }));
    }
    case 'openrouter': {
      const res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('Failed to fetch OpenRouter models');
      const data = await res.json() as any;
      return (data.data || []).map((m: any) => ({ id: m.id, name: m.name || m.id }));
    }
    case 'mistral': {
      const res = await fetch('https://api.mistral.ai/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) throw new Error('Failed to fetch Mistral models');
      const data = await res.json() as any;
      return (data.data || []).map((m: any) => ({ id: m.id, name: m.id }));
    }
    default:
      return [];
  }
}
