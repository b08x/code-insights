import { useState, useEffect } from 'react';
import { toast } from 'sonner';
import { fetchLlmModels, fetchOllamaModels, testLlmConfig } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';

export type LLMProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'openrouter' | 'mistral';

export interface ProviderInfo {
  id: LLMProvider;
  name: string;
  requiresApiKey: boolean;
  apiKeyLink?: string;
  models: Array<{ id: string; name: string; description?: string }>;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    requiresApiKey: true,
    apiKeyLink: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', description: 'Best' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: 'Fast & cheap' },
    ],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    requiresApiKey: true,
    apiKeyLink: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet', description: 'Most capable' },
      { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', description: 'Fast & cheap' },
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    requiresApiKey: true,
    apiKeyLink: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', description: 'Fast' },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', description: 'Capable' },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    requiresApiKey: false,
    models: [
      { id: 'llama3.3', name: 'Llama 3.3' },
      { id: 'qwen3:14b', name: 'Qwen3 14B' },
      { id: 'mistral', name: 'Mistral' },
      { id: 'qwen2.5-coder', name: 'Qwen 2.5 Coder' },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    requiresApiKey: true,
    apiKeyLink: 'https://openrouter.ai/settings/keys',
    models: [
      { id: 'openrouter/auto', name: 'OpenRouter Auto (Default)' },
      { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet' },
      { id: 'openai/gpt-4o', name: 'GPT-4o' },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B' },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    requiresApiKey: true,
    apiKeyLink: 'https://console.mistral.ai/api-keys/',
    models: [
      { id: 'mistral-large-latest', name: 'Mistral Large' },
      { id: 'mistral-small-latest', name: 'Mistral Small' },
      { id: 'codestral-latest', name: 'Codestral' },
    ],
  },
];

interface LlmProviderCardProps {
  title: string;
  description: string;
  icon: React.ReactNode;
  isEmbedding?: boolean;
  config?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    baseUrl?: string;
  };
  onSave: (config: { provider: string; model: string; apiKey?: string; baseUrl?: string }) => Promise<void>;
  onClear?: () => Promise<void>;
}

