import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getDb } from '@code-insights/cli/db/client';
import { jsonrepair } from 'jsonrepair';
import { createLLMClient, isLLMConfigured } from '../llm/client.js';
import { extractJsonPayload } from '../llm/prompts.js';
import { normalizeFrictionCategory } from '../llm/friction-normalize.js';
import {
  FRICTION_WINS_SYSTEM_PROMPT,
  generateFrictionWinsPrompt,
  RULES_SKILLS_SYSTEM_PROMPT,
  generateRulesSkillsPrompt,
  WORKING_STYLE_SYSTEM_PROMPT,
  generateWorkingStylePrompt,
} from '../llm/reflect-prompts.js';
import type { ReflectSection } from '@code-insights/cli/types';

const app = new Hono();

const ALL_SECTIONS: ReflectSection[] = ['friction-wins', 'rules-skills', 'working-style'];

function buildPeriodFilter(period: string): string | null {
  const now = new Date();
  if (period === '7d') return new Date(now.getTime() - 7 * 86400000).toISOString();
  if (period === '30d') return new Date(now.getTime() - 30 * 86400000).toISOString();
  if (period === '90d') return new Date(now.getTime() - 90 * 86400000).toISOString();
  return null;
}

// Build WHERE clause from period/project/source filters.
// Joins are against session_facets sf and sessions s (or just sessions s).
// Returns WHERE clause string and params array.
function buildWhereClause(
  period: string,
  project?: string,
  source?: string
): { where: string; params: (string | number)[] } {
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

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

// Run all aggregation queries needed for synthesis.
// Aggregation is done in code (SQL), not by LLM — LLMs synthesize, they don't count.
function getAggregatedData(
  db: ReturnType<typeof getDb>,
  where: string,
  params: (string | number)[]
) {
  // Determine whether to use WHERE or AND for additional predicates on non-join queries.
  // The WHERE clause already handles session filters — additional predicates need AND.
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
      json_group_array(json_extract(je.value, '$.description')) as examples
    FROM session_facets sf
    JOIN sessions s ON sf.session_id = s.id
    CROSS JOIN json_each(sf.friction_points) je
    ${where}
    GROUP BY category
    ORDER BY count DESC, avg_severity DESC
  `).all(...params) as Array<{ category: string; count: number; avg_severity: number; examples: string }>;

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

  // workflow_pattern can be NULL — filter those out for a clean distribution
  const workflowDistribution = db.prepare(`
    SELECT workflow_pattern, COUNT(*) as count
    FROM session_facets sf JOIN sessions s ON sf.session_id = s.id
    ${where}
    ${extraPrefix} sf.workflow_pattern IS NOT NULL
    GROUP BY workflow_pattern
  `).all(...params) as Array<{ workflow_pattern: string; count: number }>;

  // session_character lives on the sessions table, not facets
  const characterDistribution = db.prepare(`
    SELECT session_character, COUNT(*) as count
    FROM sessions s
    ${where}
    ${extraPrefix} s.session_character IS NOT NULL
    GROUP BY session_character
  `).all(...params) as Array<{ session_character: string; count: number }>;

  // Count faceted sessions (not all sessions — only those with extracted facets)
  const totalRow = db.prepare(
    `SELECT COUNT(*) as count FROM session_facets sf JOIN sessions s ON sf.session_id = s.id ${where}`
  ).get(...params) as { count: number };

  const frictionTotal = frictionCategories.reduce((sum, fc) => sum + fc.count, 0);

  // Parse examples from json_group_array output, then normalize via Levenshtein clustering
  const parsedFriction = frictionCategories.map(fc => ({
    ...fc,
    examples: JSON.parse(fc.examples) as string[],
  }));

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

  return {
    frictionCategories: mergedFriction,
    effectivePatterns,
    outcomeDistribution: Object.fromEntries(outcomeDistribution.map(o => [o.outcome_satisfaction, o.count])),
    workflowDistribution: Object.fromEntries(workflowDistribution.map(w => [w.workflow_pattern, w.count])),
    characterDistribution: Object.fromEntries(characterDistribution.map(ch => [ch.session_character, ch.count])),
    totalSessions: totalRow.count,
    frictionTotal,
  };
}

// Parse LLM JSON response wrapped in <json>...</json> tags with jsonrepair fallback.
function parseLLMJson<T>(response: string): T | null {
  const payload = extractJsonPayload(response);
  if (!payload) return null;
  try {
    return JSON.parse(payload) as T;
  } catch {
    try {
      return JSON.parse(jsonrepair(payload)) as T;
    } catch {
      return null;
    }
  }
}

// Detect the dominant source tool from the database to target artifact generation.
function detectTargetTool(db: ReturnType<typeof getDb>): string {
  const row = db.prepare(
    `SELECT source_tool, COUNT(*) as count FROM sessions GROUP BY source_tool ORDER BY count DESC LIMIT 1`
  ).get() as { source_tool: string; count: number } | undefined;
  return row?.source_tool || 'claude-code';
}

// POST /api/reflect/generate
// Body: { sections?: ReflectSection[], period?: string, project?: string, source?: string }
// SSE endpoint: aggregates facets in code, then calls synthesis prompts for each section.
// Streams progress events so the UI can show phase-by-phase progress.
app.post('/generate', async (c) => {
  if (!isLLMConfigured()) {
    return c.json({ error: 'LLM not configured.' }, 400);
  }

  const body = await c.req.json<{
    sections?: ReflectSection[];
    period?: string;
    project?: string;
    source?: string;
  }>();

  const sections = body.sections && body.sections.length > 0 ? body.sections : ALL_SECTIONS;
  const period = body.period || '7d';

  const db = getDb();
  const { where, params } = buildWhereClause(period, body.project, body.source);

  return streamSSE(c, async (stream) => {
    const abortSignal = c.req.raw.signal;

    try {
      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ phase: 'aggregating', message: 'Aggregating facets...' }),
      });

      const aggregated = getAggregatedData(db, where, params);

      if (aggregated.totalSessions === 0) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'No sessions with facets found. Run analysis first.' }),
        });
        return;
      }

      const client = createLLMClient();
      const results: Record<string, unknown> = {};
      const targetTool = detectTargetTool(db);

      for (const section of sections) {
        if (abortSignal.aborted) break;

        await stream.writeSSE({
          event: 'progress',
          data: JSON.stringify({ phase: 'synthesizing', section, message: `Generating ${section}...` }),
        });

        if (section === 'friction-wins') {
          const prompt = generateFrictionWinsPrompt({
            frictionCategories: aggregated.frictionCategories,
            effectivePatterns: aggregated.effectivePatterns,
            totalSessions: aggregated.totalSessions,
            period,
          });
          const response = await client.chat([
            { role: 'system', content: FRICTION_WINS_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ], { signal: abortSignal });
          const parsed = parseLLMJson(response.content);
          results['friction-wins'] = {
            section: 'friction-wins',
            ...(parsed ?? {}),
            frictionCategories: aggregated.frictionCategories,
            effectivePatterns: aggregated.effectivePatterns,
            generatedAt: new Date().toISOString(),
          };
        } else if (section === 'rules-skills') {
          // Only include patterns with sufficient occurrence counts for actionable artifacts
          const recurringFriction = aggregated.frictionCategories.filter(fc => fc.count >= 3);
          const recurringPatterns = aggregated.effectivePatterns.filter(ep => ep.frequency >= 2);
          const prompt = generateRulesSkillsPrompt({
            recurringFriction,
            effectivePatterns: recurringPatterns,
            targetTool,
          });
          const response = await client.chat([
            { role: 'system', content: RULES_SKILLS_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ], { signal: abortSignal });
          const parsed = parseLLMJson(response.content);
          results['rules-skills'] = {
            section: 'rules-skills',
            ...(parsed ?? {}),
            targetTool,
            generatedAt: new Date().toISOString(),
          };
        } else if (section === 'working-style') {
          const prompt = generateWorkingStylePrompt({
            workflowDistribution: aggregated.workflowDistribution,
            outcomeDistribution: aggregated.outcomeDistribution,
            characterDistribution: aggregated.characterDistribution,
            totalSessions: aggregated.totalSessions,
            period,
            frictionFrequency: aggregated.frictionTotal,
          });
          const response = await client.chat([
            { role: 'system', content: WORKING_STYLE_SYSTEM_PROMPT },
            { role: 'user', content: prompt },
          ], { signal: abortSignal });
          const parsed = parseLLMJson(response.content);
          results['working-style'] = {
            section: 'working-style',
            ...(parsed ?? {}),
            workflowDistribution: aggregated.workflowDistribution,
            outcomeDistribution: aggregated.outcomeDistribution,
            characterDistribution: aggregated.characterDistribution,
            generatedAt: new Date().toISOString(),
          };
        }
      }

      await stream.writeSSE({
        event: 'complete',
        data: JSON.stringify({ results }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: message }),
      }).catch(() => {});
    }
  });
});

// GET /api/reflect/results
// Returns raw aggregated facet data without LLM synthesis (fast, no cost).
// The full synthesized view requires POST /api/reflect/generate.
app.get('/results', (c) => {
  const db = getDb();
  const period = c.req.query('period') || '7d';
  const project = c.req.query('project');
  const source = c.req.query('source');

  const { where, params } = buildWhereClause(period, project, source);
  const aggregated = getAggregatedData(db, where, params);

  return c.json(aggregated);
});

export default app;
