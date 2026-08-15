import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import * as fs from 'fs';
import { getDb } from '@code-insights/cli/db/client';
import { embedOne, DEFAULT_EMBEDDING_CONFIG } from '@code-insights/cli/embeddings/client';
import { loadVectorExtension, querySimilar } from '@code-insights/cli/embeddings/store';
import { agent, ai, f, fn, AxAgentClarificationError, AxJSRuntime } from '@ax-llm/ax';
import { loadConfig } from '@code-insights/cli/utils/config';
import { loadLLMConfig } from '../llm/client.js';
import { execFileSync } from 'child_process';

const app = new Hono();

// Helper function to safely escape FTS5 query strings
function buildSafeFtsQuery(query: string): string {
  const terms = query.split(/\s+/).filter(t => t.length > 0);
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

import type { AxAgentMemoriesSearchFn } from '@ax-llm/ax';

/**
 * 3-stage hybrid search for Agent Memory.
 * 
 * Executes semantic and keyword queries against local sessions:
 * 1. BM25 Keyword Search: FTS5 matching on session messages.
 * 2. Fallback SQL LIKE: Match summary, title, or project.
 * 3. Vector Semantic Search: Semantic similarity against embedded insights.
 * 
 * Combines results using Reciprocal Rank Fusion (RRF) and caps at the top 2 sessions per query
 * to prevent context window bloat.
 */
const onMemoriesSearch: AxAgentMemoriesSearchFn = async (searches, alreadyLoaded) => {
  console.log('[DEBUG] onMemoriesSearch called', { searches });
  const db = getDb();
  const skip = new Set(alreadyLoaded.map(m => m.id));
  const results: {id: string, content: string}[] = [];
  const k = 60;
  
  for (const keyword of searches) {
    const sessionScores = new Map<string, number>();

    // 1. BM25 Keyword Search via FTS5 (messages_fts)
    try {
      const safeFtsQuery = buildSafeFtsQuery(keyword);
      if (safeFtsQuery) {
        const ftsRows = db.prepare(`
          SELECT m.session_id, bm25(messages_fts) as rank
          FROM messages_fts f
          JOIN messages m ON f.rowid = m.rowid
          WHERE messages_fts MATCH ?
          ORDER BY rank ASC
          LIMIT 20
        `).all(safeFtsQuery) as { session_id: string, rank: number }[];
        
        ftsRows.forEach((row, idx) => {
          const rrf = 1.0 / (k + idx + 1);
          sessionScores.set(row.session_id, (sessionScores.get(row.session_id) || 0) + rrf);
        });
      }
    } catch (e) {
      console.error('[DEBUG] FTS search failed', e);
    }
    
    // Fallback/Additive SQL LIKE on sessions
    const terms = keyword.split(/\s+/).filter(t => t.length > 1);
    if (terms.length > 0) {
      let sqlWhere = [];
      let sqlParams = [];
      for (const t of terms) {
        sqlWhere.push(`(summary LIKE ? OR generated_title LIKE ? OR custom_title LIKE ? OR source_tool LIKE ? OR project_path LIKE ?)`);
        const p = `%${t}%`;
        sqlParams.push(p, p, p, p, p);
      }
      const likeRows = db.prepare(`
        SELECT id FROM sessions WHERE ${sqlWhere.join(' AND ')} LIMIT 20
      `).all(...sqlParams) as { id: string }[];
      likeRows.forEach((row, idx) => {
        const rrf = 1.0 / (k + idx + 1);
        sessionScores.set(row.id, (sessionScores.get(row.id) || 0) + rrf);
      });
    }
    
    // 2. Vector Semantic Search
    try {
      loadVectorExtension(db);
      const embedding = await embedOne(DEFAULT_EMBEDDING_CONFIG, 'query', keyword);
      const vecInsights = querySimilar(db, 'insight', embedding.vector, 10);
      if (vecInsights.length > 0) {
        const insightIds = vecInsights.map(v => v.id);
        const placeholders = insightIds.map(() => '?').join(',');
        const insights = db.prepare(`SELECT id, session_id FROM insights WHERE id IN (${placeholders})`).all(...insightIds) as { id: string, session_id: string }[];
        const insightToSession = new Map(insights.map(i => [i.id, i.session_id]));
        
        vecInsights.forEach((v, idx) => {
          const sid = insightToSession.get(v.id);
          if (sid) {
            const rrf = 1.0 / (k + idx + 1);
            sessionScores.set(sid, (sessionScores.get(sid) || 0) + rrf);
          }
        });
      }
    } catch (e) {
      console.error('[DEBUG] Vector search failed', e);
    }

    // Sort by RRF score and pick top 2 sessions per search query to avoid massive context bloat
    const sortedIds = Array.from(sessionScores.entries())
      .sort((a, b) => b[1] - a[1])
      .map(e => e[0]);

    for (const sid of sortedIds.slice(0, 2)) {
      if (!skip.has(sid)) {
        // Fetch session metadata and transcript
        const session = db.prepare(`SELECT project_name, custom_title, generated_title, summary FROM sessions WHERE id = ?`).get(sid) as any;
        const messages = db.prepare(`SELECT type, content FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT 50`).all(sid) as any[];
        
        if (session) {
          const contentStr = `
Project: ${session.project_name}
Title: ${session.custom_title || session.generated_title}
Summary: ${session.summary}

Transcript:
${messages.map(m => `[${m.type}]: ${m.content}`).join('\n\n')}
          `.trim();

          results.push({ id: sid, content: contentStr });
          skip.add(sid); // don't add again in subsequent searches
        }
      }
    }
  }

  return results;
};

/**
 * MCP Integration Tools
 * Executes a codebase-memory-mcp tool synchronously.
 * 
 * Acts as the bridge between the internal Ax LLM agent and the external MCP server
 * which provides codebase navigation and indexing capabilities.
 *
 * @param toolName - The name of the MCP tool to execute.
 * @param args - JSON serializable arguments for the tool.
 * @returns The stdout of the executed tool.
 */
function execMcpCli(toolName: string, args: Record<string, any>): string {
  try {
    const stdout = execFileSync('codebase-memory-mcp', ['cli', toolName], {
      input: JSON.stringify(args),
      encoding: 'utf-8',
      timeout: 120000 // Extended timeout for indexing
    });
    return stdout;
  } catch (error: any) {
    console.error(`[MCP CLI Error] ${toolName}:`, error.stderr || error.message);
    return JSON.stringify({ error: error.stderr || error.message });
  }
}

const listProjectsTool = fn('listProjects')
  .description('List all projects currently indexed in the codebase knowledge graph. Call this first to see if a project is available.')
  .namespace('codebase')
  .returns(f.string('List of indexed projects'))
  .handler(async () => execMcpCli('list_projects', {}))
  .build();

const indexRepositoryTool = fn('indexRepository')
  .description('Index a repository into the knowledge graph. Use this if listProjects shows the repo is missing.')
  .namespace('codebase')
  .arg('repo_path', f.string('Absolute path to the repository directory'))
  .arg('mode', f.string('Optional mode: full, moderate, fast, cross-repo-intelligence').optional())
  .arg('name', f.string('Optional override for the project name').optional())
  .returns(f.string('Indexing results and stats'))
  .handler(async (args) => execMcpCli('index_repository', args))
  .build();

const getArchitectureTool = fn('getArchitecture')
  .description('Codebase overview: languages, packages, routes, hotspots. Call after verifying the project is indexed.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project'))
  .returns(f.string('Architecture summary'))
  .handler(async (args) => execMcpCli('get_architecture', args))
  .build();

