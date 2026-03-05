import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getDb } from '@code-insights/cli/db/client';
import { isLLMConfigured } from '../llm/client.js';
import { extractFacetsOnly } from '../llm/analysis.js';
import type { SQLiteMessageRow, SessionData } from '../llm/analysis.js';
import { normalizeFrictionCategory } from '../llm/friction-normalize.js';

const app = new Hono();

interface FacetRow {
  session_id: string;
  outcome_satisfaction: string;
  workflow_pattern: string | null;
  had_course_correction: number;
  course_correction_reason: string | null;
  iteration_count: number;
  friction_points: string;     // JSON
  effective_patterns: string;  // JSON
  extracted_at: string;
  analysis_version: string;
}

function buildPeriodFilter(period: string): string | null {
  const now = new Date();
  if (period === '7d') return new Date(now.getTime() - 7 * 86400000).toISOString();
  if (period === '30d') return new Date(now.getTime() - 30 * 86400000).toISOString();
  if (period === '90d') return new Date(now.getTime() - 90 * 86400000).toISOString();
  return null; // 'all'
}

// GET /api/facets
// Query params: project (project_id), period (7d|30d|90d|all), source (source_tool filter)
// Returns: { facets, missingCount, totalSessions }
app.get('/', (c) => {
  const db = getDb();
  const project = c.req.query('project');
  const period = c.req.query('period') || '7d';
  const source = c.req.query('source');

  const conditions: string[] = [];
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Total sessions in scope
  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM sessions s ${where}`
  ).get(...params) as { count: number };

  // Sessions with facets — join to sessions so period/project/source filters apply
  const facets = db.prepare(
    `SELECT sf.* FROM session_facets sf
     JOIN sessions s ON sf.session_id = s.id
     ${where}
     ORDER BY s.started_at DESC`
  ).all(...params) as FacetRow[];

  return c.json({
    facets,
    missingCount: totalRow.count - facets.length,
    totalSessions: totalRow.count,
  });
});

// GET /api/facets/aggregated
// Returns pre-aggregated friction categories and effective patterns for synthesis.
// Uses json_each() to unpack JSON arrays stored in session_facets.friction_points
// and session_facets.effective_patterns — aggregation done in SQL, not by LLM.
app.get('/aggregated', (c) => {
  const db = getDb();
  const project = c.req.query('project');
  const period = c.req.query('period') || '7d';
  const source = c.req.query('source');

  const conditions: string[] = [];
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

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Friction point aggregation using json_each to unpack the stored JSON array.
  // avg_severity maps text values to numeric weights (high=3, medium=2, low=1)
  // so we can rank categories by combined frequency × severity.
  const frictionCategories = db.prepare(`
    SELECT
      json_extract(je.value, '$.category') as category,
      COUNT(*) as count,
      AVG(CASE
        WHEN json_extract(je.value, '$.severity') = 'high' THEN 3
        WHEN json_extract(je.value, '$.severity') = 'medium' THEN 2
        ELSE 1
      END) as avg_severity,
      json_group_array(json_extract(je.value, '$.description')) as examples
    FROM session_facets sf
    JOIN sessions s ON sf.session_id = s.id
    CROSS JOIN json_each(sf.friction_points) je
    ${where}
    GROUP BY category
    ORDER BY count DESC, avg_severity DESC
  `).all(...params) as Array<{
    category: string;
    count: number;
    avg_severity: number;
    examples: string;
  }>;

  // Effective pattern aggregation — group identical descriptions across sessions
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
  `).all(...params) as Array<{
    description: string;
    frequency: number;
    avg_confidence: number;
  }>;

  // Outcome distribution — indexed column, fast
  const outcomeDistribution = db.prepare(`
    SELECT outcome_satisfaction, COUNT(*) as count
    FROM session_facets sf
    JOIN sessions s ON sf.session_id = s.id
    ${where}
    GROUP BY outcome_satisfaction
  `).all(...params) as Array<{ outcome_satisfaction: string; count: number }>;

  // Workflow distribution — indexed column, fast; NULL rows excluded
  const workflowDistribution = db.prepare(`
    SELECT workflow_pattern, COUNT(*) as count
    FROM session_facets sf
    JOIN sessions s ON sf.session_id = s.id
    ${where}
    ${conditions.length > 0 ? 'AND' : 'WHERE'} sf.workflow_pattern IS NOT NULL
    GROUP BY workflow_pattern
  `).all(...params) as Array<{ workflow_pattern: string; count: number }>;

  // Session character from sessions table (not facets)
  const characterDistribution = db.prepare(`
    SELECT session_character, COUNT(*) as count
    FROM sessions s
    ${where}
    ${conditions.length > 0 ? 'AND' : 'WHERE'} s.session_character IS NOT NULL
    GROUP BY session_character
  `).all(...params) as Array<{ session_character: string; count: number }>;

  // Parse examples from json_group_array output
  const parsedFriction = frictionCategories.map(fc => ({
    ...fc,
    examples: JSON.parse(fc.examples) as string[],
  }));

  // Normalize friction categories via Levenshtein clustering
  const normalizedFriction = new Map<string, { count: number; total_severity: number; examples: string[] }>();
  for (const fc of parsedFriction) {
    const normalized = normalizeFrictionCategory(fc.category);
    const existing = normalizedFriction.get(normalized);
    if (existing) {
      existing.count += fc.count;
      existing.total_severity += fc.avg_severity * fc.count;
      existing.examples.push(...fc.examples);
    } else {
      normalizedFriction.set(normalized, {
        count: fc.count,
        total_severity: fc.avg_severity * fc.count,
        examples: [...fc.examples],
      });
    }
  }

  const mergedFriction = Array.from(normalizedFriction.entries())
    .map(([category, data]) => ({
      category,
      count: data.count,
      avg_severity: data.total_severity / data.count,
      examples: data.examples.slice(0, 10), // cap examples
    }))
    .sort((a, b) => b.count - a.count || b.avg_severity - a.avg_severity);

  return c.json({
    frictionCategories: mergedFriction,
    effectivePatterns,
    outcomeDistribution: Object.fromEntries(outcomeDistribution.map(o => [o.outcome_satisfaction, o.count])),
    workflowDistribution: Object.fromEntries(workflowDistribution.map(w => [w.workflow_pattern, w.count])),
    characterDistribution: Object.fromEntries(characterDistribution.map(ch => [ch.session_character, ch.count])),
  });
});

