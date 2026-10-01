// Labeling page (plan step 19): /label = suggested queue + progress (view 7),
// /label/:sessionId = review one session's current analysis into a gold label.
//
// +--------------------+---------------------------------------------------+
// | QUEUE (w-72)       | Title · project · 42 msgs · medium   [Split: test] |
// | 14 unlabeled       | {Open session}              [Save] [Save & next]  |
// | > session A  <cur> |---------------------------------------------------|
// |   session B        | ANALYSIS ITEMS  3 kept · 1 wrong · 5 to review    |
// |   ...              | [decision] claim text     [Keep][Wrong][Trivial]  |
// |--------------------| MISSED KEY POINTS [______________] [Add]          |
// | PROGRESS (compact) | OUTCOME ( high | medium | low | abandoned )       |
// | 12/30 · splits     | FRICTION chips · PATTERN chips · NOTE             |
// +--------------------+---------------------------------------------------+
//
// Keys (outside text fields): j/k move · 1 keep · 2 wrong · 3 trivial · a add key point ·
// n next in queue · Ctrl/Cmd+Enter save · Ctrl/Cmd+Shift+Enter save & next.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import {
  ArrowRight,
  Check,
  ExternalLink,
  Keyboard,
  ListChecks,
  Lock,
  Minus,
  Plus,
  Save,
  Tags,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ErrorCard';
import { LabelProgressView } from '@/components/labels/LabelProgressView';
import { useRegisterPageContext } from '@/components/chat/panel/PageContextProvider';
import { useSession } from '@/hooks/useSessions';
import { useInsights } from '@/hooks/useInsights';
import { useLabel, useLabelCategories, useLabelQueue, useSaveLabel } from '@/hooks/useLabels';
import { LabelSaveError } from '@/lib/api';
import {
  EMPTY_LABEL_FORM,
  buildLabelPayload,
  countDecisions,
  deriveAnalysisItems,
  formStateFromLabel,
  isFormDirty,
  labelFormReducer,
  nextQueuedSession,
  type AnalysisItem,
  type ItemDecision,
  type LabelFormState,
} from '@/lib/label-form';
import type { LabelQueueItem } from '@/lib/types';
import { cn } from '@/lib/utils';

const BUCKET_TEXT: Record<string, string> = { short: 'short', medium: 'medium', long: 'long' };

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">{children}</kbd>
  );
}

// ── Queue sidebar ─────────────────────────────────────────────────────────────

function QueueList({ currentId }: { currentId?: string }) {
  const { data, isLoading, isError, refetch } = useLabelQueue();

  return (
    <section aria-labelledby="label-queue-heading" className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 id="label-queue-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Suggested queue
        </h2>
        {data && <span className="text-[11px] tabular-nums text-muted-foreground">{data.unlabeledCount} unlabeled</span>}
      </div>
      {isLoading ? (
        <div className="space-y-1.5">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
        </div>
      ) : isError || !data ? (
        <ErrorCard message="Could not load the queue" onRetry={() => refetch()} />
      ) : data.queue.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {data.unlabeledCount === 0 ? 'Every session is labeled.' : 'Nothing to suggest right now.'}
        </p>
      ) : (
        <ol className="space-y-0.5">
          {data.queue.map((q) => <QueueRow key={q.sessionId} item={q} current={q.sessionId === currentId} />)}
        </ol>
      )}
    </section>
  );
}

function QueueRow({ item, current }: { item: LabelQueueItem; current: boolean }) {
  return (
    <li>
      <Link
        to={`/label/${item.sessionId}`}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'block rounded-md px-2 py-1.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
          current ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60',
        )}
      >
        <span className="block truncate font-medium text-foreground">{item.title || item.sessionId.slice(0, 8)}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {item.projectName} · {BUCKET_TEXT[item.bucket]} · {item.sourceTool}
        </span>
      </Link>
    </li>
  );
}