const searchGraphTool = fn('searchGraph')
  .description('Structured search by label, name pattern, file pattern.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project'))
  .arg('name_pattern', f.string('Regex pattern for symbol name').optional())
  .arg('label', f.string('Graph label (e.g. Function, Class)').optional())
  .returns(f.string('Matching graph nodes'))
  .handler(async (args) => execMcpCli('search_graph', args))
  .build();

const getCodeSnippetTool = fn('getCodeSnippet')
  .description('Read source code for a function or symbol by qualified name.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project'))
  .arg('qualified_name', f.string('The fully qualified name of the symbol'))
  .returns(f.string('Source code snippet'))
  .handler(async (args) => execMcpCli('get_code_snippet', args))
  .build();

const tracePathTool = fn('tracePath')
  .description('Trace paths through the code graph. Use for callers, dependencies, impact analysis, or data flow tracing.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project'))
  .arg('function_name', f.string('Name of the function/class to trace'))
  .arg('direction', f.string('Direction: inbound, outbound, or both').optional())
  .arg('mode', f.string('Mode: calls, data_flow, or cross_service').optional())
  .arg('depth', f.number('Depth limit (default 3)').optional())
  .returns(f.string('Trace paths'))
  .handler(async (args) => execMcpCli('trace_path', args))
  .build();

const checkIndexCoverageTool = fn('checkIndexCoverage')
  .description('Check authoritative indexing-coverage metadata for exact paths or path scopes. Use this before negative/exhaustive claims.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project'))
  .arg('paths', f.string('Comma-separated list of repository-relative paths to check exactly').optional())
  .arg('scopes', f.string('Comma-separated list of repository-relative path prefixes (e.g. ".")').optional())
  .returns(f.string('Index coverage status'))
  .handler(async (args) => {
    const payload: any = { project: args.project };
    if (args.paths) payload.paths = args.paths.split(',').map((s: string) => s.trim());
    if (args.scopes) payload.scopes = args.scopes.split(',').map((s: string) => s.trim());
    return execMcpCli('check_index_coverage', payload);
  })
  .build();

