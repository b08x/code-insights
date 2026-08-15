# Agent Chat RAG Process — Fine-Grained Overview

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          code-insights RAG Architecture                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────────┐      ┌──────────────────────┐      ┌────────────────┐ │
│  │   Frontend      │      │   API Server (Hono)   │      │   Embeddings   │ │
│  │   React SPA     │──────▶   POST /api/agent     │──────▶   Ollama +     │ │
│  │   (RagChatPage) │      │   (agent.ts)          │      │   sqlite-vec   │ │
│  └─────────────────┘      └──────────────────────┘      └────────────────┘ │
│           │                         │                         │             │
│           │                         │                         │             │
│           ▼                         ▼                         ▼             │
│  ┌─────────────────┐      ┌──────────────────────┐      ┌────────────────┐ │
│  │   NDJSON        │      │   ax-llm Agent        │      │   SQLite DB    │ │
│  │   Streaming     │◀─────│   + AxJSRuntime       │◀─────│   + FTS5       │ │
│  │   Response      │      │   + Checkpointed      │      │   + vec_insights│ │
│  └─────────────────┘      └──────────────────────┘      └────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Frontend Layer — `RagChatPage.tsx`

**File:** `dashboard/src/pages/RagChatPage.tsx:11-376`

**State Management:**
- `messages: Message[]` — chat history (user/assistant)
- `input: string` — current user input
- `isLoading: boolean` — streaming state
- `clarification: any` — agent clarification questions
- `savedState: any` — ax-llm agent state persistence
- `liveMetrics: any[]` — real-time tool call visualization
- `showContext: boolean` — right sidebar toggle

**Request Flow:**
```typescript
handleSubmit(textToSubmit?)
  ├─ Build payload: { request: text } OR { answer: text, savedState }
  ├─ POST /api/agent
  ├─ Check Content-Type:
  │   ├─ application/json → clarification response
  │   │   ├─ setClarification({ question, details })
  │   │   ├─ setSavedState(data.savedState)
  │   │   └─ return (wait for user answer)
  │   └─ text/stream → NDJSON streaming
  │       ├─ Read chunks via ReadableStream
  │       ├─ Parse JSON lines:
  │       │   ├─ { type: 'chunk', text } → append to message
  │       │   └─ { type: 'metric', tool, args } → live metrics
  │       └─ Update messages state incrementally
  └─ Error handling → display error message
```

**UI Components:**
- Left sidebar: session history
- Center: chat messages with Markdown rendering
- Right sidebar: live metrics (tool calls)
- Input area: text input + quick prompts

---

## 2. API Server Layer — `agent.ts`

**File:** `server/src/routes/agent.ts:1-400`

**Endpoint:** `POST /api/agent`

**Request Body:**
```typescript
{ request: string }           // New query
{ answer: string, savedState: any }  // Clarification response
```

**Response Types:**
1. **Clarification (JSON):** `{ type: 'clarification', question, clarificationDetails, savedState }`
2. **Streaming (NDJSON):** Lines of `{ type: 'chunk', text }` or `{ type: 'metric', tool, args }`

**Agent Initialization:**
```typescript
const insightAgent = agent('chatHistory:Message[], userQuery:string, userClarification?:string -> reply:string', {
  agentIdentity: {
    name: 'KnowledgeAgent',
    description: systemPrompt,  // SFL constraints
  },
  contextPolicy: 'checkpointed',
  runtime: new AxJSRuntime(),
  functions: [
    onMemoriesSearch,        // Hybrid search (BM25 + vector, extract top-2 sessions)
    listProjectsTool,        // MCP: list indexed projects
    indexRepositoryTool,     // MCP: index repository
    getArchitectureTool,     // MCP: architecture overview
    searchGraphTool,         // MCP: graph search
    getCodeSnippetTool,      // MCP: code snippets
    tracePathTool,           // MCP: trace logical paths
    checkIndexCoverageTool,  // MCP: check graph index coverage
  ],
});
```

