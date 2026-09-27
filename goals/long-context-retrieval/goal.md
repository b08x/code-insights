# Goal: Long Context Retrieval

## Summary
Implement retrieval-augmented analysis for long conversations in code-insights. When a session exceeds ~80% of the model context window, switch from sending the entire conversation raw to retrieving analytically-annotated chunks via hybrid embedding retrieval. Both CLI and server paths share a single retrieval layer.

## Problem
- CLI path (`insights check --analyze`) sends entire conversation raw with no chunking
- Server path uses naive token-based chunking that destroys conversational semantics
- Long sessions hit context limits, producing incomplete or degraded analysis
- No cross-session trend analysis capability for patterns and friction points

## Solution
1. **Annotated Chunker** — Group messages into role-boundary exchanges, annotate with phase/significance/why_context, split into parent/child chunks
2. **Vector Store Extension** — New `vec_analysis_chunks` table with metadata columns for annotations
3. **Ingest-Time Embedding** — Embed chunks immediately at message ingest for instant searchability
4. **Retrieval Layer** — Dynamic query (analysis instructions + session summary + past insights) triggers threshold-based retrieval
5. **Context Augmentation** — Hybrid window + neighbor augmentation preserves orientation and flow
6. **Shared Infrastructure** — Both CLI and server use the same retrieval logic

## Scope
- **In:** CLI analysis, server analysis, embedding pipeline, vector store, retrieval logic
- **Out:** Facet extraction (stays separate), insight generation (output-only), dashboard UI changes

## Key Decisions
| Decision | Choice | Rationale |
|---|---|---|
| Chunking boundaries | Role-boundary exchanges | Preserves conversational semantics |
| Parent chunk max | 4000 chars | Matches existing backfill params |
| Child chunk max | 512 chars | Matches existing backfill params |
| Embedding timing | At ingest time | Instant searchability for trends |
| Retrieval trigger | Threshold-based (~80% context) | Short sessions get full fidelity |
| Query construction | Dynamic (instructions + summary + insights) | Adapts per session, resists shortcut learning |
| Context augmentation | Window + neighbors | Orientation + flow continuity |
| Facet strategy | Separate pass (existing) | Facets are holistic, can't be chunked |
| Embedding readiness | Soft gate | Compute in parallel, wait only if needed |
| Fallback | Block until ready | Analysis quality depends on retrieval |
| Vector table | New `vec_analysis_chunks` | Clean separation from raw messages |

## Implementation Phases
1. Annotated Chunker (new module)
2. Vector Store Extension (new table + queries)
3. Ingest-Time Embedding Pipeline
4. Retrieval Layer (shared)
5. CLI Integration
6. Server Integration
7. Testing

## Success Criteria
- Long sessions use retrieval instead of naive chunking
- Retrieved chunks carry analytical annotations
- Context window utilization improves (less redundancy, more coverage)
- Retrieval latency <500ms, embedding latency <2s per session
- Short-session behavior unchanged
- CLI and server produce consistent results

## Files
- `goals/long-context-retrieval/facts.md` — Interview answers and fact sheet
- `goals/long-context-retrieval/plan.md` — Detailed implementation plan
