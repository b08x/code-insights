import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, Copy, Loader2, Sparkles } from 'lucide-react';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { cn } from '@/lib/utils';
import { AssistantMarkdown } from '@/components/chat/message/markdown/AssistantMarkdown';
import { Skeleton } from '@/components/ui/skeleton';
import type { ChatMessage } from '@/lib/types';
import type { PendingTurn } from '@/lib/chat-stream';
import type { ChatError } from '@/hooks/useAgentChat';
import { ToolCallActivity } from './ToolCallActivity';
import { CitationLinks } from './CitationLinks';
import { DraftCard } from './DraftCard';

interface ChatMainAreaProps {
  messages: ChatMessage[];
  pending: PendingTurn | null;
  isStreaming: boolean;
  isLoadingConversation: boolean;
  lastError: ChatError | null;
  /** Narrow side-panel layout: no avatars, tighter spacing. */
  compact?: boolean;
  /** Rendered when the conversation has no messages. */
  emptyState?: ReactNode;
}

/** Message log shared by the side panel and the /chat page. */
export function ChatMainArea({
  messages,
  pending,
  isStreaming,
  isLoadingConversation,
  lastError,
  compact = false,
  emptyState,
}: ChatMainAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // Follow the stream unless the user scrolled up to read earlier messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const lastAssistantId = [...messages].reverse().find((m) => m.role === 'assistant')?.id;

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation"
      aria-busy={isStreaming}
      className={cn('flex-1 overflow-y-auto', compact ? 'px-3 py-3 space-y-4' : 'p-4 sm:p-6 space-y-6')}
    >
      {isLoadingConversation && messages.length === 0 ? (
        <div className="space-y-3" aria-label="Loading conversation">
          <Skeleton className="ml-auto h-10 w-2/3" />
          <Skeleton className="h-24 w-5/6" />
        </div>
      ) : messages.length === 0 ? (
        emptyState ?? null
      ) : (
        messages.map((msg) => {
          const isLiveAssistant = msg.role === 'assistant' && !!pending && isStreaming && msg.id === lastAssistantId;
          return (
            <MessageItem
              key={msg.id}
              message={msg}
              live={isLiveAssistant}
              compact={compact}
            />
          );
        })
      )}

      {lastError && !isStreaming && (
        <div
          role="alert"
          className={cn('flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive', !compact && 'max-w-3xl mx-auto')}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 break-words">{lastError.message}</span>
        </div>
      )}
    </div>
  );
}

function MessageItem({ message, live, compact }: { message: ChatMessage; live: boolean; compact: boolean }) {
  if (message.role === 'user') {
    return (
      <div className={cn('flex justify-end', !compact && 'max-w-3xl mx-auto w-full')}>
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground">
          {message.content}
        </div>
      </div>
    );
  }

  const meta = message.toolCalls ?? { toolCalls: [], citations: [], drafts: [] };
  const hasContent = message.content.trim().length > 0;

  return (
    <div className={cn('flex gap-3', !compact && 'max-w-3xl mx-auto w-full')}>
      {!compact && (
        <div className="mt-0.5 hidden h-7 w-7 shrink-0 items-center justify-center rounded-full border bg-muted sm:flex" aria-hidden>
          <Sparkles className="h-3.5 w-3.5 text-primary" />
        </div>
      )}
      <div className="group/msg relative min-w-0 flex-1 space-y-2">
        <ToolCallActivity toolCalls={meta.toolCalls} active={live} />
        {hasContent ? (
          <div className="text-sm">
            <AssistantMarkdown content={message.content} codeStyle={oneDark} />
          </div>
        ) : live ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            Thinking…
          </div>
        ) : null}
        {live && hasContent && <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground/60 align-middle" aria-hidden />}
        <CitationLinks citations={meta.citations} />
        {!live && hasContent && <CopyMarkdownButton text={message.content} />}
        {meta.drafts.length > 0 && (
          <div className="space-y-2">
            {meta.drafts.map((d, i) => <DraftCard key={`${d.kind}-${i}`} draft={d} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function CopyMarkdownButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/msg:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={copied ? 'Copied' : 'Copy reply as Markdown'}
    >
      {copied ? <Check className="h-3 w-3 text-emerald-600" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
