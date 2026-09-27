# Fact Sheet: Long Context Retrieval

## Scope
- **CLI + Server** — shared retrieval layer, both paths use the same analysis prompts and should produce consistent results.
- Server path already has `chunkMessages()` (naive token-based splitting) and `retrieveRelatedInsights()` (RAG via `vec_insights`). CLI path sends entire conversation raw with no chunking.

## Chunking Strategy
- **Role-boundary exchanges** — user+assistant+tools as a unit, preserving conversational flow.
- **Parent/child chunking** matching existing backfill parameters:
  - Parent: delimiters `\n\n, \n, ., ?, !, ,` / max_length 4000
  - Child: delimiters `\n\n, \n, ., ?, !, ,` / max_length 512
- **Analytically annotated** — each chunk carries metadata:
  - `phase: "decision"` / `"debug"` / `"exploration"` / `"planning"` etc.
  - `significance: "high"` / `"medium"` / `"low"` (contains key decision, friction point, pattern)
  - `related_to: [chunk IDs]` (topic relationships)
  - `why_context`: reason this chunk matters analytically

## Embedding Timing
- **At ingest time** — chunks are embedded immediately when messages are ingested/synced, so they're instantly searchable.
- Chunks are **persistent** (not ephemeral) — stored for cross-session trend analysis.

## Retrieval Strategy
- **Option C: Annotated chunks + dynamic query** — query = analysis instructions + session summary + related past insights.
  - Query adapts per session (moving target, resists shortcut learning)
  - Session summary provides context-specific grounding
  - Past insights prevent duplicate coverage
- **Threshold-based retrieval trigger** — short conversations get full fidelity, long ones get retrieval. Threshold TBD (likely ~80% of context window).

## Context Augmentation
- **Hybrid B+C**: window augmentation (compact conversation summary + position tag) + neighbor inclusion (±1 adjacent chunks for flow continuity).
  - Position tags provide global orientation ("turn 12 of 45")
  - Neighbors preserve local sequential flow
  - Deduplication of overlapping neighbors to control token cost

## Facet Strategy
- **Separate pass with sampled summary** (existing pattern) — facets are holistic, can't be chunked.
- Facets stay **output-only** for now — not used as retrieval context.

## Embedding Readiness Gate
- **Soft gate** — compute embeddings in parallel, proceed with analysis once ready. If embeddings aren't ready by the time the LLM call starts, wait. No blocking for short sessions.

## Fallback / Graceful Degradation
- **Block until embeddings are ready** — no degraded mode. Analysis quality depends on retrieval, so waiting is preferable to silent failure.

## Vector Store Design
- **New `vec_analysis_chunks` table** — separate from `vec_messages`.
  - Structurally different from raw messages (annotated, role-grouped, parent/child)
  - Clean separation avoids schema drift
  - `vec_messages` remains for backward compatibility / raw message use cases
