// Agent chat state: conversations via TanStack Query, the in-flight turn via
// the /api/chat SSE contract. One store instance (AgentChatProvider in Layout)
// is shared by the side panel and the /chat page.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  createChatConversation,
  deleteChatConversation,
  fetchChatConversation,
  fetchChatConversations,
  postChatMessage,
} from '@/lib/api';
import { parseSSEStream } from '@/lib/sse';
import {
  applyChatStreamEvent,
  createPendingTurn,
  parseChatStreamEvent,
  pendingTurnToMessages,
  type PendingTurn,
} from '@/lib/chat-stream';
import type { ChatConversation, ChatMessage, PageContext } from '@/lib/types';

export const chatKeys = {
  all: ['chat'] as const,
  conversations: ['chat', 'conversations'] as const,
  conversation: (id: string) => ['chat', 'conversation', id] as const,
};

type ConversationDetail = { conversation: ChatConversation; messages: ChatMessage[] };

const ACTIVE_KEY = 'code-insights:chat:active-conversation';
const PANEL_KEY = 'code-insights:chat:panel-open';

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode) — state still works for this tab
  }
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('API 404');
}

export function useChatConversations() {
  return useQuery({
    queryKey: chatKeys.conversations,
    queryFn: fetchChatConversations,
    select: (d) => d.conversations,
  });
}

export function useChatConversation(id: string | null) {
  return useQuery({
    queryKey: chatKeys.conversation(id ?? ''),
    queryFn: () => fetchChatConversation(id as string),
    enabled: !!id,
    retry: (count, err) => !isNotFound(err) && count < 1,
  });
}

export interface ChatError {
  message: string;
  conversationId: string;
}

export interface AgentChatStore {
  conversations: ChatConversation[];
  conversationsLoading: boolean;
  activeConversationId: string | null;
  activeConversation: ChatConversation | null;
  /** Persisted messages for the active conversation plus the in-flight turn. */
  messages: ChatMessage[];
  /** The turn currently streaming (only when it belongs to the active conversation). */
  pending: PendingTurn | null;
  isStreaming: boolean;
  isLoadingConversation: boolean;
  lastError: ChatError | null;
  selectConversation: (id: string | null) => void;
  newConversation: () => void;
  deleteConversation: (id: string) => Promise<void>;
  /** Resolves true once the server accepted the message (stream started). */
  sendMessage: (content: string, pageContext?: PageContext | null) => Promise<boolean>;
  stop: () => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
}

