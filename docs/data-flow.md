# Data Flow

> Sequence diagrams and data transformation patterns

## Primary Operations

### Insights Generation Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI as cli/src/index.ts
    participant Cmd as commands/insights.ts
    participant Queue as queue-worker.ts
    participant Parser as jsonl.ts
    participant Analyzer as llm/analysis.ts
    participant DB as analysis/analysis-db.ts
    participant Store as store.ts
    
    User->>CLI: code-insights insights
    CLI->>Cmd: insightsCommand()
    Cmd->>Parser: classifyUserMessage()
    Cmd->>Parser: extractSessionId()
    Cmd->>DB: getDb()
    DB->>Cmd: Database connection
    Cmd->>Cmd: isAlreadyAnalyzed()
    alt Already analyzed
        Cmd->>DB: Fetch existing insights
        DB->>Cmd: Return InsightRow[]
        Cmd->>Store: deduplicateByTitle()
    else Not analyzed
        Cmd->>Queue: enqueue()
        Queue->>Parser: buildSession()
        Parser->>Analyzer: analyzeSession()
        Analyzer->>DB: Load historical context
        Analyzer->>Analyzer: chunkMessages()
        Analyzer->>Analyzer: deduplicateByTitle()
        Analyzer->>DB: insertInsightsBatch()
        DB->>Store: Store new insights
    end
    Store->>User: Display insights
```

### Session Sync Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI
    participant Sync as sync.ts
    participant Parser as jsonl.ts
    participant DB as sync.ts
    participant Migrate as migrate.ts
    
    User->>CLI: code-insights sync
    CLI->>Sync: statusCommand() or runSync()
    Sync->>Parser: filterFilesToSync()
    Sync->>Sync: collect source files
    Sync->>DB: getDb()
    DB->>Sync: Database connection
    Sync->>DB: updateSyncState()
    loop For each file
        Sync->>Parser: extractSessionId()
        Sync->>Parser: extractProjectName()
        Sync->>Parser: buildSession()
        Sync->>DB: insertSessionWithProjectAndReturnIsNew()
        Sync->>DB: saveSyncState()
    end
    Sync->>DB: recalculateUsageStats()
    DB->>Sync: Return SyncResult
    Sync->>User: Display sync summary
```

### Export Generation Flow

```mermaid
sequenceDiagram
    participant User
    participant CLI
    participant Export as commands/export.ts
    participant API as server/src/index.ts
    participant DB as analysis/analysis-db.ts
    
    User->>CLI: code-insights export
    CLI->>Export: exportCommand()
    Export->>API: getExportGenerate()
    API->>DB: Query insights
    DB->>API: Return InsightRow[]
    API->>API: Format as markdown
    API->>DB: Save export state
    DB->>API: Persist export
    API->>Export: Return export result
    Export->>User: Display/download export
```

## Data Transformation Patterns

### Session → ParsedSession

```
Input: Raw session JSONL file
┌─────────────────────────────────────────────────────────┐
│ {                                                    │
│   "id": "session-123",                             │
│   "messages": [...],                                 │
│   "metadata": {                                     │
│     "provider": "claude-code",                      │
│     "timestamp": "2026-08-10T00:00:00Z",           │
│     "project": "my-project"                         │
│   }                                                   │
│ }                                                    │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ ParsedSession (jsonl.ts → buildSession)              │
│ {                                                    │
│   sessionId: string,                                 │
│   provider: ProviderType,                            │
│   projectName: string,                               │
│   messages: ParsedMessage[],                         │
│   metadata: SessionMeta,                             │
│   timestamp: Date,                                   │
│   character: string                                  │
│ }                                                    │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ InsightRow (store.ts → analysis)                    │
│ {                                                    │
│   sessionId: string,                                 │
│   title: string,                                     │
│   type: InsightType,                                 │
│   content: string,                                   │
│   evidence: string[],                                │
│   categories: string[],                              │
│   actionable: boolean,                               │
│   confidence: number,                                │
│   ...                                                │
│ }                                                    │
└─────────────────────────────────────────────────────────┘
```

### Message Chunking for Analysis

```
Full Session Messages
┌─────────────────────────────────────────────────────────┐
│ [msg1, msg2, msg3, ..., msgN]                          │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ chunkMessages() splits by:                             │
│ - Code blocks (preserved whole)                         │
│ - User/AI message boundaries                            │
│ - Token limits (~4000 tokens per chunk)                │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ [chunk1, chunk2, chunk3]                              │
│ Each chunk sent to LLM for analysis                    │
└─────────────────────────────────────────────────────────┘
```

