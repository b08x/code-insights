# Chunking + RRF Retrieval — Extraction Blueprint

Traced from code-insights (graph index `home-b08x-WorkspaceV3-code-insights`) for reuse in another app.

## 1. Component map

| Concern | File | Symbol |
|---|---|---|
| Text normalization | `cli/src/embeddings/chunker.ts` | `preprocessText` |
| Recursive chunking | `cli/src/embeddings/chunker.ts:12` | `chunkText(text, maxLength, delimiters)` |
| Parent/child chunk pipeline | `cli/src/embeddings/backfill.ts:131` | `backfillEmbeddings` |
| Vector store + chunk→entity rollup | `cli/src/embeddings/store.ts:109` | `querySimilar` |
| RRF fusion (2-way, entity-level) | `cli/src/commands/search.ts:131` | `queryCommand` |
| RRF fusion (3-way, session-level) | `server/src/routes/agent.ts:46` | `onMemoriesSearch` |
| Schema | `cli/src/db/schema.ts:126,157` | `embedding_metadata`, `entity_chunks` |
| FTS5 index + sync triggers | `cli/src/db/migrate.ts:297,337` | `messages_fts` (v12, v13) |

## 2. Chunking strategy

Recursive delimiter descent. Delimiter priority `['\n\n','\n','.','?','!',',',' ']`; within a
`maxLength` window take the *last* occurrence of the highest-priority delimiter present, include the
delimiter in the chunk, advance. No delimiter → hard cut at `maxLength`. Character-based, not token-based.

Two-level (parent/child) indexing in `backfill.ts`:
- `PARENT_CHUNK_MAX = 4000` → row in `entity_chunks`, id `${entityId}_p${i}`
- `CHILD_CHUNK_MAX = 512` → embedded, id `${parentId}_c${j}`, `embedding_metadata.parent_chunk_id` links back

Embed small (precision), retrieve/return large (context). Child embedding batches sized by
`config.batchSize`; vector table dim is lazily created from the first embedding result
(`ensureVectorTableWithDim`).

## 3. RRF fusion

Constant `k = 60` in both implementations. Score per candidate: `Σ 1/(k + rank_i + 1)` over each
retriever that returned it. No per-retriever weighting.

Retrievers:
1. **BM25** — FTS5 `MATCH`, `ORDER BY bm25(...) ASC` (lower is better), `LIMIT 20`.
2. **Vector KNN** — sqlite-vec `embedding MATCH ? ORDER BY distance`, `LIMIT topK*10`, then
   dedupe chunk→entity keeping the nearest chunk per entity (this is the over-fetch that makes
   child-chunk embedding safe).
3. **SQL LIKE fallback** (`agent.ts` only) — AND-ed `LIKE` across session metadata columns; additive,
   not conditional on BM25 failing.

Fusion is done in JS over a `Map<id, score>`, not in SQL. Ranks are list positions, so the three
retrievers need no score normalization — that is the whole reason RRF is used here.

## 4. Reuse notes for a new app

Portable as-is: `chunker.ts` (zero dependencies), the RRF `Map` reduce, the chunk→entity dedupe in
`querySimilar`, the `embedding_metadata` / `entity_chunks` schema pair.

App-specific, must be replaced: entity type union `'insight' | 'message'`, source-text builders
(`insightSourceText`, `messageSourceText`), FTS5 column list and triggers, the Ollama client.

Known rough edges to fix on transplant:
- `chunkText` is character-based; a token-based cap is more accurate for embedding models with a
  real token limit.
- `agent.ts` docstring says "top 2 sessions per query" but the code slices `.slice(0, 1)`.
- `search.ts` `queryCommand` passes the raw query to FTS5 `MATCH`; `agent.ts` sanitizes via
  `buildSafeFtsQuery` (quote-escape + phrase-wrap). Use the sanitizing path everywhere.
- `k = 60` and the `LIMIT 20` / `topK*10` fan-outs are hardcoded; make them config.
