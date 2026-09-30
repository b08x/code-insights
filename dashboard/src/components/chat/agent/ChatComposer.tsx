import { forwardRef, useId, useState, type KeyboardEvent } from 'react';
import { Send, Sparkles, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ChatComposerProps {
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
  isStreaming: boolean;
  suggestedPrompts?: string[];
  /** Show prompt chips only while the conversation is empty. */
  showSuggestions?: boolean;
  placeholder?: string;
  compact?: boolean;
}

/**
 * Message input shared by the side panel and /chat page.
 * Enter sends, Shift+Enter inserts a newline. While streaming, the send button becomes Stop.
 */
export const ChatComposer = forwardRef<HTMLTextAreaElement, ChatComposerProps>(function ChatComposer(
  { onSend, onStop, isStreaming, suggestedPrompts = [], showSuggestions = true, placeholder = 'Ask about your sessions…', compact = false },
  ref,
) {
  const [value, setValue] = useState('');
  const inputId = useId();
  const hintId = useId();

  const submit = async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isStreaming) return;
    setValue('');
    const accepted = await onSend(trimmed);
    // Rejected before the server stored it (e.g. no LLM key): give the text back.
    if (!accepted) setValue((current) => (current ? current : trimmed));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit(value);
    }
  };

  return (
    <div className={cn('border-t bg-background', compact ? 'p-3' : 'p-4')}>
      {showSuggestions && suggestedPrompts.length > 0 && (
        <div className={cn('mb-2 flex flex-wrap gap-1.5', !compact && 'max-w-3xl mx-auto')} aria-label="Suggested prompts">
          {suggestedPrompts.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={isStreaming}
              onClick={() => void submit(prompt)}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Sparkles className="h-3 w-3" aria-hidden />
              {prompt}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit(value);
        }}
        className={cn('flex items-end gap-2 rounded-lg border bg-card px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring/50', !compact && 'max-w-3xl mx-auto')}
      >
        <label htmlFor={inputId} className="sr-only">Message the agent</label>
        <textarea
          ref={ref}
          id={inputId}
          rows={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-describedby={hintId}
          className="field-sizing-content max-h-40 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
        />
        {isStreaming ? (
          <Button type="button" size="icon-sm" variant="outline" onClick={onStop} aria-label="Stop generating">
            <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
          </Button>
        ) : (
          <Button type="submit" size="icon-sm" disabled={!value.trim()} aria-label="Send message">
            <Send className="h-3.5 w-3.5" aria-hidden />
          </Button>
        )}
      </form>
      <p id={hintId} className={cn('mt-1.5 text-[10px] text-muted-foreground', !compact && 'max-w-3xl mx-auto')}>
        Enter to send · Shift+Enter for a new line · The agent reads your data; drafts are saved only when you click Save.
      </p>
    </div>
  );
});
