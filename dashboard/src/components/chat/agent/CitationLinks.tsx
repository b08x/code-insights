import { Link } from 'react-router';
import { BookMarked } from 'lucide-react';

/** Cited sessions for one reply, each linking to /sessions/:id (agent-5). */
export function CitationLinks({ citations }: { citations: string[] }) {
  if (citations.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <BookMarked className="h-3 w-3" aria-hidden />
        Sources
      </span>
      {citations.map((id, i) => (
        <Link
          key={id}
          to={`/sessions/${id}`}
          className="rounded-md border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground/80 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`Open session ${id}`}
        >
          [{i + 1}] {id.slice(0, 8)}
        </Link>
      ))}
    </div>
  );
}
