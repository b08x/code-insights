# Database Layer Module

> Transformation contract for data persistence and retrieval

## Transformation Contract

**Input**: `InsightRow[]`, `ParsedSession`, usage metrics
**Process**: Store → Index → Query → Aggregate
**Output**: Structured data for dashboard and analysis

## Overview

The Database Layer handles all persistent storage for the code-insights system. It uses SQLite as the primary database with optional vector search capabilities via sqlite-vec.

## Architecture

```mermaid
flowchart TD
    subgraph DatabaseLayer["Database Layer"]
        DB[getDb()] -->|singleton| Client[Database Client]
        Client -->|execute| SQL
        
        subgraph Tables
            Insights[(insights)]
            Sessions[(sessions)]
            Projects[(projects)]
            Usage[(analysis_usage)]
            Sync[(sync_state)]
            Vectors[(vector_indexes)]
        end
        
        SQL --> Insights
        SQL --> Sessions
        SQL --> Projects
        SQL --> Usage
        SQL --> Sync
        SQL --> Vectors
    end
    
    Input[InsightRow[]] --> DB
    DB --> Output[Query Results]
    Output --> Dashboard
    Output --> AnalysisEngine
```

## Key Files

| File | Responsibility | Community | Nodes |
|------|---------------|-----------|-------|
| `cli/src/db/client.ts` | Database client | getDb | 30 |
| `cli/src/analysis/analysis-db.ts` | Insight storage | analysis/analysis-db.ts | 14 |
| `cli/src/analysis/analysis-usage-db.ts` | Usage tracking | Analysis Usage Database | 4 |
| `cli/src/db/migrate.ts` | Database migrations | Database Migration and Sync | 29 |
| `cli/src/sync.ts` | Session sync management | sync.ts | 22 |
| `cli/src/embeddings/store.ts` | Vector storage | SQLite Vector POC | 3 |

## Core Data Structures

### Database Schema

#### insights Table

```sql
CREATE TABLE insights (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,        -- learning, decision, outcome, friction, pattern, summary
  content TEXT NOT NULL,
  evidence TEXT,             -- JSON array of evidence strings
  categories TEXT,           -- JSON array of category strings
  actionable INTEGER,        -- 0 or 1
  confidence REAL,           -- 0.0 to 1.0
  metadata TEXT,            -- Structured JSON object (see below)
  created_at TEXT NOT NULL,  -- ISO timestamp
  updated_at TEXT NOT NULL
);
```

##### Structured `metadata` JSON Contracts

`insights.metadata` stores domain-specific attributes serialized as JSON:

**1. Decision Insights (`type = 'decision'`):**
```json
{
  "situation": "Context or technical situation demanding a choice",
  "choice": "Adopted technical approach",
  "reasoning": "Underlying justification",
  "alternatives": [
    { "option": "Alternative 1", "rejected_because": "Trade-off justification" }
  ],
  "trade_offs": "Compromises accepted",
  "revisit_when": "Trigger condition for reconsidering the decision",
  "evidence": ["User#1: ...", "Assistant#2: ..."],
  "decided_by": "user | agent | collaborative",
  "intent": "Initiating intent or user goal (optional)",
  "branch_point": "Critical bifurcation point or rejected design (optional)"
}
```
> **Note on `_reasoning` lifecycle:** During LLM generation, a transient `_reasoning` scratchpad is used by the model to ground attribution in turn citations (`User#N` vs `Assistant#N`). In `analysis-db.ts` (`convertToInsightRows`), this transient field is intentionally stripped prior to SQLite insertion to maintain lean relational storage.

**2. Summary Insights (`type = 'summary'`):**
```json
{
  "outcome": "success | partial | abandoned | blocked",
  "step_matrix": [
    {
      "step": "Configure build pipeline",
      "turn_ref": "User#1",
      "driver": "User_Decide",
      "target": "Target_Config",
      "state": "State_Success"
    }
  ]
}
```
The `step_matrix` contains 4–10 semantic episodes capturing major session milestones for Formal Concept Analysis (FCA) and concept lattice derivation.