export function LlmProviderCard({ title, description, icon, isEmbedding, config, onSave, onClear }: LlmProviderCardProps) {
  const [llmProvider, setLlmProvider] = useState<LLMProvider>('openai');
  const [llmModel, setLlmModel] = useState('');
  const [customModel, setCustomModel] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [llmConfigured, setLlmConfigured] = useState(false);
  const [llmTesting, setLlmTesting] = useState(false);
  const [llmTestError, setLlmTestError] = useState<string | null>(null);
  const [ollamaDiscoveredModels, setOllamaDiscoveredModels] = useState<string[]>([]);
  const [cloudDiscoveredModels, setCloudDiscoveredModels] = useState<Array<{ id: string; name: string }>>([]);
  const [ollamaCorsOpen, setOllamaCorsOpen] = useState(false);

  // Initialize from props config
  useEffect(() => {
    if (config?.provider) {
      setLlmProvider(config.provider as LLMProvider);
      setLlmConfigured(true);
    }
    if (config?.model) {
      const providerInfo = PROVIDERS.find((p) => p.id === (config.provider ?? llmProvider));
      const isPreset = providerInfo?.models.some((m) => m.id === config.model);
      if (isPreset) {
        setLlmModel(config.model);
        setCustomModel('');
      } else {
        setCustomModel(config.model);
        setLlmModel(providerInfo?.models[0]?.id ?? '');
      }
    }
    if (config?.baseUrl) setLlmBaseUrl(config.baseUrl);
  }, [config]);

  // Default model when provider changes
  useEffect(() => {
    const providerInfo = PROVIDERS.find((p) => p.id === llmProvider);
    if (providerInfo?.models[0] && !llmModel) {
      setLlmModel(providerInfo.models[0].id);
    }
  }, [llmProvider, llmModel]);

  // Discover Ollama models
  useEffect(() => {
    if (llmProvider !== 'ollama') return;
    fetchOllamaModels(llmBaseUrl || undefined)
      .then((r) => setOllamaDiscoveredModels(r.models.map((m) => m.name)))
      .catch(() => {});
  }, [llmProvider, llmBaseUrl]);

  // Discover cloud models
  useEffect(() => {
    if (!llmConfigured || llmProvider === 'ollama') return;
    setCloudDiscoveredModels([]);
    fetchLlmModels({ 
      provider: llmProvider, 
      apiKey: llmApiKey || undefined, 
      baseUrl: llmBaseUrl || undefined 
    })
      .then((r) => {
        if (r.models && r.models.length > 0) {
          setCloudDiscoveredModels(r.models);
        }
      })
      .catch(() => {});
  }, [llmConfigured, llmProvider, llmApiKey, llmBaseUrl]);

  const handleProviderChange = (provider: LLMProvider) => {
    setLlmProvider(provider);
    setLlmConfigured(false);
    setLlmTestError(null);
    setLlmApiKey('');
    setCustomModel('');
    const providerInfo = PROVIDERS.find((p) => p.id === provider);
    setLlmModel(providerInfo?.models[0]?.id ?? '');
  };

  const handleSave = async () => {
    const providerInfo = PROVIDERS.find((p) => p.id === llmProvider);
    if (!providerInfo) return;

    const effectiveModel = customModel.trim() || llmModel;

    if (providerInfo.requiresApiKey && !llmApiKey && !config?.apiKey) {
      setLlmTestError('API key is required');
      return;
    }
    if (!effectiveModel) {
      setLlmTestError('Please select a model');
      return;
    }

    setLlmTesting(true);
    setLlmTestError(null);

    try {
      const testResult = await testLlmConfig({
        provider: llmProvider,
        model: effectiveModel,
        apiKey: llmApiKey || undefined,
        baseUrl: llmBaseUrl || undefined,
        isEmbedding,
      });

      if (testResult.success) {
        await onSave({
          provider: llmProvider,
          model: effectiveModel,
          apiKey: llmApiKey || undefined,
          baseUrl: llmBaseUrl || undefined,
        });
        setLlmConfigured(true);
        setLlmTestError(null);
        toast.success(`${title} configured successfully`);
      } else {
        setLlmTestError(testResult.error || 'Failed to connect');
      }
    } catch (err) {
      setLlmTestError(err instanceof Error ? err.message : 'Failed to save configuration');
    } finally {
      setLlmTesting(false);
    }
  };

  const handleClear = async () => {
    if (!onClear) return;
    try {
      await onClear();
      setLlmConfigured(false);
      setLlmApiKey('');
      setCustomModel('');
      setLlmTestError(null);
      toast.success(`${title} configuration cleared`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to clear configuration';
      setLlmTestError(msg);
      toast.error(msg);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className="text-base">{title}</CardTitle>
          </div>
          {llmConfigured ? (
            <Badge variant="outline" className="text-green-600 border-green-600">
              <CheckCircle className="mr-1 h-3 w-3" />
              Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="text-amber-600 border-amber-600">
              <XCircle className="mr-1 h-3 w-3" />
              Not Configured
            </Badge>
          )}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Provider Selection */}
        <div>
          <label className="text-sm font-medium">Provider</label>
          <Select value={llmProvider} onValueChange={(v) => handleProviderChange(v as LLMProvider)}>
            <SelectTrigger className="mt-1">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {PROVIDERS.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  {provider.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Model Selection */}
        <div>
          <label className="text-sm font-medium">Model</label>
          {llmProvider === 'ollama' ? (
            <div className="mt-1 space-y-2">
              <Input
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="Type any model name (e.g. llama3.3)"
              />
              {(() => {
                const hardcoded = PROVIDERS.find((p) => p.id === 'ollama')?.models.map((m) => m.id) ?? [];
                const suggestions = [...new Set([...hardcoded, ...ollamaDiscoveredModels])];
                return suggestions.length > 0 ? (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Suggestions:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {suggestions.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => setLlmModel(name)}
                          className="text-xs px-2 py-0.5 rounded-md border border-border bg-muted hover:bg-accent hover:text-accent-foreground transition-colors"
                        >
                          {name}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null;
              })()}
            </div>
          ) : (
            <div className="mt-1 space-y-2">
              <Select value={llmModel} onValueChange={setLlmModel}>
                <SelectTrigger>
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {(cloudDiscoveredModels.length > 0
                    ? cloudDiscoveredModels
                    : PROVIDERS.find((p) => p.id === llmProvider)?.models || []
                  ).map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      <div className="flex items-center justify-between gap-2">
                        <span>{model.name}</span>
                        {'description' in model && (model as any).description && (
                          <span className="text-xs text-muted-foreground">
                            {(model as any).description}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div>
                <label className="text-xs text-muted-foreground">Or enter a custom model ID</label>
                <Input
                  value={customModel}
                  onChange={(e) => setCustomModel(e.target.value)}
                  placeholder="e.g. gpt-4o, claude-3-5-sonnet-latest"
                  className="mt-1"
                />
                {customModel.trim() && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Custom model <span className="font-mono">{customModel.trim()}</span> will be used instead of the dropdown selection.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* API Key */}
        {PROVIDERS.find((p) => p.id === llmProvider)?.requiresApiKey && (
          <div>
            <label className="text-sm font-medium">API Key</label>
            <Input
              type="password"
              value={llmApiKey}
              onChange={(e) => {
                setLlmApiKey(e.target.value);
                setLlmConfigured(false);
              }}
              placeholder={
                llmConfigured
                  ? 'Leave blank to keep existing key'
                  : llmProvider === 'openai'
                    ? 'sk-...'
                    : llmProvider === 'anthropic'
                      ? 'sk-ant-...'
                      : 'AIza...'
              }
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground mt-1">
              Get your API key from{' '}
              <a
                href={PROVIDERS.find((p) => p.id === llmProvider)?.apiKeyLink}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                {PROVIDERS.find((p) => p.id === llmProvider)?.name}
              </a>
            </p>
          </div>
        )}

        {/* Ollama Base URL */}
        {llmProvider === 'ollama' && (
          <>
            <div>
              <label className="text-sm font-medium">Base URL (optional)</label>
              <Input
                value={llmBaseUrl}
                onChange={(e) => setLlmBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Leave empty for default (localhost:11434)
              </p>
            </div>
            <Collapsible open={ollamaCorsOpen} onOpenChange={setOllamaCorsOpen}>
              <CollapsibleTrigger asChild>
                <button type="button" className="flex items-center gap-2 text-xs font-medium text-amber-700 dark:text-amber-300 hover:text-amber-800 transition-colors">
                  {ollamaCorsOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  Ollama connection notes
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
                  <p className="text-xs text-amber-700">Ollama runs locally on your machine. Ensure Ollama is running before testing: <code className="bg-amber-100 px-0.5 rounded">ollama serve</code></p>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </>
        )}

        {llmTestError && <p className="text-sm text-red-500">{llmTestError}</p>}

        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={llmTesting}>
            {llmTesting ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Testing...
              </>
            ) : llmConfigured ? (
              'Update Configuration'
            ) : (
              'Save & Test'
            )}
          </Button>
          {llmConfigured && onClear && (
            <Button variant="outline" onClick={handleClear} disabled={llmTesting}>
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
