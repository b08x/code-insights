# Analysis Engine Module

> Transformation contract and architecture for the insight analysis engine

## Transformation Contract

**Input**: `ParsedSession` objects from various AI assistant providers
**Process**: LLM-powered insight extraction with deduplication and categorization
**Output**: `InsightRow[]` - structured, categorized, deduplicated insights

## Overview

The Analysis Engine is the core module responsible for transforming raw session data into actionable insights. It consists of several sub-components working together:

- **llm/analysis.ts** - Core analysis logic
- **store.ts** - Insight storage and deduplication
- **aggregation.ts** - Aggregated statistics and metrics
- **recurring-insights.ts** - Pattern detection across sessions

## Key Files

| File | Responsibility | Degree |
|------|---------------|--------|
| `llm/analysis.ts` | Session analysis with LLM | 30 nodes |
| `store.ts` | Insight storage and deduplication | 56 nodes |
| `aggregation.ts` | Aggregated statistics | 92 nodes |
| `recurring-insights.ts` | Cross-session pattern detection | 16 nodes |

## Architecture

```mermaid
flowchart TD
    subgraph AnalysisEngine["Analysis Engine"]
        A[llm/analysis.ts] -->|analyzeSession| B[store.ts]
        B -->|deduplicateByTitle| C[aggregation.ts]
        C -->|findRecurringInsights| D[recurring-insights.ts]
    end
    
    Input[ParsedSession] --> A
    D --> Output[InsightRow[]]
```

## Core Functions

### analyzeSession()

**Location**: `cli/src/llm/analysis.ts`

**Transformations**:
1. Loads historical context from database
2. Chunks messages for LLM processing
3. Extracts insights from each chunk
4. Deduplicates by title
5. Returns structured insight rows

**Signature**:
```typescript
async function analyzeSession(
  session: ParsedSession,
  options: AnalysisOptions
): Promise<AnalysisResult>
```

### deduplicateByTitle()

**Location**: `cli/src/analysis/store.ts`

**Transformations**:
1. Normalizes titles (trim, lowercase)
2. Compares using Levenshtein distance
3. Merges evidence from similar insights
4. Keeps first occurrence

**Signature**:
```typescript
function deduplicateByTitle(
  insights: InsightRow[],
  threshold?: number
): InsightRow[]
```

### chunkMessages()

**Location**: `cli/src/llm/analysis.ts`

**Transformations**:
1. Preserves code blocks as whole units
2. Respects user/AI message boundaries
3. Enforces token limits (~4000 per chunk)
4. Handles large sessions efficiently

**Signature**:
```typescript
function chunkMessages(
  messages: ParsedMessage[],
  maxTokens: number = 4000
): ParsedMessage[][]
```

## Data Flow

```
ParsedSession
    ↓
[analyzeSession]
    ↓
Message Chunks (via chunkMessages)
    ↓
LLM Analysis per Chunk
    ↓
Raw Insight Results
    ↓
[deduplicateByTitle]
    ↓
Deduplicated InsightRow[]
    ↓
Database Storage (via saveInsightsToDbWithDedup)
```

## Dependencies

### Internal Dependencies
- `getDb()` - Database connection
- `trackEvent()` - Telemetry
- `ParsedSession` - Session data structure

### External Dependencies
- LLM providers (configurable via `createClientFromConfig()`)
- SQLite database

## Configuration

### AnalysisOptions

```typescript
interface AnalysisOptions {
  model?: string;           // LLM model to use
  temperature?: number;     // Creativity level
  maxTokens?: number;      // Token limit per response
  retrievalConfig?: RetrievalConfig;  // Context retrieval settings
}
```

### RetrievalConfig

```typescript
interface RetrievalConfig {
  enabled: boolean;
  maxContext: number;
  similarityThreshold: number;
}
```

## Insight Types

The system categorizes insights into several types:

| Type | Description | Category |
|------|-------------|----------|
| `learning` | New knowledge acquired | Knowledge |
| `decision` | Decision made with driver attribution (`user` \| `agent` \| `collaborative`) | Decision |
| `summary` | Session summary milestone containing 4–10 step semantic incidence matrix | Summary |
| `outcome` | Result/outcome achieved | Outcome |
| `friction` | Problem or obstacle | Friction |
| `pattern` | Recurring pattern | Pattern |

