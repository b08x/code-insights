// Schema-aware Text-to-SQL sub-agent backing the chat agent's `queryDatabase` tool.
// Generates a single read-only SQLite SELECT/WITH query, validates & runs it through
// `executeReadOnlySql`, and automatically performs 1 error-repair retry on SQL/guard errors.

import type Database from 'better-sqlite3';
import { jsonrepair } from 'jsonrepair';
import { executeReadOnlySql, type ReadOnlySqlResult } from '@code-insights/cli/db/read-agent';
import { extractJsonPayload } from '@code-insights/cli/analysis/response-parsers';
import type { SqlSubAgentBackend } from './sql-runner.js';

export const SQL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'A single read-only SQLite SELECT or WITH query against the Code Insights database.',
    },
    explanation: {
      type: 'string',
      description: 'One-sentence description of what the query computes.',
    },
  },
  required: ['sql', 'explanation'],
  additionalProperties: false,
} as const;

export interface SqlQueryToolResult extends ReadOnlySqlResult {
  explanation: string;
  runner: string;
  retried: boolean;
}

/**
 * Build the SQL sub-agent system prompt with exact current clock & ISO-8601 window cutoffs,
 * analytical schema documentation, and safe SQLite query rules.
 */
export function buildSqlAgentSystemPrompt(now: Date = new Date()): string {
  const nowIso = now.toISOString();
  const cutoff24h = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const cutoff48h = new Date(now.getTime() - 48 * 3_600_000).toISOString();
  const cutoff7d = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const cutoff30d = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const cutoff90d = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const localStr = now.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' });

  return `You are a read-only SQLite query planner for the Code Insights database.
Your job is to translate an analytical or session-listing question into ONE safe, accurate SQLite SELECT (or WITH ... SELECT) query.

CURRENT TIME & PRE-COMPUTED ISO-8601 CUTOFFS:
- Now (UTC ISO-8601): ${nowIso}
- Local time: ${localStr}
- Last 24h cutoff: '${cutoff24h}'
- Last 48h cutoff: '${cutoff48h}'
- Last 7d cutoff:  '${cutoff7d}'
- Last 30d cutoff: '${cutoff30d}'
- Last 90d cutoff: '${cutoff90d}'

CRITICAL RULES:
1. Return ONLY JSON matching {"sql": "...", "explanation": "..."}. No prose outside JSON.
2. Query ONLY these allowed analytical tables (and json_each/json_tree):
   projects, sessions, messages, messages_fts, insights, session_facets, session_steps, analysis_usage, reflect_snapshots, usage_stats.
   Never query chat_conversations, chat_messages, sqlite_master, vec_*, or PRAGMA/DDL/DML statements.
3. TIMESTAMP COMPARISONS: Timestamps like sessions.started_at and insights.timestamp are ISO-8601 strings with 'T' and 'Z' (e.g. '2026-11-20T02:01:20.489Z').
   Compare against the pre-computed ISO cutoffs above (e.g. s.started_at >= '${cutoff7d}') OR wrap BOTH sides with datetime(...) (e.g. datetime(s.started_at) >= datetime('now', '-7 days')).
   NEVER compare raw s.started_at >= datetime('now', '-7 days') because ASCII 'T' > ' ' breaks boundary days.
4. SOFT-DELETED & SUBAGENT SESSIONS:
   - Always include \`s.deleted_at IS NULL\` when querying sessions (or joining sessions).
   - Unless includeSubagents is true, filter top-level sessions with \`s.parent_session_id IS NULL\` (or roll child rows up using \`COALESCE(s.parent_session_id, s.id) AS session_id\`).
5. CITATIONS & LIMITS:
   - Whenever returning session rows, include \`s.id AS session_id\` (or \`i.session_id\`) so the UI can cite sessions accurately.
   - Always apply \`LIMIT 50\` or smaller on non-aggregate queries, and avoid selecting unbounded raw \`messages.content\` / \`insights.content\` (use \`substr(..., 1, 250)\` if needed).
   - For session titles, use \`COALESCE(s.custom_title, s.generated_title, substr(s.summary, 1, 80), 'Untitled') AS title\`.

SCHEMA (v18):
- projects(id, name, path, git_remote_url, project_id_source, session_count, last_activity, total_input_tokens, total_output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd)
- sessions(id, project_id, project_name, project_path, git_remote_url, summary, custom_title, generated_title, title_source, session_character, started_at, ended_at, message_count, user_message_count, assistant_message_count, tool_call_count, git_branch, source_tool, parent_session_id, agent_type, total_input_tokens, total_output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, models_used, primary_model, deleted_at, compact_count, auto_compact_count, slash_commands)
  session_character values: 'deep_focus', 'bug_hunt', 'feature_build', 'exploration', 'refactor', 'learning', 'quick_task'
- messages(id, session_id, type ['user'|'assistant'|'system'], content, thinking, tool_calls, tool_results, timestamp, parent_id)
- messages_fts(content, tool_calls, tool_results) -- join via: JOIN messages m ON m.rowid = messages_fts.rowid WHERE messages_fts MATCH '...'
- insights(id, session_id, project_id, project_name, type ['summary'|'decision'|'learning'|'technique'|'prompt_quality'], title, content, summary, bullets, confidence, metadata, timestamp, scope)
  - decision metadata JSON: $.decided_by ('user'|'agent'|'collaborative'), $.situation, $.choice, $.reasoning, $.trade_offs
  - learning metadata JSON: $.symptom, $.root_cause, $.takeaway, $.applies_when
  - summary metadata JSON: $.outcome ('success'|'partial'|'abandoned'|'blocked')
  - prompt_quality metadata JSON: $.efficiency_score, $.dimension_scores.context_provision, $.dimension_scores.request_specificity, $.dimension_scores.scope_management, $.dimension_scores.information_timing, $.dimension_scores.correction_quality, $.findings (array of {category, type ['deficit'|'strength'], impact, description})
- session_facets(session_id, outcome_satisfaction ['high'|'medium'|'low'|'abandoned'], workflow_pattern, had_course_correction [0|1], course_correction_reason, iteration_count, friction_points [JSON array], effective_patterns [JSON array], extracted_at)
  - friction_points items via json_each(sf.friction_points): $.category, $.attribution ('user-actionable'|'ai-capability'|'environmental'), $.severity ('high'|'medium'|'low'), $.resolution, $.description
  - effective_patterns items via json_each(sf.effective_patterns): $.category, $.description, $.confidence, $.driver
- session_steps(session_id, idx, turn_ref, label, driver ['LLM_Decide'|'User_Decide'|'Collab_Decide'], target, state ['State_Success'|'State_Error'|'State_Blocked'], has_course_correction, ran_tests, used_tools)
- analysis_usage(session_id, analysis_type, provider, model, input_tokens, output_tokens, estimated_cost_usd, duration_ms, analyzed_at)
- reflect_snapshots(period, project_id, results_json, generated_at, window_start, window_end, session_count, facet_count)
- usage_stats(id, total_input_tokens, total_output_tokens, cache_creation_tokens, cache_read_tokens, estimated_cost_usd, sessions_with_usage)

SQL RECIPES:
- Recent sessions in window:
  SELECT s.id AS session_id, COALESCE(s.custom_title, s.generated_title, 'Untitled') AS title, s.project_name, s.source_tool, s.started_at, s.message_count, ROUND(COALESCE(s.estimated_cost_usd, 0), 3) AS cost_usd, sf.outcome_satisfaction, substr(s.summary, 1, 180) AS summary
  FROM sessions s LEFT JOIN session_facets sf ON sf.session_id = s.id
  WHERE s.deleted_at IS NULL AND s.parent_session_id IS NULL AND s.started_at >= '${cutoff7d}'
  ORDER BY s.started_at DESC LIMIT 30
- Friction / effective patterns in window:
  SELECT json_extract(f.value, '$.category') AS category, json_extract(f.value, '$.attribution') AS attribution, COUNT(*) AS occurrences, MIN(json_extract(f.value, '$.description')) AS example_description
  FROM session_facets sf JOIN sessions s ON s.id = sf.session_id, json_each(sf.effective_patterns) f
  WHERE s.deleted_at IS NULL AND s.parent_session_id IS NULL AND s.started_at >= '${cutoff30d}'
  GROUP BY category, attribution ORDER BY occurrences DESC LIMIT 20`;
}

