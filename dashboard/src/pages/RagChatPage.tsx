import { useState, useRef, useEffect } from 'react';
import { Bot, Send, Paperclip, Mic, Plus, Sparkles, BookOpen, FileText, Database, Loader2, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';

interface Message {
  role: 'user' | 'assistant';
  content: string;
}

export default function RagChatPage() {
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Hello! I can analyze your local code-insights sessions to extract SFL-compliant insights. What would you like to know?' }
  ]);
  const [activeSession, setActiveSession] = useState(1);
  const [showContext, setShowContext] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [savedState, setSavedState] = useState<any>(null);
  const [clarification, setClarification] = useState<any>(null);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e?: React.FormEvent, textToSubmit?: string) => {
    e?.preventDefault();
    const text = textToSubmit || input;
    if (!text.trim() && !clarification) return;

    const userMessage = { role: 'user' as const, content: text };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const payload = clarification 
        ? { answer: text, savedState } 
        : { request: text };

      // Clear clarification state if we are answering one
      if (clarification) {
        setClarification(null);
        setSavedState(null);
      }

      const response = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        throw new Error('Network response was not ok');
      }

      const contentType = response.headers.get('content-type');
      
      if (contentType && contentType.includes('application/json')) {
        // We received a clarification JSON object
        const data = await response.json();
        if (data.type === 'clarification') {
          setClarification({
            question: data.question,
            details: data.clarificationDetails
          });
          setSavedState(data.savedState);
          setIsLoading(false);
          return; // Wait for user to answer
        }
      }

      // Handle streaming text
      const reader = response.body?.getReader();
      const decoder = new TextDecoder('utf-8');
      
      if (!reader) throw new Error('No reader available');
      
      setMessages((prev) => [...prev, { role: 'assistant', content: '' }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        
        setMessages((prev) => {
          const newMessages = [...prev];
          const lastIndex = newMessages.length - 1;
          newMessages[lastIndex].content += chunk;
          return newMessages;
        });
      }
    } catch (error) {
      console.error('Failed to fetch:', error);
      setMessages((prev) => [...prev, { role: 'assistant', content: 'An error occurred while communicating with the agent. Check the console and server logs.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] w-full overflow-hidden bg-background">
      {/* LEFT SIDEBAR - Sessions */}
      <aside className="w-64 flex-shrink-0 border-r bg-muted/30 backdrop-blur-xl flex flex-col h-full transition-all duration-300 relative overflow-hidden hidden md:flex">
        <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-primary/10 to-transparent pointer-events-none" />
        <div className="p-4 z-10">
          <button onClick={() => setMessages([])} className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-600/90 text-primary-foreground py-2.5 px-4 rounded-xl font-medium shadow-md shadow-primary/20 transition-all active:scale-95 group">
            <Plus className="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
            New Chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 z-10 scrollbar-thin">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Recent Sessions</div>
          {[
            { id: 1, title: 'Contextual Query #4', time: 'Just now' },
          ].map((session) => (
            <button
              key={session.id}
              onClick={() => setActiveSession(session.id)}
              className={cn(
                "w-full flex flex-col items-start px-3 py-2.5 rounded-lg text-sm transition-all duration-200 text-left border border-transparent",
                activeSession === session.id 
                  ? "bg-background shadow-sm border-border/50 text-foreground" 
                  : "hover:bg-muted text-muted-foreground hover:text-foreground"
              )}
            >
              <span className="font-medium truncate w-full">{session.title}</span>
              <span className="text-[10px] opacity-70 mt-1">{session.time}</span>
            </button>
          ))}
        </div>
      </aside>

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
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6 z-10 scroll-smooth pb-24 md:pb-6">
          
          {messages.map((msg, index) => (
            <div key={index} className={cn(
              "flex gap-4 max-w-3xl mx-auto w-full animate-in fade-in slide-in-from-bottom-2",
              msg.role === 'user' ? "justify-end" : ""
            )}>
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-muted border flex items-center justify-center flex-shrink-0 mt-1 hidden sm:flex">
                  <Sparkles className="w-4 h-4 text-primary" />
                </div>
              )}
              <div className="group relative max-w-[95%] md:max-w-[85%] flex flex-col gap-1 w-full">
                <div className={cn(
                  "px-5 py-4 shadow-sm space-y-3 prose dark:prose-invert prose-sm w-full",
                  msg.role === 'user' 
                    ? "bg-primary text-primary-foreground rounded-2xl rounded-tr-sm ml-auto" 
                    : "bg-card border rounded-2xl rounded-tl-sm text-card-foreground mr-auto"
                )}>
                  <ReactMarkdown>{msg.content}</ReactMarkdown>
                </div>
                {msg.role === 'assistant' && (
                  <div className="flex justify-start opacity-0 group-hover:opacity-100 transition-opacity -mt-1 mb-1">
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(msg.content);
                        setCopiedMessageIndex(index);
                        setTimeout(() => setCopiedMessageIndex(null), 2000);
                      }}
                      className="flex items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
                      title="Copy as Markdown"
                    >
                      {copiedMessageIndex === index ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                          <span className="text-emerald-500">Copied</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>Copy Markdown</span>
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="flex gap-4 max-w-3xl mx-auto w-full animate-in fade-in">
              <div className="w-8 h-8 rounded-full bg-muted border flex items-center justify-center flex-shrink-0 mt-1">
                <Loader2 className="w-4 h-4 text-primary animate-spin" />
              </div>
              <div className="bg-card border shadow-sm px-5 py-4 rounded-2xl rounded-tl-sm text-sm text-muted-foreground flex items-center gap-2">
                Analyzing session database...
              </div>
            </div>
          )}
          
          {/* Clarification prompt */}
          {clarification && (
            <div className="flex gap-4 max-w-3xl mx-auto w-full animate-in fade-in">
              <div className="w-8 h-8 rounded-full bg-orange-100 border-orange-200 flex items-center justify-center flex-shrink-0 mt-1">
                <Bot className="w-4 h-4 text-orange-600" />
              </div>
              <div className="bg-orange-50/50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 shadow-sm px-5 py-4 rounded-2xl rounded-tl-sm text-sm flex flex-col gap-3 max-w-[85%]">
                <p className="font-medium text-orange-800 dark:text-orange-300">
                  {clarification.question}
                </p>
                {clarification.details?.type === 'single_choice' && clarification.details.choices && (
                  <div className="flex flex-wrap gap-2 mt-2">
                    {clarification.details.choices.map((choice: any, idx: number) => {
                      const label = typeof choice === 'string' ? choice : choice.label;
                      const value = typeof choice === 'string' ? choice : choice.value;
                      return (
                        <button
                          key={idx}
                          onClick={() => handleSubmit(undefined, value)}
                          className="bg-background border shadow-sm px-3 py-1.5 rounded-lg hover:bg-orange-100 hover:text-orange-900 transition-colors"
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <div className="p-4 bg-background/80 backdrop-blur-xl border-t z-10">
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto relative group">
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
            {['Summarize my React sessions', 'Find bugs from last week'].map(prompt => (
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

      {/* RIGHT SIDEBAR - Context & Metadata */}
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
          <div className="text-xs text-muted-foreground italic mb-2">
            Metadata and context visualization will appear here during active tool usage.
          </div>
        </div>
      </aside>
    </div>
  );
}
