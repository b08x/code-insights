import ReactMarkdown from 'react-markdown';
import { Brain } from 'lucide-react';

interface ThinkingBlockProps {
  thinking: string;
}

/**
 * Always-expanded block showing Claude's internal reasoning (thinking content).
 */
export function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  return (
    <div className="mb-3 rounded-lg bg-amber-500/5 border border-amber-400/20 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400 font-medium mb-2">
        <Brain className="h-3 w-3" />
        <span>Thinking</span>
      </div>
      <div className="text-sm text-muted-foreground italic prose prose-sm dark:prose-invert max-w-none [&_p]:my-1 [&_strong]:not-italic [&_strong]:text-amber-700 dark:[&_strong]:text-amber-300">
        <ReactMarkdown>{thinking}</ReactMarkdown>
      </div>
    </div>
  );
}
