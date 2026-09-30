import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { PageContext } from '@/lib/types';

interface PageContextValue {
  /** Effective context: route-derived page type merged with whatever the page registered. */
  pageContext: PageContext;
  setPageContext: (ctx: PageContext | null) => void;
}

const PageContextCtx = createContext<PageContextValue | null>(null);

/** Map first path segment to a page type, e.g. /sessions/abc -> 'session', /sessions -> 'sessions'. */
function pageFromPath(pathname: string): string {
  const [first, second] = pathname.split('/').filter(Boolean);
  if (!first) return 'dashboard';
  if (first === 'sessions' && second) return 'session';
  return first;
}

export function PageContextProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [registered, setRegistered] = useState<PageContext | null>(null);

  const pageContext = useMemo<PageContext>(
    () => ({ page: pageFromPath(pathname), ...(registered ?? {}) }),
    [pathname, registered],
  );

  const value = useMemo(() => ({ pageContext, setPageContext: setRegistered }), [pageContext]);
  return <PageContextCtx.Provider value={value}>{children}</PageContextCtx.Provider>;
}

export function usePageContext(): PageContextValue {
  const ctx = useContext(PageContextCtx);
  if (!ctx) throw new Error('usePageContext must be used inside PageContextProvider');
  return ctx;
}

/**
 * Register page-specific context (IDs) for the chat panel while the calling
 * page is mounted. Cleared on unmount so stale IDs never leak to other pages.
 */
export function useRegisterPageContext(ctx: PageContext | null) {
  const { setPageContext } = usePageContext();
  // Serialize so callers can pass object literals without re-running every render.
  const key = ctx ? JSON.stringify(ctx) : null;
  useEffect(() => {
    setPageContext(key ? (JSON.parse(key) as PageContext) : null);
    return () => setPageContext(null);
  }, [key, setPageContext]);
}