// POST /api/facets/backfill
// Body: { sessionIds: string[] }
// Streams progress as facets are extracted one-by-one for sessions that lack them.
// Uses extractFacetsOnly (lightweight prompt: summary + first/last 20 messages).
app.post('/backfill', async (c) => {
  if (!isLLMConfigured()) {
    return c.json({ error: 'LLM not configured.' }, 400);
  }

  const body = await c.req.json<{ sessionIds?: string[] }>();
  if (!body.sessionIds || !Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
    return c.json({ error: 'sessionIds array required' }, 400);
  }

  const db = getDb();

  return streamSSE(c, async (stream) => {
    const abortSignal = c.req.raw.signal;
    let completed = 0;
    let failed = 0;
    const total = body.sessionIds!.length;

    for (const sessionId of body.sessionIds!) {
      if (abortSignal.aborted) break;

      const session = db.prepare(
        `SELECT id, project_id, project_name, project_path, summary, ended_at
         FROM sessions WHERE id = ?`
      ).get(sessionId) as SessionData | undefined;

      if (!session) {
        failed++;
        // Still emit progress so the client can track the count
        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({
            completed,
            failed,
            total,
            currentSessionId: sessionId,
          }),
        });
        continue;
      }

      const messages = db.prepare(
        `SELECT id, session_id, type, content, thinking, tool_calls, tool_results, usage, timestamp, parent_id
         FROM messages WHERE session_id = ? ORDER BY timestamp ASC`
      ).all(sessionId) as SQLiteMessageRow[];

      const result = await extractFacetsOnly(session, messages, { signal: abortSignal });
      if (result.success) {
        completed++;
      } else {
        failed++;
      }

      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({
          completed,
          failed,
          total,
          currentSessionId: sessionId,
        }),
      });
    }

    await stream.writeSSE({
      event: 'complete',
      data: JSON.stringify({ completed, failed, total }),
    });
  });
});

export default app;
