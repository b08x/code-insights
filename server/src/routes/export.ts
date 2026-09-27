import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { getDb } from '@code-insights/cli/db/client';
import { trackEvent, captureError } from '@code-insights/cli/utils/telemetry';
import type { ExportTemplate } from '@code-insights/cli/types';
import { formatKnowledgeBase } from '../export/knowledge-base.js';
import { formatAgentRules } from '../export/agent-rules.js';
import type { SessionRow, InsightRow } from '../export/knowledge-base.js';
import { createLLMClient, loadLLMConfig } from '../llm/client.js';
import { requireLLM } from './route-helpers.js';
import {
  applyDepthCap,
  buildInsightContext,
  getExportSystemPrompt,
  buildExportUserPrompt,
  type ExportFormat,
  type ExportScope,
  type ExportDepth,
  type ExportInsightRow,
} from '../llm/export-prompts.js';

const app = new Hono();

// Date validation helper for YYYY-MM-DD format
function validateDateString(dateStr: string): boolean {
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateStr)) return false;
  const date = new Date(dateStr + 'T00:00:00Z');
  return date.toISOString().slice(0, 10) === dateStr;
}

// SQLite SQLITE_LIMIT_VARIABLE_NUMBER is 999 by default.
// Batch insights queries to avoid hitting this limit for large session sets.
const INSIGHTS_BATCH_SIZE = 500;

