# Search & Retrieval Pipeline Architecture

## Overview

Code Insights implements a multi-strategy search system combining keyword-based full-text search, vector similarity search, and hybrid fusion to retrieve sessions, messages, and insights.

## Pipeline Summary

| Pipeline | Target | Strategy | Entry Point |
|----------|--------|----------|-------------|
| Keyword Search | Messages | SQLite FTS5 BM25 | `cli/src/commands/search.ts:searchCommand` |
| Vector Search | Messages | sqlite-vec KNN | `cli/src/commands/search.ts:vsearchCommand` |
| Hybrid Search | Messages | RRF(BM25 + KNN) | `cli/src/commands/search.ts:queryCommand` |
| Embedding Search | Insights | sqlite-vec KNN | `cli/src/commands/embeddings.ts:embeddingsSearchCommand` |
| API Search | Sessions + Insights | SQL LIKE | `server/src/routes/search.ts` |
| Analysis Retrieval | Insights | Vector similarity | `server/src/llm/analysis.ts:getRetrievalConfig` |
| Agent RAG Memory | Messages + Transcripts | Hybrid RRF (BM25 + KNN) | `server/src/routes/agent.ts:onMemoriesSearch` |

---

## CLI Pipelines

### 1. Keyword Search (BM25)

```
User Query → FTS5 MATCH → bm25() scoring → rowid lookup → message fetch
```

- **Target:** `messages_fts` virtual table
- **Scoring:** BM25 (lower = better match)
- **Limit:** Configurable `--top-k` (default: 5)
- **No embedding required** — pure text search

```typescript
// cli/src/commands/search.ts:43-48
db.prepare(`
  SELECT rowid, bm25(messages_fts) as score
  FROM messages_fts
  WHERE messages_fts MATCH ?
  ORDER BY score
  LIMIT ?
`).all(query, topK)
```

### 2. Vector Search (KNN)

```
User Query → Ollama embedOne → querySimilar() → distance sort → message fetch
```

- **Embedding:** Ollama model (configurable via `--model`)
- **Storage:** `sqlite-vec` extension loaded at runtime
- **Table:** `message_embeddings`
- **Similarity:** `1 / (1 + distance)` (cosine distance → similarity score)

```typescript
// cli/src/embeddings/store.ts:84-96
db.prepare(`
  SELECT id, distance FROM message_embeddings
  WHERE embedding MATCH ? ORDER BY distance LIMIT ?
`).all(vecToBlob(queryVector), topK)
```

### 3. Hybrid Search (RRF Fusion)

```
User Query ─┬─→ BM25 (top 20) → rank list ─┐
             └─→ KNN  (top 20) → rank list ─┼─→ RRF merge → top-K results
                                             │
                                     Σ 1/(k + rank)
                                     k = 60
```

- **Algorithm:** Reciprocal Rank Fusion
- **Both retrievers run independently** — results merged by document ID
- **RRF score:** Sum of `1/(60 + rank)` from each ranker
- **Advantage:** Combines lexical precision with semantic recall

```typescript
// cli/src/commands/search.ts:176-187
const sorted = Array.from(rrfScores.entries())
  .sort((a, b) => b[1].rrf - a[1].rrf)
  .slice(0, topK)
```

### 4. Embedding Search (Insights)

```
User Query → Ollama embedOne → querySimilar(db, 'insight', ...) → insight fetch
```

- **Target:** `insight_embeddings` table (not messages)
- **Use case:** Find semantically similar past insights for analysis context
- **Same vector pipeline** as message search, different entity type

---

## Server API Pipeline

### GET /api/search

```
HTTP GET /api/search?q=<query>&limit=20
         │
         ├─→ Sessions: LIKE search on title/summary/project/branch
         └─→ Insights: LIKE search on title/content/summary
                    │
                    └─→ buildSnippet() → context window around match
```

- **No FTS or vector index** — uses SQL `LIKE` with escaped wildcards
- **Searches across:** sessions (5 columns) + insights (3 columns)
- **Snippet extraction:** Centers a 120-char window on the first match
- **Response:** `{ sessions: SearchSession[], insights: SearchInsight[] }`

### Agent RAG Memory Search (onMemoriesSearch)

```
User Query ─┬─→ BM25 messages_fts (top 50) → rank list ─┐
            │                                            │
            └─→ KNN vec_insights (top 20) → rank list ─┼─→ RRF merge → sort
                                                         │
                                        extract top-2 sessions
                                                         │
                                      fetch full session transcripts
                                      (up to 50 messages each)
```

- **Algorithm:** Reciprocal Rank Fusion (k=60)
- **Transcripts Extracted:** Extracts the complete conversational transcript for the top-2 scoring sessions to provide the agent with deep context rather than fragmented snippets.
- **Citation Tracking:** Triggered subsequently by `onUsedMemories` if the LLM uses the information.