**Streaming Flow:**
```typescript
POST /
  ├─ Load config (agent or fallback LLM)
  ├─ Resolve API key (env or stored)
  ├─ Create LLM instance via ax-llm
  ├─ Restore agent state if clarification
  ├─ insightAgent.streamingForward(llm, { userQuery, userClarification })
  ├─ Read first chunk (catch AxAgentClarificationError before HTTP 200)
  ├─ streamText() → NDJSON response
  │   ├─ First chunk: reply + function calls
  │   └─ Subsequent chunks: reply + metrics
  └─ Error handling:
      ├─ AxAgentClarificationError → JSON response
      └─ Other → 500 error
```

---

## 3. Tool Layer — Hybrid Search & Retrieval

### 3.1 `onMemoriesSearch`

**Hybrid Search & Memory Extraction Pipeline:**
```
User Query
    │
    ▼
┌───────────────────────────────────────────────┐
│           Reciprocal Rank Fusion (RRF)        │
│           k = 60                              │
├───────────────────────────────────────────────┤
│                                               │
│  ┌─────────────────┐  ┌────────────────────┐ │
│  │  BM25 FTS5      │  │  Vector Semantic   │ │
│  │  Keyword Search  │  │  Search (KNN)      │ │
│  └────────┬────────┘  └────────┬───────────┘ │
│           │                    │              │
│           ▼                    ▼              │
│  ┌─────────────────┐  ┌────────────────────┐ │
│  │ messages_fts    │  │ vec_insights       │ │
│  │ (session_id,    │  │ (id, distance)     │ │
│  │  bm25 rank)     │  │                    │ │
│  └────────┬────────┘  └────────┬───────────┘ │
│           │                    │              │
│           └────────┬───────────┘              │
│                    ▼                          │
│  ┌─────────────────────────────────────────┐ │
│  │  RRF Score = Σ 1/(k + rank + 1)        │ │
│  │  Sort by score DESC                     │ │
│  │  Extract top-2 session transcripts      │ │
│  └─────────────────────────────────────────┘ │
│                                               │
└───────────────────────────────────────────────┘
```

**BM25 Search:**
```sql
SELECT m.session_id, bm25(messages_fts) as rank
FROM messages_fts f
JOIN messages m ON f.rowid = m.rowid
WHERE messages_fts MATCH ?
ORDER BY rank ASC
LIMIT 50
```

**Vector Search:**
```typescript
loadVectorExtension(db);
const embedding = await embedOne(DEFAULT_EMBEDDING_CONFIG, 'query', keyword);
const vecInsights = querySimilar(db, 'insight', embedding.vector, 20);
```

**RRF Score Calculation & Transcript Extraction:**
```typescript
const k = 60;
const sessionScores = new Map<string, number>();

// Aggregate RRF scores
ftsRows.forEach((row, idx) => {
  const rrf = 1.0 / (k + idx + 1);
  sessionScores.set(row.session_id, 
    (sessionScores.get(row.session_id) || 0) + rrf);
});

// Extract top 2 sessions based on RRF score
const topSessions = Array.from(sessionScores.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 2);

// Fetch transcript for top sessions
const transcripts = topSessions.map(([sessionId]) => {
  return db.prepare(`
    SELECT type, content, timestamp, tool_calls 
    FROM messages 
    WHERE session_id = ? 
    ORDER BY timestamp ASC
    LIMIT 50
  `).all(sessionId);
});
```

### 3.3 MCP Tools (Codebase Integration)

```typescript
function execMcpCli(toolName: string, args: Record<string, any>): string {
  return execFileSync('codebase-memory-mcp', 
    ['cli', toolName, JSON.stringify(args)], {
      encoding: 'utf-8',
      timeout: 120000  // 2 minutes for indexing
    });
}
```

