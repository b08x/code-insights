import { useState } from 'react';
import { CheckCircle2, ChevronRight, Code2, Loader2, Wrench, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatToolCall } from '@/lib/types';

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return '';
  if (typeof args === 'string') return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function ToolCallDetailView({ tool }: { tool: ChatToolCall }) {
  const [sqlOpen, setSqlOpen] = useState(false);
  const detail = tool.detail;
  if (!detail || (!detail.sql && !detail.error)) return null;

  const rowSummary = typeof detail.rowCount === 'number'
    ? `${detail.rowCount} row${detail.rowCount === 1 ? '' : 's'}${detail.truncated ? ' (capped)' : ''}`
    : null;
  const labelParts = ['SQL', rowSummary, detail.runner].filter(Boolean);

  return (
    <div className="mt-0.5 pl-4.5">
      <button
        type="button"
        onClick={() => setSqlOpen((v) => !v)}
        aria-expanded={sqlOpen}
        className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] font-sans text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Code2 className="h-2.5 w-2.5" aria-hidden />
        <span>{labelParts.join(' · ')}</span>
        <ChevronRight className={cn('h-2.5 w-2.5 transition-transform', sqlOpen && 'rotate-90')} aria-hidden />
      </button>
      {sqlOpen && (
        <div className="mt-1 space-y-1 rounded border bg-muted/40 p-2 font-sans text-[11px]">
          {detail.explanation && (
            <p className="text-muted-foreground">{detail.explanation}</p>
          )}
          {detail.sql && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-background/70 p-1.5 font-mono text-[10px] leading-4 text-foreground">
              <code>{detail.sql}</code>
            </pre>
          )}
          {detail.error && (
            <p className="text-destructive">{detail.error}</p>
          )}
        </div>
      )}
    </div>
  );
}

interface ToolCallActivityProps {
  toolCalls: ChatToolCall[];
  /** True while the turn is still streaming; shows a working indicator. */
  active?: boolean;
  /** Start expanded (used on the /chat context rail). */
  defaultOpen?: boolean;
}

/** Compact, collapsible list of tool calls the agent made for one reply. */
export function ToolCallActivity({ toolCalls, active = false, defaultOpen = false }: ToolCallActivityProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (toolCalls.length === 0 && !active) return null;

  const failed = toolCalls.filter((t) => !t.ok).length;
  const summary = active
    ? toolCalls.length === 0
      ? 'Working…'
      : `Running tools · ${toolCalls.length} so far`
    : `Used ${toolCalls.length} tool${toolCalls.length === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`;

  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        disabled={toolCalls.length === 0}
        className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:hover:bg-transparent disabled:cursor-default"
      >
        {active ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Wrench className="h-3 w-3" aria-hidden />}
        <span>{summary}</span>
        {toolCalls.length > 0 && (
          <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} aria-hidden />
        )}
      </button>
      {open && toolCalls.length > 0 && (
        <ol className="mt-1 ml-1 space-y-1 border-l pl-3">
          {toolCalls.map((t, i) => {
            const args = formatArgs(t.args);
            return (
              <li key={`${t.name}-${i}`} className="font-mono text-[11px] leading-5">
                <div className="flex items-start gap-1.5">
                  {t.ok ? (
                    <CheckCircle2 className="mt-1 h-3 w-3 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="succeeded" />
                  ) : (
                    <XCircle className="mt-1 h-3 w-3 shrink-0 text-destructive" aria-label="failed" />
                  )}
                  <span className="min-w-0 flex-1 break-all">
                    <span className="font-semibold text-foreground">{t.name}</span>
                    {args && <span className="text-muted-foreground">({args.length > 160 ? `${args.slice(0, 160)}…` : args})</span>}
                  </span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">{formatMs(t.ms)}</span>
                </div>
                <ToolCallDetailView tool={t} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