---

## Analysis Retrieval

### RetrievalConfig

```typescript
// server/src/llm/analysis.ts:297-320
interface RetrievalConfig {
  enabled: boolean;        // Enable/disable retrieval augmentation
  topK: number;            // Number of similar insights to retrieve
  similarityThreshold: number;  // Minimum similarity score
  sameProjectOnly: boolean;     // Filter to same project
}
```

**Purpose:** Enriches LLM prompts with relevant past insights during analysis.

**Configuration path:** `config.dashboard.analysis.retrieval`

**Flow:**
```
analyzeSession()
  → getRetrievalConfig()
    → loadConfig() → config.dashboard.analysis.retrieval
  → embed session content
  → querySimilar(db, 'insight', vector, topK)
  → filter by similarityThreshold + sameProjectOnly
  → inject into LLM prompt context
```

---

## Vector Infrastructure

### sqlite-vec Integration

```typescript
// cli/src/embeddings/store.ts
loadVectorExtension(db)  // Loads sqlite-vec binary extension
vecToBlob(vector)        // Float32Array → Buffer for storage
querySimilar(db, entityType, queryVector, topK)  // Generic KNN query
```

### Entity Type Mapping

| Entity | Embedding Table | Content Source |
|--------|-----------------|----------------|
| `message` | `message_embeddings` | Message content |
| `insight` | `insight_embeddings` | Insight title + summary |

### Embedding Generation

- **Provider:** Ollama (local or remote)
- **Functions:** `embedOne()`, `embedBatch()`, `embedTexts()`
- **Rate limiting:** `createRateLimiter()` for batch operations
- **Backfill:** `code-insights embeddings backfill --entity messages|insights`

---

## Data Flow Diagrams

### Search Request Flow

```
┌─────────────┐
│  CLI Query   │
└──────┬──────┘
       │
       ▼
┌──────────────┐     ┌──────────────┐
│ search       │     │ vsearch      │
│ (BM25 only)  │     │ (vector only)│
└──────┬───────┘     └──────┬───────┘
       │                     │
       │              ┌──────▼───────┐
       │              │ embed query  │
       │              │ (Ollama)     │
       │              └──────┬───────┘
       │                     │
       │              ┌──────▼───────┐
       │              │ querySimilar │
       │              │ (sqlite-vec) │
       │              └──────┬───────┘
       │                     │
       ▼                     ▼
┌──────────────────────────────────┐
│         queryCommand            │
│     (Hybrid RRF Fusion)         │
│  BM25 top-20 + KNN top-20      │
│  → RRF merge → top-K results   │
└──────────────────────────────────┘
```

### Analysis Retrieval Flow

```
┌─────────────────┐
│ analyzeSession  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ getRetrieval    │
│ Config          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌──────────────┐
│ embed session   │────▶│ Ollama       │
│ content         │     │ embedOne()   │
└────────┬────────┘     └──────────────┘
         │
         ▼
┌─────────────────┐
│ querySimilar    │
│ (insight table) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ filter by       │
│ threshold +     │
│ project scope   │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ inject into     │
│ LLM prompt      │
└─────────────────┘
```

---

## Schema Dependencies

### Tables

- `messages` — source content with FTS5 index
- `messages_fts` — virtual table for BM25 search
- `message_embeddings` — sqlite-vec vector storage
- `insights` — analyzed insights
- `insight_embeddings` — sqlite-vec vector storage
- `sessions` — session metadata (searched by API)

### Extensions

- `sqlite-vec` — vector similarity search (loaded at runtime via `loadVectorExtension()`)

---

## Configuration

### Embedding Config

```typescript
// cli/src/commands/search.ts:11-17
buildEmbeddingConfig({ model?: string })
// Returns: { model: string, baseUrl?: string }
// Default model from config or environment
```

### Retrieval Config

```yaml
# config.yaml
dashboard:
  analysis:
    retrieval:
      enabled: true
      topK: 5
      similarityThreshold: 0.3
      sameProjectOnly: true
```

---

## Key Files

| File | Purpose |
|------|---------|
| `cli/src/commands/search.ts` | CLI search commands (keyword, vector, hybrid) |
| `cli/src/commands/embeddings.ts` | Embedding search for insights |
| `cli/src/embeddings/store.ts` | Vector storage and KNN queries |
| `cli/src/embeddings/ollama-client.ts` | Ollama embedding client |
| `server/src/routes/search.ts` | API search endpoint (LIKE-based) |
| `server/src/llm/analysis.ts` | Analysis retrieval config |
| `cli/src/db/migrate.ts` | Schema migrations (FTS + vector tables) |