function Sidebar({ currentId }: { currentId?: string }) {
  return (
    <aside className="border-b lg:border-b-0 lg:border-r bg-muted/10 lg:sticky lg:top-14 lg:h-[calc(100vh-3.5rem)] lg:overflow-y-auto">
      <div className="p-4 space-y-6">
        <QueueList currentId={currentId} />
        {currentId && (
          <div className="hidden lg:block border-t pt-4">
            <LabelProgressView variant="compact" />
          </div>
        )}
      </div>
    </aside>
  );
}

// ── Overview (/label) ────────────────────────────────────────────────────────

function LabelOverview() {
  const navigate = useNavigate();
  const { data } = useLabelQueue();
  const first = data?.queue[0]?.sessionId ?? null;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      if (e.key === 'n' && first) {
        e.preventDefault();
        navigate(`/label/${first}`);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [first, navigate]);

  return (
    <div className="max-w-3xl p-6 space-y-6">
      <header className="space-y-2">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <Tags className="h-5 w-5" aria-hidden />
          Labeling
        </h1>
        <p className="text-sm text-muted-foreground">
          Review a session&rsquo;s current analysis: keep what is right, mark what is wrong, and add what it missed.
          Labels become the gold set prompt optimization scores against.
        </p>
        <div className="flex items-center gap-3 pt-1">
          <Button size="sm" disabled={!first} onClick={() => first && navigate(`/label/${first}`)}>
            Start labeling
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground flex items-center gap-1">
            or press <Kbd>n</Kbd>
          </span>
        </div>
      </header>
      <section aria-labelledby="label-progress-heading" className="rounded-lg border bg-card p-4">
        <h2 id="label-progress-heading" className="text-sm font-semibold mb-4">Label progress</h2>
        <LabelProgressView />
      </section>
    </div>
  );
}

// ── Session labeling (/label/:sessionId) ─────────────────────────────────────

const KIND_LABEL: Record<AnalysisItem['kind'], string> = {
  summary: 'summary',
  decision: 'decision',
  learning: 'learning',
  technique: 'technique',
  friction: 'friction',
  pattern: 'pattern',
};

const DECISIONS: Array<{ value: ItemDecision; label: string; key: string; icon: typeof Check }> = [
  { value: 'keep', label: 'Keep', key: '1', icon: Check },
  { value: 'wrong', label: 'Wrong', key: '2', icon: X },
  { value: 'trivial', label: 'Trivial', key: '3', icon: Minus },
];

// Pressed state uses the solid shadcn variants; the outline variant's dark: classes would
// otherwise override a custom background in dark mode.
const DECISION_VARIANT: Record<ItemDecision, 'default' | 'destructive' | 'secondary'> = {
  keep: 'default',
  wrong: 'destructive',
  trivial: 'secondary',
};

const DECISION_ROW: Record<ItemDecision, string> = {
  keep: 'border-l-primary',
  wrong: 'border-l-destructive',
  trivial: 'border-l-border opacity-60',
};

const DECISION_STATUS: Record<ItemDecision, string> = {
  keep: 'key point',
  wrong: 'forbidden claim',
  trivial: 'skipped',
};

interface ItemRowProps {
  item: AnalysisItem;
  index: number;
  decision: ItemDecision | undefined;
  active: boolean;
  onFocus: () => void;
  onDecide: (d: ItemDecision) => void;
  rowRef: (el: HTMLLIElement | null) => void;
}

