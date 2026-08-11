import { Hono } from 'hono';
import { loadConfig, saveConfig } from '@code-insights/cli/utils/config';
import type { ClaudeInsightConfig, LLMProviderConfig } from '@code-insights/cli/types';
import { loadLLMConfig, testLLMConfig } from '../llm/client.js';
import { discoverOllamaModels } from '../llm/providers/ollama.js';
import { discoverModels } from '../llm/discover.js';

const app = new Hono();

const VALID_PROVIDERS = ['openai', 'anthropic', 'gemini', 'ollama', 'openrouter', 'mistral'] as const;

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai:     'OPENAI_API_KEY',
  anthropic:  'ANTHROPIC_API_KEY',
  gemini:     'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral:    'MISTRAL_API_KEY',
};

function maskApiKey(key: string | undefined): string | undefined {
  if (!key || key.length < 8) return key ? '***' : undefined;
  return key.slice(0, 4) + '...' + key.slice(-4);
}

/**
 * Describe the API key source for a provider.
 */
function describeApiKeySource(provider: string, storedKey?: string): 'env' | 'stored' | 'none' {
  const envVar = PROVIDER_API_KEY_ENV[provider];
  if (envVar && process.env[envVar]) return 'env';
  if (storedKey) return 'stored';
  return 'none';
}

// GET /api/config/llm — return full config (API key masked)
app.get('/llm', (c) => {
  const config = loadConfig();
  const llm = config?.dashboard?.llm;
  const agent = config?.dashboard?.agent;
  const embedding = config?.dashboard?.embedding;

  return c.json({
    dashboardPort: config?.dashboard?.port ?? 7890,
    provider: llm?.provider,
    model: llm?.model,
    apiKey: maskApiKey(llm?.apiKey),
    apiKeySource: llm ? describeApiKeySource(llm.provider, llm.apiKey) : 'none',
    baseUrl: llm?.baseUrl,
    agent: agent ? {
      provider: agent.provider,
      model: agent.model,
      apiKey: maskApiKey(agent.apiKey),
      baseUrl: agent.baseUrl,
    } : undefined,
    embedding: embedding ? {
      provider: embedding.provider,
      model: embedding.model,
      apiKey: maskApiKey(embedding.apiKey),
      baseUrl: embedding.baseUrl,
    } : undefined,
  });
});

// PUT /api/config/llm — update dashboard port and/or configs
app.put('/llm', async (c) => {
  const body = await c.req.json<{
    dashboardPort?: number;
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
    agent?: Partial<LLMProviderConfig>;
    embedding?: Partial<LLMProviderConfig>;
  }>();

  const config: ClaudeInsightConfig = loadConfig() ?? {
    sync: { claudeDir: '', excludeProjects: [] },
  };

  let changed = false;

  // Update dashboard port if provided
  if (body.dashboardPort !== undefined) {
    const port = body.dashboardPort;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
      return c.json({ error: 'dashboardPort must be an integer between 1 and 65535' }, 400);
    }
    config.dashboard = { ...config.dashboard, port };
    changed = true;
  }

  // Update background analysis LLM config if fields are provided
  const hasLLMField = body.provider !== undefined || body.model !== undefined ||
    body.apiKey !== undefined || body.baseUrl !== undefined;

  if (hasLLMField) {
    if (body.provider !== undefined && !VALID_PROVIDERS.includes(body.provider as typeof VALID_PROVIDERS[number])) {
      return c.json({ error: `provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, 400);
    }

    const existingLlm = config.dashboard?.llm ?? {} as Partial<LLMProviderConfig>;

    const updatedLlm: LLMProviderConfig = {
      provider: (body.provider as LLMProviderConfig['provider']) ?? existingLlm.provider ?? 'ollama',
      model: body.model ?? existingLlm.model ?? '',
      ...(body.apiKey !== undefined
        ? { apiKey: body.apiKey || undefined }
        : existingLlm.apiKey !== undefined ? { apiKey: existingLlm.apiKey } : {}),
      ...(body.baseUrl !== undefined
        ? { baseUrl: body.baseUrl || undefined }
        : existingLlm.baseUrl !== undefined ? { baseUrl: existingLlm.baseUrl } : {}),
    };

    if (!updatedLlm.model) {
      return c.json({ error: 'model is required when setting LLM config' }, 400);
    }

    config.dashboard = { ...config.dashboard, llm: updatedLlm };
    changed = true;
  }

  // Update agent config
  if (body.agent !== undefined) {
    if (body.agent.provider && !VALID_PROVIDERS.includes(body.agent.provider as typeof VALID_PROVIDERS[number])) {
      return c.json({ error: `agent provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, 400);
    }
    const existingAgent = config.dashboard?.agent ?? {} as Partial<LLMProviderConfig>;
    
    // Check if we are clearing the agent config
    if (body.agent.provider === undefined && body.agent.model === undefined && body.agent.apiKey === undefined && body.agent.baseUrl === undefined && Object.keys(body.agent).length > 0) {
        // Just clearing specific fields, handled below
    }

    if (Object.keys(body.agent).length === 0) {
        config.dashboard = { ...config.dashboard, agent: undefined };
    } else {
        const updatedAgent: LLMProviderConfig = {
            provider: body.agent.provider ?? existingAgent.provider ?? 'openai',
            model: body.agent.model ?? existingAgent.model ?? '',
            ...(body.agent.apiKey !== undefined
              ? { apiKey: body.agent.apiKey || undefined }
              : existingAgent.apiKey !== undefined ? { apiKey: existingAgent.apiKey } : {}),
            ...(body.agent.baseUrl !== undefined
              ? { baseUrl: body.agent.baseUrl || undefined }
              : existingAgent.baseUrl !== undefined ? { baseUrl: existingAgent.baseUrl } : {}),
        };
        config.dashboard = { ...config.dashboard, agent: updatedAgent };
    }
    changed = true;
  }

  // Update embedding config
  if (body.embedding !== undefined) {
    if (body.embedding.provider && !VALID_PROVIDERS.includes(body.embedding.provider as typeof VALID_PROVIDERS[number])) {
      return c.json({ error: `embedding provider must be one of: ${VALID_PROVIDERS.join(', ')}` }, 400);
    }
    const existingEmbedding = config.dashboard?.embedding ?? {} as Partial<LLMProviderConfig>;

    if (Object.keys(body.embedding).length === 0) {
        config.dashboard = { ...config.dashboard, embedding: undefined };
    } else {
        const updatedEmbedding: LLMProviderConfig = {
            provider: body.embedding.provider ?? existingEmbedding.provider ?? 'ollama',
            model: body.embedding.model ?? existingEmbedding.model ?? '',
            ...(body.embedding.apiKey !== undefined
              ? { apiKey: body.embedding.apiKey || undefined }
              : existingEmbedding.apiKey !== undefined ? { apiKey: existingEmbedding.apiKey } : {}),
            ...(body.embedding.baseUrl !== undefined
              ? { baseUrl: body.embedding.baseUrl || undefined }
              : existingEmbedding.baseUrl !== undefined ? { baseUrl: existingEmbedding.baseUrl } : {}),
        };
        config.dashboard = { ...config.dashboard, embedding: updatedEmbedding };
    }
    changed = true;
  }

  if (!changed) {
    return c.json({ ok: true });
  }

  saveConfig(config);
  return c.json({ ok: true });
});

