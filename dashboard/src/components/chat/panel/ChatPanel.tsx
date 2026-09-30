import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Bot, History, Maximize2, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useAgentChat } from '@/hooks/useAgentChat';
import { describePageContext, getSuggestedPrompts } from '@/lib/chat-prompts';
import { formatRelativeDate } from '@/lib/date-utils';
import { ChatMainArea } from '@/components/chat/agent/ChatMainArea';
import { ChatComposer } from '@/components/chat/agent/ChatComposer';
import { ChatEmptyState } from '@/components/chat/agent/ChatEmptyState';
import { usePageContext } from './PageContextProvider';

export const CHAT_PANEL_ID = 'agent-chat-panel';
export const CHAT_TOGGLE_ID = 'agent-chat-toggle';

/**
 * Non-modal chat side panel available on every page (agent-7). Sends the
 * current page context with each message (agent-8) and shows per-page
 * suggested prompts (agent-9). Escape closes it and returns focus to the
 * header toggle.
 */
export function ChatPanel() {
  const chat = useAgentChat();
  const { pageContext } = usePageContext();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const contextLabel = describePageContext(pageContext);
  const prompts = getSuggestedPrompts(pageContext);

  // Move focus into the panel when it opens.
  useEffect(() => {
    if (!chat.panelOpen) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [chat.panelOpen]);

  if (!chat.panelOpen) return null;

  const close = () => {
    chat.setPanelOpen(false);
    requestAnimationFrame(() => document.getElementById(CHAT_TOGGLE_ID)?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Portaled menus/tooltips bubble React events here; only close for Escape
    // pressed on elements physically inside the panel.
    if (e.key === 'Escape' && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) {
      e.stopPropagation();
      close();
    }
  };

  return (
    <aside
      id={CHAT_PANEL_ID}
      aria-label="Agent chat"
      onKeyDown={onKeyDown}
      className="fixed inset-x-0 top-14 bottom-14 z-40 flex flex-col border-l bg-background shadow-lg md:bottom-0 md:left-auto md:w-[420px]"
    >
      <header className="flex h-11 shrink-0 items-center gap-1 border-b pl-3 pr-1.5">
        <Bot className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {chat.activeConversation?.title ?? 'Agent chat'}
        </h2>

        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Conversation history">
                  <History className="h-4 w-4" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>History</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-72 max-h-80 overflow-y-auto">
            <DropdownMenuLabel className="text-xs">Recent conversations</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {chat.conversations.length === 0 ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet</div>
            ) : (
              chat.conversations.slice(0, 20).map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  onSelect={() => chat.selectConversation(c.id)}
                  className={cn('flex items-center gap-2 text-xs', c.id === chat.activeConversationId && 'font-semibold')}
                >
                  <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatRelativeDate(c.updatedAt)}</span>
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={chat.newConversation} aria-label="New chat">
              <Plus className="h-4 w-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>New chat</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" asChild>
              <Link to="/chat" onClick={() => chat.setPanelOpen(false)} aria-label="Open full-page chat">
                <Maximize2 className="h-4 w-4" aria-hidden />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open full page</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close chat panel">
              <X className="h-4 w-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close (Esc)</TooltipContent>
        </Tooltip>
      </header>

      {contextLabel && (
        <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
          <span>Context:</span>
          <span className="rounded border bg-background px-1.5 font-mono text-foreground/80" title={JSON.stringify(pageContext)}>
            {contextLabel}
          </span>
        </div>
      )}

      <ChatMainArea
        compact
        messages={chat.messages}
        pending={chat.pending}
        isStreaming={chat.isStreaming}
        isLoadingConversation={chat.isLoadingConversation}
        lastError={chat.lastError}
        emptyState={<ChatEmptyState contextLabel={contextLabel?.toLowerCase()} />}
      />

      <ChatComposer
        ref={inputRef}
        compact
        onSend={(text) => chat.sendMessage(text, pageContext)}
        onStop={chat.stop}
        isStreaming={chat.isStreaming}
        suggestedPrompts={prompts}
        showSuggestions={chat.messages.length === 0}
      />
    </aside>
  );
}