**Available Tools:**
- `list_projects` → List indexed repositories
- `index_repository` → Index a repository
- `get_architecture` → Architecture overview
- `search_graph` → Structured graph search
- `get_code_snippet` → Read source code
- `trace_path` → Trace logical paths between files/components
- `check_index_coverage` → Check graph index coverage

---

## 4. Embedding Layer

### 4.1 Configuration

```typescript
// cli/src/embeddings/types.ts
interface EmbeddingConfig {
  model: string;              // 'qwen3-embedding:0.6b'
  baseUrl: string;            // 'http://tinybot:11434'
  dim: number;                // 1024
  batchSize: number;          // 50
  rateLimitPerMinute: number; // 0 = disabled
}

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: 'qwen3-embedding:0.6b',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://tinybot:11434',
  dim: 1024,
  batchSize: 50,
  rateLimitPerMinute: 0,
};
```

### 4.2 Embedding Pipeline

```typescript
// cli/src/embeddings/ollama-client.ts
async function embedBatch(config, texts, rateLimiter): Promise<Float32Array[]> {
  const url = `${config.baseUrl}/api/embed`;
  const body = { model: config.model, input: texts };
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { method: 'POST', body });
    const json = await res.json();
    return json.embeddings.map(e => new Float32Array(e));
  }
}

async function embedOne(config, id, text): Promise<EmbeddingResult> {
  const results = await embedTexts(config, [{ id, text }]);
  return results[0];
}
```

**Text Truncation:**
```typescript
const MAX_EMBEDDING_CHARS = 8192;
const texts = batch.map(b => 
  b.text.length > MAX_EMBEDDING_CHARS 
    ? b.text.slice(0, MAX_EMBEDDING_CHARS) 
    : b.text
);
```

### 4.3 Vector Store (sqlite-vec)

**Tables:**
```sql
-- vec_insights: for insight embeddings
CREATE VIRTUAL TABLE vec_insights USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[1024]
);

-- vec_messages: for message embeddings
CREATE VIRTUAL TABLE vec_messages USING vec0(
  id TEXT PRIMARY KEY,
  embedding float[1024]
);
```

**KNN Query:**
```typescript
function querySimilar(db, entityType, queryVector, topK) {
  return db.prepare(`
    SELECT id, distance 
    FROM ${tableName} 
    WHERE embedding MATCH ? 
    ORDER BY distance 
    LIMIT ?
  `).all(vecToBlob(queryVector), topK);
}
```

**Filtered Query (Same Project):**
```typescript
function querySimilarFiltered(db, entityType, queryVector, topK, projectId) {
  // Fetch extra candidates (topK * 10)
  const candidates = querySimilar(db, entityType, queryVector, topK * 10);
  
  // Filter by project_id in JS
  return candidates
    .filter(c => projectMap.get(c.id) === projectId)
    .slice(0, topK);
}
```

---

## 5. Analysis Pipeline — Retrieval-Augmented Generation

### 5.1 Configuration

```typescript
// server/src/llm/analysis.ts
interface RetrievalConfig {
  enabled: boolean;           // default: true
  topK: number;              // default: 5
  similarityThreshold: number; // default: 0.75 (cosine similarity)
  sameProjectOnly: boolean;  // default: true
}
```

### 5.2 Retrieval Flow

```typescript
async function retrieveRelatedInsights(session, formattedMessages, 
                                       embeddingConfig, retrievalConfig) {
  // 1. Load vector extension
  loadVectorExtension(db);
  
  // 2. Check vector table exists
  const tableCheck = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_insights'"
  ).get();
  
  // 3. Embed session text (truncate to 4000 chars)
  const textToEmbed = formattedMessages.slice(0, 4000);
  const embedding = await embedOne(embeddingConfig, 
    `session-${session.id}`, textToEmbed);
  
  // 4. Query similar insights (filtered by project)
  const candidates = querySimilarFiltered(db, 'insight', 
    embedding.vector, retrievalConfig.topK, session.project_id);
  
  // 5. Fetch insight details
  const rows = db.prepare(`
    SELECT id, type, title, content, confidence 
    FROM insights WHERE id IN (?)
  `).all(...ids);
  
  // 6. Filter by similarity threshold
  return candidates
    .filter(c => (1 - c.distance) >= retrievalConfig.similarityThreshold)
    .map(c => ({
      type: insight.type,
      title: insight.title,
      content: insight.content.slice(0, 300),
      confidence: insight.confidence,
    }));
}
```

