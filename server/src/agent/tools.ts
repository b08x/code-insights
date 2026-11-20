// Tool registry for the chat agent.
//
// Tools are plain Ax function-calling definitions. Core retrieval tools back onto
// cli/src/db/read-agent.ts and the SQL sub-agent (sql-agent.ts). There are deliberately NO
// tools that write labels, promote versions, or start runs (agent-10): the only "output"
// tool, proposeDraft, returns a typed payload that the UI renders behind a Save button.
//
// Later phases (labeling, optimization) call `toolRegistry.register(...)` to append their
// read-only tools (listRuns, getRun, getRoundDiff, compareVersions, getLabel — agent-11).

import { execFile } from 'child_process';
import { fn, f } from '@ax-llm/ax';
import type { AxFunction } from '@ax-llm/ax';
import type Database from 'better-sqlite3';
import { getDb, openReadOnlyDb } from '@code-insights/cli/db/client';
import { searchSessionSnippets, getSessionWindow } from '@code-insights/cli/db/read-agent';
import { embedOne, resolveEmbeddingConfig } from '@code-insights/cli/embeddings/client';
import { loadVectorExtension } from '@code-insights/cli/embeddings/store';
import { loadConfig } from '@code-insights/cli/utils/config';
import type { ClaudeInsightConfig } from '@code-insights/cli/types';
import { runSqlSubAgent } from './sql-agent.js';
import { resolveSqlRunner, type SqlSubAgentBackend } from './sql-runner.js';

export type ToolGroup = 'core' | 'codebase' | 'optimization';

export interface ToolRuntimeContext {
  signal?: AbortSignal;
  /** Test seam to supply a read-only handle over an in-memory DB. */
  getReadOnlyDb?: () => { db: Database.Database; close: () => void };
  /** Test seam to supply a mock SQL sub-agent backend. */
  sqlBackend?: SqlSubAgentBackend;
}

export interface RegisteredTool {
  /** Fully qualified function name as the model sees it (e.g. `queryDatabase`, `codebase.listProjects`). */
  id: string;
  group: ToolGroup;
  /** Omit for always-on tools. */
  enabled?: (config: ClaudeInsightConfig | null) => boolean;
  fn: AxFunction;
  /** Optional per-turn factory so live AbortSignals/seams bind cleanly without ALS hazards. */
  buildFn?: (runtime?: ToolRuntimeContext) => AxFunction;
}

/** Opt-in: only an explicit `dashboard.agent.codebaseTools === true` enables codebase.* tools (agent-4). */
export function isCodebaseToolsEnabled(config: ClaudeInsightConfig | null): boolean {
  return config?.dashboard?.agent?.codebaseTools === true;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.id)) throw new Error(`Tool already registered: ${tool.id}`);
    this.tools.set(tool.id, tool);
    return this;
  }

  unregister(id: string): void {
    this.tools.delete(id);
  }

  /** Registered tools that are enabled under `config`. Disabled tools are absent, not just hidden (agent-4). */
  list(config: ClaudeInsightConfig | null): RegisteredTool[] {
    return [...this.tools.values()].filter(t => !t.enabled || t.enabled(config));
  }

  functions(config: ClaudeInsightConfig | null, runtime?: ToolRuntimeContext): AxFunction[] {
    return this.list(config).map(t => (t.buildFn ? t.buildFn(runtime) : t.fn));
  }
}

export const toolRegistry = new ToolRegistry();


// ─── Draft payload (agent-10) ─────────────────────────────────────────────────

export type DraftKind = 'note' | 'label' | 'prompt';

export interface DraftPayload {
  kind: DraftKind;
  title: string;
  content: string;
  sessionId?: string;
}

const DRAFT_KINDS: DraftKind[] = ['note', 'label', 'prompt'];

export function toDraftPayload(args: Record<string, unknown>): DraftPayload {
  const kind = DRAFT_KINDS.includes(args.kind as DraftKind) ? (args.kind as DraftKind) : 'note';
  return {
    kind,
    title: String(args.title ?? '').slice(0, 200),
    content: String(args.content ?? '').slice(0, 10_000),
    ...(typeof args.sessionId === 'string' && args.sessionId ? { sessionId: args.sessionId } : {}),
  };
}

// ─── Core tools ───────────────────────────────────────────────────────────────

