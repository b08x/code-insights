import { Hono } from 'hono';
import { streamText } from 'hono/streaming';
import * as fs from 'fs';
import { getDb } from '@code-insights/cli/db/client';
import { agent, ai, f, fn, AxAgentClarificationError } from '@ax-llm/ax';
import { loadConfig } from '@code-insights/cli/utils/config';
import { loadLLMConfig } from '../llm/client.js';

const app = new Hono();

// 1. Define Tools
const searchSessionsTool = fn('searchSessions')
  .description('Find past coding sessions by keyword or project name to identify where work happened.')
  .namespace('kb')
  .arg('keyword', f.string('Keyword to search in summaries and titles').optional())
  .arg('project', f.string('Project name filter').optional())
  .arg('limit', f.number('Max results (default 10)').optional())
  .returns(f.string('JSON array of session metadata'))
  .handler(async ({ keyword, project, limit = 10 }) => {
    console.log('[DEBUG] searchSessionsTool called', { keyword, project, limit });
    const db = getDb();
    const query = `
      SELECT id, project_name, custom_title, generated_title, summary, started_at, message_count
      FROM sessions
      WHERE 
        (@project IS NULL OR project_name LIKE '%' || @project || '%')
        AND
        (@keyword IS NULL OR summary LIKE '%' || @keyword || '%' OR generated_title LIKE '%' || @keyword || '%' OR custom_title LIKE '%' || @keyword || '%')
      ORDER BY started_at DESC
      LIMIT @limit;
    `;
    const stmt = db.prepare(query);
    const results = stmt.all({ 
      project: project || null, 
      keyword: keyword || null, 
      limit 
    });
    return JSON.stringify(results);
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

// System prompt enforcing SFL constraints
const systemPrompt = `
You are the Code Insights Knowledge Agent. Your task is to extract targeted insights from session transcripts.
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
  functions: [searchSessionsTool, getSessionTranscriptTool],
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
