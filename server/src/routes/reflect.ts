import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getDb } from '@code-insights/cli/db/client';
import { jsonrepair } from 'jsonrepair';
import { createLLMClient, isLLMConfigured } from '../llm/client.js';
import { extractJsonPayload } from '../llm/prompts.js';
import {
  FRICTION_WINS_SYSTEM_PROMPT,
  generateFrictionWinsPrompt,
  RULES_SKILLS_SYSTEM_PROMPT,
  generateRulesSkillsPrompt,
  WORKING_STYLE_SYSTEM_PROMPT,
  generateWorkingStylePrompt,
} from '../llm/reflect-prompts.js';
import { buildWhereClause, getAggregatedData } from './shared-aggregation.js';
import type { ReflectSection } from '@code-insights/cli/types';

const app = new Hono();

const ALL_SECTIONS: ReflectSection[] = ['friction-wins', 'rules-skills', 'working-style'];

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
  const period = body.period || '30d';

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
  const period = c.req.query('period') || '30d';
  const project = c.req.query('project');
  const source = c.req.query('source');

  const { where, params } = buildWhereClause(period, project, source);
  const aggregated = getAggregatedData(db, where, params);

  return c.json(aggregated);
});

export default app;