// System prompt enforcing SFL constraints
const systemPrompt = `
You are the Code Insights Knowledge Agent, an intelligent conversational assistant designed exclusively to analyze local AI coding sessions.
If a user's request is vague or conversational (e.g., "review the last 24 hours", "what did I do today?"), ALWAYS assume they are referring to their code-insights sessions or codebase. Use your database tools (like searchSessionsTool) to find relevant recent sessions, and never fall back to asking about general tasks like emails, calendar events, or non-coding activities.

You also have access to the live codebase graph. If asked about the current project structure or codebase, use the codebase tools (start by checking if it's indexed).
You MUST run checkIndexCoverageTool before making exhaustive or negative claims about the codebase structure to ensure you aren't hallucinating on partially indexed code.

Follow strict SFL constraints:
1. ANTI-SLOP: Eliminate conversational padding.
2. NO MECHANICAL LISTS: Strictly forbid mechanical file listing.
3. METHODOLOGICAL NARRATIVE: Capture analytical methodology.
4. RAGE LOOP DETECTION: Identify temporal loops.
5. DIMENSION SCORING: Score from 0-100.

When finalizing an insight or responding to a session query, format EXACTLY as:
# [Insight Title]
**Dimension Score:** [0-100] - [Brief justification]
## Methodological Narrative
[narrative]
## SFL Breakdown
* **Field (Ideational):** [tasks/entities]
* **Tenor (Interpersonal):** [power dynamic]
* **Mode (Textual):** [architectural structure]
## Friction & Rage Loops
[details]
`;

const runtime = new AxJSRuntime();

// 2. Define Agent Factory
const insightAgent = agent('userQuery:string, chatHistory?:string[], userClarification?:string -> reply:string', {
  agentIdentity: {
    name: 'KnowledgeAgent',
    description: systemPrompt,
  },
  runtime,
  maxRuntimeChars: 4000,
  contextPolicy: {
    preset: 'checkpointed',
    budget: 'balanced',
  },
  onMemoriesSearch,
  functions: [
    listProjectsTool,
    indexRepositoryTool,
    getArchitectureTool,
    searchGraphTool,
    getCodeSnippetTool,
    tracePathTool,
    checkIndexCoverageTool
  ],
  contextFields: [],
});

