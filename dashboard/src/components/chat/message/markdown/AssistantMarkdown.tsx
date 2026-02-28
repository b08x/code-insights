import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter';
import { CopyButton } from '../CopyButton';
import { cn } from '@/lib/utils';
import { preprocessInsightBlocks } from '../preprocess';

interface AssistantMarkdownProps {
  content: string;
  codeStyle: SyntaxHighlighterProps['style'];
}

export function AssistantMarkdown({ content, codeStyle }: AssistantMarkdownProps) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none [&_p]:my-1">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          blockquote({ children }) {
            return (
              <div className="my-3 rounded-lg border border-purple-500/20 bg-purple-500/5 px-4 py-3 not-prose">
                {children}
              </div>
            );
          },
          table({ children }) {
            return (
              <div className="my-3 overflow-x-auto">
                <table className="min-w-full text-sm border-collapse border border-border">
                  {children}
                </table>
              </div>
            );
          },
          th({ children }) {
            return (
              <th className="border border-border bg-muted/50 px-3 py-1.5 text-left text-xs font-medium">
                {children}
              </th>
            );
          },
          td({ children }) {
            return (
              <td className="border border-border px-3 py-1.5 text-sm">
                {children}
              </td>
            );
          },
          code(props) {
            const { children, className, ...rest } = props;
            const langMatch = /language-(\w+)/.exec(className || '');
            const isBlock = !!langMatch;
            const codeString = String(children).replace(/\n$/, '');
            if (isBlock) {
              return (
                <div className="relative group/code my-3">
                  <div className="flex items-center justify-between px-4 py-1.5 bg-muted rounded-t-lg border-b border-border">
                    <span className="text-xs text-muted-foreground">{langMatch[1]}</span>
                  </div>
                  <CopyButton text={codeString} />
                  <SyntaxHighlighter
                    style={codeStyle}
                    language={langMatch[1]}
                    PreTag="div"
                    customStyle={{ marginTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}
                  >
                    {codeString}
                  </SyntaxHighlighter>
                </div>
              );
            }
            return (
              <code className={cn('px-1.5 py-0.5 rounded bg-muted text-sm', className)} {...rest}>
                {children}
              </code>
            );
          },
        }}
      >
        {preprocessInsightBlocks(content)}
      </ReactMarkdown>
    </div>
  );
}