/**
 * Parse `{ sql, explanation }` from the SQL sub-agent's raw output, tolerating code fences,
 * slightly malformed JSON (via jsonrepair), or plain SQL blocks.
 */
export function parseSqlAgentResponse(raw: string): { sql: string; explanation: string } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'SQL sub-agent returned an empty response' };

  const jsonCandidate = extractJsonPayload(trimmed);
  if (jsonCandidate) {
    for (const candidate of [jsonCandidate, (() => { try { return jsonrepair(jsonCandidate); } catch { return ''; } })()]) {
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate) as { sql?: unknown; explanation?: unknown };
        if (typeof parsed?.sql === 'string' && parsed.sql.trim()) {
          return {
            sql: parsed.sql.trim(),
            explanation: typeof parsed.explanation === 'string' ? parsed.explanation.trim() : '',
          };
        }
      } catch {
        // Try next candidate
      }
    }
  }

  // Fallback: raw fenced SQL block or bare SELECT/WITH statement
  const sqlFence = trimmed.match(/```(?:sql|sqlite)?\s*([\s\S]*?)\s*```/i);
  if (sqlFence?.[1]?.trim()) {
    return { sql: sqlFence[1].trim(), explanation: '' };
  }
  if (/^\s*(SELECT|WITH)\b/i.test(trimmed)) {
    return { sql: trimmed, explanation: '' };
  }

  return { error: 'Could not extract a SQL query from SQL sub-agent output' };
}

