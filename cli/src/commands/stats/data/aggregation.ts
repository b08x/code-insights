// ──────────────────────────────────────────────────────
// Stats command — Pure aggregation layer
//
// All functions operate on SessionRow[] and produce
// aggregated output types.  Completely data-source agnostic.
// ──────────────────────────────────────────────────────

import type {
  Period,
  SessionRow,
  StatsOverview,
  CostBreakdown,
  ProjectStatsEntry,
  TodayStats,
  TodaySession,
  ModelStatsEntry,
  TimeSeriesPoint,
  GroupedMetric,
  DayStats,
} from './types.js';
import { getModelPricing } from '../../../utils/pricing.js';

// ──────────────────────────────────────────────────────
// Generic helpers
// ──────────────────────────────────────────────────────

function sum<T>(items: T[], fn: (item: T) => number): number {
  return items.reduce((acc, item) => acc + fn(item), 0);
}

function diffMinutes(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

function findMostFrequent(items: string[]): string | undefined {
  if (items.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const item of items) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

// ──────────────────────────────────────────────────────
// Date helpers
// ──────────────────────────────────────────────────────

function today(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function yesterday(): Date {
  const d = today();
  d.setDate(d.getDate() - 1);
  return d;
}

function startOfWeek(): Date {
  const d = today();
  const day = d.getDay(); // 0=Sun, 1=Mon, ... 6=Sat
  const diff = day === 0 ? 6 : day - 1; // days back to Monday
  d.setDate(d.getDate() - diff);
  return d;
}

/**
 * Returns the start date for a given period, or undefined for 'all'.
 */
export function periodStartDate(period: Period): Date | undefined {
  const d = today();
  switch (period) {
    case '7d':
      d.setDate(d.getDate() - 7);
      return d;
    case '30d':
      d.setDate(d.getDate() - 30);
      return d;
    case '90d':
      d.setDate(d.getDate() - 90);
      return d;
    case 'all':
      return undefined;
  }
}

/**
 * Resolve the display title for a session.
 */
export function resolveTitle(session: SessionRow): string {
  return (
    session.customTitle ??
    session.generatedTitle ??
    session.summary ??
    'Untitled Session'
  );
}

/**
 * Shorten a model identifier to a display-friendly name.
 */
export function shortenModelName(model: string): string {
  // Claude 4.x opus variants
  if (/^claude-opus-4/.test(model)) return 'Opus 4.x';
  // Claude 4.x sonnet variants
  if (/^claude-sonnet-4/.test(model)) return 'Sonnet 4.x';
  // Claude haiku variants (covers haiku-4-5, haiku-3-5, etc.)
  if (/^claude-haiku/.test(model)) return 'Haiku';
  // Claude 3.5 sonnet
  if (/^claude-3-5-sonnet/.test(model)) return 'Sonnet 3.5';
  // Claude 3.5 haiku
  if (/^claude-3-5-haiku/.test(model)) return 'Haiku 3.5';
  // Claude 3 opus
  if (/^claude-3-opus/.test(model)) return 'Opus 3';
  // Claude 3 sonnet
  if (/^claude-3-sonnet/.test(model)) return 'Sonnet 3';
  // Claude 3 haiku
  if (/^claude-3-haiku/.test(model)) return 'Haiku 3';
  // GPT-4o
  if (/^gpt-4o/.test(model)) return 'GPT-4o';
  // GPT-4-turbo
  if (/^gpt-4-turbo/.test(model)) return 'GPT-4 Turbo';
  // Fallback: truncate to 20 chars
  return model.length > 20 ? model.slice(0, 20) : model;
}

// ──────────────────────────────────────────────────────
// Time-series helpers
// ──────────────────────────────────────────────────────

/** Pad a number to 2 digits */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Get ISO week number for a date */
function isoWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  // Set to nearest Thursday: current date + 4 - dayOfWeek (Mon=1, Sun=7)
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** Get ISO week year for a date (may differ from calendar year at year boundaries) */
function isoWeekYear(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  return date.getUTCFullYear();
}

/**
 * Returns the bucket key for a given date based on period granularity.
 */
export function bucketKey(date: Date, period: Period): string {
  switch (period) {
    case '7d':
    case '30d': {
      const y = date.getFullYear();
      const m = pad2(date.getMonth() + 1);
      const d = pad2(date.getDate());
      return `${y}-${m}-${d}`;
    }
    case '90d': {
      const wy = isoWeekYear(date);
      const wk = isoWeek(date);
      return `${wy}-W${pad2(wk)}`;
    }
    case 'all': {
      const y = date.getFullYear();
      const m = pad2(date.getMonth() + 1);
      return `${y}-${m}`;
    }
  }
}

/**
 * Create empty time-series buckets for the full date range.
 * Uses an optional referenceDate for deterministic testing (defaults to today).
 */
export function createBuckets(
  period: Period,
  referenceDate?: Date,
): Map<string, TimeSeriesPoint> {
  const ref = referenceDate ?? today();
  const buckets = new Map<string, TimeSeriesPoint>();

  switch (period) {
    case '7d': {
      for (let i = 6; i >= 0; i--) {
        const d = new Date(ref);
        d.setDate(d.getDate() - i);
        const key = bucketKey(d, period);
        buckets.set(key, { date: key, value: 0 });
      }
      break;
    }
    case '30d': {
      for (let i = 29; i >= 0; i--) {
        const d = new Date(ref);
        d.setDate(d.getDate() - i);
        const key = bucketKey(d, period);
        buckets.set(key, { date: key, value: 0 });
      }
      break;
    }
    case '90d': {
      // 13 weekly buckets ending at the current week
      for (let i = 12; i >= 0; i--) {
        const d = new Date(ref);
        d.setDate(d.getDate() - i * 7);
        const key = bucketKey(d, period);
        if (!buckets.has(key)) {
          buckets.set(key, { date: key, value: 0 });
        }
      }
      break;
    }
    case 'all': {
      // 12 monthly buckets ending at the current month
      for (let i = 11; i >= 0; i--) {
        const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
        const key = bucketKey(d, period);
        buckets.set(key, { date: key, value: 0 });
      }
      break;
    }
  }

  return buckets;
}

/**
 * Group sessions into time-series buckets.
 * Returns an array sorted oldest-first with gap-filling (zero values).
 */
export function groupByDay(
  sessions: SessionRow[],
  period: Period,
  metric: 'sessions' | 'cost' | 'tokens' = 'sessions',
): TimeSeriesPoint[] {
  const buckets = createBuckets(period);

  for (const s of sessions) {
    const key = bucketKey(s.startedAt, period);
    const bucket = buckets.get(key);
    if (bucket) {
      switch (metric) {
        case 'sessions':
          bucket.value += 1;
          break;
        case 'cost':
          bucket.value += s.estimatedCostUsd ?? 0;
          break;
        case 'tokens':
          bucket.value +=
            (s.totalInputTokens ?? 0) +
            (s.totalOutputTokens ?? 0) +
            (s.cacheCreationTokens ?? 0) +
            (s.cacheReadTokens ?? 0);
          break;
      }
    }
  }

  // Return sorted oldest-first (Map insertion order is already oldest-first)
  return Array.from(buckets.values());
}

// ──────────────────────────────────────────────────────
// Day / range stats
// ──────────────────────────────────────────────────────

/**
 * Compute stats for sessions starting on a specific calendar day.
 */
export function computeDayStats(sessions: SessionRow[], dayStart: Date): DayStats {
  const dayYear = dayStart.getFullYear();
  const dayMonth = dayStart.getMonth();
  const dayDate = dayStart.getDate();

  const daySessions = sessions.filter((s) => {
    const d = s.startedAt;
    return (
      d.getFullYear() === dayYear &&
      d.getMonth() === dayMonth &&
      d.getDate() === dayDate
    );
  });

  return {
    sessionCount: daySessions.length,
    totalCost: sum(daySessions, (s) => s.estimatedCostUsd ?? 0),
    totalMinutes: sum(daySessions, (s) => diffMinutes(s.startedAt, s.endedAt)),
  };
}

/**
 * Compute stats for sessions in a [from, to) date range.
 */
export function computeRangeStats(
  sessions: SessionRow[],
  from: Date,
  to: Date,
): DayStats {
  const fromMs = from.getTime();
  const toMs = to.getTime();

  const rangeSessions = sessions.filter((s) => {
    const t = s.startedAt.getTime();
    return t >= fromMs && t < toMs;
  });

  return {
    sessionCount: rangeSessions.length,
    totalCost: sum(rangeSessions, (s) => s.estimatedCostUsd ?? 0),
    totalMinutes: sum(rangeSessions, (s) => diffMinutes(s.startedAt, s.endedAt)),
  };
}

// ──────────────────────────────────────────────────────
// Top N
// ──────────────────────────────────────────────────────

/**
 * Compute top projects by session count.
 */
export function computeTopProjects(
  sessions: SessionRow[],
  limit: number,
): GroupedMetric[] {
  const groups = groupBy(sessions, (s) => s.projectName);
  const total = sessions.length;

  const metrics: GroupedMetric[] = [];
  for (const [name, group] of groups) {
    metrics.push({
      name,
      count: group.length,
      cost: sum(group, (s) => s.estimatedCostUsd ?? 0),
      percent: total > 0 ? (group.length / total) * 100 : 0,
    });
  }

  metrics.sort((a, b) => b.count - a.count);
  return metrics.slice(0, limit);
}

// ──────────────────────────────────────────────────────
// Helper: number of days in a period
// ──────────────────────────────────────────────────────

function daysInPeriod(period: Period, sessions: SessionRow[]): number {
  switch (period) {
    case '7d':
      return 7;
    case '30d':
      return 30;
    case '90d':
      return 90;
    case 'all': {
      if (sessions.length === 0) return 1; // avoid division by zero
      const dates = sessions.map((s) => s.startedAt.getTime());
      const earliest = Math.min(...dates);
      const latest = Math.max(...dates);
      const days = Math.ceil((latest - earliest) / 86_400_000) + 1;
      return Math.max(days, 1);
    }
  }
}

// ──────────────────────────────────────────────────────
// Main aggregation functions
// ──────────────────────────────────────────────────────

/**
 * High-level overview of all sessions in the period.
 */
export function computeOverview(
  sessions: SessionRow[],
  period: Period,
): StatsOverview {
  const sessionsWithCost = sessions.filter(
    (s) => s.estimatedCostUsd != null,
  );

  const totalCost = sum(sessionsWithCost, (s) => s.estimatedCostUsd!);

  const totalTokens = sum(sessionsWithCost, (s) =>
    (s.totalInputTokens ?? 0) +
    (s.totalOutputTokens ?? 0) +
    (s.cacheCreationTokens ?? 0) +
    (s.cacheReadTokens ?? 0),
  );

  const uniqueProjects = new Set(sessions.map((s) => s.projectId));

  // Source tools — only populate if 2+ distinct sources exist
  const sourceToolNames = sessions
    .map((s) => s.sourceTool)
    .filter((t): t is string => t != null);
  const uniqueSourceTools = new Set(sourceToolNames);
  let sourceTools: GroupedMetric[] = [];
  if (uniqueSourceTools.size >= 2) {
    const groups = groupBy(
      sessions.filter((s) => s.sourceTool != null),
      (s) => s.sourceTool!,
    );
    for (const [name, group] of groups) {
      sourceTools.push({
        name,
        count: group.length,
        cost: sum(group, (s) => s.estimatedCostUsd ?? 0),
        percent:
          sessions.length > 0 ? (group.length / sessions.length) * 100 : 0,
      });
    }
    sourceTools.sort((a, b) => b.count - a.count);
  }

  // Week range: Monday of current week through end of today
  const weekStart = startOfWeek();
  const tomorrow = today();
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    sessionCount: sessions.length,
    messageCount: sum(sessions, (s) => s.messageCount),
    totalCost,
    sessionsWithCostCount: sessionsWithCost.length,
    totalTimeMinutes: sum(sessions, (s) => diffMinutes(s.startedAt, s.endedAt)),
    totalTokens,
    projectCount: uniqueProjects.size,
    activityByDay: groupByDay(sessions, period),
    todayStats: computeDayStats(sessions, today()),
    yesterdayStats: computeDayStats(sessions, yesterday()),
    weekStats: computeRangeStats(sessions, weekStart, tomorrow),
    topProjects: computeTopProjects(sessions, 5),
    sourceTools,
  };
}

/**
 * Detailed cost breakdown across projects, models, and tokens.
 */
export function computeCostBreakdown(
  sessions: SessionRow[],
  period: Period,
): CostBreakdown {
  const costSessions = sessions.filter(
    (s) => s.estimatedCostUsd != null,
  );
  const totalCost = sum(costSessions, (s) => s.estimatedCostUsd!);
  const days = daysInPeriod(period, costSessions);
  const avgPerDay = days > 0 ? totalCost / days : 0;
  const avgPerSession =
    costSessions.length > 0 ? totalCost / costSessions.length : 0;

  // Daily cost trend
  const dailyTrend = groupByDay(sessions, period, 'cost');

  // Peak day
  let peakDay: CostBreakdown['peakDay'] = null;
  if (dailyTrend.length > 0) {
    const peak = dailyTrend.reduce((best, pt) =>
      pt.value > best.value ? pt : best,
    );
    if (peak.value > 0) {
      // Count sessions on peak day
      const peakSessions = sessions.filter(
        (s) => bucketKey(s.startedAt, period) === peak.date,
      );
      peakDay = {
        date: peak.date,
        cost: peak.value,
        sessions: peakSessions.length,
      };
    }
  }

  // By project
  const projectGroups = groupBy(costSessions, (s) => s.projectName);
  const byProject: GroupedMetric[] = [];
  for (const [name, group] of projectGroups) {
    const cost = sum(group, (s) => s.estimatedCostUsd!);
    byProject.push({
      name,
      count: group.length,
      cost,
      percent: totalCost > 0 ? (cost / totalCost) * 100 : 0,
    });
  }
  byProject.sort((a, b) => b.cost - a.cost);

  // By model
  const modelSessions = costSessions.filter((s) => s.primaryModel != null);
  const modelGroups = groupBy(modelSessions, (s) => s.primaryModel!);
  const byModel: GroupedMetric[] = [];
  for (const [name, group] of modelGroups) {
    const cost = sum(group, (s) => s.estimatedCostUsd!);
    byModel.push({
      name,
      count: group.length,
      cost,
      percent: totalCost > 0 ? (cost / totalCost) * 100 : 0,
    });
  }
  byModel.sort((a, b) => b.cost - a.cost);

  // Token breakdown with pricing
  const inputTokens = sum(costSessions, (s) => s.totalInputTokens ?? 0);
  const outputTokens = sum(costSessions, (s) => s.totalOutputTokens ?? 0);
  const cacheCreation = sum(costSessions, (s) => s.cacheCreationTokens ?? 0);
  const cacheReads = sum(costSessions, (s) => s.cacheReadTokens ?? 0);

  // Compute costs using weighted average pricing across models
  // For simplicity, use per-session model pricing and sum
  let inputCost = 0;
  let outputCost = 0;
  let cacheCreationCost = 0;
  let cacheReadCost = 0;

  for (const s of costSessions) {
    const pricing = getModelPricing(s.primaryModel ?? '');
    inputCost += ((s.totalInputTokens ?? 0) / 1_000_000) * pricing.input;
    outputCost += ((s.totalOutputTokens ?? 0) / 1_000_000) * pricing.output;
    cacheCreationCost +=
      ((s.cacheCreationTokens ?? 0) / 1_000_000) * pricing.input * 1.25;
    cacheReadCost +=
      ((s.cacheReadTokens ?? 0) / 1_000_000) * pricing.input * 0.1;
  }

  const cacheDenominator = inputTokens + cacheReads;
  const cacheHitRate =
    cacheDenominator > 0 ? cacheReads / cacheDenominator : 0;

  return {
    totalCost,
    avgPerDay,
    avgPerSession,
    sessionCount: sessions.length,
    sessionsWithCostCount: costSessions.length,
    dailyTrend,
    peakDay,
    byProject,
    byModel,
    tokenBreakdown: {
      inputTokens,
      outputTokens,
      cacheCreation,
      cacheReads,
      inputCost,
      outputCost,
      cacheCreationCost,
      cacheReadCost,
      cacheHitRate,
    },
  };
}

/**
 * Per-project statistics.
 */
export function computeProjectStats(
  sessions: SessionRow[],
  period: Period,
): ProjectStatsEntry[] {
  const groups = groupBy(sessions, (s) => s.projectId);
  const entries: ProjectStatsEntry[] = [];

  for (const [projectId, group] of groups) {
    if (group.length === 0) continue;

    const models = group
      .map((s) => s.primaryModel)
      .filter((m): m is string => m != null);
    const sourceTools = group
      .map((s) => s.sourceTool)
      .filter((t): t is string => t != null);

    const costSessions = group.filter((s) => s.estimatedCostUsd != null);

    entries.push({
      projectId,
      projectName: group[0].projectName,
      sessionCount: group.length,
      totalCost: sum(costSessions, (s) => s.estimatedCostUsd!),
      totalTimeMinutes: sum(group, (s) => diffMinutes(s.startedAt, s.endedAt)),
      messageCount: sum(group, (s) => s.messageCount),
      totalTokens: sum(costSessions, (s) =>
        (s.totalInputTokens ?? 0) +
        (s.totalOutputTokens ?? 0) +
        (s.cacheCreationTokens ?? 0) +
        (s.cacheReadTokens ?? 0),
      ),
      primaryModel: findMostFrequent(models),
      lastActive: group.reduce(
        (latest, s) => (s.endedAt > latest ? s.endedAt : latest),
        group[0].endedAt,
      ),
      sourceTool: findMostFrequent(sourceTools),
      activityByDay: groupByDay(group, period),
    });
  }

  entries.sort((a, b) => b.sessionCount - a.sessionCount);
  return entries;
}

/**
 * Today's session details.
 */
export function computeTodayStats(sessions: SessionRow[]): TodayStats {
  const t = today();
  const tYear = t.getFullYear();
  const tMonth = t.getMonth();
  const tDate = t.getDate();

  const todaySessions = sessions.filter((s) => {
    const d = s.startedAt;
    return (
      d.getFullYear() === tYear &&
      d.getMonth() === tMonth &&
      d.getDate() === tDate
    );
  });

  const costSessions = todaySessions.filter(
    (s) => s.estimatedCostUsd != null,
  );

  // Build TodaySession array, sorted by startedAt ASC (chronological)
  const sortedSessions = [...todaySessions].sort(
    (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
  );

  const sessionDetails: TodaySession[] = sortedSessions.map((s) => ({
    id: s.id,
    projectName: s.projectName,
    title: resolveTitle(s),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMinutes: diffMinutes(s.startedAt, s.endedAt),
    cost: s.estimatedCostUsd,
    model: s.primaryModel,
    messageCount: s.messageCount,
    sessionCharacter: s.sessionCharacter,
  }));

  return {
    date: t,
    sessionCount: todaySessions.length,
    totalCost: sum(costSessions, (s) => s.estimatedCostUsd!),
    totalTimeMinutes: sum(todaySessions, (s) =>
      diffMinutes(s.startedAt, s.endedAt),
    ),
    messageCount: sum(todaySessions, (s) => s.messageCount),
    totalTokens: sum(costSessions, (s) =>
      (s.totalInputTokens ?? 0) +
      (s.totalOutputTokens ?? 0) +
      (s.cacheCreationTokens ?? 0) +
      (s.cacheReadTokens ?? 0),
    ),
    sessions: sessionDetails,
  };
}

/**
 * Per-model statistics.
 */
export function computeModelStats(
  sessions: SessionRow[],
  period: Period,
): ModelStatsEntry[] {
  const withModel = sessions.filter((s) => s.primaryModel != null);
  const totalSessions = withModel.length;
  const totalCostAll = sum(
    withModel.filter((s) => s.estimatedCostUsd != null),
    (s) => s.estimatedCostUsd!,
  );

  const groups = groupBy(withModel, (s) => s.primaryModel!);
  const entries: ModelStatsEntry[] = [];

  for (const [model, group] of groups) {
    const costSessions = group.filter((s) => s.estimatedCostUsd != null);
    const modelTotalCost = sum(costSessions, (s) => s.estimatedCostUsd!);
    const pricing = getModelPricing(model);

    // Per-session token-based cost breakdown
    let inputCost = 0;
    let outputCost = 0;
    let cacheCost = 0;

    for (const s of costSessions) {
      inputCost += ((s.totalInputTokens ?? 0) / 1_000_000) * pricing.input;
      outputCost += ((s.totalOutputTokens ?? 0) / 1_000_000) * pricing.output;
      cacheCost +=
        ((s.cacheCreationTokens ?? 0) / 1_000_000) * pricing.input * 1.25 +
        ((s.cacheReadTokens ?? 0) / 1_000_000) * pricing.input * 0.1;
    }

    const totalTokens = sum(costSessions, (s) =>
      (s.totalInputTokens ?? 0) +
      (s.totalOutputTokens ?? 0) +
      (s.cacheCreationTokens ?? 0) +
      (s.cacheReadTokens ?? 0),
    );

    entries.push({
      model,
      displayName: shortenModelName(model),
      sessionCount: group.length,
      sessionPercent:
        totalSessions > 0 ? (group.length / totalSessions) * 100 : 0,
      totalCost: modelTotalCost,
      costPercent:
        totalCostAll > 0 ? (modelTotalCost / totalCostAll) * 100 : 0,
      avgCostPerSession:
        costSessions.length > 0 ? modelTotalCost / costSessions.length : 0,
      totalTokens,
      inputCost,
      outputCost,
      cacheCost,
      trend: groupByDay(group, period),
    });
  }

  entries.sort((a, b) => b.totalCost - a.totalCost);
  return entries;
}