function makeQueryDatabaseTool(runtime?: ToolRuntimeContext): AxFunction {
  return fn('queryDatabase')
    .description(
      'Run a schema-aware read-only SQL query via the SQL sub-agent to list sessions by date/project/tool, compute analytics/token/cost stats, query insights (decisions, learnings, summaries, prompt_quality), inspect session_facets (friction points, effective patterns, outcomes), or inspect session_steps. Prefer this over searchSessions for any date-range listing, counting, or structured filtering.',
    )
    .arg('question', f.string('Natural-language analytical or session-listing question'))
    .arg('timeRange', f.string('Optional time window hint, e.g. 24h, 48h, 7d, 30d, or 2026-11-01..2026-11-20').optional())
    .arg('project', f.string('Optional project name or ID to scope the query').optional())
    .arg('includeSubagents', f.boolean('Set true only when explicitly asking about child subagent runs').optional())
    .returns(f.json('Query result rows, generated SQL metadata, and verified parent session IDs'))
    .handler(async (args: {
      question: string;
      timeRange?: string;
      project?: string;
      includeSubagents?: boolean;
    }) => {
      const resolved = runtime?.sqlBackend
        ? { backend: runtime.sqlBackend }
        : resolveSqlRunner(loadConfig());

      if ('error' in resolved) {
        return {
          ok: false,
          sql: '',
          explanation: '',
          runner: '',
          columns: [],
          rows: [],
          rowCount: 0,
          truncated: false,
          referencedSessionIds: [],
          retried: false,
          error: resolved.error,
        };
      }

      const handle = runtime?.getReadOnlyDb
        ? runtime.getReadOnlyDb()
        : (() => {
            const db = openReadOnlyDb();
            return { db, close: () => db.close() };
          })();

      try {
        return await runSqlSubAgent({
          db: handle.db,
          backend: resolved.backend,
          question: args.question,
          timeRange: args.timeRange,
          project: args.project,
          includeSubagents: args.includeSubagents,
          signal: runtime?.signal,
        });
      } finally {
        handle.close();
      }
    })
    .build();
}

function makeSearchSessionsTool(runtime?: ToolRuntimeContext): AxFunction {
  return fn('searchSessions')
    .description(
      'Semantic + FTS5 keyword search across session messages, summaries, and insights by topic, error, or concept. Returns ranked short snippets rolled up to parent sessions with facet summaries. Do NOT pass date phrases like "last week" as query; use since/until ISO bounds or use queryDatabase to list sessions by date.',
    )
    .arg('query', f.string('Topical search query (keywords, error messages, concepts — never date phrases)'))
    .arg('since', f.string('Optional inclusive start ISO-8601 timestamp or YYYY-MM-DD').optional())
    .arg('until', f.string('Optional inclusive end ISO-8601 timestamp or YYYY-MM-DD').optional())
    .arg('projectName', f.string('Restrict to project name substring').optional())
    .arg('projectId', f.string('Restrict to one project ID').optional())
    .arg('sourceTool', f.string('Restrict to a source tool, e.g. claude-code, opencode, antigravity').optional())
    .arg('limit', f.number('Max sessions (default 5, max 10)').optional())
    .returns(f.json('Ranked session snippets rolled up to parent sessions'))
    .handler(async (args: {
      query: string;
      since?: string;
      until?: string;
      projectName?: string;
      projectId?: string;
      sourceTool?: string;
      limit?: number;
    }) => {
      const db = getDb();
      let queryVector: Float32Array | null = null;
      const embConfig = resolveEmbeddingConfig(loadConfig());
      if (embConfig) {
        try {
          loadVectorExtension(db);
          const emb = await embedOne(embConfig, 'query', args.query, {
            maxRetries: 1,
            timeoutMs: 3000,
            signal: runtime?.signal,
          });
          queryVector = emb?.vector ?? null;
        } catch {
          // Embeddings are optional / may fail fast — keyword + metadata search still works.
        }
      }
      const limit = Math.min(Math.max(Math.floor(args.limit ?? 5), 1), 10);
      return {
        results: searchSessionSnippets(
          db,
          args.query,
          {
            projectId: args.projectId,
            projectName: args.projectName,
            sourceTool: args.sourceTool,
            since: args.since,
            until: args.until,
          },
          limit,
          { queryVector },
        ),
      };
    })
    .build();
}

const getSessionTool = fn('getSession')
  .description('Read a window of turns from one session (0-based, inclusive), plus its facets and child subagents. Returns at most 40 turns; content is truncated per turn.')
  .arg('sessionId', f.string('Session ID'))
  .arg('fromTurn', f.number('First turn index (default 0)').optional())
  .arg('toTurn', f.number('Last turn index, inclusive (default fromTurn + 19)').optional())
  .returns(f.json('Session window'))
  .handler(async (args: { sessionId: string; fromTurn?: number; toTurn?: number }) => {
    const from = args.fromTurn ?? 0;
    const window = getSessionWindow(getDb(), args.sessionId, from, args.toTurn ?? from + 19);
    return window ?? { error: `Session not found: ${args.sessionId}` };
  })
  .build();

const proposeDraftTool = fn('proposeDraft')
  .description('Propose a draft (note, label, or prompt text) for the user to review. Nothing is saved: the UI shows the draft with a Save button the user must click.')
  .arg('kind', f.string('One of note, label, prompt'))
  .arg('title', f.string('Short title'))
  .arg('content', f.string('Draft body in markdown'))
  .arg('sessionId', f.string('Session the draft relates to').optional())
  .returns(f.json('The draft payload, as shown to the user'))
  .handler(async (args: Record<string, unknown>) => ({ draft: toDraftPayload(args) }))
  .build();