### Deduplication Strategy

```
Input: Raw LLM analysis results
┌─────────────────────────────────────────────────────────┐
│ [insight1, insight2, insight3, ...]                      │
│   - Some may be duplicates                               │
│   - Some may be near-duplicates (similar titles)          │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ deduplicateByTitle() (store.ts)                         │
│ - Normalize titles (trim, lowercase)                     │
│ - Use Levenshtein distance for similarity                │
│ - Keep first occurrence, merge evidence                 │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ Deduplicated insights stored in database                  │
└─────────────────────────────────────────────────────────┘
```

## Recurring Insights Detection

```mermaid
sequenceDiagram
    participant Store as store.ts
    participant Recurring as recurring-insights.ts
    participant Vector as Vector Search
    participant LLM as LLM Analysis
    
    Store->>Recurring: findRecurringInsights()
    Recurring->>Vector: findRecurringInsightsByVector()
    Vector->>Vector: Build TF-IDF vectors
    Vector->>Vector: cosineSimilarity()
    Vector->>Recurring: Return similar insight groups
    alt LLM configured
        Recurring->>LLM: findRecurringInsightsByLLM()
        LLM->>Recurring: Return LLM-detected patterns
    else No LLM
        Recurring->>Vector: Fall back to vector only
    end
    Recurring->>Store: Return grouped insights
```

### Vector Similarity Flow

```
Input: N insights with content
┌─────────────────────────────────────────────────────────┐
│ For each insight:                                       │
│   1. Tokenize content                                    │
│   2. Build TF-IDF vector                                 │
│   3. Normalize vector                                   │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ Compare all pairs:                                      │
│   dotProduct(vecA, vecB)                                 │
│   cosineSimilarity(vecA, vecB)                           │
└─────────────────────────────────────────────────────────┘
                           ↓
┌─────────────────────────────────────────────────────────┐
│ Group insights with similarity > threshold (0.7)           │
│ Each group = recurring insight theme                     │
└─────────────────────────────────────────────────────────┘
```

## Queue Processing Flow

```mermaid
sequenceDiagram
    participant Queue as queue-worker.ts
    participant Worker
    participant Runner as MistralVibeRunner/others
    
    Queue->>Queue: spawnWorker()
    Queue->>Worker: Process queue items
    loop While queue not empty
        Worker->>Queue: Get next item
        Queue->>Worker: Return session ID
        Worker->>Runner: Process session
        Runner->>Runner: Extract session data
        Runner->>Runner: Analyze with LLM
        Runner->>Runner: Store results
        Worker->>Queue: Mark complete
    end
```

## Database Write Flow

```mermaid
sequenceDiagram
    participant Analyzer as llm/analysis.ts
    participant DB as getDb()
    participant Client as Database Client
    
    Analyzer->>DB: getDb()
    DB->>Client: Check singleton
    alt Singleton exists
        Client->>DB: Return existing
    else Create new
        Client->>Client: new Database()
        Client->>Client: Connect to SQLite
        Client->>DB: Store singleton
    end
    DB->>Analyzer: Return client
    Analyzer->>Client: insertInsightsBatch()
    Client->>Client: Prepare SQL
    Client->>Client: Execute transaction
    Client->>Analyzer: Return result
```

## Error Handling Flows

### Rate Limit Handling

```mermaid
sequenceDiagram
    participant Client as LLM Client
    participant LLM
    participant Limiter as Rate Limiter
    
    Client->>Limiter: Check rate limit
    Limiter->>Limiter: Check token bucket
    alt Under limit
        Limiter->>Client: Allow
        Client->>LLM: Send request
    else Over limit
        Limiter->>Client: Wait
        Client->>Client: Sleep until tokens available
        Client->>Limiter: Retry
    end
```

### Analysis Error Handling

```mermaid
sequenceDiagram
    participant Analyzer
    participant DB
    participant Store
    
    Analyzer->>DB: Begin transaction
    DB->>Analyzer: Transaction started
    Analyzer->>Analyzer: Try analyze
    alt Success
        Analyzer->>DB: insertInsightsBatch()
        Analyzer->>DB: Commit
    else Error
        Analyzer->>DB: Rollback
        Analyzer->>Store: Log error
        Analyzer->>Store: Mark session for retry
    end
```

---

*Generated by graphify + codebase-mapper. Last updated: 2026-08-10*