/** Owns chat state. Call once (AgentChatProvider); consumers use useAgentChat(). */
export function useAgentChatStore(): AgentChatStore {
  const qc = useQueryClient();
  const [activeId, setActiveIdState] = useState<string | null>(() => readStorage(ACTIVE_KEY));
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const [lastError, setLastError] = useState<ChatError | null>(null);
  const [panelOpen, setPanelOpenState] = useState<boolean>(() => readStorage(PANEL_KEY) === '1');
  const abortRef = useRef<AbortController | null>(null);

  const setActiveId = useCallback((id: string | null) => {
    setActiveIdState(id);
    writeStorage(ACTIVE_KEY, id);
  }, []);

  const setPanelOpen = useCallback((open: boolean) => {
    setPanelOpenState(open);
    writeStorage(PANEL_KEY, open ? '1' : null);
  }, []);

  const togglePanel = useCallback(() => {
    setPanelOpenState((prev) => {
      writeStorage(PANEL_KEY, prev ? null : '1');
      return !prev;
    });
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const list = useChatConversations();
  const detail = useChatConversation(activeId);

  // A stored conversation that was deleted elsewhere: fall back to a fresh chat.
  useEffect(() => {
    if (activeId && detail.isError && isNotFound(detail.error)) setActiveId(null);
  }, [activeId, detail.isError, detail.error, setActiveId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const selectConversation = useCallback((id: string | null) => {
    abortRef.current?.abort();
    setLastError(null);
    setActiveId(id);
  }, [setActiveId]);

  const newConversation = useCallback(() => selectConversation(null), [selectConversation]);

  const deleteMutation = useMutation({
    mutationFn: deleteChatConversation,
    onSuccess: (_d, id) => {
      qc.removeQueries({ queryKey: chatKeys.conversation(id) });
      void qc.invalidateQueries({ queryKey: chatKeys.conversations });
    },
  });

  const deleteConversation = useCallback(async (id: string) => {
    if (id === activeId) selectConversation(null);
    try {
      await deleteMutation.mutateAsync(id);
      toast.success('Conversation deleted');
    } catch (err) {
      toast.error('Could not delete conversation', {
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [activeId, deleteMutation, selectConversation]);

  const sendMessage = useCallback(async (content: string, pageContext?: PageContext | null) => {
    const text = content.trim();
    if (!text || abortRef.current) return false;
    setLastError(null);

    let conversationId = activeId;
    if (!conversationId) {
      try {
        const { conversation } = await createChatConversation();
        conversationId = conversation.id;
        qc.setQueryData<ConversationDetail>(chatKeys.conversation(conversation.id), { conversation, messages: [] });
        setActiveId(conversation.id);
      } catch (err) {
        toast.error('Could not start a conversation', {
          description: err instanceof Error ? err.message : undefined,
        });
        return false;
      }
    }

    const controller = new AbortController();
    abortRef.current = controller;
    let turn = createPendingTurn(conversationId, text, pageContext ?? null);
    setPending(turn);

    try {
      const res = await postChatMessage(conversationId, { content: text, pageContext: pageContext ?? null }, controller.signal);
      if (!res.body) throw new Error('Empty response from server');
      for await (const raw of parseSSEStream(res.body)) {
        const ev = parseChatStreamEvent(raw);
        if (!ev) continue;
        turn = applyChatStreamEvent(turn, ev);
        setPending(turn);
      }
      if (turn.status === 'connecting' || turn.status === 'streaming') {
        turn = { ...turn, status: 'error', error: 'The stream ended before the agent finished.' };
      }
    } catch (err) {
      if (controller.signal.aborted) {
        turn = { ...turn, status: 'aborted' };
      } else {
        turn = { ...turn, status: 'error', error: err instanceof Error ? err.message : 'Agent request failed' };
      }
    } finally {
      abortRef.current = null;
    }

    const key = chatKeys.conversation(conversationId);
    if (turn.status === 'done') {
      qc.setQueryData<ConversationDetail>(key, (old) =>
        old ? { ...old, messages: [...old.messages, ...pendingTurnToMessages(turn)] } : old);
      setPending(null);
      void qc.invalidateQueries({ queryKey: key });
    } else {
      if (turn.status === 'error') {
        setLastError({ message: turn.error ?? 'Agent error', conversationId });
        toast.error('Agent chat failed', { description: turn.error ?? undefined });
      }
      // Server persists the user turn and any partial reply; resync before dropping the local copy.
      await qc.invalidateQueries({ queryKey: key });
      setPending(null);
      if (turn.status === 'aborted') {
        // Partial reply is written after the server notices the disconnect.
        setTimeout(() => void qc.invalidateQueries({ queryKey: key }), 750);
      }
    }
    void qc.invalidateQueries({ queryKey: chatKeys.conversations });
    return turn.userMessageId !== null;
  }, [activeId, qc, setActiveId]);

  const activePending = pending && pending.conversationId === activeId ? pending : null;

  const messages = useMemo(() => {
    const base = detail.data?.messages ?? [];
    if (!activePending) return base;
    // Show the in-flight turn; dedupe in case a refetch already returned its user message.
    const extra = pendingTurnToMessages(activePending).filter((m) => !base.some((b) => b.id === m.id));
    if (activePending.status !== 'done' && !extra.some((m) => m.role === 'assistant')) {
      extra.push({
        id: `pending-assistant-${activePending.startedAt}`,
        conversationId: activePending.conversationId,
        role: 'assistant',
        content: '',
        context: null,
        toolCalls: { toolCalls: [], citations: [], drafts: [] },
        createdAt: activePending.startedAt,
      });
    }
    return [...base, ...extra];
  }, [detail.data, activePending]);

  const conversations = list.data ?? [];

  return {
    conversations,
    conversationsLoading: list.isLoading,
    activeConversationId: activeId,
    activeConversation: detail.data?.conversation ?? conversations.find((c) => c.id === activeId) ?? null,
    messages,
    pending: activePending,
    isStreaming: pending !== null && (pending.status === 'connecting' || pending.status === 'streaming'),
    isLoadingConversation: !!activeId && detail.isLoading,
    lastError: lastError && lastError.conversationId === activeId ? lastError : null,
    selectConversation,
    newConversation,
    deleteConversation,
    sendMessage,
    stop,
    panelOpen,
    setPanelOpen,
    togglePanel,
  };
}

export const AgentChatContext = createContext<AgentChatStore | null>(null);

/** Shared chat store for the side panel and /chat page. Requires AgentChatProvider. */
export function useAgentChat(): AgentChatStore {
  const ctx = useContext(AgentChatContext);
  if (!ctx) throw new Error('useAgentChat must be used inside AgentChatProvider');
  return ctx;
}