toolRegistry.register({
  id: 'queryDatabase',
  group: 'core',
  fn: makeQueryDatabaseTool(),
  buildFn: makeQueryDatabaseTool,
});
toolRegistry.register({
  id: 'searchSessions',
  group: 'core',
  fn: makeSearchSessionsTool(),
  buildFn: makeSearchSessionsTool,
});
toolRegistry.register({ id: getSessionTool.name, group: 'core', fn: getSessionTool });
toolRegistry.register({ id: proposeDraftTool.name, group: 'core', fn: proposeDraftTool });

// ─── Codebase tools (optional, agent-4) ───────────────────────────────────────

/**
 * Run a codebase-memory-mcp tool asynchronously (does not block the event loop).
 * Bridge to the external MCP server that provides codebase navigation. Errors resolve as
 * a JSON `{error}` string so the model can react instead of the stream aborting.
 */
export async function execMcpCli(toolName: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile('codebase-memory-mcp', ['cli', toolName], { timeout: 120000 }, (error, stdout, stderr) => {
      if (error) {
        console.error(`[MCP CLI Error] ${toolName}:`, stderr || error.message);
        resolve(JSON.stringify({ error: stderr || error.message }));
      } else {
        resolve(stdout.toString());
      }
    });
    if (child.stdin) {
      child.stdin.write(JSON.stringify(args));
      child.stdin.end();
    }
  });
}

const codebaseTools: AxFunction[] = [
  fn('listProjects')
    .description('List all projects currently indexed in the codebase knowledge graph. Call this first. Indexing new repositories is not available to the agent.')
    .namespace('codebase')
    .returns(f.string('List of indexed projects'))
    .handler(async () => execMcpCli('list_projects', {}))
    .build(),
  fn('getArchitecture')
    .description('Codebase overview: languages, packages, routes, hotspots.')
    .namespace('codebase')
    .arg('project', f.string('Name of the indexed project'))
    .returns(f.string('Architecture summary'))
    .handler(async (args: Record<string, unknown>) => execMcpCli('get_architecture', args))
    .build(),
  fn('searchGraph')
    .description('Structured search by label, name pattern, file pattern.')
    .namespace('codebase')
    .arg('project', f.string('Name of the indexed project'))
    .arg('name_pattern', f.string('Regex pattern for symbol name').optional())
    .arg('label', f.string('Graph label (e.g. Function, Class)').optional())
    .returns(f.string('Matching graph nodes'))
    .handler(async (args: Record<string, unknown>) => execMcpCli('search_graph', args))
    .build(),
  fn('getCodeSnippet')
    .description('Read source code for a function or symbol by qualified name.')
    .namespace('codebase')
    .arg('project', f.string('Name of the indexed project'))
    .arg('qualified_name', f.string('The fully qualified name of the symbol'))
    .returns(f.string('Source code snippet'))
    .handler(async (args: Record<string, unknown>) => execMcpCli('get_code_snippet', args))
    .build(),
  fn('tracePath')
    .description('Trace paths through the code graph: callers, dependencies, impact analysis, data flow.')
    .namespace('codebase')
    .arg('project', f.string('Name of the indexed project'))
    .arg('function_name', f.string('Name of the function/class to trace'))
    .arg('direction', f.string('inbound, outbound, or both').optional())
    .arg('mode', f.string('calls, data_flow, or cross_service').optional())
    .arg('depth', f.number('Depth limit (default 3)').optional())
    .returns(f.string('Trace paths'))
    .handler(async (args: Record<string, unknown>) => execMcpCli('trace_path', args))
    .build(),
  fn('checkIndexCoverage')
    .description('Check indexing-coverage metadata for exact paths or path scopes. Use before negative/exhaustive claims.')
    .namespace('codebase')
    .arg('project', f.string('Name of the indexed project'))
    .arg('paths', f.string('Comma-separated repository-relative paths').optional())
    .arg('scopes', f.string('Comma-separated repository-relative path prefixes').optional())
    .returns(f.string('Index coverage status'))
    .handler(async (args: { project: string; paths?: string; scopes?: string }) => {
      const payload: Record<string, unknown> = { project: args.project };
      if (args.paths) payload.paths = args.paths.split(',').map(s => s.trim());
      if (args.scopes) payload.scopes = args.scopes.split(',').map(s => s.trim());
      return execMcpCli('check_index_coverage', payload);
    })
    .build(),
];

for (const t of codebaseTools) {
  toolRegistry.register({
    id: `${t.namespace}.${t.name}`,
    group: 'codebase',
    enabled: isCodebaseToolsEnabled,
    fn: t,
  });
}
