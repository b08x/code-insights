import { Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ChatSidebarProps {
  activeSession: number;
  setActiveSession: (id: number) => void;
  onNewChat: () => void;
}

export function ChatSidebar({ activeSession, setActiveSession, onNewChat }: ChatSidebarProps) {
  // Hardcoded for now based on original RagChatPage.tsx
  const sessions = [
    { id: 1, title: 'Contextual Query #4', time: 'Just now' },
  ];

  return (
    <aside className="w-64 flex-shrink-0 border-r bg-muted/30 backdrop-blur-xl flex flex-col h-full transition-all duration-300 relative overflow-hidden hidden md:flex">
      <div className="absolute top-0 left-0 right-0 h-32 bg-gradient-to-b from-primary/10 to-transparent pointer-events-none" />
      <div className="p-4 z-10">
        <button 
          onClick={onNewChat} 
          className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-primary to-blue-600 hover:from-primary/90 hover:to-blue-600/90 text-primary-foreground py-2.5 px-4 rounded-xl font-medium shadow-md shadow-primary/20 transition-all active:scale-95 group"
        >
          <Plus className="w-4 h-4 group-hover:rotate-90 transition-transform duration-300" />
          New Chat
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1 z-10 scrollbar-thin">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Recent Sessions</div>
        {sessions.map((session) => (
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
  );
}
