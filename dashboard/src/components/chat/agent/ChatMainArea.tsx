import React, { useRef, useEffect, useState } from 'react';
import { Bot, Send, Paperclip, Mic, Sparkles, Loader2, Copy, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import ReactMarkdown from 'react-markdown';
import type { Message, Clarification } from '@/hooks/useAgentChat';

interface ChatMainAreaProps {
  input: string;
  setInput: (value: string) => void;
  messages: Message[];
  isLoading: boolean;
  clarification: Clarification | null;
  sendMessage: (textToSubmit?: string) => void;
}

export function ChatMainArea({
  input,
  setInput,
  messages,
  isLoading,
  clarification,
  sendMessage,
}: ChatMainAreaProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = (e?: React.FormEvent, textToSubmit?: string) => {
    e?.preventDefault();
    sendMessage(textToSubmit);
  };

  return (
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
                {clarification.details.choices.map((choice: string | { label: string; value: string }, idx: number) => {
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
  );
}
