import type { ReactNode } from 'react';
import { AgentChatContext, useAgentChatStore } from '@/hooks/useAgentChat';

/** Single chat store shared by the side panel and the /chat page. Mounted in Layout. */
export function AgentChatProvider({ children }: { children: ReactNode }) {
  const store = useAgentChatStore();
  return <AgentChatContext.Provider value={store}>{children}</AgentChatContext.Provider>;
}