// POST /api/config/llm/test — validate LLM credentials with a test call
app.post('/llm/test', async (c) => {
  // Allow testing with body config or existing saved config
  let testConfig: LLMProviderConfig | null = null;
  let isEmbedding = false;

  try {
    const body = await c.req.json<Partial<LLMProviderConfig> & { isEmbedding?: boolean }>();
    isEmbedding = !!body.isEmbedding;
    if (body.provider && body.model) {
      testConfig = {
        provider: body.provider as any,
        model: body.model,
        ...(body.apiKey ? { apiKey: body.apiKey } : {}),
        ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
      };
    }
  } catch {
    // No body or invalid JSON — use existing config
  }

  if (!testConfig) {
    testConfig = loadLLMConfig();
  }

  if (!testConfig) {
    return c.json({
      success: false,
      error: 'No LLM config found. Provide config in request body.',
    }, 400);
  }

  if (isEmbedding) {
    try {
      const { ai } = await import('@ax-llm/ax');
      const isOllama = testConfig.provider === 'ollama';
      
      let axProviderName = testConfig.provider as string;
      if (testConfig.provider === 'gemini') axProviderName = 'google-gemini';
      if (testConfig.provider === 'ollama' || testConfig.provider === 'openrouter') axProviderName = 'openai';

      const aiOptions: any = { name: axProviderName };
      if (testConfig.apiKey) aiOptions.apiKey = testConfig.apiKey;
      // Provide a dummy key if none is set to prevent instantiation errors on some providers
      if (!testConfig.apiKey && isOllama) aiOptions.apiKey = 'ollama';
      else if (!testConfig.apiKey) aiOptions.apiKey = 'dummy';
      
      aiOptions.config = { model: testConfig.model, embedModel: testConfig.model };
      if (testConfig.baseUrl) {
        // Strip trailing slash before checking/appending
        const cleanUrl = testConfig.baseUrl.replace(/\/+$/, '');
        aiOptions.apiURL = isOllama 
          ? (cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`)
          : cleanUrl;
      } else if (isOllama) {
        aiOptions.apiURL = 'http://localhost:11434/v1';
      } else if (testConfig.provider === 'openrouter') {
        aiOptions.apiURL = 'https://openrouter.ai/api/v1';
      }

      const llm = ai(aiOptions);
      await llm.embed({ texts: ['test'] });
      return c.json({ success: true }, 200);
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown embedding error',
      }, 422);
    }
  }

  const result = await testLLMConfig(testConfig);
  return c.json(result, result.success ? 200 : 422);
});

// GET /api/config/llm/ollama-models — return locally available Ollama models
app.get('/llm/ollama-models', async (c) => {
  const baseUrl = c.req.query('baseUrl');
  const models = await discoverOllamaModels(baseUrl);
  return c.json({ models });
});

// POST /api/config/llm/models — discover models for a provider using an API key
app.post('/llm/models', async (c) => {
  const body = await c.req.json<{ provider: string, apiKey?: string, baseUrl?: string }>();

  if (!body.provider) {
    return c.json({ error: 'provider is required' }, 400);
  }

  // Resolve API key: body.apiKey > env var > saved config (for this provider only)
  let apiKey: string | undefined;
  if (body.apiKey) {
    apiKey = body.apiKey;
  } else {
    const envVar = PROVIDER_API_KEY_ENV[body.provider];
    if (envVar && process.env[envVar]) {
      apiKey = process.env[envVar];
    } else {
      const savedConfig = loadLLMConfig();
      if (savedConfig?.provider === body.provider) {
        apiKey = savedConfig?.apiKey;
      }
    }
  }

  try {
    const models = await discoverModels(body.provider as any, apiKey, body.baseUrl);
    return c.json({ models });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Failed to fetch models' }, 500);
  }
});

export default app;
