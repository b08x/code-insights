# Implementation Plan: Long Context Retrieval

## Overview
Add retrieval-augmented analysis to code-insights, enabling long conversations to be analyzed via context-augmented text chunking with hybrid embedding retrieval. Both CLI (`insights check --analyze`) and server (`analyzeSession`) paths use a shared retrieval layer.

---

## Phase 1: Annotated Chunker (New Module)
**Files:** `cli/src/embeddings/annotated-chunker.ts` (new), `cli/src/types.ts`

### 1.1 Message-to-Exchange Grouping
- Parse `type` field from messages to group user+assistant+tools into logical exchanges
- Each exchange = one chunk unit (preserves conversational flow)
- Configurable grouping rules (role metadata as boundary signals)

### 1.2 Analytical Annotation
For each exchange, compute:
- `phase`: heuristic classifier — `"decision"` / `"debug"` / `"exploration"` / `"planning"` / `"execution"` / `"review"`
- `significance`: score based on presence of key signals (decisions, friction points, tool failures, long thinking chains)
- `related_to`: topic similarity to other chunks (optional, computed via TF-IDF or embedding cosine)
- `why_context`: compact string explaining why this chunk matters analytically

### 1.3 Parent/Child Splitting
- Use existing `chunkText()` with configured delimiters
- Parent: max 4000 chars, delimiters `\n\n, \n, ., ?, !, ,`
- Child: max 512 chars, delimiters `\n\n, \n, ., ?, !, ,`
- Each child inherits parent's annotations

### 1.4 Source Text Construction
- Annotated source = role label + phase + significance + why_context + raw content
- This is what gets embedded (not just raw content)

---

## Phase 2: Vector Store Extension
**Files:** `cli/src/embeddings/store.ts`, `cli/src/embeddings/schema.ts` (new)

### 2.1 New Table: `vec_analysis_chunks`
```sql
CREATE TABLE IF NOT EXISTS analysis_chunks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  parent_chunk_id TEXT,
  content TEXT NOT NULL,
  phase TEXT,
  significance TEXT,
  why_context TEXT,
  related_to TEXT,  -- JSON array of chunk IDs
  embedding_status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

-- vec virtual table for similarity search
CREATE VIRTUAL TABLE vec_analysis_chunks USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[768]  -- dimension from model
);
```

### 2.2 Query Functions
- `querySimilarAnalysisChunks(queryEmbedding, options)` — base similarity search
- `querySimilarAnalysisChunksFiltered(queryEmbedding, filters, options)` — with session/phase/significance filters
- `getAnalysisChunksBySession(sessionId)` — retrieve all chunks for a session

### 2.3 Backfill Integration
- Extend `backfillEmbeddings()` to support `entityType: 'analysis_chunk'`
- Or create separate `backfillAnalysisChunks()` function
- Embedding status tracking: `pending` → `computed` → `failed`

---

## Phase 3: Ingest-Time Embedding Pipeline
**Files:** `cli/src/embeddings/backfill.ts`, `server/src/routes/sessions.ts` (or ingest hook)

### 3.1 On-Ingest Chunking
When messages are ingested/synced:
1. Group messages into exchanges (Phase 1.1)
2. Annotate each exchange (Phase 1.2)
3. Split into parent/child chunks (Phase 1.3)
4. Embed child chunks immediately
5. Store in `vec_analysis_chunks` + metadata in `analysis_chunks`

### 3.2 Embedding Readiness Gate (Soft)
- Start embedding computation in parallel with analysis setup
- If embeddings are ready by the time LLM call starts → use retrieval
- If not ready → wait (block analysis, not user)
- Short sessions: embeddings compute fast enough to not block

### 3.3 Status Tracking
- `embedding_status` per chunk: `pending` | `computed` | `failed`
- `embedding_status` per session aggregate: enable/disable retrieval based on readiness

---

## Phase 4: Retrieval Layer (Shared)
**Files:** `cli/src/analysis/retrieval.ts` (new), `server/src/llm/retrieval.ts` (new, shared logic)

### 4.1 Threshold-Based Trigger
- Compute total token count of formatted conversation
- If < 80% of model context window → full fidelity (no retrieval)
- If >= 80% → retrieval mode
- Threshold configurable per model

### 4.2 Dynamic Query Construction
1. Generate session summary (compact: what happened, key decisions, outcomes)
2. Retrieve related past insights via existing `retrieveRelatedInsights()`
3. Combine: analysis instructions + session summary + related insights
4. Embed combined query → vector search against `vec_analysis_chunks`

