import { Search, FolderSearch } from 'lucide-react';
import type { ToolCall, ToolResult } from '@/lib/types';
import { parseToolInput } from '../utils';
import { usePreviewLines } from '../usePreview';
import { ToolPanelHeader } from './ToolPanelHeader';

interface SearchToolPanelProps {
  toolCall: ToolCall;
  result?: ToolResult;
}

export function SearchToolPanel({ toolCall, result }: SearchToolPanelProps) {
  const input = parseToolInput(toolCall.input);
  const isGrep = toolCall.name === 'Grep';
  const Icon = isGrep ? Search : FolderSearch;

  const pattern = (input.pattern as string) || '';
  const searchPath = (input.path as string) || '';

  const resultText = result?.output || '';
  const resultLines = resultText.split('\n').filter(l => l.trim());
  const PREVIEW_LINES = 15;
  const { hasMore, previewLines, showFull, toggle } = usePreviewLines(resultLines, PREVIEW_LINES);

  return (
    <div className="my-2 rounded-lg border border-border overflow-hidden">
      <ToolPanelHeader
        className="bg-muted/60 border-border"
        icon={<Icon className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
        title={isGrep ? 'Search' : 'Find Files'}
        meta={(
          <code className="text-xs font-mono bg-amber-500/10 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded truncate">
            {pattern}
          </code>
        )}
        rightContent={searchPath ? (
          <span className="text-[10px] text-muted-foreground/60 truncate" title={searchPath}>
            in {searchPath}
          </span>
        ) : null}
      />

      {resultText ? (
        <div className="px-3 py-2">
          <div className="space-y-0.5">
            {previewLines.map((line, i) => (
              <div key={i} className="text-xs font-mono text-muted-foreground truncate" title={line}>
                {line}
              </div>
            ))}
          </div>
          {hasMore && (
            <button
              onClick={toggle}
              className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-700 mt-1.5"
            >
              {showFull ? 'Show less' : `Show all (${resultLines.length} results)`}
            </button>
          )}
        </div>
      ) : (
        <div className="px-3 py-1.5 text-xs text-muted-foreground italic">
          No matches found
        </div>
      )}
    </div>
  );
}
