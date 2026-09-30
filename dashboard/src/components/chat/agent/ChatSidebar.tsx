import { useState } from 'react';
import { MessageSquare, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { formatRelativeDate } from '@/lib/date-utils';
import type { ChatConversation } from '@/lib/types';

interface ChatSidebarProps {
  conversations: ChatConversation[];
  isLoading: boolean;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  onDelete: (id: string) => void;
  className?: string;
}

/** Persisted conversation list (agent-6). Used by the /chat page. */
export function ChatSidebar({ conversations, isLoading, activeId, onSelect, onNewChat, onDelete, className }: ChatSidebarProps) {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const confirmTarget = conversations.find((c) => c.id === confirmId);

  return (
    <aside className={cn('flex w-64 shrink-0 flex-col border-r bg-muted/20', className)} aria-label="Conversations">
      <div className="p-3">
        <Button onClick={onNewChat} size="sm" className="w-full gap-1.5">
          <Plus className="h-4 w-4" aria-hidden />
          New chat
        </Button>
      </div>
      <div className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Recent</div>
      <nav className="flex-1 overflow-y-auto px-2 pb-3">
        {isLoading ? (
          <div className="space-y-2 px-1 pt-1">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full" />)}
          </div>
        ) : conversations.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">No conversations yet. Ask a question to start one.</p>
        ) : (
          <ul className="space-y-0.5">
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id} className="group/conv relative">
                  <button
                    type="button"
                    onClick={() => onSelect(c.id)}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'flex w-full items-start gap-2 rounded-md px-2 py-1.5 pr-8 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                    )}
                  >
                    <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{c.title}</span>
                      <span className="block text-[10px] opacity-70">{formatRelativeDate(c.updatedAt)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmId(c.id)}
                    aria-label={`Delete conversation "${c.title}"`}
                    className="absolute right-1 top-1.5 rounded p-1 text-muted-foreground opacity-0 hover:bg-muted hover:text-destructive group-hover/conv:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </nav>

      <AlertDialog open={confirmId !== null} onOpenChange={(open) => !open && setConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
            <AlertDialogDescription>
              &ldquo;{confirmTarget?.title}&rdquo; and its messages will be removed permanently.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (confirmId) onDelete(confirmId);
                setConfirmId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}