// 3. API Endpoint
app.post('/', async (c) => {
  const body = await c.req.json();
  const request = body.request;
  const answer = body.answer;
  const savedState = body.savedState;
  const chatHistory = body.chatHistory;

  // Load the agent configuration
  const config = loadConfig();
  const agentConfig = config?.dashboard?.agent;
  
  // Fallback to the main LLM config if agent config isn't explicitly set
  const fallbackConfig = loadLLMConfig();
  
  const provider = agentConfig?.provider || fallbackConfig?.provider || 'openai';
  const model = agentConfig?.model || fallbackConfig?.model || 'gpt-4o-mini';
  
  // Resolve API key
  let apiKey = agentConfig?.apiKey || fallbackConfig?.apiKey;
  if (!apiKey) {
    const envVarMap: Record<string, string> = {
      openai: 'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini: 'GEMINI_API_KEY',
      openrouter: 'OPENROUTER_API_KEY',
      mistral: 'MISTRAL_API_KEY',
    };
    const envVar = envVarMap[provider as string];
    if (envVar && process.env[envVar]) {
      apiKey = process.env[envVar];
    }
  }
  
  if (!apiKey && provider !== 'ollama') {
    return c.json({ error: 'No API key configured for the Agent. Please set it in the Settings page.' }, 400);
  }

  const isOllama = provider === 'ollama';
  
  let axProviderName: string = provider;
  if (provider === 'gemini') axProviderName = 'google-gemini';
  if (provider === 'ollama' || provider === 'openrouter') axProviderName = 'openai';

  const aiOptions: any = { 
    name: axProviderName,
  };
  
  if (apiKey) {
    aiOptions.apiKey = apiKey;
  } else if (isOllama) {
    aiOptions.apiKey = 'ollama'; // dummy key for ax to not throw
  }
  
  if (model) {
    aiOptions.config = { model, embedModel: model };
  }
  
  const baseUrl = agentConfig?.baseUrl || fallbackConfig?.baseUrl;
  if (baseUrl) {
    const cleanUrl = baseUrl.replace(/\/+$/, '');
    aiOptions.apiURL = isOllama ? (cleanUrl.endsWith('/v1') ? cleanUrl : `${cleanUrl}/v1`) : cleanUrl;
  } else if (isOllama) {
    aiOptions.apiURL = 'http://localhost:11434/v1';
  } else if (provider === 'openrouter') {
    aiOptions.apiURL = 'https://openrouter.ai/api/v1';
  }

  const llm = ai(aiOptions);
  
  if (savedState) {
    insightAgent.setState(savedState);
  }

  try {
    const citedSessions = new Set<string>();

    /**
     * Executes the Ax Agent in streaming mode (streamingForward route logic).
     * 
     * The agent may emit internal actions, tool calls, or requests for user clarification.
     * We capture memory usage (citedSessions) to append citations to the final output.
     */
    const streamResult = (await insightAgent.streamingForward(
      llm, 
      { userQuery: request, chatHistory: chatHistory, userClarification: answer },
      {
        onUsedMemories: (items) => {
          for (const item of items) {
             citedSessions.add(item.id);
          }
        }
      }
    )) as AsyncIterableIterator<any>;
    
    // We must read the first chunk to catch any AxAgentClarificationError before sending HTTP 200 headers
    // because once streamText is returned, headers are sent and we can't return a JSON response.
    const iterator = streamResult[Symbol.asyncIterator]();
    const firstResult = await iterator.next();
    
    if (firstResult.done) {
      return c.text('');
    }

    return streamText(c, async (stream) => {
      let hasWrittenReply = false;

      try {
        // Send the first chunk we already pulled
        const firstChunk = firstResult.value;
        fs.appendFileSync('agent-debug.log', 'FIRST CHUNK: ' + JSON.stringify(firstChunk) + '\n');
        
        const firstReply = firstChunk?.delta?.reply || firstChunk?.reply;
        if (firstReply) {
          hasWrittenReply = true;
          await stream.write(JSON.stringify({ type: 'chunk', text: firstReply }) + '\n');
        }
        
        const firstFunctionCalls = firstChunk?.delta?.functionCalls || firstChunk?.functionCalls;
        if (firstFunctionCalls && Array.isArray(firstFunctionCalls) && firstFunctionCalls.length > 0) {
          for (const fc of firstFunctionCalls) {
            await stream.write(JSON.stringify({
              type: 'metric',
              tool: fc.name || fc.function?.name,
              args: fc.arguments || fc.function?.arguments
            }) + '\n');
          }
        }
        
        // Stream the rest
        while (true) {
          const { done, value: chunk } = await iterator.next();
          if (done) break;
          
          fs.appendFileSync('agent-debug.log', 'CHUNK: ' + JSON.stringify(chunk) + '\n');
          
          // Emit Text
          const replyText = chunk?.delta?.reply || chunk?.reply;
          if (replyText) {
            hasWrittenReply = true;
            await stream.write(JSON.stringify({ type: 'chunk', text: replyText }) + '\n');
          }
          
          // Emit Tools (live metrics)
          const functionCalls = chunk?.delta?.functionCalls || chunk?.functionCalls;
          if (functionCalls && Array.isArray(functionCalls) && functionCalls.length > 0) {
            for (const fc of functionCalls) {
              await stream.write(JSON.stringify({
                type: 'metric',
                tool: fc.name || fc.function?.name,
                args: fc.arguments || fc.function?.arguments
              }) + '\n');
            }
          }
        }
        
        if (!hasWrittenReply) {
          await stream.write(JSON.stringify({ type: 'chunk', text: "\n\n*The agent completed its process but did not return a valid reply. This often happens if the configured LLM does not strictly follow the required JSON output schema. Try using a more capable model (like gpt-4o or claude-3-5-sonnet).*" }) + '\n');
        }

        // Append citations at the end of the stream
        if (citedSessions.size > 0) {
          let citationMd = '\n\n---\n**Sources Consulted:**\n';
          for (const sessionId of citedSessions) {
            citationMd += `- [Session ${sessionId.substring(0, 8)}](/sessions/${sessionId})\n`;
          }
          await stream.write(JSON.stringify({ type: 'chunk', text: citationMd }) + '\n');
        }

      } catch (err: any) {
        console.error('Error during streaming:', err);
        await stream.write(JSON.stringify({ type: 'chunk', text: `\n\n[Agent Error: ${err.message}]` }) + '\n');
      }
    });

  } catch (error) {
    if (error instanceof AxAgentClarificationError) {
      return c.json({
        type: 'clarification',
        question: error.question,
        clarificationDetails: error.clarification,
        savedState: error.getState(),
      });
    }
    console.error('Agent error:', error);
    return c.json({ error: 'Internal agent error' }, 500);
  }
});

export default app;
