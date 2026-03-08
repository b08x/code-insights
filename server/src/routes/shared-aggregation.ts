// Shared aggregation logic for facets and reflect routes.
// Extracted to avoid ~150 lines of duplication between the two routes.

import { getDb } from '@code-insights/cli/db/client';
import { normalizeFrictionCategory } from '../llm/friction-normalize.js';

export function buildPeriodFilter(period: string): string | null {
  const now = new Date();
  if (period === '7d') return new Date(now.getTime() - 7 * 86400000).toISOString();
  if (period === '30d') return new Date(now.getTime() - 30 * 86400000).toISOString();
  if (period === '90d') return new Date(now.getTime() - 90 * 86400000).toISOString();
  return null; // 'all'
}

export function buildWhereClause(
  period: string,
  project?: string,
  source?: string
): { where: string; params: (string | number)[] } {
  // Always exclude soft-deleted sessions from aggregations
  const conditions: string[] = ['s.deleted_at IS NULL'];
  const params: (string | number)[] = [];

  const periodStart = buildPeriodFilter(period);
  if (periodStart) {
    conditions.push('s.started_at >= ?');
    params.push(periodStart);
  }
  if (project) {
    conditions.push('s.project_id = ?');
    params.push(project);
  }
  if (source) {
    conditions.push('s.source_tool = ?');
    params.push(source);
  }

  return {
    where: `WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

export interface AggregatedFrictionCategory {
  category: string;
  count: number;
  avg_severity: number;
  examples: string[];
}

export interface AggregatedEffectivePattern {
  description: string;
  frequency: number;
  avg_confidence: number;
}

export interface RateLimitInfo {
  count: number;
  sessionsAffected: number;
  examples: string[];
}

export interface AggregatedData {
  frictionCategories: AggregatedFrictionCategory[];
  effectivePatterns: AggregatedEffectivePattern[];
  outcomeDistribution: Record<string, number>;
  workflowDistribution: Record<string, number>;
  characterDistribution: Record<string, number>;
  totalSessions: number;
  frictionTotal: number;
  totalAllSessions: number;  // all sessions in scope (not just those with facets)
  rateLimitInfo: RateLimitInfo | null;
  streak: number;            // consecutive days with at least one session (ignores period filter)
  sourceToolCount: number;   // distinct AI tools used within the scope
}

/**
 * Run all aggregation queries needed for facet analysis and synthesis.
 * Aggregation is done in code (SQL), not by LLMs — LLMs synthesize, they don't count.
 *
 * project and source are passed separately so streak can build its own
 * period-free where clause (streak measures continuity across all time).
 */
export function getAggregatedData(
  db: ReturnType<typeof getDb>,
  where: string,
  params: (string | number)[],
  project?: string,
  source?: string
): AggregatedData {
  const hasWhere = where.length > 0;
  const extraPrefix = hasWhere ? 'AND' : 'WHERE';

  const frictionCategories = db.prepare(`
    SELECT
      json_extract(je.value, '$.category') as category,
      COUNT(*) as count,
      AVG(CASE
        WHEN json_extract(je.value, '$.severity') = 'high' THEN 3
        WHEN json_extract(je.value, '$.severity') = 'medium' THEN 2
        ELSE 1
      END) as avg_severity,
      json_group_array(json_extract(je.value, '$.description')) as examples,
      json_group_array(sf.session_id) as session_ids
    FROM session_facets sf
    JOIN sessions s ON sf.session_id = s.id
    CROSS JOIN json_each(sf.friction_points) je
    ${where}
    GROUP BY category
    ORDER BY count DESC, avg_severity DESC
  `).all(...params) as Array<{ category: string; count: number; avg_severity: number; examples: string; session_ids: string }>;

  const effectivePatterns = db.prepare(`
    SELECT
      json_extract(je.value, '$.description') as description,
      COUNT(*) as frequency,
      AVG(json_extract(je.value, '$.confidence')) as avg_confidence
    FROM session_facets sf
    JOIN sessions s ON sf.session_id = s.id
    CROSS JOIN json_each(sf.effective_patterns) je
    ${where}
    GROUP BY description
    ORDER BY frequency DESC, avg_confidence DESC
  `).all(...params) as Array<{ description: string; frequency: number; avg_confidence: number }>;

  const outcomeDistribution = db.prepare(`
    SELECT outcome_satisfaction, COUNT(*) as count
    FROM session_facets sf JOIN sessions s ON sf.session_id = s.id
    ${where}
    GROUP BY outcome_satisfaction
  `).all(...params) as Array<{ outcome_satisfaction: string; count: number }>;

  const workflowDistribution = db.prepare(`
    SELECT workflow_pattern, COUNT(*) as count
    FROM session_facets sf JOIN sessions s ON sf.session_id = s.id
    ${where}
    ${extraPrefix} sf.workflow_pattern IS NOT NULL
    GROUP BY workflow_pattern
  `).all(...params) as Array<{ workflow_pattern: string; count: number }>;

  const characterDistribution = db.prepare(`
    SELECT session_character, COUNT(*) as count
    FROM sessions s
    ${where}
    ${extraPrefix} s.session_character IS NOT NULL
    GROUP BY session_character
  `).all(...params) as Array<{ session_character: string; count: number }>;

  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM session_facets sf JOIN sessions s ON sf.session_id = s.id ${where}`
  ).get(...params) as { count: number };

  const totalAllRow = db.prepare(
    `SELECT COUNT(*) as count FROM sessions s ${where}`
  ).get(...params) as { count: number };

  // Parse examples and session_ids from json_group_array output, then normalize via alias + Levenshtein clustering
  const parsedFriction = frictionCategories.map(fc => ({
    ...fc,
    examples: JSON.parse(fc.examples) as string[],
    session_ids: JSON.parse(fc.session_ids) as string[],
  }));

  const normalizedFriction = new Map<string, { count: number; total_severity: number; examples: string[]; session_ids: string[] }>();
  for (const fc of parsedFriction) {
    const normalized = normalizeFrictionCategory(fc.category);
    const existing = normalizedFriction.get(normalized);
    if (existing) {
      existing.count += fc.count;
      existing.total_severity += fc.avg_severity * fc.count;
      existing.examples.push(...fc.examples);
      existing.session_ids.push(...fc.session_ids);
    } else {
      normalizedFriction.set(normalized, {
        count: fc.count,
        total_severity: fc.avg_severity * fc.count,
        examples: [...fc.examples],
        session_ids: [...fc.session_ids],
      });
    }
  }

  // Partition: separate rate-limit-hit entries from general friction.
  // Rate limits are a billing/plan constraint — surfaced as a usage insight, not friction.
  // The alias map already normalizes all rate limit variants to "rate-limit-hit".
  // A regex sweep catches creative LLM variants ("throttled-by-api", etc.) that bypass
  // both the alias map and Levenshtein clustering.
  const RATE_LIMIT_CATEGORY = 'rate-limit-hit';
  const RATE_LIMIT_REGEX = /rate.?limit|throttl/i;
  let rateLimitInfo: RateLimitInfo | null = null;

  // Accumulated data for rateLimitInfo, merged from exact match + regex sweep
  let rateLimitCount = 0;
  let rateLimitSessionIds: string[] = [];
  let rateLimitExamples: string[] = [];

  const rateLimitEntry = normalizedFriction.get(RATE_LIMIT_CATEGORY);
  if (rateLimitEntry) {
    rateLimitCount += rateLimitEntry.count;
    rateLimitSessionIds.push(...rateLimitEntry.session_ids);
    rateLimitExamples.push(...rateLimitEntry.examples);
    normalizedFriction.delete(RATE_LIMIT_CATEGORY);
  }

  // Regex sweep over remaining entries to catch variants the alias map missed
  for (const [category, entry] of normalizedFriction) {
    if (RATE_LIMIT_REGEX.test(category)) {
      rateLimitCount += entry.count;
      rateLimitSessionIds.push(...entry.session_ids);
      rateLimitExamples.push(...entry.examples);
      normalizedFriction.delete(category);
    }
  }

  if (rateLimitCount > 0) {
    const uniqueSessions = new Set(rateLimitSessionIds);
    rateLimitInfo = {
      count: rateLimitCount,
      sessionsAffected: uniqueSessions.size,
      examples: rateLimitExamples.slice(0, 3),
    };
  }

  const mergedFriction = Array.from(normalizedFriction.entries())
    .map(([category, data]) => ({
      category,
      count: data.count,
      avg_severity: data.total_severity / data.count,
      examples: data.examples.slice(0, 10),
    }))
    .sort((a, b) => b.count - a.count || b.avg_severity - a.avg_severity);

  // frictionTotal reflects only non-rate-limit friction (rate limits partitioned separately)
  const frictionTotal = mergedFriction.reduce((sum, fc) => sum + fc.count, 0);

  // Count distinct source tools within scope (for hero card stat pill)
  const sourceToolRow = db.prepare(
    `SELECT COUNT(DISTINCT source_tool) as count FROM sessions s ${where}`
  ).get(...params) as { count: number };

  // Streak: count consecutive days (backward from today) with at least one session.
  // Always uses all-time scope — filtering by period would cap streak at the window size.
  // Respects project and source filters since those are user-scope constraints.
  const { where: streakWhere, params: streakParams } = buildWhereClause('all', project, source);
  const sessionDates = db.prepare(
    `SELECT DISTINCT date(started_at) as session_date FROM sessions s ${streakWhere} ORDER BY session_date DESC`
  ).all(...streakParams) as Array<{ session_date: string }>;

  let streak = 0;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (let i = 0; i < sessionDates.length; i++) {
    const sessionDay = new Date(sessionDates[i].session_date + 'T00:00:00');
    const expectedDay = new Date(today.getTime() - i * 86400000);
    // Allow today or yesterday as the start of an active streak
    if (i === 0 && sessionDay.getTime() < expectedDay.getTime() - 86400000) break;
    if (i > 0 && sessionDay.getTime() !== expectedDay.getTime()) break;
    streak++;
  }

  return {
    frictionCategories: mergedFriction,
    effectivePatterns,
    outcomeDistribution: Object.fromEntries(outcomeDistribution.map(o => [o.outcome_satisfaction, o.count])),
    workflowDistribution: Object.fromEntries(workflowDistribution.map(w => [w.workflow_pattern, w.count])),
    characterDistribution: Object.fromEntries(characterDistribution.map(ch => [ch.session_character, ch.count])),
    totalSessions: totalRow.count,
    frictionTotal,
    totalAllSessions: totalAllRow.count,
    rateLimitInfo,
    streak,
    sourceToolCount: sourceToolRow.count,
  };
}
