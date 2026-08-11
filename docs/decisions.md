# Design Decisions

> WHY/NOTE/HACK comments and architectural rationale extracted from the codebase

## Database Design Decisions

### Singleton Database Connection

**Decision**: Use `getDb()` as a singleton for database connections.

**Rationale** (EXTRACTED): 
- High betweenness centrality (0.040) - connects 10+ communities
- Ensures consistent connection management across the application
- Prevents connection leaks
- Enables transaction management across modules
- Simplifies dependency injection

**Impact**: `getDb()` is the #2 most connected node (65 edges) in the entire graph, making it a critical cross-community bridge.

**Files**: `cli/src/db/client.ts`, `cli/src/analysis/analysis-db.ts`

---

### SQLite Vector Limitations

**Decision**: Require LIMIT clause on KNN queries for sqlite-vec vec0.

**Rationale** (EXTRACTED from `cli/src/embeddings/store.ts:81`):
```
// NOTE: sqlite-vec vec0 requires LIMIT on KNN queries.
```

**Impact**: Ensures compatibility with sqlite-vec vector search functionality.

---

## Session Processing Decisions

### ParsedSession as Universal Bridge

**Decision**: Use `ParsedSession` as the central data structure for all session types.

**Rationale**: 
- Connects 12 different communities (rank #4 with 36 edges)
- Normalizes diverse session formats from multiple AI assistants
- Enables uniform processing regardless of source provider

**Providers Normalized**:
- Claude Code
- Mistral Vibe
- Copilot CLI
- Cursor
- OpenCode
- Codex
- Copilot (VS Code)

**Files**: `cli/src/parser/jsonl.ts`, `cli/src/parser/registry.ts`, `cli/src/types.ts`

---

### Bash/Shell Tool Handling

**Decision**: Special handling for bash/shell execution tools.

**Rationale** (EXTRACTED from `cli/src/parser/titles.ts:15`):
```
// NOTE: Bash/shell execution tools (Bash, run_in_terminal, copilot_runInTerminal,
```

**Impact**: Proper categorization and parsing of shell command executions.

---

## Optimization Engine Decisions

### GEPA Optimization Approach

**Decision**: Use Genetic Algorithm (GEPA) for prompt optimization.

**Rationale** (EXTRACTED from `cli/src/optimization/flow.ts:80`):
```
* NOTE: After calling applyOptimizedComponents(), the internal AxGen
```

**Key Components**:
- Student/Teacher prompt patterns
- Template-based prompt generation
- Multi-objective scoring
- Iterative refinement

**Files**: `cli/src/optimization/flow.ts`, `cli/src/optimization/prompts.ts`

---

## Deduplication Strategy

### Title-Based Deduplication

**Decision**: Deduplicate insights by title with fuzzy matching.

**Rationale** (EXTRACTED from test files):
```
// NOTE: saveInsightsToDbWithDedup uses getDb() singleton internally for writes
```

**Implementation**:
- `deduplicateByTitle()` in `store.ts`
- Uses Levenshtein distance for similarity detection
- Merges evidence from similar insights
- Keeps first occurrence

**Files**: `cli/src/analysis/store.ts`, `cli/src/analysis/analysis-db.ts`

---

## Testing Decisions

### Mock Database for Tests

**Decision**: Use mock database functions for testing.

**Rationale**:
- Isolated test environment
- Prevents test data from polluting production
- Enables deterministic test results

**Files**: `cli/src/__fixtures__/db/seed.ts`

---

## Architectural Patterns

### High Cohesion Communities

The following communities show strong internal connectivity (cohesion > 0.25):

| Community | Cohesion | Nodes | Pattern |
|-----------|----------|-------|---------|
| SQLite Vector POC | 0.83 | 3 | Focused experimental code |
| Hook Installation Tests | 0.60 | 4 | Tightly coupled test utilities |
| LLM Configuration Banner | 0.50 | 4 | UI configuration component |
| Insight Scoring Metrics | 0.34 | 13 | Metric calculation utilities |
| Browser Open Commands | 0.48 | 5 | Command utilities |

### Low Cohesion Communities (Refactoring Candidates)

The following communities show weak internal connectivity (cohesion < 0.10):

| Community | Cohesion | Nodes | Concern |
|-----------|----------|-------|---------|
| aggregation.ts | 0.07 | 92 | **Should be split** - too many responsibilities |
| Database Migration and Sync | 0.05 | 38 | **Should be split** - database vs sync logic |
| MessageBubble.tsx | 0.07 | 40 | **Should be split** - UI component too large |
| cn | 0.08 | 37 | Utility function overused |

**Suggested Refactoring**:
- Split `aggregation.ts` into smaller, focused modules
- Separate database operations from sync logic
- Break down `MessageBubble.tsx` into smaller components

---

## Provider Integration Decisions

### Multi-Provider Runner Architecture

**Decision**: Implement separate runner classes for each provider.

**Rationale**:
- `ClaudeNativeRunner` for Claude Code native format
- `MistralVibeRunner` for Mistral Vibe sessions
- `CodexNativeRunner` for Codex sessions
- `AntigravityNativeRunner` for Antigravity
- `NativeRunner` for Claude JSONL format

**Benefits**:
- Provider-specific parsing logic
- Consistent `ParsedSession` output
- Easy to add new providers

**Files**: `cli/src/analysis/*.runner.ts`

---

## Error Detection Patterns

### Rage Loop Detection

**Decision**: Implement heuristic-based rage loop detection.

**Rationale**: Identify when users are stuck in repeated, unproductive cycles.

**Implementation**:
- `detectRageLoopHeuristic()` in `loop-detector.ts`
- `RageLoopSignal` type for classification

**Files**: `cli/src/analysis/loop-detector.ts`

---

## Category Normalization

### Consistent Category Labels

**Decision**: Normalize insight and pattern categories to canonical values.

**Rationale**: Ensure consistent categorization across the application.

**Implementation**:
- `normalizeCategory()` for general categories
- `normalizeFrictionCategory()` for friction types
- `normalizePatternCategory()` for pattern types
- `normalizePromptQualityCategory()` for PQ categories

**Files**: 
- `cli/src/analysis/normalize-utils.ts`
- `cli/src/analysis/friction-normalize.ts`
- `cli/src/analysis/pattern-normalize.ts`
- `cli/src/analysis/prompt-quality-normalize.ts`

---

## Telemetry Decisions

### Event Tracking Strategy

**Decision**: Centralized event tracking via `trackEvent()`.

**Rationale**: 
- Single point for all analytics
- Consistent event format
- Easy to add new tracking points

**Impact**: `trackEvent()` is #3 most connected node (38 edges).

**Files**: `cli/src/utils/telemetry.ts`

---

## UI Decisions

### Tailwind CSS ClassName Utility

**Decision**: Use `cn()` utility for className merging.

**Rationale**: 
- Most connected node in graph (112 edges, rank #1)
- Centralizes Tailwind class merging logic
- Used across all UI components

**Files**: `dashboard/src/lib/utils.ts`

---

## Open Questions from Graph

The knowledge graph suggests investigating:

1. **Should `aggregation.ts` be split into smaller, more focused modules?**
   - Cohesion score: 0.07 - nodes are weakly interconnected

2. **Should `Database Migration and Sync` be split into smaller, more focused modules?**
   - Cohesion score: 0.05 - nodes are weakly interconnected

3. **Should `MessageBubble.tsx` be split into smaller, more focused modules?**
   - Cohesion score: 0.07 - nodes are weakly interconnected

4. **What connects the 357 weakly-connected nodes to the rest of the system?**
   - These have ≤1 connection - possible missing edges or undocumented components

5. **How does `getDb()` maintain consistency across 10+ communities?**
   - Singleton pattern prevents connection leaks

6. **Why is `cn()` used in 14 different communities?**
   - Reflects unified styling approach across dashboard

7. **How does `ParsedSession` bridge 12 communities?**
   - Normalizes diverse session formats into common structure

---

*Generated by graphify + codebase-mapper. Last updated: 2026-08-10*
