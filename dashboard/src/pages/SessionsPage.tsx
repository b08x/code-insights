import {
  useMemo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { ImperativePanelGroupHandle, ImperativePanelHandle, PanelGroupStorage } from 'react-resizable-panels';
import { useMissingFacets } from '@/hooks/useFacets';
import { useSessions } from '@/hooks/useSessions';
import { useProjects } from '@/hooks/useProjects';
import { useInsights } from '@/hooks/useInsights';
import { useFilterParams } from '@/hooks/useFilterParams';
import { ProjectNav } from '@/components/sessions/ProjectNav';
import { SessionListPanel } from '@/components/sessions/SessionListPanel';
import { SessionDetailPanel } from '@/components/sessions/SessionDetailPanel';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  ArrowLeft,
  ChevronDown,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Viewport breakpoint (below lg keeps the stacked list + Sheet behavior) ──

const lgQuery = typeof window !== 'undefined' ? window.matchMedia('(min-width: 1024px)') : null;
function subscribeLg(cb: () => void) {
  lgQuery?.addEventListener('change', cb);
  return () => lgQuery?.removeEventListener('change', cb);
}
function getIsLg() {
  return lgQuery?.matches ?? true;
}

// ── Pane sizing (pixels; converted to percentages of the measured container) ──
// The layout is chosen from the container width, not the viewport, so the page
// degrades gracefully when the docked chat panel takes 420px of the viewport.

const THREE_PANE_MIN_WIDTH = 1100;
const TWO_PANE_MIN_WIDTH = 720;

const NAV = { min: 160, default: 220, max: 320 };
const LIST = { min: 260, default: 340, max: 560 };
const DETAIL_MIN = 380;
const KEYBOARD_STEP_PX = 20;

type LayoutMode = 'stacked' | 'two' | 'three';

/** localStorage wrapper for persisted pane sizes; storage can throw in private mode. */
const safeStorage: PanelGroupStorage = {
  getItem(name) {
    try {
      return window.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem(name, value) {
    try {
      window.localStorage.setItem(name, value);
    } catch {
      // Persistence is a convenience; ignore quota / privacy-mode errors.
    }
  },
};

function useElementWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** Pixel value as a percentage of the group width, clamped to [0, 100]. */
function toPct(px: number, width: number) {
  return Math.max(0, Math.min(100, (px / width) * 100));
}

export default function SessionsPage() {
  const [filters, setFilter, setFilters] = useFilterParams({
    q: '',
    project: 'all',
    source: 'all',
    character: 'all',
    status: 'all',
    dateRange: 'all',
    dateFrom: '',
    dateTo: '',
    outcome: 'all',
    session: '',
  });

  const { data: projects = [], isLoading: projectsLoading } = useProjects();

  const sessionParams = useMemo(() => {
    const params: { projectId?: string; sourceTool?: string; limit?: number } = { limit: 200 };
    if (filters.project !== 'all') params.projectId = filters.project;
    if (filters.source !== 'all') params.sourceTool = filters.source;
    return params;
  }, [filters.project, filters.source]);

  const { data: sessions = [], isLoading: sessionsLoading } = useSessions(sessionParams);
  const { data: insights = [], isLoading: insightsLoading } = useInsights();

  const { data: missingFacetsData } = useMissingFacets();
  const missingFacetIds = useMemo(
    () => new Set(missingFacetsData?.sessionIds ?? []),
    [missingFacetsData]
  );

  const loading = sessionsLoading || projectsLoading || insightsLoading;

  const handleSelectProject = useCallback(
    (projectId: string) => {
      const currentSessionId = filters.session;
      if (currentSessionId && projectId !== 'all') {
        const currentSession = sessions.find((s) => s.id === currentSessionId);
        if (currentSession && currentSession.project_id !== projectId) {
          setFilters({ project: projectId, session: '' });
          return;
        }
      }
      setFilter('project', projectId);
    },
    [filters.session, sessions, setFilter, setFilters]
  );

  const handleSelectSource = useCallback(
    (source: string) => setFilter('source', source),
    [setFilter]
  );

  const handleSelectSession = useCallback(
    (sessionId: string) => {
      setFilter('session', sessionId);
    },
    [setFilter]
  );

  const handleCloseSession = useCallback(() => setFilter('session', ''), [setFilter]);

  const handleFilterChange = useCallback(
    (key: 'q' | 'character' | 'status' | 'dateRange' | 'dateFrom' | 'dateTo' | 'outcome', value: string) => {
      setFilter(key, value);
    },
    [setFilter]
  );

  const handleSetFilters = useCallback(
    (updates: Record<string, string>) => {
      setFilters(updates as Parameters<typeof setFilters>[0]);
    },
    [setFilters]
  );

  const handleClearFilters = useCallback(() => {
    setFilters({ q: '', character: 'all', status: 'all', dateRange: 'all', dateFrom: '', dateTo: '', outcome: 'all' });
  }, [setFilters]);

  const selectedProjectName = useMemo(() => {
    if (filters.project === 'all') return 'All Projects';
    return projects.find((p) => p.id === filters.project)?.name ?? 'Project';
  }, [filters.project, projects]);

  const showProject = filters.project === 'all';
  const isLg = useSyncExternalStore(subscribeLg, getIsLg);
  const [containerRef, containerWidth] = useElementWidth<HTMLDivElement>();

  const mode: LayoutMode =
    !isLg || containerWidth === null || containerWidth < TWO_PANE_MIN_WIDTH
      ? 'stacked'
      : containerWidth >= THREE_PANE_MIN_WIDTH
        ? 'three'
        : 'two';

  // ── Resizable group state ──
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  const navRef = useRef<ImperativePanelHandle>(null);
  const [navCollapsed, setNavCollapsed] = useState(false);

  const width = containerWidth ?? 0;
  const sizes = useMemo(() => {
    if (width <= 0) return null;
    const navDefault = toPct(NAV.default, width);
    const listDefault = toPct(LIST.default, width);
    // Leave room for the detail pane's minimum, whatever the other panes do.
    const listMaxPx = mode === 'three' ? LIST.max : Math.min(LIST.max, width - DETAIL_MIN);
    return {
      nav: { min: toPct(NAV.min, width), max: toPct(NAV.max, width), default: navDefault },
      list: { min: toPct(LIST.min, width), max: toPct(listMaxPx, width), default: listDefault },
      detailMin: toPct(DETAIL_MIN, width),
      // Arrow keys on a focused handle move it ~20px instead of the default 10%.
      keyboardStep: toPct(KEYBOARD_STEP_PX, width),
      defaultLayout:
        mode === 'three'
          ? [navDefault, listDefault, 100 - navDefault - listDefault]
          : [listDefault, 100 - listDefault],
    };
  }, [width, mode]);

  const handleResetLayout = useCallback(() => {
    if (sizes) groupRef.current?.setLayout(sizes.defaultLayout);
  }, [sizes]);

  const handleLayout = useCallback(
    (layout: number[]) => {
      if (mode === 'three') setNavCollapsed(layout[0] === 0);
    },
    [mode]
  );

  const toggleNav = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    if (nav.isCollapsed()) nav.expand();
    else nav.collapse();
  }, []);

  // ── Shared pane content ──

  const projectNav = (
    <ProjectNav
      projects={projects}
      selectedProject={filters.project}
      selectedSource={filters.source}
      onSelectProject={handleSelectProject}
      onSelectSource={handleSelectSource}
    />
  );

  const projectSheet = (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 min-w-0 max-w-full justify-start gap-1 px-2 text-xs font-medium"
          aria-label={`Project: ${selectedProjectName}. Change project`}
        >
          <span className="truncate">{selectedProjectName}</span>
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="w-[260px] p-0">
        <SheetHeader className="px-4 py-3 border-b">
          <SheetTitle className="text-sm font-semibold">Projects</SheetTitle>
          <SheetDescription className="sr-only">Select a project</SheetDescription>
        </SheetHeader>
        {projectNav}
      </SheetContent>
    </Sheet>
  );

  const listPanel = (
    <SessionListPanel
      sessions={sessions}
      insights={insights}
      selectedSessionId={filters.session}
      showProject={showProject}
      projectId={filters.project || undefined}
      filters={{
        q: filters.q,
        character: filters.character,
        status: filters.status,
        dateRange: filters.dateRange,
        dateFrom: filters.dateFrom,
        dateTo: filters.dateTo,
        outcome: filters.outcome,
      }}
      onFilterChange={handleFilterChange}
      onSetFilters={handleSetFilters}
      onClearFilters={handleClearFilters}
      onSelectSession={handleSelectSession}
      loading={loading}
      missingFacetIds={missingFacetIds}
    />
  );

  const listHeader = (
    <PaneHeader
      title="Sessions"
      leading={
        mode === 'three' && navCollapsed ? (
          <IconAction label="Show projects" onClick={toggleNav}>
            <PanelLeftOpen className="h-3.5 w-3.5" />
          </IconAction>
        ) : null
      }
    >
      {mode === 'three' ? (
        <span className="truncate text-xs text-muted-foreground" title={selectedProjectName}>
          {selectedProjectName}
        </span>
      ) : (
        projectSheet
      )}
    </PaneHeader>
  );

  const detailPane = (
    <Pane>
      <PaneHeader title={filters.session ? 'Session' : 'Details'}>
        {filters.session && (
          <IconAction label="Close session" onClick={handleCloseSession}>
            <X className="h-3.5 w-3.5" />
          </IconAction>
        )}
      </PaneHeader>
      {filters.session ? (
        <div className="min-h-0 flex-1 overflow-y-auto" key={filters.session}>
          <SessionDetailPanel sessionId={filters.session} onDelete={handleCloseSession} />
        </div>
      ) : (
        <EmptyDetailState hasSessions={sessions.length > 0} loading={loading} />
      )}
    </Pane>
  );

  const handleProps = {
    onDoubleClick: handleResetLayout,
    title: 'Drag to resize. Double-click to reset.',
    className:
      'transition-colors data-[resize-handle-state=hover]:bg-primary/40 data-[resize-handle-state=drag]:bg-primary',
  };

  return (
    <div ref={containerRef} className="flex h-[calc(100vh-3.5rem)] w-full min-w-0 overflow-hidden bg-background">
      {mode === 'stacked' || !sizes ? (
        <>
          <Pane className="w-full">
            {listHeader}
            <div className="min-h-0 flex-1">{listPanel}</div>
          </Pane>

          {/* Below the two-pane threshold: session detail as a Sheet from the right */}
          {filters.session && containerWidth !== null && (
            <Sheet
              open={!!filters.session}
              onOpenChange={(open) => {
                if (!open) handleCloseSession();
              }}
            >
              <SheetContent side="right" className="w-full sm:w-[85vw] p-0 flex flex-col">
                <SheetHeader className="sr-only">
                  <SheetTitle>Session Detail</SheetTitle>
                  <SheetDescription>Session detail view</SheetDescription>
                </SheetHeader>
                <div className="shrink-0 px-3 pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs gap-1"
                    onClick={handleCloseSession}
                  >
                    <ArrowLeft className="h-3 w-3" />
                    Back to list
                  </Button>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <SessionDetailPanel sessionId={filters.session} onDelete={handleCloseSession} />
                </div>
              </SheetContent>
            </Sheet>
          )}
        </>
      ) : (
        // Keyed by mode: react-resizable-panels v3 throws ("Previous layout not
        // found") when a panel is added to a mounted group, so each mode gets a
        // fresh group. Layouts persist per panel set, so nothing is lost.
        <ResizablePanelGroup
          key={mode}
          ref={groupRef}
          direction="horizontal"
          autoSaveId="sessions-page-layout"
          storage={safeStorage}
          keyboardResizeBy={sizes.keyboardStep}
          onLayout={handleLayout}
        >
          {mode === 'three' && (
            <>
              <ResizablePanel
                ref={navRef}
                id="sessions-nav"
                order={1}
                collapsible
                collapsedSize={0}
                minSize={sizes.nav.min}
                maxSize={sizes.nav.max}
                defaultSize={sizes.nav.default}
              >
                <Pane>
                  <PaneHeader title="Projects">
                    <IconAction label="Hide projects" onClick={toggleNav}>
                      <PanelLeftClose className="h-3.5 w-3.5" />
                    </IconAction>
                  </PaneHeader>
                  <div className="min-h-0 flex-1">{projectNav}</div>
                </Pane>
              </ResizablePanel>
              <ResizableHandle aria-label="Resize projects pane" {...handleProps} />
            </>
          )}

          <ResizablePanel
            id="sessions-list"
            order={2}
            minSize={sizes.list.min}
            maxSize={sizes.list.max}
            defaultSize={sizes.list.default}
          >
            <Pane>
              {listHeader}
              <div className="min-h-0 flex-1">{listPanel}</div>
            </Pane>
          </ResizablePanel>
          <ResizableHandle aria-label="Resize sessions pane" {...handleProps} />

          <ResizablePanel id="sessions-detail" order={3} minSize={sizes.detailMin}>
            {detailPane}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}

// ── Pane primitives ──

/**
 * `relative` makes the pane the containing block for absolutely positioned
 * descendants (e.g. `sr-only` labels in ProjectNav rows) so overflow-hidden
 * clips them; otherwise they escape and extend the document height.
 */
function Pane({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('relative flex h-full min-w-0 flex-col overflow-hidden', className)}>
      {children}
    </div>
  );
}

/** Fixed-height pane header so panes line up and never grow while resizing. */
function PaneHeader({
  title,
  leading,
  children,
}: {
  title: string;
  leading?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b px-3">
      {leading}
      <h2 className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h2>
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">{children}</div>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function EmptyDetailState({ hasSessions, loading }: { hasSessions: boolean; loading: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 text-center">
      <MousePointerClick className="mb-3 h-10 w-10 text-muted-foreground/40" />
      <p className="text-sm font-medium text-muted-foreground">
        {loading || hasSessions ? 'Select a session to view details' : 'No sessions to show'}
      </p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">
        {loading || hasSessions
          ? 'Choose a session from the list to see its overview, insights, and conversation.'
          : 'Adjust the project or filters, or sync sessions with the CLI to populate this list.'}
      </p>
    </div>
  );
}
