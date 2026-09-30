import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Header } from './Header';
import { CommandPalette } from '@/components/search/CommandPalette';
import { useCommandPalette } from '@/hooks/useCommandPalette';
import { useAgentChat } from '@/hooks/useAgentChat';
import { AgentChatProvider } from '@/components/chat/panel/AgentChatProvider';
import { PageContextProvider } from '@/components/chat/panel/PageContextProvider';
import { ChatPanel } from '@/components/chat/panel/ChatPanel';
import { cn } from '@/lib/utils';

export function Layout() {
  return (
    <TooltipProvider>
      <PageContextProvider>
        <AgentChatProvider>
          <LayoutShell />
        </AgentChatProvider>
      </PageContextProvider>
    </TooltipProvider>
  );
}

function LayoutShell() {
  const { isOpen, open, close } = useCommandPalette();
  const { panelOpen, togglePanel } = useAgentChat();
  const { pathname } = useLocation();
  // The full-page /chat view replaces the panel; both share one chat store.
  const panelAvailable = !pathname.startsWith('/chat');
  const showPanel = panelAvailable && panelOpen;

  // Global shortcuts: Cmd/Ctrl+K search, Cmd/Ctrl+J agent chat panel
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key === 'k') {
        e.preventDefault();
        open();
      } else if (e.key === 'j' && panelAvailable) {
        e.preventDefault();
        togglePanel();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, togglePanel, panelAvailable]);

  return (
    <div className="min-h-screen bg-background">
      <Header onOpenSearch={open} chatPanelAvailable={panelAvailable} />
      {/* pt-14 accounts for the fixed header height; pb-14 accounts for mobile bottom nav.
          md:pr reserves room for the docked chat panel so page content stays usable. */}
      <main className={cn('pt-14 pb-14 md:pb-0', showPanel && 'md:pr-[420px]')}>
        <Outlet />
      </main>
      {showPanel && <ChatPanel />}
      <Toaster />
      <CommandPalette isOpen={isOpen} onClose={close} />
    </div>
  );
}
