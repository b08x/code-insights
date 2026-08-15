import { useState, useMemo } from 'react';
import { Bot, Send, Paperclip, Mic, Sparkles, BookOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentChat } from '@/hooks/useAgentChat';
import { ChatSidebar } from '@/components/chat/agent/ChatSidebar';
import { ChatContextPanel } from '@/components/chat/agent/ChatContextPanel';
import { ChatMainArea } from '@/components/chat/agent/ChatMainArea';
import { useSessions } from '@/hooks/useSessions';

export default function RagChatPage() {
  const {
    input,
    setInput,
    messages,
    isLoading,
    clarification,
    liveMetrics,
    sendMessage,
    clearMessages,
  } = useAgentChat();

  const [activeSession, setActiveSession] = useState(1);
  const [showContext, setShowContext] = useState(true);

  const { data: sessions } = useSessions({ limit: 5 });

  const suggestedPrompts = useMemo(() => {
    if (!sessions || sessions.length === 0) {
      return ['Summarize my recent sessions', 'Find bugs from last week'];
    }
    
    const prompts: string[] = [];
    
    const recentSession = sessions[0];
    const title = recentSession.custom_title || recentSession.generated_title || recentSession.project_name || 'my recent work';
    prompts.push(`Summarize my work on "${title}"`);
    
    if (sessions.length > 1) {
      const secondSession = sessions[1];
      const secondTitle = secondSession.custom_title || secondSession.generated_title || secondSession.project_name || 'recent changes';
      prompts.push(`What did I do in "${secondTitle}"?`);
    } else {
      prompts.push('Find bugs from last week');
    }
    
    return prompts;
  }, [sessions]);

  const handleSubmit = (e?: React.FormEvent, textToSubmit?: string) => {
    e?.preventDefault();
    sendMessage(textToSubmit);
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-background">
      <ChatSidebar 
        activeSession={activeSession} 
        setActiveSession={setActiveSession} 
        onNewChat={clearMessages} 
      />

      {/* CENTER - Chat Area */}
      <main className="flex-1 flex flex-col relative bg-gradient-to-b from-background to-muted/20">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/5 rounded-full blur-3xl pointer-events-none animate-pulse duration-[10s]" />
        
        {/* Header */}
        <header className="h-14 border-b bg-background/80 backdrop-blur-md flex items-center justify-between px-6 z-10">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-primary to-blue-500 flex items-center justify-center text-white shadow-sm">
                <Bot className="w-4 h-4" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-emerald-500 rounded-full border-2 border-background" />
            </div>
            <div>
              <h2 className="font-semibold text-sm leading-none">Knowledge Agent</h2>
              <span className="text-xs text-muted-foreground hidden sm:inline-block mt-1">SFL-Compliant Insights Engine</span>
            </div>
          </div>
          <button 
            onClick={() => setShowContext(!showContext)}
            className={cn(
              "text-xs px-3 py-1.5 rounded-full border transition-all duration-300 flex items-center gap-1.5",
              showContext ? "bg-primary/10 text-primary border-primary/20" : "hover:bg-muted text-muted-foreground"
            )}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Context Panel</span>
          </button>
        </header>

        {/* Chat History */}
        <ChatMainArea 
          input={input}
          setInput={setInput}
          messages={messages}
          isLoading={isLoading}
          clarification={clarification}
          sendMessage={sendMessage}
        />

        {/* Input Area */}
        <div className="p-4 bg-background/80 backdrop-blur-xl border-t z-20">
          <form 
            onSubmit={handleSubmit}
            className="max-w-3xl mx-auto relative group"
          >
            <div className="absolute -inset-0.5 bg-gradient-to-r from-primary to-blue-500 rounded-xl blur opacity-20 group-focus-within:opacity-40 transition duration-500" />
            <div className="relative flex items-center bg-card border shadow-sm rounded-xl px-2 py-2">
              <button type="button" className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted">
                <Paperclip className="w-5 h-5" />
              </button>
              <input 
                type="text" 
                placeholder={clarification ? "Please provide clarification..." : "Ask the Knowledge Agent..."}
                className="flex-1 bg-transparent border-none focus:outline-none px-3 text-sm"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={isLoading}
              />
              <button type="button" className="p-2 text-muted-foreground hover:text-foreground transition-colors rounded-lg hover:bg-muted mr-1">
                <Mic className="w-5 h-5" />
              </button>
              <button 
                type="submit"
                disabled={isLoading || (!input.trim() && !clarification)}
                className={cn(
                  "p-2 rounded-lg transition-all duration-300 shadow-sm",
                  input.trim() && !isLoading
                    ? "bg-primary text-primary-foreground hover:bg-primary/90 hover:scale-105" 
                    : "bg-muted text-muted-foreground pointer-events-none"
                )}
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </form>
          <div className="max-w-3xl mx-auto flex gap-2 mt-3 overflow-x-auto scrollbar-none pb-2">
            {suggestedPrompts.map((prompt: string) => (
              <button 
                key={prompt} 
                onClick={() => handleSubmit(undefined, prompt)}
                className="text-[11px] whitespace-nowrap bg-muted/50 border hover:bg-muted px-3 py-1.5 rounded-full text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
              >
                <Sparkles className="w-3 h-3" />
                {prompt}
              </button>
            ))}
          </div>
        </div>
      </main>

      <ChatContextPanel showContext={showContext} liveMetrics={liveMetrics} />
    </div>
  );
}