function buildSqlUserPrompt(params: {
  question: string;
  timeRange?: string;
  project?: string;
  includeSubagents?: boolean;
}): string {
  const lines = [`Question: ${params.question}`];
  if (params.timeRange) lines.push(`Requested timeRange: ${params.timeRange}`);
  if (params.project) lines.push(`Requested project filter: ${params.project}`);
  lines.push(`includeSubagents: ${params.includeSubagents === true ? 'true' : 'false'}`);
  return lines.join('\n');
}

function buildRepairUserPrompt(
  originalUserPrompt: string,
  failedSql: string,
  errorMessage: string,
): string {
  return `${originalUserPrompt}

Your previous SQL attempt failed.
Failed SQL:
${failedSql}

Error:
${errorMessage}

Fix the SQL query and return ONLY JSON matching {"sql": "...", "explanation": "..."}.`;
}

export async function runSqlSubAgent(params: {
  db: Database.Database;
  backend: SqlSubAgentBackend;
  question: string;
  timeRange?: string;
  project?: string;
  includeSubagents?: boolean;
  now?: Date;
  signal?: AbortSignal;
}): Promise<SqlQueryToolResult> {
  const systemPrompt = buildSqlAgentSystemPrompt(params.now);
  const userPrompt = buildSqlUserPrompt(params);

  let lastSql = '';
  let lastExplanation = '';
  let lastError = 'SQL generation failed';

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0
      ? userPrompt
      : buildRepairUserPrompt(userPrompt, lastSql || '(no valid SQL extracted)', lastError);

    let raw: string;
    try {
      raw = await params.backend.generate({
        systemPrompt,
        userPrompt: prompt,
        jsonSchema: SQL_OUTPUT_SCHEMA,
        signal: params.signal,
      });
    } catch (err) {
      return {
        ok: false,
        sql: lastSql,
        explanation: lastExplanation,
        runner: params.backend.label,
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        referencedSessionIds: [],
        retried: attempt > 0,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const parsed = parseSqlAgentResponse(raw);
    if ('error' in parsed) {
      lastError = parsed.error;
      continue;
    }

    lastSql = parsed.sql;
    lastExplanation = parsed.explanation;

    const result = executeReadOnlySql(params.db, parsed.sql);
    if (result.ok) {
      return {
        ...result,
        explanation: lastExplanation,
        runner: params.backend.label,
        retried: attempt > 0,
      };
    }

    lastError = result.error ?? 'SQL execution failed';
    lastSql = result.sql || lastSql;
  }

  return {
    ok: false,
    sql: lastSql,
    explanation: lastExplanation,
    runner: params.backend.label,
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    referencedSessionIds: [],
    retried: true,
    error: lastError,
  };
}
