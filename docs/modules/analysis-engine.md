# Analysis Engine Module

> Transformation contract and architecture for the insight analysis engine

## Transformation Contract

**Input**: `ParsedSession` objects from various AI assistant providers
**Process**: Unified analysis pipeline orchestrating RAG context, prompt resolution, runner execution, SFL dimension scoring, FCA step extraction, and provenance recording
**Output**: `AnalysisResult`, `InsightRow[]`, `SessionFacets` - structured, categorized, deduplicated insights and session aggregates

## Overview

The Analysis Engine is the core module responsible for transforming raw session data into actionable insights. It consists of several sub-components working together:

- **pipeline.ts** - Unified analysis pipeline orchestrating RAG context, prompt resolution, and runner execution
- **runner-selection.ts** - Precedence-based runner selection and scoped model/variant rules
- **opencode-runner.ts** - Headless OpenCode CLI runner with stdin piping, tmpdir isolation, and token extraction
- **native-runner.ts** - API-based model runner (also includes codex-runner.ts, antigravity-runner.ts, mistral-vibe-runner.ts, provider-runner.ts)
- **analysis-db.ts** - Insight & facet persistence with deduplication and provenance invariance
- **queue-worker.ts** - Background job processing with `IdentityMismatchError` retry handling

## Key Files

| File | Responsibility |
|------|---------------|
| `pipeline.ts` | Unified analysis pipeline |
| `runner-selection.ts` | Runner selection rules |
| `opencode-runner.ts` | OpenCode CLI headless runner |
| `native-runner.ts` | API-based model runner |
| `analysis-db.ts` | Insight persistence with provenance invariance |
| `queue-worker.ts` | Background job processing |

## Architecture

```mermaid
flowchart TD
    subgraph AnalysisEngine["Analysis Engine"]
        A[pipeline.ts] -->|selectRunner| B[runner-selection.ts]
        B --> C{Runner Type}
        C -->|OpenCode| D[opencode-runner.ts]
        C -->|Native/API| E[native-runner.ts]
        D --> F[analysis-db.ts]
        E --> F
    end
    
    Input[ParsedSession] --> A
    F -->|deduplicate| Output[InsightRow[], SessionFacets]
```

## Core Functions

### runAnalysisPipeline()

**Location**: `cli/src/analysis/pipeline.ts`

**Transformations**:
1. Resolves prompts and model configurations
2. Selects appropriate runner via `runner-selection.ts`
3. Executes LLM runner
4. Extracts insights, SFL dimensions, and FCA steps
5. Records provenance

### deduplicateByTitle() and Provenance Invariance

**Location**: `cli/src/analysis/analysis-db.ts`

**Transformations**:
1. Normalizes titles (trim, lowercase)
2. Compares using Levenshtein distance
3. Merges evidence from similar insights
4. **Provenance Invariance**: Preserves original `student_identity` and `prompt_version_id` on merged insights.

## Queue Worker and Error Semantics

The background job processor (`queue-worker.ts`) handles session analysis tasks. If an `IdentityMismatchError` occurs (e.g. runner/prompt changes mid-queue), the queue will safely retry the semantics, avoiding corrupted or incorrectly attributed provenance.

## Data Flow

```
ParsedSession
    ↓
[runAnalysisPipeline]
    ↓
Runner Selection (opencode, native, codex, etc.)
    ↓
LLM Execution
    ↓
Raw Insight Results
    ↓
[saveInsightsToDbWithDedup]
    ↓
Deduplicated InsightRow[], SessionFacets
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

### 5. Subscription Pricing & Pay-As-You-Go Cost Correlation (`plans.ts`, `aggregation.ts`)
The analytics engine models the duality between flat-rate subscriptions and pay-as-you-go API consumption:
- **Plan Registry**: Configurable subscription tiers (`Google AI Premium / Antigravity` at $19.99/mo, `Claude Pro` at $21.00/mo, `Mistral Pro` at $14.99/mo) and unmetered/pay-as-you-go fallbacks.
- **Spend Allocation**: Allocates flat subscription fees proportionally across queried analysis periods (e.g. 30 days = 100% monthly fee) while capturing pay-as-you-go charges directly.
- **API Value & Compute Leverage**: Correlates actual session tokens against public model pricing tables to calculate Pay-As-You-Go API value, absorbed value (`API Value - Actual Spend`), and compute leverage multipliers (`API Value / Actual Spend`), quantifying unmetered exploration and tooling runway.
- **Antigravity Estimation**: Uses token estimation from transcript and message contents based on Gemini 2.0 Flash pricing to establish baseline API value.

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
- `cli/src/utils/__tests__/plans.test.ts`
- `cli/src/commands/stats/__tests__/`

Key test files:
- `plans.test.ts` - Subscription matching, period spend calculation, and ROI metrics
- `retrieval-integration.test.ts` - Integration tests
- `dedup.test.ts` - Deduplication tests
- `loop-detector.test.ts` - Rage loop detection

## Metrics

The engine tracks:
- Analysis latency per session
- Insights generated per session
- Deduplication rate
- Category distribution
- Subscription plan spend, pay-as-you-go API equivalents, and net plan savings

---

*Generated by graphify + codebase-mapper. Last updated: 2026-09-28*