### 5.3 Prompt Injection

```typescript
// cli/src/analysis/prompts.ts
function buildSessionAnalysisInstructions(projectName, sessionSummary, 
                                          meta, loopSignal, relatedInsights) {
  const relatedBlock = relatedInsights && relatedInsights.length > 0
    ? `<related_insights>
${relatedInsights.map((ri, i) => `
  <insight index="${i + 1}">
    <type>${ri.type}</type>
    <title>${ri.title}</title>
    <content>${ri.content}</content>
    <confidence>${ri.confidence}</confidence>
  </insight>`).join('')}
</related_insights>

<related_insights_instructions>
These are insights from similar past sessions in the same project. 
Do NOT duplicate them. Instead, note if they reinforce or contradict 
the current session's patterns. If a related insight is directly 
relevant, reference it by index (e.g., "reinforces insight #2").
</related_insights_instructions>`
    : '';
    
  return `<task>Extract analytical session facets...</task>
${relatedBlock}
<output_schema>...</output_schema>`;
}
```

### 5.4 Analysis Execution

```typescript
async function analyzeSession(session, messages, options) {
  // 1. Format messages
  const formattedMessages = formatMessagesForAnalysis(messages);
  
  // 2. Retrieve related insights (RAG context)
  const relatedInsights = await retrieveRelatedInsights(
    session, formattedMessages, embeddingConfig, retrievalConfig
  );
  
  // 3. Chunk if needed (MAX_INPUT_TOKENS = 100,000)
  if (estimatedTokens > MAX_INPUT_TOKENS) {
    const chunks = chunkMessages(messages, estimateTokens);
    const chunkResponses = [];
    
    for (const chunk of chunks) {
      const response = await client.chat([
        { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
        { role: 'user', content: [
          buildCacheableConversationBlock(chunkFormatted),
          buildSessionAnalysisInstructions(..., relatedInsights),
        ]},
      ]);
      chunkResponses.push(parseAnalysisResponse(response.content));
    }
    analysisResponse = mergeAnalysisResponses(chunkResponses);
  } else {
    // Single chunk
    const response = await client.chat([
      { role: 'system', content: SHARED_ANALYST_SYSTEM_PROMPT },
      { role: 'user', content: [
        buildCacheableConversationBlock(formattedMessages),
        buildSessionAnalysisInstructions(..., relatedInsights),
      ]},
    ]);
    analysisResponse = parseAnalysisResponse(response.content);
  }
  
  // 4. Save insights
  const insights = convertToInsightRows(analysisResponse, session);
  saveInsightsToDb(insights);
  deleteSessionInsights(session.id, { excludeTypes: ['prompt_quality'] });
  
  // 5. Save facets
  if (analysisResponse.facets) {
    saveFacetsToDb(session.id, analysisResponse.facets, ANALYSIS_VERSION);
  }
  
  // 6. Record usage
  saveAnalysisUsage({ session_id, input_tokens, output_tokens, cost_usd });
}
```

---

## 6. LLM Client Layer

**File:** `server/src/llm/client.ts`

**Supported Providers:**
```typescript
const PROVIDER_API_KEY_ENV: Record<string, string> = {
  openai:     'OPENAI_API_KEY',
  anthropic:  'ANTHROPIC_API_KEY',
  gemini:     'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral:    'MISTRAL_API_KEY',
};
```

