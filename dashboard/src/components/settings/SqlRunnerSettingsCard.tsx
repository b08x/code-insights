import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Database, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useRunnerModels, useSaveLlmConfig, RUNNERS_WITH_MODEL_LIST } from '@/hooks/useConfig';
import type { AnalysisRunnerName, SqlRunnerName, SqlRunnerSetting } from '@/lib/types';

interface SqlRunnerOption {
  id: SqlRunnerName;
  name: string;
  tag: string;
  modelHint: string;
  variantHint: string | null;
  variantExamples?: string[];
}

const SQL_RUNNERS: SqlRunnerOption[] = [
  { id: 'provider', name: 'Background Analysis Provider', tag: 'API (fast)', modelHint: '', variantHint: null },
  { id: 'agent', name: 'Interactive Chat Agent', tag: 'API (chat)', modelHint: '', variantHint: null },
  { id: 'claude', name: 'Claude Code', tag: '--claude', modelHint: 'CLI default (e.g. claude-sonnet-4-6)', variantHint: 'Passed as --effort', variantExamples: ['low', 'medium', 'high'] },
  { id: 'codex', name: 'Codex CLI', tag: '--codex', modelHint: 'CLI default (e.g. gpt-5.4)', variantHint: 'Passed as model_reasoning_effort', variantExamples: ['minimal', 'low', 'medium', 'high'] },
  { id: 'antigravity', name: 'Antigravity', tag: '--antigravity', modelHint: 'CLI default', variantHint: null },
  { id: 'vibe', name: 'Mistral Vibe', tag: '--vibe', modelHint: 'CLI default (sets VIBE_ACTIVE_MODEL)', variantHint: null },
  { id: 'opencode', name: 'OpenCode', tag: '--opencode', modelHint: 'CLI default (provider/model)', variantHint: 'Passed as --variant', variantExamples: ['high', 'max', 'minimal'] },
];

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
const VARIANT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/;
const CUSTOM = '__custom__';
const CLI_DEFAULT = '__default__';

interface SqlRunnerSettingsCardProps {
  saved?: SqlRunnerSetting;
  providerSummary?: string;
  agentSummary?: string;
}