#### sessions Table

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  project_name TEXT,
  project_path TEXT,
  session_title TEXT,
  character TEXT,
  timestamp TEXT NOT NULL,
  token_count INTEGER,
  message_count INTEGER,
  duration_seconds INTEGER,
  metadata TEXT,
  created_at TEXT NOT NULL
);
```

#### analysis_usage Table

```sql
CREATE TABLE analysis_usage (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  analysis_type TEXT NOT NULL,  -- insight, pq, recurring
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cost_real REAL,
  latency_ms INTEGER,
  created_at TEXT NOT NULL
);
```

#### session_steps Table (v15)

```sql
CREATE TABLE session_steps (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  turn_ref TEXT NOT NULL,
  label TEXT NOT NULL,
  driver TEXT NOT NULL,
  target TEXT NOT NULL,
  state TEXT NOT NULL,
  targets TEXT,
  has_course_correction INTEGER NOT NULL DEFAULT 0,
  ran_tests INTEGER NOT NULL DEFAULT 0,
  used_tools INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, idx)
);
CREATE INDEX idx_session_steps_session ON session_steps(session_id);
CREATE INDEX idx_session_steps_driver ON session_steps(driver);
CREATE INDEX idx_session_steps_state ON session_steps(state);
CREATE INDEX idx_session_steps_target ON session_steps(target);
```

#### deleted_sessions Table (v16)

```sql
CREATE TABLE deleted_sessions (
  id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT
);
CREATE INDEX idx_deleted_sessions_deleted_at ON deleted_sessions(deleted_at DESC);
```

The `deleted_sessions` table acts as a permanent tombstone registry. Whenever sessions are permanently purged (via `code-insights purge` or `code-insights sync prune --hard`), their IDs are recorded here. Ingestion guards in `sync.ts` and `write.ts` verify `isSessionTombstoned(id)` so that tombstoned sessions are never re-discovered or re-imported from raw disk log files during subsequent sync runs (including `code-insights sync --force`).

## Core Functions

### purgeSessions()

**Location**: `cli/src/db/purge.ts`

**Purpose**: Permanently purge soft-deleted or specific sessions and record their tombstone IDs

**Behavior**:
1. Identifies target sessions (all with `deleted_at IS NOT NULL` if no specific IDs passed, or specific ID list)
2. Records session IDs into `deleted_sessions` tombstone table
3. Cascades deletion across SQLite child tables (`insights`, `session_steps`, `session_facets`, `analysis_usage`, `messages`, `sessions`)
4. Guarantees that subsequent syncs permanently ignore these sessions without touching raw tool files on disk

**Signature**:
```typescript
function purgeSessions(
  options?: {
    sessionIds?: string[];
    reason?: string;
    db?: Database.Database;
  }
): PurgeResult;
```

### reprocessDatabase()

**Location**: `cli/src/db/reprocess.ts`

**Purpose**: Zero-cost local backfill and schema normalization without invoking LLM APIs

**Behavior**:
1. Unpacks `step_matrix` JSON from summary `insights.metadata` into relational `session_steps` (Schema v15)
2. Enriches step attributes with co-occurring flags (`ran_tests`, `used_tools`, `has_course_correction`, `targets`)
3. Attributes legacy decision insights lacking `decided_by` using evidence turn citations (`User#N` vs `Assistant#N`)
4. Normalizes facet friction categories to canonical formats
5. Rebuilds FTS5 full-text index for fast search

**Signature**:
```typescript
async function reprocessDatabase(
  options?: ReprocessOptions
): Promise<ReprocessStats>;
```


### getDb()

**Location**: `cli/src/db/client.ts`

**Purpose**: Get or create the singleton database connection

**Behavior**:
- Creates SQLite database connection on first call
- Returns existing connection on subsequent calls
- Handles connection errors gracefully

**Signature**:
```typescript
function getDb(): Database;
```

**Design Rationale**: Singleton pattern ensures:
- Consistent connection state across application
- Prevents connection leaks
- Enables transaction management
- Simplifies dependency injection

### saveInsightsToDb()

**Location**: `cli/src/analysis/analysis-db.ts`

**Purpose**: Persist insight rows to database

**Behavior**:
- Batches inserts for efficiency
- Handles conflicts (same session + title)
- Updates timestamps

**Signature**:
```typescript
async function saveInsightsToDb(
  insights: InsightRow[],
  db?: Database
): Promise<void>;
```

### saveInsightsToDbWithDedup()

**Location**: `cli/src/analysis/analysis-db.ts`

**Purpose**: Persist insights with automatic deduplication

**Behavior**:
1. Checks for existing insights with same title in same session
2. Skips duplicates
3. Updates existing if content differs
4. Inserts new insights

**Note** (EXTRACTED): Uses `getDb()` singleton internally for writes

**Signature**:
```typescript
async function saveInsightsToDbWithDedup(
  insights: InsightRow[],
  options?: SaveOptions
): Promise<DedupMetrics>;
```

### saveSessionStepsToDb()

**Location**: `cli/src/analysis/analysis-db.ts`

**Purpose**: Persist normalized semantic step episodes to the `session_steps` table

**Behavior**:
1. Deletes existing steps for `session_id` within a transaction to maintain idempotency
2. Inserts steps with 0-indexed order `idx`, `turn_ref`, `label`, canonical `driver`, `target`, `state`, JSON-stringified multi-target array `targets`, and boolean flags `has_course_correction`, `ran_tests`, `used_tools`

**Signature**:
```typescript
function saveSessionStepsToDb(
  sessionId: string,
  steps: SemanticStep[],
  db?: Database
): void;
```

### insertSessionWithProjectAndReturnIsNew()