**Client Creation:**
```typescript
function createClientFromConfig(config: LLMProviderConfig): LLMClient {
  switch (config.provider) {
    case 'openai':     return createOpenAIClient(apiKey, model);
    case 'anthropic':  return createAnthropicClient(apiKey, model);
    case 'gemini':     return createGeminiClient(apiKey, model);
    case 'ollama':     return createOllamaClient(model, baseUrl);
    case 'openrouter': return createOpenRouterClient(apiKey, model);
    case 'mistral':    return createMistralClient(apiKey, model);
  }
}
```

---

## 7. Data Flow Summary

```
User Query
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. Frontend (RagChatPage)                                   │
│    POST /api/agent { request: "query" }                     │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. API Server (agent.ts)                                    │
│    ├─ Load config (provider, model, API key)                │
│    ├─ Create ax-llm agent with 7 tools                      │
│    └─ insightAgent.streamingForward(llm, { userQuery })     │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. Tool Execution (LLM decides which tools to call)         │
│    ├─ onMemoriesSearch                                      │
│    │   ├─ BM25 FTS5 search on messages_fts                 │
│    │   ├─ Vector search on vec_insights                     │
│    │   ├─ RRF fusion of results                             │
│    │   └─ Extract top-2 session transcripts                 │
│    └─ MCP Tools (codebase-memory-mcp CLI)                   │
│        ├─ list_projects                                     │
│        ├─ index_repository                                  │
│        ├─ get_architecture                                  │
│        ├─ search_graph                                      │
│        ├─ get_code_snippet                                  │
│        ├─ trace_path                                        │
│        └─ check_index_coverage                              │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Response Generation & Citation Tracking                  │
│    ├─ LLM generates reply with tool results                 │
│    ├─ onUsedMemories callback handles citation tracking     │
│    ├─ ax-llm handles clarification if needed                │
│    └─ Streaming: { type: 'chunk', text } + { type: 'metric' }│
│       └─ Stream Appendix: Send citations at end of stream   │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Frontend Rendering                                       │
│    ├─ Parse NDJSON stream                                   │
│    ├─ Append text to assistant message                      │
│    └─ Display live metrics in sidebar                       │
└─────────────────────────────────────────────────────────────┘
```

---

## 8. Key Integration Points

| Component | File | Purpose |
|-----------|------|---------|
| `RagChatPage` | `dashboard/src/pages/RagChatPage.tsx` | Frontend chat UI |
| `agent.ts` | `server/src/routes/agent.ts` | API endpoint + agent |
| `onMemoriesSearch` | `server/src/routes/agent.ts:21-135` | Hybrid search & transcript extraction |
| `onUsedMemories` | `server/src/routes/agent.ts:137-148` | Citation tracking |
| `embedOne` | `cli/src/embeddings/ollama-client.ts:149-156` | Single embedding |
| `querySimilar` | `cli/src/embeddings/store.ts:84-96` | KNN vector search |
| `retrieveRelatedInsights` | `server/src/llm/analysis.ts:322-393` | RAG context injection |
| `buildSessionAnalysisInstructions` | `cli/src/analysis/prompts.ts:84-206` | Prompt with RAG |
| `analyzeSession` | `server/src/llm/analysis.ts:26-295` | Full analysis pipeline |

---

## 9. Coverage & Audit

**Graph Coverage:** All 8 core files have `no_recorded_issue` status with `metadata_match` freshness.

**Graph Health Warning:** 812 dangling-endpoint edges, 152 collapsed directed edges — expected for external dependencies (Ollama, MCP CLI).

**Evidence Tier:** Verify (Tier 2) — direct source reads for all material claims, both call directions traced for `retrieveRelatedInsights` and `searchSessionsTool`.

---

## 10. Generated

**Date:** 2026-08-14
**Source:** codebase-memory graph tools + direct source reads
**Graph Generation:** 2026-08-14T15:09:40Z
