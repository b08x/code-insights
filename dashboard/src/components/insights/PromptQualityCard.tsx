import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Target, AlertTriangle, Lightbulb, TrendingDown } from 'lucide-react';
import type { Insight } from '@/lib/types';
import { parseJsonField } from '@/lib/types';

interface PromptQualityCardProps {
  insight: Insight;
}

interface AntiPattern {
  name: string;
  count: number;
  examples: string[];
}

interface WastedTurn {
  messageIndex: number;
  reason: string;
  suggestedRewrite?: string;
}

function getScoreColor(score: number): string {
  if (score >= 80) return 'text-green-500';
  if (score >= 60) return 'text-yellow-500';
  if (score >= 40) return 'text-orange-500';
  return 'text-red-500';
}

function getScoreLabel(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Needs Improvement';
  return 'Poor';
}

export function PromptQualityCard({ insight }: PromptQualityCardProps) {
  const metadata = parseJsonField<Record<string, unknown>>(insight.metadata, {});
  const bullets = parseJsonField<string[]>(insight.bullets, []);

  const score = typeof metadata.efficiencyScore === 'number' ? metadata.efficiencyScore : 0;
  const wastedTurns = Array.isArray(metadata.wastedTurns) ? metadata.wastedTurns as WastedTurn[] : [];
  const antiPatterns = Array.isArray(metadata.antiPatterns) ? metadata.antiPatterns as AntiPattern[] : [];
  const reduction = typeof metadata.potentialMessageReduction === 'number' ? metadata.potentialMessageReduction : 0;

  return (
    <Card className="border-rose-500/20">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <div className="rounded-md p-1.5 bg-rose-500/10 text-rose-500 border-rose-500/20">
              <Target className="h-4 w-4" />
            </div>
            <CardTitle className="text-base">Prompt Quality Analysis</CardTitle>
          </div>
          <Badge variant="outline" className="bg-rose-500/10 text-rose-500 border-rose-500/20">
            Prompt Quality
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="flex items-center gap-4">
          <div className="text-center">
            <p className={`text-3xl font-bold ${getScoreColor(score)}`}>
              {score}
            </p>
            <p className="text-xs text-muted-foreground">/100</p>
          </div>
          <div>
            <p className={`text-sm font-medium ${getScoreColor(score)}`}>
              {getScoreLabel(score)}
            </p>
            <p className="text-sm text-muted-foreground">
              {insight.content}
            </p>
          </div>
        </div>

        {reduction > 0 && (
          <div className="flex items-center gap-2 text-sm rounded-md bg-muted/50 p-2">
            <TrendingDown className="h-4 w-4 text-muted-foreground shrink-0" />
            <span>
              Could have been done in <strong>{reduction} fewer</strong> messages
            </span>
          </div>
        )}

        {antiPatterns.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />
              Anti-Patterns Detected
            </div>
            <div className="space-y-1.5">
              {antiPatterns.map((pattern, i) => (
                <div key={i} className="text-sm rounded-md border p-2">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{pattern.name}</span>
                    <Badge variant="secondary" className="text-xs">
                      {pattern.count}x
                    </Badge>
                  </div>
                  {pattern.examples.length > 0 && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      e.g. &ldquo;{pattern.examples[0]}&rdquo;
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {wastedTurns.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              Wasted Turns ({wastedTurns.length})
            </p>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {wastedTurns.slice(0, 5).map((turn, i) => (
                <div key={i} className="text-sm rounded-md border p-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs shrink-0">
                      Msg #{turn.messageIndex + 1}
                    </Badge>
                    <span className="text-muted-foreground">{turn.reason}</span>
                  </div>
                  {turn.suggestedRewrite && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                        Better prompt
                      </summary>
                      <p className="mt-1 bg-muted/50 rounded p-1.5">
                        {turn.suggestedRewrite}
                      </p>
                    </details>
                  )}
                </div>
              ))}
              {wastedTurns.length > 5 && (
                <p className="text-xs text-muted-foreground">
                  +{wastedTurns.length - 5} more wasted turns...
                </p>
              )}
            </div>
          </div>
        )}

        {bullets.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Lightbulb className="h-3.5 w-3.5 text-yellow-500" />
              Tips
            </div>
            <ul className="list-disc list-inside space-y-1 text-sm text-muted-foreground">
              {bullets.map((tip, i) => (
                <li key={i}>{tip}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