function fetchInsightsForSessions(db: ReturnType<typeof getDb>, sessionIds: string[]): InsightRow[] {
  if (sessionIds.length === 0) return [];

  const results: InsightRow[] = [];
  for (let i = 0; i < sessionIds.length; i += INSIGHTS_BATCH_SIZE) {
    const chunk = sessionIds.slice(i, i + INSIGHTS_BATCH_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT id, session_id, project_id, project_name, type, title, content,
              summary, bullets, confidence, source, metadata, timestamp,
              created_at, scope, analysis_version, linked_insight_ids
       FROM insights WHERE session_id IN (${placeholders})
       ORDER BY type, timestamp`,
    ).all(...chunk) as InsightRow[];
    results.push(...rows);
  }
  return results;
}

// POST /api/export/markdown — export sessions/insights as markdown
app.post('/markdown', async (c) => {
  const db = getDb();
  const body = await c.req.json<{
    sessionIds?: string[];
    projectId?: string;
    template?: ExportTemplate;
  }>();

  const { sessionIds, projectId, template = 'knowledge-base' } = body;

  if (template !== 'knowledge-base' && template !== 'agent-rules') {
    return c.json({ error: 'template must be "knowledge-base" or "agent-rules"' }, 400);
  }
  if (sessionIds !== undefined && !Array.isArray(sessionIds)) {
    return c.json({ error: 'sessionIds must be an array' }, 400);
  }
  if (sessionIds && (sessionIds as unknown[]).some((id) => typeof id !== 'string')) {
    return c.json({ error: 'sessionIds must contain only strings' }, 400);
  }
  if (sessionIds && sessionIds.length > 100) {
    return c.json({ error: 'Maximum 100 session IDs per export request' }, 400);
  }

  let sessions: SessionRow[];
  if (sessionIds && sessionIds.length > 0) {
    const placeholders = sessionIds.map(() => '?').join(', ');
    sessions = db.prepare(
      `SELECT id, project_name, generated_title, custom_title, started_at, ended_at,
              message_count, estimated_cost_usd, session_character, source_tool
       FROM sessions WHERE id IN (${placeholders}) AND deleted_at IS NULL ORDER BY started_at DESC`,
    ).all(...sessionIds) as SessionRow[];
  } else if (projectId) {
    // Cap at 100 to avoid unbounded queries and SQLite variable limit on insight fetch
    sessions = db.prepare(
      `SELECT id, project_name, generated_title, custom_title, started_at, ended_at,
              message_count, estimated_cost_usd, session_character, source_tool
       FROM sessions WHERE project_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 100`,
    ).all(projectId) as SessionRow[];
  } else {
    // "Everything" export — most recent 100 sessions
    sessions = db.prepare(
      `SELECT id, project_name, generated_title, custom_title, started_at, ended_at,
              message_count, estimated_cost_usd, session_character, source_tool
       FROM sessions WHERE deleted_at IS NULL ORDER BY started_at DESC LIMIT 100`,
    ).all() as SessionRow[];
  }

  const insights = fetchInsightsForSessions(db, sessions.map((s) => s.id));

  const markdown =
    template === 'agent-rules'
      ? formatAgentRules(sessions, insights)
      : formatKnowledgeBase(sessions, insights);

  trackEvent('export_run', {
    format: 'markdown',
    template,
    session_count: sessions.length,
    insight_count: insights.length,
    success: true,
  });

  c.header('Content-Type', 'text/markdown');
  return c.body(markdown);
});

// ─── LLM-powered export types (co-located, not in cli/src/types.ts) ──────────

interface ExportGenerateBody {
  scope: ExportScope;
  projectId?: string;
  format: ExportFormat;
  depth?: ExportDepth;
  dateFrom?: string; // YYYY-MM-DD format
  dateTo?: string; // YYYY-MM-DD format
}

interface ExportGenerateMetadata {
  insightCount: number;    // insights actually sent to LLM
  totalInsights: number;   // total insights available for scope
  sessionCount: number;
  projectCount: number;
  scope: ExportScope;
  depth: ExportDepth;
}

// Fetch scoped insights ordered by confidence DESC, timestamp DESC.
// Excludes 'summary' type — per-session summaries aren't cross-session knowledge.
// Supports optional date range filtering on insights.timestamp.
function fetchScopedInsights(
  db: ReturnType<typeof getDb>,
  scope: ExportScope,
  projectId: string | undefined,
  dateFrom?: string,
  dateTo?: string
): ExportInsightRow[] {
  let query = `
    SELECT i.id, i.type, i.title, i.content, i.summary, i.confidence, i.project_name, i.timestamp
    FROM insights i
    JOIN sessions s ON i.session_id = s.id AND s.deleted_at IS NULL
    WHERE i.type != 'summary'
  `;

  const params: (string | number)[] = [];

  if (scope === 'project') {
    if (!projectId) return [];
    query += ` AND i.project_id = ?`;
    params.push(projectId);
  }

  if (dateFrom) {
    query += ` AND i.timestamp >= ?`;
    params.push(dateFrom + 'T00:00:00Z');
  }

  if (dateTo) {
    query += ` AND i.timestamp < date(?, '+1 day')`;
    params.push(dateTo + 'T00:00:00Z');
  }

  query += ` ORDER BY i.confidence DESC, i.timestamp DESC`;

  return db.prepare(query).all(...params) as ExportInsightRow[];
}

function fetchSessionContext(
  db: ReturnType<typeof getDb>,
  scope: ExportScope,
  projectId: string | undefined,
  dateFrom?: string,
  dateTo?: string
): { sessionCount: number; projectCount: number; projectName: string | undefined; dateFrom: string; dateTo: string } {
  const today = new Date().toISOString().slice(0, 10);

  if (scope === 'project' && projectId) {
    let query = `
      SELECT COUNT(*) as cnt, MIN(started_at) as min_date, MAX(ended_at) as max_date, project_name
      FROM sessions s
      WHERE s.project_id = ? AND s.deleted_at IS NULL
    `;
    const params: (string | number)[] = [projectId];

    if (dateFrom || dateTo) {
      query += ` AND EXISTS (
        SELECT 1 FROM insights i
        WHERE i.session_id = s.id
      `;
      if (dateFrom) {
        query += ` AND i.timestamp >= ?`;
        params.push(dateFrom + 'T00:00:00Z');
      }
      if (dateTo) {
        query += ` AND i.timestamp < date(?, '+1 day')`;
        params.push(dateTo + 'T00:00:00Z');
      }
      query += `)`;
    }

    const row = db.prepare(query).get(...params) as { cnt: number; min_date: string; max_date: string; project_name: string } | undefined;
    return {
      sessionCount: row?.cnt ?? 0,
      projectCount: 1,
      projectName: row?.project_name,
      dateFrom: dateFrom || row?.min_date?.slice(0, 10) || today,
      dateTo: dateTo || row?.max_date?.slice(0, 10) || today,
    };
  }

  let query = `
    SELECT COUNT(*) as session_cnt,
           COUNT(DISTINCT project_id) as project_cnt,
           MIN(started_at) as min_date,
           MAX(ended_at) as max_date
    FROM sessions s
    WHERE s.deleted_at IS NULL
  `;
  const params: (string | number)[] = [];

  if (dateFrom || dateTo) {
    query += ` AND EXISTS (
      SELECT 1 FROM insights i
      WHERE i.session_id = s.id
    `;
    if (dateFrom) {
      query += ` AND i.timestamp >= ?`;
      params.push(dateFrom + 'T00:00:00Z');
    }
    if (dateTo) {
      query += ` AND i.timestamp < date(?, '+1 day')`;
      params.push(dateTo + 'T00:00:00Z');
    }
    query += `)`;
  }

  const row = db.prepare(query).get(...params) as { session_cnt: number; project_cnt: number; min_date: string; max_date: string } | undefined;

  return {
    sessionCount: row?.session_cnt ?? 0,
    projectCount: row?.project_cnt ?? 0,
    projectName: undefined,
    dateFrom: dateFrom || row?.min_date?.slice(0, 10) || today,
    dateTo: dateTo || row?.max_date?.slice(0, 10) || today,
  };
}

// POST /api/export/generate
// Synchronous LLM export — returns full result when complete.
app.post('/generate', requireLLM(), async (c) => {

  const body = await c.req.json<ExportGenerateBody>();
  const { scope, projectId, format, depth = 'standard', dateFrom, dateTo } = body;

  if (scope !== 'project' && scope !== 'all') {
    return c.json({ error: 'scope must be "project" or "all"' }, 400);
  }
  if (scope === 'project' && !projectId) {
    return c.json({ error: 'projectId is required when scope is "project"' }, 400);
  }
  if (!['agent-rules', 'knowledge-brief', 'obsidian', 'notion'].includes(format)) {
    return c.json({ error: 'format must be one of: agent-rules, knowledge-brief, obsidian, notion' }, 400);
  }
  if (!['essential', 'standard', 'comprehensive'].includes(depth)) {
    return c.json({ error: 'depth must be one of: essential, standard, comprehensive' }, 400);
  }
  if (dateFrom && !validateDateString(dateFrom)) {
    return c.json({ error: 'dateFrom must be a valid YYYY-MM-DD date' }, 400);
  }
  if (dateTo && !validateDateString(dateTo)) {
    return c.json({ error: 'dateTo must be a valid YYYY-MM-DD date' }, 400);
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return c.json({ error: 'dateFrom must be before or equal to dateTo' }, 400);
  }

  const db = getDb();
  const llmConfig = loadLLMConfig();
  const startTime = Date.now();

  try {
    const rawInsights = fetchScopedInsights(db, scope, projectId, dateFrom, dateTo);
    const { capped, totalInsights } = applyDepthCap(rawInsights, depth);
    const sessionCtx = fetchSessionContext(db, scope, projectId, dateFrom, dateTo);

    const ctx = {
      scope,
      format,
      depth,
      projectName: sessionCtx.projectName,
      sessionCount: sessionCtx.sessionCount,
      projectCount: sessionCtx.projectCount,
      dateRange: {
        from: sessionCtx.dateFrom,
        to: sessionCtx.dateTo,
        userSelected: !!(dateFrom || dateTo)
      },
      exportDate: new Date().toISOString().slice(0, 10),
    };

    const systemPrompt = getExportSystemPrompt(ctx);
    const insightContext = buildInsightContext(capped);
    const userPrompt = buildExportUserPrompt(ctx, insightContext);

    const client = createLLMClient();
    const response = await client.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { signal: c.req.raw.signal });

    const metadata: ExportGenerateMetadata = {
      insightCount: capped.length,
      totalInsights,
      sessionCount: sessionCtx.sessionCount,
      projectCount: sessionCtx.projectCount,
      scope,
      depth,
    };

    trackEvent('export_run', {
      format: `llm-${format}`,
      scope,
      depth,
      insight_count: capped.length,
      session_count: sessionCtx.sessionCount,
      llm_provider: llmConfig?.provider,
      llm_model: llmConfig?.model,
      duration_ms: Date.now() - startTime,
      success: true,
    });

    return c.json({ content: response.content, metadata }, 200);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // Client disconnected — 422 is the closest Hono allows; client ignores this on abort
      return c.json({ error: 'Export cancelled' }, 422);
    }
    const message = error instanceof Error ? error.message : 'Export generation failed';
    captureError(error, { format, scope, depth, llm_provider: llmConfig?.provider, llm_model: llmConfig?.model });
    trackEvent('export_run', {
      format: `llm-${format}`,
      scope,
      depth,
      llm_provider: llmConfig?.provider,
      llm_model: llmConfig?.model,
      duration_ms: Date.now() - startTime,
      success: false,
      error_message: message,
    });
    return c.json({ error: message }, 422);
  }
});

// GET /api/export/generate/stream?scope=project&projectId=xxx&format=agent-rules&depth=standard
// SSE endpoint — streams progress events during LLM export generation.
// onProgress is implicit (no chunked analysis here); stream.writeSSE is fire-and-forget
// for progress events (non-fatal if missed).
app.get('/generate/stream', requireLLM(), async (c) => {

  const scope = c.req.query('scope') as ExportScope | undefined;
  const projectId = c.req.query('projectId');
  const format = c.req.query('format') as ExportFormat | undefined;
  const depth = (c.req.query('depth') ?? 'standard') as ExportDepth;
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');

  if (scope !== 'project' && scope !== 'all') {
    return c.json({ error: 'scope must be "project" or "all"' }, 400);
  }
  if (scope === 'project' && !projectId) {
    return c.json({ error: 'projectId is required when scope is "project"' }, 400);
  }
  if (!format || !['agent-rules', 'knowledge-brief', 'obsidian', 'notion'].includes(format)) {
    return c.json({ error: 'format must be one of: agent-rules, knowledge-brief, obsidian, notion' }, 400);
  }
  if (!['essential', 'standard', 'comprehensive'].includes(depth)) {
    return c.json({ error: 'depth must be one of: essential, standard, comprehensive' }, 400);
  }
  if (dateFrom && !validateDateString(dateFrom)) {
    return c.json({ error: 'dateFrom must be a valid YYYY-MM-DD date' }, 400);
  }
  if (dateTo && !validateDateString(dateTo)) {
    return c.json({ error: 'dateTo must be a valid YYYY-MM-DD date' }, 400);
  }
  if (dateFrom && dateTo && dateFrom > dateTo) {
    return c.json({ error: 'dateFrom must be before or equal to dateTo' }, 400);
  }

  const db = getDb();
  const llmConfig = loadLLMConfig();

  return streamSSE(c, async (stream) => {
    const streamStart = Date.now();
    try {
      const abortSignal = c.req.raw.signal;

      // Phase 1: load and count insights, emit counts before LLM call
      const rawInsights = fetchScopedInsights(db, scope, projectId, dateFrom, dateTo);
      const { capped, totalInsights } = applyDepthCap(rawInsights, depth);

      await stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({
          phase: 'loading_insights',
          insightCount: capped.length,
          totalInsights,
        }),
      });

      if (capped.length === 0) {
        await stream.writeSSE({
          event: 'error',
          data: JSON.stringify({ error: 'No insights found for the selected scope. Run analysis on some sessions first.' }),
        });
        return;
      }

      // Phase 2: synthesizing
      void stream.writeSSE({
        event: 'progress',
        data: JSON.stringify({ phase: 'synthesizing', progress: 'Sending to LLM...' }),
      }).catch(() => {});

      const sessionCtx = fetchSessionContext(db, scope, projectId, dateFrom, dateTo);
      const ctx = {
        scope,
        format,
        depth,
        projectName: sessionCtx.projectName,
        sessionCount: sessionCtx.sessionCount,
        projectCount: sessionCtx.projectCount,
        dateRange: {
          from: sessionCtx.dateFrom,
          to: sessionCtx.dateTo,
          userSelected: !!(dateFrom || dateTo)
        },
        exportDate: new Date().toISOString().slice(0, 10),
      };

      const systemPrompt = getExportSystemPrompt(ctx);
      const insightContext = buildInsightContext(capped);
      const userPrompt = buildExportUserPrompt(ctx, insightContext);

      const client = createLLMClient();
      const response = await client.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], { signal: abortSignal });

      const metadata: ExportGenerateMetadata = {
        insightCount: capped.length,
        totalInsights,
        sessionCount: sessionCtx.sessionCount,
        projectCount: sessionCtx.projectCount,
        scope,
        depth,
      };

      trackEvent('export_run', {
        format: `llm-${format}`,
        scope,
        depth,
        insight_count: capped.length,
        session_count: sessionCtx.sessionCount,
        llm_provider: llmConfig?.provider,
        llm_model: llmConfig?.model,
        duration_ms: Date.now() - streamStart,
        success: true,
      });

      // Phase 3: complete — send full content + metadata
      await stream.writeSSE({
        event: 'complete',
        data: JSON.stringify({ content: response.content, metadata }),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      captureError(err, { format, scope, depth, llm_provider: llmConfig?.provider, llm_model: llmConfig?.model });
      trackEvent('export_run', {
        format: `llm-${format}`,
        scope,
        depth,
        llm_provider: llmConfig?.provider,
        llm_model: llmConfig?.model,
        duration_ms: Date.now() - streamStart,
        success: false,
        error_message: message,
      });
      await stream.writeSSE({
        event: 'error',
        data: JSON.stringify({ error: message }),
      }).catch(() => {});
    }
  });
});

// FCA Standard Binary Attributes
const FCA_ATTRIBUTES = [
  'LLM_Decide',
  'User_Decide',
  'Collab_Decide',
  'Target_Config',
  'Target_SrcCode',
  'Target_Test',
  'Target_Docs',
  'State_Success',
  'State_Error',
  'State_Blocked',
] as const;

/**
 * GET /api/export/session/:id/rails
 *
 * Exports session metadata, unpacked relational decision insights (with decided_by,
 * intent, and branch_point), and semantic step matrices in a normalized ActiveRecord-ready
 * JSON structure (`rails-v1`).
 *
 * @param id - Session UUID
 * @returns JSON object containing session, decisions, and step_matrix
 */
app.get('/session/:id/rails', (c) => {
  const id = c.req.param('id');
  const db = getDb();

  const session = db.prepare(
    `SELECT id, project_id, project_name, generated_title, custom_title,
            started_at, ended_at, message_count, estimated_cost_usd, session_character, source_tool
     FROM sessions WHERE id = ? AND deleted_at IS NULL`,
  ).get(id) as Record<string, unknown> | undefined;

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const insightRows = db.prepare(
    `SELECT id, session_id, project_id, project_name, type, title, content,
            summary, bullets, confidence, metadata, timestamp, created_at, scope, analysis_version
     FROM insights WHERE session_id = ? ORDER BY created_at ASC`,
  ).all(id) as Array<{
    id: string;
    session_id: string;
    project_id: string;
    project_name: string;
    type: string;
    title: string;
    content: string;
    summary: string;
    bullets: string;
    confidence: number;
    metadata: string | null;
    timestamp: string;
    created_at: string;
    scope: string;
    analysis_version: string;
  }>;

  const decisions = insightRows
    .filter(r => r.type === 'decision')
    .map(r => {
      let meta: Record<string, unknown> = {};
      try {
        meta = r.metadata ? JSON.parse(r.metadata) : {};
      } catch {}

      return {
        id: r.id,
        session_id: r.session_id,
        project_id: r.project_id,
        title: r.title,
        decided_by: meta.decided_by || 'collaborative',
        intent: meta.intent || null,
        branch_point: meta.branch_point || null,
        situation: meta.situation || null,
        choice: meta.choice || null,
        reasoning: meta.reasoning || null,
        alternatives: meta.alternatives || [],
        trade_offs: meta.trade_offs || null,
        revisit_when: meta.revisit_when || null,
        confidence: r.confidence,
        created_at: r.created_at,
      };
    });

  let stepMatrix: Array<{
    step: string;
    turn_ref: string;
    driver: string;
    target: string;
    state: string;
  }> = [];

  const summaryRow = insightRows.find(r => r.type === 'summary');
  if (summaryRow?.metadata) {
    try {
      const meta = JSON.parse(summaryRow.metadata);
      if (Array.isArray(meta.step_matrix)) {
        stepMatrix = meta.step_matrix;
      }
    } catch {}
  }

  return c.json({
    exported_at: new Date().toISOString(),
    format: 'rails-v1',
    session,
    decisions,
    step_matrix: stepMatrix,
  });
});

/**
 * GET /api/export/session/:id/fca
 *
 * Exports the Formal Concept Analysis (FCA) incidence matrix for a session as a formal
 * context (G, M, I). G represents semantic episode steps, M represents 10 canonical binary
 * attributes (Drivers, Targets, States), and I represents incidence.
 *
 * @param id - Session UUID
 * @param format - Query param: 'json' (default) or 'csv'. Also respects 'Accept: text/csv' header.
 * @returns JSON formal context object or downloadable CSV file attachment
 */
app.get('/session/:id/fca', (c) => {
  const id = c.req.param('id');
  const format = c.req.query('format') || 'json';
  const db = getDb();

  const session = db.prepare(
    `SELECT id, project_name, generated_title, custom_title
     FROM sessions WHERE id = ? AND deleted_at IS NULL`,
  ).get(id) as { id: string; project_name: string; generated_title: string; custom_title?: string } | undefined;

  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const summaryRow = db.prepare(
    `SELECT metadata FROM insights WHERE session_id = ? AND type = 'summary' LIMIT 1`,
  ).get(id) as { metadata: string | null } | undefined;

  let stepMatrix: Array<{
    step: string;
    turn_ref: string;
    driver: string;
    target: string;
    state: string;
  }> = [];

  if (summaryRow?.metadata) {
    try {
      const meta = JSON.parse(summaryRow.metadata);
      if (Array.isArray(meta.step_matrix)) {
        stepMatrix = meta.step_matrix;
      }
    } catch {}
  }

  if (format === 'csv' || c.req.header('accept')?.includes('text/csv')) {
    const header = ['Step', 'Turn', ...FCA_ATTRIBUTES].join(',');
    const rows = stepMatrix.map(s => {
      const cells = [
        `"${(s.step || '').replace(/"/g, '""')}"`,
        `"${(s.turn_ref || '').replace(/"/g, '""')}"`,
        s.driver === 'LLM_Decide' ? '1' : '0',
        s.driver === 'User_Decide' ? '1' : '0',
        s.driver === 'Collab_Decide' ? '1' : '0',
        s.target === 'Target_Config' ? '1' : '0',
        s.target === 'Target_SrcCode' ? '1' : '0',
        s.target === 'Target_Test' ? '1' : '0',
        s.target === 'Target_Docs' ? '1' : '0',
        s.state === 'State_Success' ? '1' : '0',
        s.state === 'State_Error' ? '1' : '0',
        s.state === 'State_Blocked' ? '1' : '0',
      ];
      return cells.join(',');
    });

    const csvContent = [header, ...rows].join('\n');
    return c.text(csvContent, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="session-${id}-fca.csv"`,
    });
  }

  const objects = stepMatrix.map(s => s.step);
  const incidence = stepMatrix.map(s => [
    s.driver === 'LLM_Decide',
    s.driver === 'User_Decide',
    s.driver === 'Collab_Decide',
    s.target === 'Target_Config',
    s.target === 'Target_SrcCode',
    s.target === 'Target_Test',
    s.target === 'Target_Docs',
    s.state === 'State_Success',
    s.state === 'State_Error',
    s.state === 'State_Blocked',
  ]);

  const context = stepMatrix.map(s => ({
    step: s.step,
    turn_ref: s.turn_ref,
    attributes: {
      LLM_Decide: s.driver === 'LLM_Decide',
      User_Decide: s.driver === 'User_Decide',
      Collab_Decide: s.driver === 'Collab_Decide',
      Target_Config: s.target === 'Target_Config',
      Target_SrcCode: s.target === 'Target_SrcCode',
      Target_Test: s.target === 'Target_Test',
      Target_Docs: s.target === 'Target_Docs',
      State_Success: s.state === 'State_Success',
      State_Error: s.state === 'State_Error',
      State_Blocked: s.state === 'State_Blocked',
    },
  }));

  return c.json({
    session_id: id,
    objects,
    attributes: FCA_ATTRIBUTES,
    incidence,
    context,
  });
});

export default app;
