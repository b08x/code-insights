import { Bot } from 'lucide-react';

export function ChatEmptyState({ contextLabel }: { contextLabel?: string | null }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <Bot className="h-8 w-8 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">Ask about your sessions</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        The agent searches your local sessions, insights, and analytics and cites the sessions it used.
        {contextLabel ? ` It knows you are viewing ${contextLabel}.` : ''}
      </p>
    </div>
  );
}
