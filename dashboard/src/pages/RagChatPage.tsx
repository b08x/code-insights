import { useEffect, useRef, useState } from 'react';
import { Bot, PanelRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAgentChat } from '@/hooks/useAgentChat';
import { usePageContext } from '@/components/chat/panel/PageContextProvider';
import { getSuggestedPrompts } from '@/lib/chat-prompts';
import { ChatSidebar } from '@/components/chat/agent/ChatSidebar';
import { ChatContextPanel } from '@/components/chat/agent/ChatContextPanel';
import { ChatMainArea } from '@/components/chat/agent/ChatMainArea';
import { ChatComposer } from '@/components/chat/agent/ChatComposer';
import { ChatEmptyState } from '@/components/chat/agent/ChatEmptyState';

/** Full-width chat (agent-7). Shares the store with the side panel via useAgentChat(). */
export default function RagChatPage() {
  const chat = useAgentChat();
  const { pageContext } = usePageContext();
  const [showContext, setShowContext] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Focus the composer on arrival and whenever the active conversation changes.
  useEffect(() => {
    inputRef.current?.focus();
  }, [chat.activeConversationId]);

  return (
    <div className="flex h-[calc(100vh-7rem)] md:h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-background">
      <ChatSidebar
        className="hidden md:flex"
        conversations={chat.conversations}
        isLoading={chat.conversationsLoading}
        activeId={chat.activeConversationId}
        onSelect={chat.selectConversation}
        onNewChat={chat.newConversation}
        onDelete={(id) => void chat.deleteConversation(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4">
          <Bot className="h-4 w-4 text-primary" aria-hidden />
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">
            {chat.activeConversation?.title ?? 'New conversation'}
          </h1>
          <Button
            variant={showContext ? 'secondary' : 'ghost'}
            size="sm"
            className="hidden h-7 gap-1.5 px-2 text-xs lg:inline-flex"
            onClick={() => setShowContext((v) => !v)}
            aria-pressed={showContext}
          >
            <PanelRight className="h-3.5 w-3.5" aria-hidden />
            Activity
          </Button>
        </header>

        <ChatMainArea
          messages={chat.messages}
          pending={chat.pending}
          isStreaming={chat.isStreaming}
          isLoadingConversation={chat.isLoadingConversation}
          lastError={chat.lastError}
          emptyState={<ChatEmptyState />}
        />

        <ChatComposer
          ref={inputRef}
          onSend={(text) => chat.sendMessage(text, pageContext)}
          onStop={chat.stop}
          isStreaming={chat.isStreaming}
          suggestedPrompts={getSuggestedPrompts(pageContext)}
          showSuggestions={chat.messages.length === 0}
        />
      </main>

      <ChatContextPanel showContext={showContext} messages={chat.messages} isStreaming={chat.isStreaming} />
    </div>
  );
}
