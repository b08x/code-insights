import { useState, useCallback, useRef, useEffect } from 'react';
import { useFacetAggregation, useFacetSummary } from '@/hooks/useReflect';
import { reflectGenerateStream } from '@/lib/api';
import { parseSSEStream } from '@/lib/sse';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ErrorCard';
import { useThemeColors } from '@/lib/hooks/useThemeColors';
import { CHART_COLORS } from '@/lib/constants/colors';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from 'recharts';
import {
  AlertTriangle, Sparkles, Shield, Brain, Copy, Check, Loader2,
} from 'lucide-react';

// CHART_COLORS.models is the shared hex color array for multi-series charts
const PALETTE = CHART_COLORS.models;

type PatternsRange = '7d' | '30d' | '90d' | 'all';
type ActiveTab = 'friction-wins' | 'rules-skills' | 'working-style';

const rangeOptions: { value: PatternsRange; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

export default function PatternsPage() {
  const [range, setRange] = useState<PatternsRange>('30d');
  const [activeTab, setActiveTab] = useState<ActiveTab>('friction-wins');
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState('');
  const [reflectResults, setReflectResults] = useState<Record<string, unknown> | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const { tooltipBg, tooltipBorder } = useThemeColors();
  const abortRef = useRef<AbortController | null>(null);

  const { data: aggregation, isLoading, isError, refetch } = useFacetAggregation({ period: range });
  const { data: summary } = useFacetSummary({ period: range });

  // Abort in-flight generation on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    // Abort any previous in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setGenerating(true);
    setGenerationProgress('Starting...');
    setReflectResults(null);

    try {
      const response = await reflectGenerateStream(
        { period: range },
        controller.signal
      );

      if (!response.body) throw new Error('No response body');

      for await (const event of parseSSEStream(response.body)) {
        if (event.event === 'progress') {
          try {
            const data = JSON.parse(event.data) as { message?: string };
            setGenerationProgress(data.message || 'Processing...');
          } catch { /* skip malformed event */ }
        } else if (event.event === 'complete') {
          try {
            const data = JSON.parse(event.data) as { results?: Record<string, unknown> };
            setReflectResults(data.results ?? null);
          } catch { /* skip malformed event */ }
        } else if (event.event === 'error') {
          try {
            const data = JSON.parse(event.data) as { error?: string };
            setGenerationProgress(`Error: ${data.error ?? 'Unknown error'}`);
          } catch { /* skip malformed event */ }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setGenerationProgress(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }, [range]);

  const handleCopy = useCallback((text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-6 p-4 lg:p-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-4 lg:p-6">
        <ErrorCard message="Failed to load patterns data" onRetry={refetch} />
      </div>
    );
  }

  const frictionData = (aggregation?.frictionCategories || []).slice(0, 10).map(fc => ({
    category: fc.category,
    count: fc.count,
    severity: Math.round(fc.avg_severity * 10) / 10,
  }));

  const outcomeData = Object.entries(aggregation?.outcomeDistribution || {}).map(([name, value]) => ({
    name,
    value,
  }));

  const workflowData = Object.entries(aggregation?.workflowDistribution || {}).map(([name, value]) => ({
    name: name.replace(/-/g, ' '),
    value,
  }));

  const characterData = Object.entries(aggregation?.characterDistribution || {}).map(([name, value]) => ({
    name: name.replace(/_/g, ' '),
    value,
  }));

  // Check for reflect results in the active tab
  const frictionWinsResult = reflectResults?.['friction-wins'] as Record<string, unknown> | undefined;
  const rulesSkillsResult = reflectResults?.['rules-skills'] as Record<string, unknown> | undefined;
  const workingStyleResult = reflectResults?.['working-style'] as Record<string, unknown> | undefined;

  const tabs = [
    { id: 'friction-wins' as const, label: 'Friction & Wins', icon: AlertTriangle },
    { id: 'rules-skills' as const, label: 'Rules & Skills', icon: Shield },
    { id: 'working-style' as const, label: 'Working Style', icon: Brain },
  ];

  return (
    <div className="space-y-6 p-4 lg:p-6">
      {/* Header with range selector and generate button */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold">Patterns</h1>
          <p className="text-sm text-muted-foreground">
            Cross-session analysis — friction, wins, and working style
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border bg-muted p-0.5">
            {rangeOptions.map(opt => (
              <Button
                key={opt.value}
                variant={range === opt.value ? 'default' : 'ghost'}
                size="sm"
                className="h-7 px-3 text-xs"
                onClick={() => setRange(opt.value)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
          <Button
            onClick={handleGenerate}
            disabled={generating || !aggregation?.totalSessions}
            size="sm"
          >
            {generating ? (
              <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Generating...</>
            ) : (
              <><Sparkles className="h-4 w-4 mr-1.5" />Generate</>
            )}
          </Button>
        </div>
      </div>

      {/* Missing facets alert */}
      {summary && summary.missingCount > 0 && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-50 dark:bg-amber-950/20 p-4">
          <AlertTriangle className="h-5 w-5 text-amber-500 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium">
              {summary.missingCount} of {summary.totalSessions} sessions haven't been analyzed for patterns
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Run session analysis to extract facets, or they'll be generated automatically when you click Generate.
            </p>
          </div>
        </div>
      )}

      {/* Generation progress */}
      {generating && (
        <Card>
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">{generationProgress}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tab navigation with ARIA roles */}
      <div role="tablist" aria-label="Pattern analysis sections" className="flex border-b">
        {tabs.map(tab => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === tab.id
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {activeTab === 'friction-wins' && (
        <div role="tabpanel" id="tabpanel-friction-wins" className="space-y-6">
          {/* Narrative from LLM */}
          {frictionWinsResult?.narrative && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Analysis</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {String(frictionWinsResult.narrative)}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Friction bar chart */}
          {frictionData.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Friction Categories</CardTitle>
                <CardDescription>Most common blockers across sessions</CardDescription>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={Math.max(200, frictionData.length * 36)}>
                  <BarChart data={frictionData} layout="vertical" margin={{ left: 120 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
                    <XAxis type="number" />
                    <YAxis type="category" dataKey="category" width={110} tick={{ fontSize: 12 }} />
                    <Tooltip
                      contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8 }}
                    />
                    <Bar dataKey="count" fill={PALETTE[0]} radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No friction data yet. Analyze sessions to extract facets.
              </CardContent>
            </Card>
          )}

          {/* Effective patterns */}
          {(aggregation?.effectivePatterns || []).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Effective Patterns</CardTitle>
                <CardDescription>Techniques that work well across sessions</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {aggregation!.effectivePatterns.slice(0, 8).map((ep, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <span className="text-xs font-mono text-muted-foreground mt-0.5 shrink-0">
                        {ep.frequency}x
                      </span>
                      <span className="text-sm">{ep.description}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'rules-skills' && (
        <div role="tabpanel" id="tabpanel-rules-skills" className="space-y-6">
          {rulesSkillsResult ? (
            <>
              {/* CLAUDE.md Rules */}
              {Array.isArray(rulesSkillsResult.claudeMdRules) && (rulesSkillsResult.claudeMdRules as Array<{ rule: string; rationale: string; frictionSource: string }>).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">CLAUDE.md Rules</CardTitle>
                    <CardDescription>Add these to your AI assistant configuration</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {(rulesSkillsResult.claudeMdRules as Array<{ rule: string; rationale: string; frictionSource: string }>).map((r, i) => (
                      <div key={i} className="rounded-lg border p-4">
                        <div className="flex items-start justify-between gap-2">
                          <code className="text-sm font-mono flex-1">{r.rule}</code>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => handleCopy(r.rule, `rule-${i}`)}
                          >
                            {copiedKey === `rule-${i}` ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">{r.rationale}</p>
                        <span className="text-xs text-muted-foreground/60">Source: {r.frictionSource}</span>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Skill Templates */}
              {Array.isArray(rulesSkillsResult.skillTemplates) && (rulesSkillsResult.skillTemplates as Array<{ name: string; description: string; content: string }>).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Skill Templates</CardTitle>
                    <CardDescription>Reusable workflows for repetitive tasks</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {(rulesSkillsResult.skillTemplates as Array<{ name: string; description: string; content: string }>).map((s, i) => (
                      <div key={i} className="rounded-lg border p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <h4 className="text-sm font-medium">{s.name}</h4>
                            <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => handleCopy(s.content, `skill-${i}`)}
                          >
                            {copiedKey === `skill-${i}` ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <pre className="mt-3 rounded bg-muted p-3 text-xs overflow-x-auto whitespace-pre-wrap">{s.content}</pre>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}

              {/* Hook Configs */}
              {Array.isArray(rulesSkillsResult.hookConfigs) && (rulesSkillsResult.hookConfigs as Array<{ event: string; command: string; rationale: string }>).length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Hook Configurations</CardTitle>
                    <CardDescription>Automation triggers</CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {(rulesSkillsResult.hookConfigs as Array<{ event: string; command: string; rationale: string }>).map((h, i) => (
                      <div key={i} className="rounded-lg border p-4">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <span className="text-xs font-mono bg-muted px-1.5 py-0.5 rounded">{h.event}</span>
                            <code className="block text-sm font-mono mt-2">{h.command}</code>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => handleCopy(h.command, `hook-${i}`)}
                          >
                            {copiedKey === `hook-${i}` ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                          </Button>
                        </div>
                        <p className="text-xs text-muted-foreground mt-2">{h.rationale}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                Click <strong>Generate</strong> to create rules, skills, and hooks from your patterns.
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === 'working-style' && (
        <div role="tabpanel" id="tabpanel-working-style" className="space-y-6">
          {/* Narrative from LLM */}
          {workingStyleResult?.narrative && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Your Working Style</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {String(workingStyleResult.narrative)}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Distribution charts */}
          <div className="grid gap-4 md:grid-cols-2">
            {outcomeData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Outcome Distribution</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={outcomeData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                        {outcomeData.map((_, i) => (
                          <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8 }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {workflowData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Workflow Patterns</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={workflowData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                        {workflowData.map((_, i) => (
                          <Cell key={i} fill={PALETTE[(i + 2) % PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8 }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}

            {characterData.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Session Types</CardTitle>
                </CardHeader>
                <CardContent>
                  <ResponsiveContainer width="100%" height={200}>
                    <PieChart>
                      <Pie data={characterData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                        {characterData.map((_, i) => (
                          <Cell key={i} fill={PALETTE[(i + 4) % PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: tooltipBg, border: `1px solid ${tooltipBorder}`, borderRadius: 8 }} />
                      <Legend />
                    </PieChart>
                  </ResponsiveContainer>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Empty state for working style */}
          {!workingStyleResult?.narrative && outcomeData.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No working style data yet. Analyze sessions and click <strong>Generate</strong>.
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
