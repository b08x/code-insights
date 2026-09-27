import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Check, Table, FileJson, FileSpreadsheet } from 'lucide-react';
import { toast } from 'sonner';
import type { SemanticStep } from '@/lib/types';
import { fetchSessionRailsExport, fetchSessionFcaExport } from '@/lib/api';

interface FcaMatrixCardProps {
  sessionId: string;
  stepMatrix?: SemanticStep[];
}

interface AttributeDef {
  key: string;
  label: string;
  category: 'driver' | 'target' | 'state';
  description: string;
}

const ATTRIBUTES: AttributeDef[] = [
  // Drivers
  { key: 'LLM_Decide', label: 'LLM', category: 'driver', description: 'Autonomous agent decision driver' },
  { key: 'User_Decide', label: 'User', category: 'driver', description: 'User-directed decision driver' },
  { key: 'Collab_Decide', label: 'Collab', category: 'driver', description: 'Collaborative / co-designed driver' },
  // Targets
  { key: 'Target_Config', label: 'Config', category: 'target', description: 'Target: configuration or environment' },
  { key: 'Target_SrcCode', label: 'SrcCode', category: 'target', description: 'Target: application source code' },
  { key: 'Target_Test', label: 'Test', category: 'target', description: 'Target: test suite or verification' },
  { key: 'Target_Docs', label: 'Docs', category: 'target', description: 'Target: documentation or specifications' },
  // States
  { key: 'State_Success', label: 'Success', category: 'state', description: 'State: completed successfully' },
  { key: 'State_Error', label: 'Error', category: 'state', description: 'State: encountered error or failure' },
  { key: 'State_Blocked', label: 'Blocked', category: 'state', description: 'State: blocked / waiting on user or environment' },
];

/**
 * FcaMatrixCard renders an interactive Formal Concept Analysis (FCA) incidence matrix
 * table for a session. It visualizes the formal context (G, M, I) where:
 * - G (Objects) are the semantic episode steps.
 * - M (Attributes) are the 10 canonical binary attributes (Drivers, Targets, States).
 * - I (Incidence) displays checkmark indicators where step g has attribute m.
 *
 * Provides instant download triggers for Rails JSON (`rails-v1`) and FCA CSV exports.
 */
export function FcaMatrixCard({ sessionId, stepMatrix = [] }: FcaMatrixCardProps) {
  const [downloading, setDownloading] = useState<'rails' | 'csv' | null>(null);

  if (!stepMatrix || stepMatrix.length === 0) {
    return null;
  }

  async function handleExportRails() {
    try {
      setDownloading('rails');
      const data = await fetchSessionRailsExport(sessionId);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}-rails.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Exported Rails-ready session JSON');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to export Rails JSON');
    } finally {
      setDownloading(null);
    }
  }

  async function handleExportCsv() {
    try {
      setDownloading('csv');
      const csv = await fetchSessionFcaExport(sessionId, 'csv');
      const blob = new Blob([csv as string], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `session-${sessionId}-fca.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Exported FCA incidence matrix CSV');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to export FCA CSV');
    } finally {
      setDownloading(null);
    }
  }

  return (
    <Card className="border border-border/80 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Table className="h-4 w-4 text-indigo-500" />
              <CardTitle className="text-base font-semibold">
                Formal Concept Analysis (FCA) Incidence Matrix
              </CardTitle>
              <Badge variant="secondary" className="text-xs font-mono">
                {stepMatrix.length} steps × {ATTRIBUTES.length} attrs
              </Badge>
            </div>
            <CardDescription className="text-xs">
              Compact semantic episodes (objects <span className="font-serif italic font-medium">G</span>) and binary feature incidence (attributes <span className="font-serif italic font-medium">M</span>, <span className="font-serif italic font-medium">I</span>) for concept lattice derivation.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleExportCsv}
              disabled={downloading !== null}
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-500" />
              FCA CSV
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleExportRails}
              disabled={downloading !== null}
            >
              <FileJson className="h-3.5 w-3.5 text-red-500" />
              Rails JSON
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="rounded-md border overflow-x-auto bg-card">
          <table className="w-full text-xs border-collapse">
            <thead>
              {/* Category group headers */}
              <tr className="border-b bg-muted/40 text-[11px] font-medium text-muted-foreground">
                <th className="py-2 px-3 text-left border-r" colSpan={2}>
                  Formal Objects (<span className="font-serif italic">G</span>)
                </th>
                <th className="py-2 px-2 text-center border-r bg-blue-500/5 text-blue-600 dark:text-blue-400 font-semibold" colSpan={3}>
                  Decision Drivers
                </th>
                <th className="py-2 px-2 text-center border-r bg-amber-500/5 text-amber-600 dark:text-amber-400 font-semibold" colSpan={4}>
                  Target Scope
                </th>
                <th className="py-2 px-2 text-center bg-emerald-500/5 text-emerald-600 dark:text-emerald-400 font-semibold" colSpan={3}>
                  State
                </th>
              </tr>
              {/* Individual attribute column headers */}
              <tr className="border-b bg-muted/20 text-muted-foreground font-medium">
                <th className="py-2 px-3 text-left w-12 font-mono text-[11px]">Turn</th>
                <th className="py-2 px-3 text-left min-w-[200px] border-r">Step Description</th>
                {ATTRIBUTES.map((attr) => (
                  <th
                    key={attr.key}
                    className="py-2 px-2 text-center min-w-[54px] font-mono text-[10px]"
                    title={`${attr.label} (${attr.key}): ${attr.description}`}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="cursor-help">{attr.label}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="text-xs">
                        <p className="font-semibold font-mono">{attr.key}</p>
                        <p className="text-muted-foreground">{attr.description}</p>
                      </TooltipContent>
                    </Tooltip>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stepMatrix.map((step, idx) => {
                const attrs = {
                  LLM_Decide: step.driver === 'LLM_Decide',
                  User_Decide: step.driver === 'User_Decide',
                  Collab_Decide: step.driver === 'Collab_Decide',
                  Target_Config: step.target === 'Target_Config',
                  Target_SrcCode: step.target === 'Target_SrcCode',
                  Target_Test: step.target === 'Target_Test',
                  Target_Docs: step.target === 'Target_Docs',
                  State_Success: step.state === 'State_Success',
                  State_Error: step.state === 'State_Error',
                  State_Blocked: step.state === 'State_Blocked',
                };

                return (
                  <tr
                    key={idx}
                    className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                  >
                    <td className="py-2 px-3 font-mono text-[11px] text-muted-foreground whitespace-nowrap">
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {step.turn_ref}
                      </Badge>
                    </td>
                    <td className="py-2 px-3 font-medium text-foreground border-r">
                      {step.step}
                    </td>
                    {ATTRIBUTES.map((attr) => {
                      const hasAttr = Boolean(attrs[attr.key as keyof typeof attrs]);
                      return (
                        <td
                          key={attr.key}
                          className="py-2 px-2 text-center"
                          aria-label={`${step.step} - ${attr.label}: ${hasAttr ? 'yes' : 'no'}`}
                        >
                          {hasAttr ? (
                            <span className="inline-flex items-center justify-center h-5 w-5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 font-bold">
                              <Check className="h-3.5 w-3.5" />
                            </span>
                          ) : (
                            <span className="text-muted-foreground/30">&middot;</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