**Location**: `cli/src/sync.ts`

**Purpose**: Insert session and return whether it was new

**Behavior**:
- Checks if session already exists
- Inserts new session
- Updates sync state
- Returns boolean indicating new vs existing

**Signature**:
```typescript
async function insertSessionWithProjectAndReturnIsNew(
  session: ParsedSession,
  syncState: SyncState
): Promise<boolean>;
```

### insertInsightsBatch()

**Location**: `cli/src/analysis/analysis-db.ts`

**Purpose**: Bulk insert insights efficiently

**Behavior**:
- Uses SQLite transaction
- Batches inserts in chunks
- Handles partial failures

**Signature**:
```typescript
async function insertInsightsBatch(
  insights: InsightRow[],
  db?: Database
): Promise<void>;
```

## Query Functions

### getSessionAnalysisUsage()

**Location**: `cli/src/analysis/analysis-usage-db.ts`

**Purpose**: Get analysis usage statistics for a session

**Note** (EXTRACTED): Uses `getDb()` singleton

**Signature**:
```typescript
async function getSessionAnalysisUsage(
  sessionId: string
): Promise<AnalysisUsageRow[]>;
```

### markInsightStale()

**Location**: `cli/src/analysis/analysis-db.ts`

**Purpose**: Mark an insight as stale (needs re-analysis)

**Note** (EXTRACTED): Uses `getDb()` singleton

**Signature**:
```typescript
async function markInsightStale(
  insightId: string,
  db?: Database
): Promise<void>;
```

## Migration System

### runMigrations()

**Location**: `cli/src/db/migrate.ts`

**Purpose**: Run database schema migrations

**Behavior**:
1. Checks current schema version
2. Runs pending migrations in order
3. Updates version tracking
4. Validates migration results

**Note**: Called by `initTestDb()` (surprising connection from test utilities)

**Signature**:
```typescript
async function runMigrations(
  db: Database
): Promise<void>;
```

## Vector Storage (sqlite-vec)

### Vector Tables

```sql
-- Created by sqlite-vec extension
CREATE VIRTUAL TABLE vec_insights USING vec0(
  content TEXT,
  vector FLOAT[1536]  -- embedding dimension
);
```

### Vector Operations

**Note** (EXTRACTED from `cli/src/embeddings/store.ts:81`):
```
// NOTE: sqlite-vec vec0 requires LIMIT on KNN queries.
```

**Functions**:
- `embed()` - Generate embeddings
- `vecToBlob()` - Convert vectors to SQLite storage format
- KNN search with LIMIT clause requirement

## Sync System

### updateSyncState()

**Location**: `cli/src/sync.ts`

**Purpose**: Update the sync state for a file

**Behavior**:
- Tracks last sync timestamp
- Records file hash for change detection
- Marks files as synced

**Signature**:
```typescript
async function updateSyncState(
  filePath: string,
  hash: string,
  db?: Database
): Promise<void>;
```

### recalculateUsageStats()

**Location**: `cli/src/sync.ts`

**Purpose**: Recalculate aggregate usage statistics

**Note** (EXTRACTED): Uses `getDb()` singleton

**Signature**:
```typescript
async function recalculateUsageStats(
  db?: Database
): Promise<void>;
```

## Indexes

### Performance Indexes

```sql
-- Session lookups
CREATE INDEX idx_sessions_project ON sessions(project_name);
CREATE INDEX idx_sessions_timestamp ON sessions(timestamp);

-- Insight lookups
CREATE INDEX idx_insights_session ON insights(session_id);
CREATE INDEX idx_insights_type ON insights(type);
CREATE INDEX idx_insights_created ON insights(created_at);

-- Usage tracking
CREATE INDEX idx_usage_session ON analysis_usage(session_id);
CREATE INDEX idx_usage_type ON analysis_usage(analysis_type);
```

## Transactions

All write operations use transactions for:
1. **Atomicity** - All or nothing
2. **Consistency** - Database remains valid
3. **Isolation** - Concurrent operations don't interfere
4. **Durability** - Changes persist after commit

## Error Handling

### Connection Errors
- Retry with exponential backoff
- Log errors for debugging
- Graceful degradation where possible

### Query Errors
- Validate SQL before execution
- Handle missing tables gracefully
- Provide meaningful error messages

### Constraint Errors
- Handle unique violations
- Handle foreign key violations
- Provide context for debugging

## Testing

Tests located in:
- `cli/src/analysis/__tests__/analysis-db.test.ts`
- `cli/src/analysis/__tests__/analysis-usage-db.test.ts`
- `cli/src/__fixtures__/db/seed.ts`

Key test utilities:
- `createTestDb()` - Create isolated test database
- `makeParsedSession()` - Create test session data
- `makeInsight()` - Create test insight data

---

*Generated by graphify + codebase-mapper. Last updated: 2026-08-10*
