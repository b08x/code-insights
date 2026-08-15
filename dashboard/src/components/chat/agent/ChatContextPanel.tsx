import { Database } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { LiveMetric } from '@/hooks/useAgentChat';

interface ChatContextPanelProps {
  showContext: boolean;
  liveMetrics: LiveMetric[];
}

export function ChatContextPanel({ showContext, liveMetrics }: ChatContextPanelProps) {
  return (
    <aside className={cn(
      "flex-shrink-0 border-l bg-card/50 backdrop-blur-xl flex flex-col h-full transition-all duration-300 overflow-hidden relative absolute md:relative right-0 z-20",
      showContext ? "w-full md:w-80 opacity-100 translate-x-0" : "w-0 opacity-0 translate-x-full border-none"
    )}>
      <div className="p-4 border-b bg-background/50 flex items-center justify-between sticky top-0 z-10">
        <h3 className="font-semibold text-sm flex items-center gap-2">
          <Database className="w-4 h-4 text-primary" />
          Live Metrics
        </h3>
        <span className="text-[10px] bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 px-2 py-0.5 rounded-full font-medium border border-emerald-500/20">
          Agent Online
        </span>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {liveMetrics.length === 0 ? (
          <div className="text-xs text-muted-foreground italic mb-2">
            Metadata and context visualization will appear here during active tool usage.
          </div>
        ) : (
          liveMetrics.map((metric, index) => (
            <div key={index} className="bg-background rounded-lg border p-3 shadow-sm text-xs">
              <div className="font-semibold text-primary mb-1 flex items-center gap-1">
                <Database className="w-3 h-3" />
                {metric.tool}
              </div>
              <div className="text-muted-foreground whitespace-pre-wrap font-mono text-[10px] break-all">
                {typeof metric.args === 'string' 
                  ? metric.args 
                  : JSON.stringify(metric.args, null, 2)}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
