import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import * as fs from 'fs';
import { getDb } from '@code-insights/cli/db/client';
import { embedOne, DEFAULT_EMBEDDING_CONFIG } from '@code-insights/cli/embeddings/client';
import { loadVectorExtension, querySimilar } from '@code-insights/cli/embeddings/store';
import { agent, ai, f, fn, AxAgentClarificationError } from '@ax-llm/ax';
import { loadConfig } from '@code-insights/cli/utils/config';
import { loadLLMConfig } from '../llm/client.js';
import { execFileSync } from 'child_process';

const app = new Hono();

// Helper function to safely escape FTS5 query strings
function buildSafeFtsQuery(query: string): string {
  const terms = query.split(/\s+/).filter(t => t.length > 0);
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

// 1. Define Tools
const searchSessionsTool = fn('searchSessions')
  .description('Find past coding sessions by keyword, concept, or project name. Uses hybrid search (semantic + keyword) for high accuracy.')
  .namespace('kb')
  .arg('keyword', f.string('Keyword or concept to search for').optional())
  .arg('project', f.string('Project name filter').optional())
  .arg('limit', f.number('Max results (default 10)').optional())
  .returns(f.string('JSON array of session metadata'))
  .handler(async ({ keyword, project, limit = 10 }) => {
    console.log('[DEBUG] searchSessionsTool called', { keyword, project, limit });
    const db = getDb();
    
    // RRF (Reciprocal Rank Fusion) state
    const k = 60;
    const sessionScores = new Map<string, number>();
    
    if (!keyword && !project) {
        return JSON.stringify(db.prepare(`SELECT id, project_name, project_path, custom_title, generated_title, summary, started_at, message_count FROM sessions ORDER BY started_at DESC LIMIT ?`).all(limit));
    }

    if (keyword) {
      // 1. BM25 Keyword Search via FTS5 (messages_fts)
      try {
        const safeFtsQuery = buildSafeFtsQuery(keyword);
        const ftsRows = db.prepare(`
          SELECT m.session_id, bm25(messages_fts) as rank
          FROM messages_fts f
          JOIN messages m ON f.rowid = m.rowid
          WHERE messages_fts MATCH ?
          ORDER BY rank ASC
          LIMIT 50
        `).all(safeFtsQuery) as { session_id: string, rank: number }[];
        
        ftsRows.forEach((row, idx) => {
          const rrf = 1.0 / (k + idx + 1);
          sessionScores.set(row.session_id, (sessionScores.get(row.session_id) || 0) + rrf);
        });
      } catch (e) {
        console.error('[DEBUG] FTS search failed', e);
      }
      
      // Fallback/Additive SQL LIKE on sessions (includes source_tool and project_path)
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
          SELECT id FROM sessions WHERE ${sqlWhere.join(' AND ')} LIMIT 50
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
        const vecInsights = querySimilar(db, 'insight', embedding.vector, 20);
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
    }
    
    let finalSessions: any[] = [];
    if (sessionScores.size > 0) {
      // Sort by RRF score
      const sortedIds = Array.from(sessionScores.entries())
        .sort((a, b) => b[1] - a[1])
        .map(e => e[0]);
        
      for (const sid of sortedIds) {
        if (finalSessions.length >= limit) break;
        const row = db.prepare(`SELECT id, project_name, project_path, custom_title, generated_title, summary, started_at, message_count FROM sessions WHERE id = ? ${project ? "AND project_name LIKE ?" : ""}`).get(project ? [sid, `%${project}%`] : [sid]);
        if (row) {
          finalSessions.push(row);
        }
      }
    } else if (project) {
      finalSessions = db.prepare(`SELECT id, project_name, project_path, custom_title, generated_title, summary, started_at, message_count FROM sessions WHERE project_name LIKE ? ORDER BY started_at DESC LIMIT ?`).all(`%${project}%`, limit) as any[];
    }
    
    return JSON.stringify(finalSessions.slice(0, limit));
  })
  .build();

const getSessionTranscriptTool = fn('getSessionTranscript')
  .description('Retrieve the full conversation transcript for a specific session ID. Use this to read the actual prompts and code before extracting an insight.')
  .namespace('kb')
  .arg('sessionId', f.string('The exact ID of the session to read'))
  .returns(f.string('JSON array of messages (user, assistant, tool calls)'))
  .handler(async ({ sessionId }) => {
    console.log('[DEBUG] getSessionTranscriptTool called', { sessionId });
    const db = getDb();
    const stmt = db.prepare(`SELECT type, content, timestamp, tool_calls FROM messages WHERE session_id = @sessionId ORDER BY timestamp ASC`);
    const results = stmt.all({ sessionId });
    return JSON.stringify(results.slice(0, 50)); // Limit to prevent context explosion
  })
  .build();

// MCP Integration Tools
function execMcpCli(toolName: string, args: Record<string, any>): string {
  try {
    const stdout = execFileSync('codebase-memory-mcp', ['cli', toolName, JSON.stringify(args)], {
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
  .arg('project', f.string('Name of the indexed project').optional())
  .returns(f.string('Architecture summary'))
  .handler(async (args) => execMcpCli('get_architecture', args))
  .build();

const searchGraphTool = fn('searchGraph')
  .description('Structured search by label, name pattern, file pattern.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project').optional())
  .arg('name_pattern', f.string('Regex pattern for symbol name').optional())
  .arg('label', f.string('Graph label (e.g. Function, Class)').optional())
  .returns(f.string('Matching graph nodes'))
  .handler(async (args) => execMcpCli('search_graph', args))
  .build();

const getCodeSnippetTool = fn('getCodeSnippet')
  .description('Read source code for a function or symbol by qualified name.')
  .namespace('codebase')
  .arg('project', f.string('Name of the indexed project').optional())
  .arg('qualified_name', f.string('The fully qualified name of the symbol'))
  .returns(f.string('Source code snippet'))
  .handler(async (args) => execMcpCli('get_code_snippet', args))
  .build();

// System prompt enforcing SFL constraints
const systemPrompt = `
You are the Code Insights Knowledge Agent. Your task is to extract targeted insights from session transcripts.
You also have access to the live codebase graph. If asked about the current project structure or codebase, use the codebase tools (start by checking if it's indexed).
Follow strict SFL constraints:
1. ANTI-SLOP: Eliminate conversational padding.
2. NO MECHANICAL LISTS: Strictly forbid mechanical file listing.
3. METHODOLOGICAL NARRATIVE: Capture analytical methodology.
4. RAGE LOOP DETECTION: Identify temporal loops.
5. DIMENSION SCORING: Score from 0-100.

When finalizing your response, format EXACTLY as:
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

// 2. Define Agent Factory
const insightAgent = agent('userQuery:string, userClarification?:string -> reply:string', {
  agentIdentity: {
    name: 'KnowledgeAgent',
    description: systemPrompt,
  },
  functions: [
    searchSessionsTool, 
    getSessionTranscriptTool,
    listProjectsTool,
    indexRepositoryTool,
    getArchitectureTool,
    searchGraphTool,
    getCodeSnippetTool
  ],
  contextFields: [],
});

// 3. API Endpoint
app.post('/', async (c) => {
  const body = await c.req.json();
  const request = body.request;
  const answer = body.answer;
  const savedState = body.savedState;

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
    const streamResult = (await insightAgent.streamingForward(llm, { userQuery: request, userClarification: answer })) as AsyncIterableIterator<any>;
    
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
          await stream.write(firstReply);
        }
        
        // Stream the rest
        while (true) {
          const { done, value: chunk } = await iterator.next();
          if (done) break;
          
          fs.appendFileSync('agent-debug.log', 'CHUNK: ' + JSON.stringify(chunk) + '\n');
          
          const replyText = chunk?.delta?.reply || chunk?.reply;
          if (replyText) {
            hasWrittenReply = true;
            await stream.write(replyText);
          }
        }
        
        if (!hasWrittenReply) {
          await stream.write("\n\n*The agent completed its process but did not return a valid reply. This often happens if the configured LLM does not strictly follow the required JSON output schema. Try using a more capable model (like gpt-4o or claude-3-5-sonnet).*");
        }
      } catch (err: any) {
        console.error('Error during streaming:', err);
        await stream.write(`\n\n[Agent Error: ${err.message}]`);
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