function ItemRow({ item, index, decision, active, onFocus, onDecide, rowRef }: ItemRowProps) {
  const textId = `label-item-${index}`;
  return (
    <li
      ref={rowRef}
      tabIndex={active ? 0 : -1}
      onFocus={onFocus}
      aria-labelledby={textId}
      className={cn(
        'group flex flex-col gap-2 sm:flex-row sm:items-start rounded-md border border-l-4 bg-card px-3 py-2.5 outline-none',
        decision ? DECISION_ROW[decision] : 'border-l-transparent',
        active && 'ring-2 ring-ring/60',
      )}
    >
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px] font-normal">{KIND_LABEL[item.kind]}</Badge>
          {item.category && <span className="text-[11px] font-mono text-muted-foreground">{item.category}</span>}
          {decision && (
            <span className="text-[11px] text-muted-foreground">→ {DECISION_STATUS[decision]}</span>
          )}
        </div>
        <p id={textId} className={cn('text-sm leading-snug', decision === 'wrong' && 'line-through decoration-destructive/60')}>
          {item.text}
        </p>
      </div>
      <div role="group" aria-label="Decision" className="flex shrink-0 gap-1">
        {DECISIONS.map(({ value, label, key, icon: Icon }) => {
          const pressed = decision === value;
          return (
            <Button
              key={value}
              type="button"
              size="xs"
              variant={pressed ? DECISION_VARIANT[value] : 'outline'}
              aria-pressed={pressed}
              aria-keyshortcuts={key}
              title={`${label} (${key})`}
              tabIndex={active ? 0 : -1}
              onClick={() => onDecide(value)}
              className="min-w-[4.5rem] border border-transparent data-[pressed=false]:border-input"
              data-pressed={pressed}
            >
              <Icon aria-hidden />
              {label}
            </Button>
          );
        })}
      </div>
    </li>
  );
}

function ChipPicker({
  legend,
  options,
  selected,
  onToggle,
  hint,
}: {
  legend: string;
  options: string[];
  selected: string[];
  onToggle: (v: string) => void;
  hint?: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{legend}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = selected.includes(o);
          return (
            <button
              key={o}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(o)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                on ? 'bg-primary text-primary-foreground border-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted/60',
              )}
            >
              {on && <Check className="h-3 w-3" aria-hidden />}
              {o}
            </button>
          );
        })}
      </div>
      {hint && <p className="text-[11px] text-muted-foreground">{hint}</p>}
    </fieldset>
  );
}