export function SqlRunnerSettingsCard({ saved, providerSummary, agentSummary }: SqlRunnerSettingsCardProps) {
  const saveMutation = useSaveLlmConfig();
  const ids = { runner: useId(), model: useId(), custom: useId(), variant: useId(), help: useId() };

  const [runner, setRunner] = useState<SqlRunnerName | undefined>(saved?.name);
  const [model, setModel] = useState(saved?.model ?? '');
  const [variant, setVariant] = useState(saved?.variant ?? '');
  const [customMode, setCustomMode] = useState(false);

  useEffect(() => {
    setRunner(saved?.name);
    setModel(saved?.model ?? '');
    setVariant(saved?.variant ?? '');
    setCustomMode(false);
  }, [saved?.name, saved?.model, saved?.variant]);

  const info = SQL_RUNNERS.find((r) => r.id === runner);
  const isApiBacked = runner === 'provider' || runner === 'agent';
  const supportsList = !!runner && !isApiBacked && RUNNERS_WITH_MODEL_LIST.includes(runner as AnalysisRunnerName);
  const { data: models = [], isFetching: modelsLoading } = useRunnerModels(
    supportsList ? (runner as AnalysisRunnerName) : undefined,
  );

  const trimmedModel = model.trim();
  const showSelect = supportsList && models.length > 0;
  const modelInList = models.includes(trimmedModel);
  const useCustomInput = !showSelect || customMode || (!!trimmedModel && !modelInList);

  const trimmedVariant = variant.trim();
  const modelError = !isApiBacked && trimmedModel && !MODEL_RE.test(trimmedModel)
    ? 'Use letters, digits and . _ : / @ + - (no leading dash).'
    : null;
  const variantError = info?.variantHint && trimmedVariant && !VARIANT_RE.test(trimmedVariant)
    ? 'Use letters, digits and . _ - (no leading dash).'
    : null;

  const dirty = useMemo(() => (
    runner !== saved?.name
    || (!isApiBacked && trimmedModel !== (saved?.model ?? ''))
    || (!!info?.variantHint && trimmedVariant !== (saved?.variant ?? ''))
  ), [runner, saved, isApiBacked, trimmedModel, trimmedVariant, info?.variantHint]);

  const handleRunnerChange = (next: string) => {
    setRunner(next as SqlRunnerName);
    setModel(next === saved?.name ? saved?.model ?? '' : '');
    setVariant(next === saved?.name ? saved?.variant ?? '' : '');
    setCustomMode(false);
  };

  const handleSave = async () => {
    if (!runner) return;
    try {
      await saveMutation.mutateAsync({
        agent: {
          sqlRunner: {
            name: runner,
            model: isApiBacked ? '' : trimmedModel,
            variant: info?.variantHint ? trimmedVariant : '',
          },
        },
      });
      toast.success(`SQL sub-agent runner set to ${info?.name ?? runner}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save SQL sub-agent runner');
    }
  };

  const handleClear = async () => {
    try {
      await saveMutation.mutateAsync({ agent: { sqlRunner: null } });
      toast.success('SQL sub-agent runner reset to Auto (Provider → Agent)');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to reset SQL sub-agent runner');
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database className="h-5 w-5" aria-hidden="true" />
            <CardTitle className="text-base">SQL Sub-Agent Runner</CardTitle>
          </div>
          {saved ? (
            <Badge variant="secondary" className="font-normal">
              {SQL_RUNNERS.find((r) => r.id === saved.name)?.name ?? saved.name}
            </Badge>
          ) : (
            <Badge variant="outline" className="font-normal text-muted-foreground">Auto (Provider → Agent)</Badge>
          )}
        </div>
        <CardDescription>
          Runner that translates natural-language questions into read-only SQLite queries for{' '}
          <code className="font-mono text-xs">queryDatabase</code>. Defaults to Background Analysis Provider then Chat Agent for low latency.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label htmlFor={ids.runner}>Runner</Label>
            <Select value={runner ?? ''} onValueChange={handleRunnerChange}>
              <SelectTrigger id={ids.runner}>
                <SelectValue placeholder="Auto (Provider → Agent)" />
              </SelectTrigger>
              <SelectContent>
                {SQL_RUNNERS.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <span>{r.name}</span>
                    <span className="ml-2 font-mono text-xs text-muted-foreground">{r.tag}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={ids.variant} className={!info?.variantHint ? 'text-muted-foreground' : undefined}>
              Variant
            </Label>
            <Input
              id={ids.variant}
              value={info?.variantHint ? variant : ''}
              onChange={(e) => setVariant(e.target.value)}
              disabled={!info?.variantHint}
              placeholder={info?.variantHint ? `e.g. ${info.variantExamples?.join(', ')}` : 'Not supported by this runner'}
              aria-invalid={!!variantError}
              aria-describedby={`${ids.variant}-hint`}
              className="font-mono text-sm"
            />
            <p id={`${ids.variant}-hint`} className={`text-xs ${variantError ? 'text-destructive' : 'text-muted-foreground'}`}>
              {variantError ?? (info?.variantHint ? `${info.variantHint}. Blank = CLI default.` : 'Reasoning effort is not configurable for this runner.')}
            </p>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={useCustomInput ? ids.custom : ids.model} className={!runner || isApiBacked ? 'text-muted-foreground' : undefined}>
            Model
          </Label>

          {isApiBacked ? (
            <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
              {runner === 'provider'
                ? <>Uses Background Analysis Provider{providerSummary ? <> (<span className="font-mono">{providerSummary}</span>)</> : ' configured above'}.</>
                : <>Uses Interactive Knowledge Agent{agentSummary ? <> (<span className="font-mono">{agentSummary}</span>)</> : ' (or Background Provider fallback)'}.</>}
            </p>
          ) : (
            <>
              {showSelect && (
                <Select
                  value={customMode || (trimmedModel && !modelInList) ? CUSTOM : trimmedModel || CLI_DEFAULT}
                  onValueChange={(v) => {
                    if (v === CUSTOM) {
                      setCustomMode(true);
                    } else if (v === CLI_DEFAULT) {
                      setCustomMode(false);
                      setModel('');
                    } else {
                      setCustomMode(false);
                      setModel(v);
                    }
                  }}
                >
                  <SelectTrigger id={ids.model} aria-describedby={ids.help}>
                    <SelectValue placeholder={info?.modelHint || 'CLI default'} />
                  </SelectTrigger>
                  <SelectContent className="max-h-72">
                    <SelectItem value={CLI_DEFAULT} className="text-muted-foreground">CLI default</SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m} value={m} className="font-mono text-xs">{m}</SelectItem>
                    ))}
                    <SelectItem value={CUSTOM}>Custom model id…</SelectItem>
                  </SelectContent>
                </Select>
              )}

              {useCustomInput && (
                <Input
                  id={ids.custom}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!runner}
                  placeholder={runner ? info?.modelHint || 'CLI default' : 'Auto (select a runner to override)'}
                  aria-invalid={!!modelError}
                  aria-describedby={ids.help}
                  className={`font-mono text-sm ${showSelect ? 'mt-2' : ''}`}
                  aria-label={showSelect ? 'Custom model id' : undefined}
                />
              )}

              <p id={ids.help} className={`flex items-center gap-1.5 text-xs ${modelError ? 'text-destructive' : 'text-muted-foreground'}`}>
                {modelError ?? (
                  modelsLoading ? (
                    <><Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> Loading models from the CLI…</>
                  ) : showSelect ? (
                    <>{models.length} models from <code className="font-mono">{runner === 'antigravity' ? 'agy' : 'opencode'} models</code>. Blank = CLI default.</>
                  ) : supportsList ? (
                    'Could not list models from the CLI; type a model id. Blank = CLI default.'
                  ) : (
                    'Type a model id. Blank = CLI default.'
                  )
                )}
              </p>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            onClick={handleSave}
            disabled={!runner || !dirty || !!modelError || !!variantError || saveMutation.isPending}
          >
            {saveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            Save SQL runner
          </Button>
          {saved && (
            <Button variant="outline" onClick={handleClear} disabled={saveMutation.isPending}>
              Reset to Auto
            </Button>
          )}
          {dirty && runner && (
            <span className="text-xs text-muted-foreground" role="status">Unsaved changes</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
