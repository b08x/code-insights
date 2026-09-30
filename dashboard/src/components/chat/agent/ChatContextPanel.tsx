import { Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/types';
import { ToolCallActivity } from './ToolCallActivity';
import { CitationLinks } from './CitationLinks';

interface ChatContextPanelProps {
  showContext: boolean;
  messages: ChatMessage[];
  isStreaming: boolean;
}

/** Right rail on /chat: tool activity and sources for every reply in the conversation. */
export function ChatContextPanel({ showContext, messages, isStreaming }: ChatContextPanelProps) {
  const replies = messages.filter((m) => m.role === 'assistant');
  const lastReplyId = replies[replies.length - 1]?.id;
  const citations = Array.from(new Set(replies.flatMap((m) => m.toolCalls?.citations ?? [])));
  const withTools = replies.filter((m) => (m.toolCalls?.toolCalls.length ?? 0) > 0 || (isStreaming && m.id === lastReplyId));

  if (!showContext) return null;

  return (
    <aside className="hidden w-80 shrink-0 flex-col border-l bg-muted/10 lg:flex" aria-label="Agent activity">
      <div className="flex h-11 items-center gap-2 border-b px-4">
        <Wrench className="h-4 w-4 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-semibold">Activity</h2>
      </div>
      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Tool calls</h3>
          {withTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">Tool calls appear here as the agent queries your sessions, insights, and analytics.</p>
          ) : (
            <ol className="space-y-3">
              {withTools.map((m, i) => (
                <li key={m.id} className={cn('rounded-md border bg-background p-2')}>
                  <div className="mb-1 text-[10px] text-muted-foreground">Reply {i + 1}</div>
                  <ToolCallActivity
                    toolCalls={m.toolCalls?.toolCalls ?? []}
                    active={isStreaming && m.id === lastReplyId}
                    defaultOpen
                  />
                </li>
              ))}
            </ol>
          )}
        </section>
        <section>
          <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Cited sessions</h3>
          {citations.length === 0 ? (
            <p className="text-xs text-muted-foreground">None yet.</p>
          ) : (
            <CitationLinks citations={citations} />
          )}
        </section>
      </div>
    </aside>
  );
}
