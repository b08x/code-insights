import ReactMarkdown from 'react-markdown';
import { preprocessUserContent } from '../preprocess';

interface UserMarkdownProps {
  content: string;
}

export function UserMarkdown({ content }: UserMarkdownProps) {
  return (
    <div className="prose prose-sm max-w-none [&_p]:my-1 dark:prose-invert">
      <ReactMarkdown>{preprocessUserContent(content)}</ReactMarkdown>
    </div>
  );
}