function SessionLabeler({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate();
  const sessionQ = useSession(sessionId);
  const insightsQ = useInsights({ sessionId });
  const labelQ = useLabel(sessionId);
  const categoriesQ = useLabelCategories();
  const queueQ = useLabelQueue();
  const saveMutation = useSaveLabel();

  const session = sessionQ.data;
  const categories = categoriesQ.data;
  const label = labelQ.data ?? null;

  const items = useMemo(
    () =>
      deriveAnalysisItems(insightsQ.data ?? [], session?.facets ?? null, categories
        ? { friction: categories.frictionCategories, pattern: categories.patternCategories }
        : undefined),
    [insightsQ.data, session?.facets, categories],
  );

  const [form, dispatch] = useReducer(labelFormReducer, EMPTY_LABEL_FORM);
  const [baseline, setBaseline] = useState<LabelFormState>(EMPTY_LABEL_FORM);
  const [activeIndex, setActiveIndex] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [newPoint, setNewPoint] = useState('');
  const rowRefs = useRef<Array<HTMLLIElement | null>>([]);
  const keyPointInputRef = useRef<HTMLInputElement>(null);

  const ready = sessionQ.isSuccess && insightsQ.isSuccess && labelQ.isSuccess && categoriesQ.isSuccess;

  // (Re)initialize the form when the session, its label or its analysis changes.
  const initKey = ready ? `${sessionId}|${label?.updatedAt ?? 'new'}|${items.map((i) => i.id).join(',')}` : null;
  useEffect(() => {
    if (!initKey) return;
    const next = formStateFromLabel(items, label);
    dispatch({ type: 'reset', state: next });
    setBaseline(next);
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initKey captures items/label identity
  }, [initKey]);

  const dirty = isFormDirty(form, baseline);
  const counts = countDecisions(items, form);
  const nextId = nextQueuedSession(queueQ.data?.queue ?? [], sessionId);

  const focusRow = useCallback((i: number) => {
    setActiveIndex(i);
    const el = rowRefs.current[i];
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }, []);

  const decide = useCallback(
    (index: number, decision: ItemDecision) => {
      const item = items[index];
      if (!item) return;
      dispatch({ type: 'decide', item, decision });
    },
    [items],
  );

  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const skipBlockRef = useRef(false);

  const goNext = useCallback(() => {
    if (!nextId) {
      toast.info('The queue is empty');
      return;
    }
    // The navigation blocker below asks before discarding unsaved edits.
    navigate(`/label/${nextId}`);
  }, [navigate, nextId]);

  const save = useCallback(
    async (andNext: boolean) => {
      const built = buildLabelPayload(items, form);
      if (!built.ok) {
        setErrors(built.errors);
        return;
      }
      setErrors([]);
      try {
        const saved = await saveMutation.mutateAsync({ sessionId, input: built.value });
        toast.success(`Label saved · ${saved.split} split`);
        if (andNext) {
          // Just saved: the form is still "dirty" until the label refetch resets the baseline.
          skipBlockRef.current = true;
          if (nextId) navigate(`/label/${nextId}`);
          else toast.info('That was the last queued session');
        }
      } catch (e) {
        if (e instanceof LabelSaveError) setErrors(e.details.length ? e.details : [e.message]);
        else setErrors([e instanceof Error ? e.message : 'Save failed']);
      }
    },
    [form, items, navigate, nextId, saveMutation, sessionId],
  );

  // Keyboard-first review. Text fields keep their own keys, except Ctrl/Cmd+Enter to save.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void save(e.shiftKey);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTypingTarget(e.target)) return;
      switch (e.key) {
        case 'j':
          if (items.length) { e.preventDefault(); focusRow(Math.min(activeIndex + 1, items.length - 1)); }
          break;
        case 'k':
          if (items.length) { e.preventDefault(); focusRow(Math.max(activeIndex - 1, 0)); }
          break;
        case '1':
        case '2':
        case '3': {
          if (!items.length) break;
          e.preventDefault();
          decide(activeIndex, DECISIONS[Number(e.key) - 1].value);
          if (activeIndex < items.length - 1) focusRow(activeIndex + 1);
          break;
        }
        case 'a':
          e.preventDefault();
          keyPointInputRef.current?.focus();
          break;
        case 'n':
          e.preventDefault();
          goNext();
          break;
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [activeIndex, decide, focusRow, goNext, items.length, save]);

  // In-app navigation (queue links, Open session, nav, browser back) with unsaved edits asks first.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && !skipBlockRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm('Discard unsaved changes to this label?')) blocker.proceed();
    else blocker.reset();
  }, [blocker]);

  // Warn before closing or reloading the tab with unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  function addPoint() {
    if (!newPoint.trim()) return;
    dispatch({ type: 'addKeyPoint', text: newPoint });
    setNewPoint('');
  }

  function onKeyPointKeyDown(e: ReactKeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      addPoint();
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  }

  if (sessionQ.isError) {
    return (
      <div className="p-6 max-w-xl">
        <ErrorCard message="Session not found or failed to load" onRetry={() => sessionQ.refetch()} />
      </div>
    );
  }
  if (!ready || !session || !categories) {
    return (
      <div className="p-6 space-y-3" aria-busy="true">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
      </div>
    );
  }

  const title = session.custom_title || session.generated_title || session.summary || sessionId.slice(0, 8);
  const facetOutcome = session.facets?.outcome_satisfaction;
  const analysisFriction = [...new Set(items.filter((i) => i.kind === 'friction' && i.category).map((i) => i.category!))];
  const analysisPatterns = [...new Set(items.filter((i) => i.kind === 'pattern' && i.category).map((i) => i.category!))];

  return (
    <div className="flex flex-col min-h-[calc(100vh-3.5rem)]">
      {/* Header */}
      <header className="border-b px-6 py-3 space-y-1.5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="text-base font-semibold leading-snug flex-1 min-w-[12rem]">{title}</h1>
          <Badge
            variant="outline"
            className="gap-1 font-normal"
            title={label ? 'Split is assigned on first save and never changes' : 'The server assigns a split on first save'}
          >
            <Lock className="h-3 w-3" aria-hidden />
            {label ? <>Split: <span className="font-medium">{label.split}</span></> : 'Split assigned on first save'}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{session.project_name}</span>
          <span aria-hidden>·</span>
          <span>{session.source_tool ?? 'unknown tool'}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{session.message_count} msgs</span>
          {label && (
            <>
              <span aria-hidden>·</span>
              <span>labeled</span>
            </>
          )}
          <Link
            to={`/sessions/${sessionId}`}
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground underline-offset-2 hover:underline"
          >
            Open session <ExternalLink className="h-3 w-3" aria-hidden />
          </Link>
        </div>
      </header>

      <div className="flex-1 px-6 py-4 space-y-6 max-w-4xl w-full">
        {/* Items */}
        <section aria-labelledby="items-heading" className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="items-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
              <ListChecks className="h-3.5 w-3.5" aria-hidden />
              Current analysis
            </h2>
            {items.length > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground" aria-live="polite">
                {counts.keep} kept · {counts.wrong} wrong · {counts.trivial} trivial · {counts.undecided} to review
              </span>
            )}
          </div>
          {items.length === 0 ? (
            <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
              This session has no analysis yet.{' '}
              <Link to={`/sessions/${sessionId}`} className="text-foreground underline underline-offset-2">Analyze it</Link>{' '}
              first, or type the key points below.
            </div>
          ) : (
            <ul className="space-y-1.5" aria-label="Analysis items">
              {items.map((item, i) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  index={i}
                  decision={form.decisions[item.id]}
                  active={i === activeIndex}
                  onFocus={() => setActiveIndex(i)}
                  onDecide={(d) => { setActiveIndex(i); decide(i, d); }}
                  rowRef={(el) => { rowRefs.current[i] = el; }}
                />
              ))}
            </ul>
          )}
        </section>

        {/* Missed key points */}
        <section aria-labelledby="missed-heading" className="space-y-2">
          <h2 id="missed-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Missed key points
          </h2>
          <div className="flex gap-2">
            <Input
              ref={keyPointInputRef}
              value={newPoint}
              onChange={(e) => setNewPoint(e.target.value)}
              onKeyDown={onKeyPointKeyDown}
              placeholder="Something the analysis should have said…"
              aria-label="New key point"
              aria-keyshortcuts="a"
              className="h-8 text-sm"
            />
            <Button type="button" size="sm" variant="outline" onClick={addPoint} disabled={!newPoint.trim()}>
              <Plus aria-hidden />
              Add
            </Button>
          </div>
          {form.extraKeyPoints.length > 0 && (
            <ul className="space-y-1" aria-label="Key points not in the current analysis">
              {form.extraKeyPoints.map((kp, i) => (
                <li key={`${i}-${kp}`} className="flex items-start gap-2 rounded-md border border-l-4 border-l-primary bg-card px-3 py-1.5 text-sm">
                  <span className="flex-1">{kp}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove key point: ${kp}`}
                    onClick={() => dispatch({ type: 'removeKeyPoint', index: i })}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Saved forbidden claims the current analysis no longer contains: kept unless removed. */}
        {form.preservedForbidden.length > 0 && (
          <section aria-labelledby="preserved-forbidden-heading" className="space-y-2">
            <h2 id="preserved-forbidden-heading" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Forbidden claims not in the current analysis
            </h2>
            <ul className="space-y-1">
              {form.preservedForbidden.map((fc, i) => (
                <li key={`${i}-${fc}`} className="flex items-start gap-2 rounded-md border border-l-4 border-l-destructive bg-card px-3 py-1.5 text-sm">
                  <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex-1">{fc}</span>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove forbidden claim: ${fc}`}
                    onClick={() => dispatch({ type: 'removeForbidden', index: i })}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Outcome */}
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outcome</legend>
          <div role="radiogroup" aria-label="Outcome" className="inline-flex rounded-md border p-0.5">
            {categories.outcomes.map((o) => {
              const on = form.outcome === o;
              return (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => dispatch({ type: 'setOutcome', outcome: o })}
                  className={cn(
                    'rounded px-3 py-1 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {o}
                </button>
              );
            })}
          </div>
          {facetOutcome && <p className="text-[11px] text-muted-foreground">Analysis said: {facetOutcome}</p>}
        </fieldset>

        <ChipPicker
          legend="Friction categories"
          options={categories.frictionCategories}
          selected={form.frictionCategories}
          onToggle={(c) => dispatch({ type: 'toggleFriction', category: c })}
          hint={analysisFriction.length ? `Analysis: ${analysisFriction.join(', ')}` : undefined}
        />
        <ChipPicker
          legend="Pattern categories"
          options={categories.patternCategories}
          selected={form.patternCategories}
          onToggle={(c) => dispatch({ type: 'togglePattern', category: c })}
          hint={analysisPatterns.length ? `Analysis: ${analysisPatterns.join(', ')}` : undefined}
        />

        <div className="space-y-2">
          <label htmlFor="label-note" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Note <span className="normal-case font-normal">(optional)</span>
          </label>
          <textarea
            id="label-note"
            value={form.note}
            onChange={(e) => dispatch({ type: 'setNote', note: e.target.value })}
            rows={2}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 dark:bg-input/30"
            placeholder="Context for future you, e.g. why the outcome is low"
          />
        </div>
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-14 md:bottom-0 border-t bg-background/95 backdrop-blur px-6 py-2.5">
        {errors.length > 0 && (
          <ul role="alert" className="mb-2 text-xs text-destructive space-y-0.5">
            {errors.map((err) => <li key={err}>{err}</li>)}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <p className="hidden md:flex items-center gap-1.5 text-[11px] text-muted-foreground mr-auto">
            <Keyboard className="h-3.5 w-3.5" aria-hidden />
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>1</Kbd> keep · <Kbd>2</Kbd> wrong · <Kbd>3</Kbd> trivial ·{' '}
            <Kbd>a</Kbd> add point · <Kbd>n</Kbd> next · <Kbd>Ctrl</Kbd>+<Kbd>Enter</Kbd> save
          </p>
          <span className="text-[11px] text-muted-foreground md:hidden mr-auto">{dirty ? 'Unsaved changes' : ''}</span>
          {dirty && <span className="hidden md:inline text-[11px] text-muted-foreground">Unsaved changes</span>}
          <Button type="button" size="sm" variant="ghost" onClick={goNext} disabled={!nextId} aria-keyshortcuts="n">
            Skip
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void save(false)}
            disabled={saveMutation.isPending}
            aria-keyshortcuts="Control+Enter Meta+Enter"
          >
            <Save aria-hidden />
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void save(true)}
            disabled={saveMutation.isPending}
            aria-keyshortcuts="Control+Shift+Enter Meta+Shift+Enter"
          >
            Save &amp; next
            <ArrowRight aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function LabelPage() {
  const { sessionId } = useParams<{ sessionId?: string }>();
  // One registration for both routes: lets the chat panel resolve "this session" (agent-7/agent-9).
  useRegisterPageContext(sessionId ? { page: 'label', sessionId } : { page: 'label' });

  return (
    <div className="lg:grid lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Sidebar currentId={sessionId} />
      <div className="min-w-0">
        {sessionId ? <SessionLabeler key={sessionId} sessionId={sessionId} /> : <LabelOverview />}
      </div>
    </div>
  );
}
