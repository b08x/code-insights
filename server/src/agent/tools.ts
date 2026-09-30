// Tool registry for the chat agent.
//
// Tools are plain Ax function-calling definitions. Core tools are thin wrappers over the
// shared read functions in cli/src/db/read-agent.ts. There are deliberately NO tools that
// write labels, promote versions, or start runs (agent-10): the only "output" tool,
// proposeDraft, returns a typed payload that the UI renders behind a Save button.
//
// Later phases (labeling, optimization) call `toolRegistry.register(...)` to append their
// read-only tools (listRuns, getRun, getRoundDiff, compareVersions, getLabel — agent-11).

import { execFile } from 'child_process';
import { fn, f } from '@ax-llm/ax';
import type { AxFunction } from '@ax-llm/ax';
import { getDb } from '@code-insights/cli/db/client';
import {
  searchSessionSnippets,
  getSessionWindow,
  listInsights,
  getAnalyticsSummary,
  type AnalyticsRange,
} from '@code-insights/cli/db/read-agent';
import { embedOne, DEFAULT_EMBEDDING_CONFIG } from '@code-insights/cli/embeddings/client';
import { loadVectorExtension } from '@code-insights/cli/embeddings/store';
import type { ClaudeInsightConfig } from '@code-insights/cli/types';

export type ToolGroup = 'core' | 'codebase' | 'optimization';

export interface RegisteredTool {
  /** Fully qualified function name as the model sees it (e.g. `searchSessions`, `codebase.listProjects`). */
  id: string;
  group: ToolGroup;
  /** Omit for always-on tools. */
  enabled?: (config: ClaudeInsightConfig | null) => boolean;
  fn: AxFunction;
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

  functions(config: ClaudeInsightConfig | null): AxFunction[] {
    return this.list(config).map(t => t.fn);
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

const searchSessionsTool = fn('searchSessions')
  .description('Search past coding sessions by keywords or meaning. Returns ranked short snippets with session IDs (never full transcripts). Use getSession to read more of a session.')
  .arg('query', f.string('Search query'))
  .arg('projectId', f.string('Restrict to one project ID').optional())
  .arg('sourceTool', f.string('Restrict to a source tool, e.g. claude-code').optional())
  .arg('limit', f.number('Max sessions (default 5, max 10)').optional())
  .returns(f.json('Ranked session snippets'))
  .handler(async (args: { query: string; projectId?: string; sourceTool?: string; limit?: number }) => {
    const db = getDb();
    let queryVector: Float32Array | null = null;
    try {
      loadVectorExtension(db);
      const emb = await embedOne(DEFAULT_EMBEDDING_CONFIG, 'query', args.query);
      queryVector = emb?.vector ?? null;
    } catch {
      // Embeddings are optional; keyword search still works.
    }
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 5), 1), 10);
    return {
      results: searchSessionSnippets(db, args.query, { projectId: args.projectId, sourceTool: args.sourceTool }, limit, { queryVector }),
    };
  })
  .build();

const getSessionTool = fn('getSession')
  .description('Read a window of turns from one session (0-based, inclusive). Returns at most 40 turns; content is truncated per turn.')
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

const listInsightsTool = fn('listInsights')
  .description('List LLM-generated insights (decisions, learnings, friction, patterns, summaries), highest confidence first.')
  .arg('sessionId', f.string('Only insights for this session').optional())
  .arg('projectId', f.string('Only insights for this project').optional())
  .arg('type', f.string('Insight type filter, e.g. decision, learning, summary').optional())
  .arg('limit', f.number('Max insights (default 20, max 50)').optional())
  .returns(f.json('Insights'))
  .handler(async (args: { sessionId?: string; projectId?: string; type?: string; limit?: number }) => ({
    insights: listInsights(getDb(), args),
  }))
  .build();

const getAnalyticsTool = fn('getAnalytics')
  .description('Aggregate usage analytics (sessions, projects, tokens, cost, source tools) for a time range.')
  .arg('range', f.string('One of 7d, 30d, 90d, all (default 30d)').optional())
  .returns(f.json('Analytics summary'))
  .handler(async (args: { range?: string }) => {
    const range: AnalyticsRange = (['7d', '30d', '90d', 'all'] as const).includes(args.range as AnalyticsRange)
      ? (args.range as AnalyticsRange)
      : '30d';
    return getAnalyticsSummary(getDb(), range);
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

for (const t of [searchSessionsTool, getSessionTool, listInsightsTool, getAnalyticsTool, proposeDraftTool]) {
  toolRegistry.register({ id: t.name, group: 'core', fn: t });
}

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
    .description('List all projects currently indexed in the codebase knowledge graph. Call this first.')
    .namespace('codebase')
    .returns(f.string('List of indexed projects'))
    .handler(async () => execMcpCli('list_projects', {}))
    .build(),
  fn('indexRepository')
    .description('Index a repository into the knowledge graph. Use this if listProjects shows the repo is missing.')
    .namespace('codebase')
    .arg('repo_path', f.string('Absolute path to the repository directory'))
    .arg('mode', f.string('Optional mode: full, moderate, fast, cross-repo-intelligence').optional())
    .arg('name', f.string('Optional override for the project name').optional())
    .returns(f.string('Indexing results and stats'))
    .handler(async (args: Record<string, unknown>) => execMcpCli('index_repository', args))
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