### 4.3 Retrieval Execution
- Query `vec_analysis_chunks` with dynamic query vector
- Filter by current session (exclude self) or include cross-session for trends
- Rank by cosine similarity + significance weight
- Return top-K chunks (K configurable, default ~20)

### 4.4 Context Augmentation (Hybrid B+C)
For each retrieved chunk:
1. **Window augmentation**: prepend compact conversation summary + position tag (`"turn 12 of 45"`)
2. **Neighbor inclusion**: fetch ±1 adjacent chunks by `chunk_index`
3. **Deduplication**: collapse overlapping neighbors to control token cost
4. **Assembly**: ordered list of augmented chunks for prompt injection

### 4.5 Prompt Injection
- Modify `buildCacheableConversationBlock()` and analysis prompts
- Inject retrieved context block before formatted messages
- Label clearly: `## Retrieved Context (most relevant segments)` 
- Preserve existing fallback: if retrieval fails, fall back to naive chunking

---

## Phase 5: CLI Integration
**Files:** `cli/src/commands/insights.ts`

### 5.1 `runInsightsCommand()` Changes
- After `loadSessionMessages()`, check embedding readiness
- If soft gate: trigger parallel embedding computation, await readiness
- If threshold met: run retrieval pipeline (Phase 4)
- Inject retrieved context into `performAnalysis()` call

### 5.2 `performAnalysis()` Changes
- Accept optional `retrievedContext` parameter
- If provided, prepend to conversation block
- If not provided, use full conversation (existing behavior)

### 5.3 New CLI Command: `insights embeddings status`
- Show embedding status per session
- Show `vec_analysis_chunks` row counts
- Show missing/embedded/pending/failed breakdown

---

## Phase 6: Server Integration
**Files:** `server/src/llm/analysis.ts`

### 6.1 `analyzeSession()` Changes
- Replace naive `chunkMessages()` with retrieval-augmented path
- Threshold check: if conversation fits in context → full fidelity
- If not → run retrieval pipeline (shared logic from Phase 4)

### 6.2 Retrieval Config
- `getRetrievalConfig()` already exists — extend with:
  - `chunkAnnotationsEnabled: boolean`
  - `neighborInclusion: boolean`
  - `windowAugmentation: boolean`

### 6.3 Facet Pass (Unchanged)
- Facets remain separate pass with sampled summary
- No retrieval augmentation for facet extraction
- Facets stay output-only (not used as retrieval context)

---

## Phase 7: Testing
**Files:** `cli/src/embeddings/__tests__/annotated-chunker.test.ts`, `cli/src/analysis/__tests__/retrieval.test.ts`

### 7.1 Unit Tests
- Exchange grouping: verify role-boundary detection
- Annotation: verify phase/significance classification
- Parent/child splitting: verify delimiter behavior and max lengths
- Dynamic query construction: verify instruction + summary + insights combination

### 7.2 Integration Tests
- Full pipeline: ingest → annotate → embed → retrieve → augment → analyze
- Threshold behavior: short session (no retrieval) vs long session (retrieval)
- Fallback: verify graceful degradation when embeddings unavailable

### 7.3 Performance Tests
- Embedding latency per session (target: <2s for typical session)
- Retrieval latency (target: <500ms)
- Token overhead from augmentation (target: <15% of retrieved chunk tokens)

---

## Dependencies & Risks

### Dependencies
- Existing `chunkText()` function (reused for parent/child splitting)
- Existing `embedTexts()` function (reused for embedding)
- Existing `retrieveRelatedInsights()` (reused for cross-session context)
- Gemini embedding model (already configured)

### Risks
1. **Embedding latency at ingest** — may slow down message sync
   - Mitigation: async background job, don't block ingest
2. **Annotation quality** — heuristic phase/significance may be inaccurate
   - Mitigation: start with simple heuristics, iterate based on retrieval precision
3. **Token budget overflow** — augmentation + neighbors may exceed context window
   - Mitigation: strict token counting, dynamic K adjustment
4. **Cross-session retrieval noise** — retrieving chunks from other sessions may add irrelevant context
   - Mitigation: filter by project, recency, and significance threshold

---

## Success Criteria
- Long sessions (>80% context window) use retrieval instead of naive chunking
- Retrieved chunks carry analytical annotations (phase, significance, why_context)
- Context window utilization improves (less redundancy, more coverage)
- Retrieval latency <500ms, embedding latency <2s per session
- Existing short-session behavior unchanged (full fidelity)
- CLI and server paths produce consistent results