## Decision Attribution & Semantic Step Matrix Pipeline / SFL

### 1. Decision Driver Attribution (`prompts.ts`)
The analysis engine categorizes decision agency to distinguish autonomous AI decisions from user instructions and co-designed choices:
- **`decided_by`**:
  - `'user'`: Decisions explicitly commanded or instructed by the user (`User#N` turn citations).
  - `'agent'`: Architectural or technical choices proposed and executed by the AI (`Assistant#N` turn citations).
  - `'collaborative'`: Co-designed choices converged upon jointly (both `User#N` and `Assistant#N` citations).
- **`intent`**: Initiating intent or user goal that prompted the decision.
- **`branch_point`**: Critical bifurcation point or alternative design branched away from.
- **Attribution Grounding (`_reasoning`)**: The prompt enforces a transient `_reasoning` scratchpad field during generation where the LLM quotes turn citations before outputting the decision. This field is stripped before database persistence in `analysis-db.ts` to keep storage lean.

### 2. Semantic Step Matrix (`step_matrix`)
Prompt Rule 7 extracts a compact semantic incidence matrix (4–10 major session episodes) structured as `SemanticStep`:
- `step`: Concise episode milestone name (e.g. `"Setup Vite config"`).
- `turn_ref`: Turn citation anchor (e.g. `"User#1"`, `"Assistant#2"`).
- `driver`: `LLM_Decide` | `User_Decide` | `Collab_Decide`.
- `target`: `Target_Config` | `Target_SrcCode` | `Target_Test` | `Target_Docs`.
- `state`: `State_Success` | `State_Error` | `State_Blocked`.

### 3. Response Normalization (`response-parsers.ts`)
The response parser applies fuzzy canonicalization across all semantic step dimensions:
- Driver aliases (`agent`, `ai`, `llm` → `LLM_Decide`; `user`, `human` → `User_Decide`; `collab` → `Collab_Decide`).
- Target aliases (`config`, `infra`, `env` → `Target_Config`; `test`, `spec` → `Target_Test`; `doc`, `readme` → `Target_Docs`; `src`, `code` → `Target_SrcCode`).
- State aliases (`err`, `fail` → `State_Error`; `block`, `wait` → `State_Blocked`; `succ`, `ok`, `pass` → `State_Success`).

The parsed `step_matrix` is stored in the `summary` insight's `metadata` field, feeding downstream Formal Concept Analysis (`GET /api/export/session/:id/fca`) and ActiveRecord Rails exports (`GET /api/export/session/:id/rails`).

### 4. SFL & Schema Synchronization (`schemas/`)
- **SFL-Compliant Prompt Structure**: Prompts now feature explicit `<task>` extraction boundaries and validation rules (acceptance criteria) for outputs including tri-stratal SFL breakdowns for findings and takeaways (Ideational/Field, Interpersonal/Tenor, Textual/Mode).
- **Schema Synchronization**: Schema definitions are actively synchronized between TypeScript types (`prompt-types.ts`) and JSON schemas (`prompt-quality.json`, `session-analysis.json`).

## Quality Metrics

Each insight is scored on:

1. **Confidence**: 0-1 scale based on LLM certainty
2. **Actionable**: Boolean - can user act on this?
3. **Evidence**: Array of supporting message excerpts

## Performance Considerations

1. **Chunking Strategy**: Messages are chunked to stay within LLM context limits
2. **Deduplication**: Reduces storage and display of duplicate insights
3. **Caching**: Historical context loaded once per session
4. **Parallel Processing**: Multiple chunks analyzed concurrently

## Testing

Tests located in:
- `cli/src/analysis/__tests__/`

Key test files:
- `retrieval-integration.test.ts` - Integration tests
- `dedup.test.ts` - Deduplication tests
- `loop-detector.test.ts` - Rage loop detection

## Metrics

The engine tracks:
- Analysis latency per session
- Insights generated per session
- Deduplication rate
- Category distribution

---

*Generated by graphify + codebase-mapper. Last updated: 2026-08-10*
