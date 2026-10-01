// View 7 — label progress (label-12): counts per split, per project and per length bucket
// against coverage targets. Meters, not charts: each row is one ratio against a limit.
// Fill = primary, track = a lighter step of the same hue; a met target also shows a check
// icon and the word "met" so state never relies on color alone.

import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ErrorCard';
import { useLabelProgress } from '@/hooks/useLabels';
import { coverageRatio, coverageStatus, splitTargets } from '@/lib/label-form';
import { cn } from '@/lib/utils';

const BUCKET_LABELS: Record<string, string> = {
  short: 'Short (<20 msgs)',
  medium: 'Medium (20–79)',
  long: 'Long (80+)',
};

const SPLIT_LABELS = { train: 'Train', validation: 'Validation', test: 'Test' } as const;

interface MeterRowProps {
  label: string;
  labeled: number;
  target: number;
  /** Sessions available to label; 0 renders an empty "none available" row, never a full meter. */
  available?: number;
  /** Extra muted context, e.g. "12 available". */
  hint?: string;
  compact?: boolean;
}

function MeterRow({ label, labeled, target, available, hint, compact }: MeterRowProps) {
  const status = coverageStatus({ labeled, target, available });
  const ratio = status === 'unavailable' ? 0 : coverageRatio(labeled, target);
  return (
    <div className={cn('grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3', compact ? 'gap-y-1' : 'gap-y-1.5')}>
      <span className={cn('truncate text-xs', status === 'unavailable' ? 'text-muted-foreground' : 'text-foreground')} title={label}>
        {label}
      </span>
      {status === 'unavailable' ? (
        <span className="text-xs text-muted-foreground">none available</span>
      ) : (
        <span className="flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
          <span className="text-foreground font-medium">{labeled}</span>/{target}
          {status === 'met' && (
            <span className="inline-flex items-center gap-0.5 text-foreground">
              <Check className="h-3 w-3" aria-hidden />
              <span className="sr-only">target</span> met
            </span>
          )}
        </span>
      )}
      {status === 'unavailable' ? (
        <div className="col-span-2 h-1.5 rounded-full border border-dashed border-border" aria-hidden />
      ) : (
        <div
          role="meter"
          aria-label={`${label} labels`}
          aria-valuemin={0}
          aria-valuemax={target}
          aria-valuenow={Math.min(labeled, target)}
          aria-valuetext={`${labeled} of ${target}${hint ? `, ${hint}` : ''}`}
          className="col-span-2 h-1.5 rounded-full bg-primary/15 overflow-hidden"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}
      {hint && !compact && <span className="col-span-2 text-[11px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

interface LabelProgressViewProps {
  /** Compact = sidebar variant: totals + splits only. */
  variant?: 'full' | 'compact';
  className?: string;
}

export function LabelProgressView({ variant = 'full', className }: LabelProgressViewProps) {
  const { data, isLoading, isError, refetch } = useLabelProgress();

  if (isLoading) {
    return (
      <div className={cn('space-y-3', className)} aria-busy="true">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-full" />
        <Skeleton className="h-2 w-3/4" />
      </div>
    );
  }
  if (isError || !data) {
    return <ErrorCard message="Could not load label progress" onRetry={() => refetch()} />;
  }

  const compact = variant === 'compact';
  const perSplit = splitTargets(data.targets.totalLabels);

  return (
    <div className={cn('space-y-5', className)}>
      <Section title="Labels">
        <MeterRow label="All sessions" labeled={data.total} target={data.targets.totalLabels} compact={compact} />
      </Section>

      <Section title="By split" aside={<span className="text-[11px] text-muted-foreground">60 / 20 / 20</span>}>
        <div className="space-y-2">
          {(Object.keys(SPLIT_LABELS) as Array<keyof typeof SPLIT_LABELS>).map((s) => (
            <MeterRow key={s} label={SPLIT_LABELS[s]} labeled={data.splits[s]} target={perSplit[s]} compact />
          ))}
        </div>
      </Section>

      {!compact && (
        <>
          <Section title="By session length">
            <div className="space-y-2">
              {data.byLengthBucket.map((b) => (
                <MeterRow
                  key={b.bucket}
                  label={BUCKET_LABELS[b.bucket] ?? b.bucket}
                  labeled={b.labeled}
                  target={b.target}
                  available={b.available}
                  hint={`${b.available} available`}
                  compact
                />
              ))}
            </div>
          </Section>

          <Section
            title="By project"
            aside={<span className="text-[11px] text-muted-foreground">target {data.targets.perProject} each</span>}
          >
            {data.byProject.length === 0 ? (
              <p className="text-xs text-muted-foreground">No sessions yet. Run <code className="font-mono">code-insights sync</code> first.</p>
            ) : (
              <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
                {data.byProject.map((p) => (
                  <MeterRow
                    key={p.projectId}
                    label={p.projectName}
                    labeled={p.labeled}
                    target={p.target}
                    available={p.available}
                    hint={`${p.available} sessions`}
                    compact
                  />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
