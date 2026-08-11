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
  type TEXT NOT NULL,        -- learning, decision, outcome, friction, pattern
  content TEXT NOT NULL,
  evidence TEXT,             -- JSON array of evidence strings
  categories TEXT,           -- JSON array of category strings
  actionable INTEGER,        -- 0 or 1
  confidence REAL,           -- 0.0 to 1.0
  metadata TEXT,            -- JSON object
  created_at TEXT NOT NULL,  -- ISO timestamp
  updated_at TEXT NOT NULL
);
```

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

## Core Functions

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
