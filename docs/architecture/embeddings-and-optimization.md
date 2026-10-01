# Embeddings & Optimization Architecture

> Vector-based semantic search and GEPA prompt optimization. Added in v4.7.0.

---

## Overview

Two new systems were added to Code Insights in v4.7.0:

1. **Embeddings System** — Vector embeddings for semantic search over insights and messages, using Ollama for embedding generation and sqlite-vec for KNN similarity search.
2. **Optimization System** — GEPA (Genetic-Pareto) prompt optimization for insight generation, using `@ax-llm/ax` to evolve prompts against multi-objective metrics.

Both systems are optional and local-first. Embeddings require an Ollama instance; optimization requires an LLM provider API key.

---

## Embeddings System

### Purpose

Enable semantic search and deduplication over insights and messages without sending data to external APIs (beyond the initial embedding generation via Ollama).

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Embeddings Pipeline                                          │
│                                                              │
│  Insights / Messages                                         │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐  │
│  │ Embedding   │───▶│ Ollama      │───▶│ EmbeddingResult │  │
│  │ Client      │    │ /api/embed  │    │ (id, vector,    │  │
│  │             │    │             │    │  sourceText)    │  │
│  └─────────────┘    └─────────────┘    └────────┬────────┘  │
│                                                  │           │
│                                                  ▼           │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ Vector Store (sqlite-vec)                            │    │
│  │  ┌────────────────┐  ┌────────────────┐              │    │
│  │  │ vec_insights   │  │ vec_messages   │              │    │
│  │  │ (id, embedding │  │ (id, embedding │              │    │
│  │  │  float[768])   │  │  float[768])   │              │    │
│  │  └────────────────┘  └────────────────┘              │    │
│  │  KNN search via sqlite-vec virtual tables            │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ embedding_metadata table                             │    │
│  │  Tracks provenance: model, dim, source_text, dates   │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `EmbeddingConfig` | `cli/src/embeddings/types.ts` | Configuration (model, baseUrl, dim, batchSize) |
| `EmbeddingClient` | `cli/src/embeddings/client.ts` | Ollama `/api/embed` client with batching |
| `OllamaClient` | `cli/src/embeddings/ollama-client.ts` | Ollama-specific HTTP client |
| `VectorStore` | `cli/src/embeddings/store.ts` | sqlite-vec virtual table management, KNN queries |
| `Backfill` | `cli/src/embeddings/backfill.ts` | Batch embedding pipeline with progress tracking |
| `embedding_metadata` | `cli/src/db/schema.ts` | Provenance tracking for computed embeddings |

### Configuration

Default embedding config:
```typescript
export const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  model: 'embeddinggemma:latest',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  dim: 768,
  batchSize: 50,
  rateLimitPerMinute: 0  // disabled
}
```

### Database Schema Changes (V11)

- `embedding_status` column added to `insights` and `messages` tables (`pending`, `computed`, `stale`, `failed`)
- `embedding_metadata` table for provenance
- `vec_insights` and `vec_messages` virtual tables via sqlite-vec

### Hierarchical Parent/Child Chunking Strategy

To avoid LLM context length errors during backfill and to ensure high-quality semantic retrieval, the system uses a hierarchical chunking strategy for long messages:

- **Parent Chunks**: Messages are split into parent chunks with a maximum of 4000 characters. These chunks preserve the broader context and are stored in the `entity_chunks` table.
- **Child Chunks**: The parent chunks are further split into smaller child chunks with a maximum of 512 characters. The embedding vectors are computed on these child chunks, and their provenance is tracked in the `embedding_metadata` table.

This approach guarantees that the LLM is fed safely sized tokens during embedding generation while retaining the ability to return substantial context during RAG.

### CLI Commands

| Command | Purpose |
|---------|---------|
| `embeddings backfill` | Compute embeddings for pending entities |
| `embeddings status` | Show coverage stats |
| `embeddings recompute` | Force re-compute stale embeddings |
| `embeddings search` | KNN similarity search (debugging) |

### Recurring Insights Integration

The recurring insights system (`server/src/llm/recurring-insights.ts`) now uses a hybrid approach:

1. **sqlite-vec KNN** finds semantically similar insights (cosine similarity >= 0.85)
2. **MMR (Maximal Marginal Relevance)** deduplicates groups (lambda=0.7)
3. **LLM** is used only for theme naming (small prompt, ~90% token reduction vs. previous LLM-only clustering)

---

## Retrieval-Augmented Analysis System

> Added in v4.8.0 - Annotated chunking and retrieval-augmented analysis pipeline

### Purpose

Enhance session analysis quality by augmenting the LLM context with relevant historical information from your codebase history. This addresses the cold-start problem and provides richer context for more accurate insights.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ Retrieval-Augmented Analysis Pipeline                          │
│                                                                  │
│  Session Transcript                                             │
│        │                                                        │
│        ▼                                                        │
│  ┌──────────────────┐  ┌──────────────────────────┐            │
│  │ Annotated        │  │ Analysis Pipeline         │            │
│  │ Chunker          │───▶│ (embedding, readiness)    │            │
│  │                  │  │                          │            │
│  │ - role boundary   │  └──────────┬───────────────┘            │
│  │ - phase/session   │             │                            │
│  │ - parent/child    │             ▼                            │
│  │   splitting       │  ┌──────────────────────┐            │
│  └──────────────────┘  │ vec_analysis_chunks   │            │
│                         │ (KNN search)         │            │
│                         └──────────┬───────────┘            │
│                                    │                            │
│                                    ▼                            │
│                         ┌──────────────────────┐            │
│                         │ Retrieval Layer       │            │
│                         │ - threshold config    │            │
│                         │ - dynamic query       │            │
│                         │ - context window      │            │
│                         └──────────┬───────────┘            │
│                                    │                            │
│                                    ▼                            │
│                         ┌──────────────────────┐            │
│                         │ Render Layer          │            │
│                         │ - Rich Terminal       │            │
│                         │ - Score bars          │            │
│                         │ - Severity dots        │            │
│                         │ - Dimension breakdown  │            │
│                         └──────────────────────┘            │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `AnnotatedChunker` | `cli/src/analysis/annotated-chunker.ts` | Intelligent chunking respecting role boundaries with parent/child strategy |
| `AnalysisChunksStore` | `cli/src/analysis/analysis-chunks-store.ts` | Manages vec_analysis_chunks table for storing analysis chunks |
| `AnalysisPipeline` | `cli/src/analysis/analysis-pipeline.ts` | Orchestrates embedding, indexing, and retrieval readiness |
| `Retrieval` | `cli/src/analysis/retrieval.ts` | Shared retrieval layer with threshold and dynamic query configuration |
| `Render` | `cli/src/analysis/render.ts` | Rich terminal output formatting (score bars, severity dots) |

### Database Schema Changes (V13)

- `vec_analysis_chunks` virtual table via sqlite-vec for KNN search on analysis chunks
- Stores chunks from annotated chunker with parent/child relationships
- Enables retrieval of relevant historical context for analysis augmentation

### Annotated Chunking Strategy

The annotated chunker implements a sophisticated splitting strategy:

1. **Role Boundary Respect**: Chunks are split at message role boundaries (user/assistant) to preserve conversation context
2. **Phase Detection**: Identifies session phases (e.g., coding, debugging, reviewing) for semantic grouping
3. **Parent/Child Splitting**: 
   - Parent chunks: Up to 4000 characters, preserving broader context
   - Child chunks: Up to 512 characters, used for embedding computation
   - Child chunks reference their parent for provenance tracking
4. **Annotated Metadata**: Each chunk carries metadata about its role, phase, position, and relationships

This strategy ensures:
- High-quality semantic retrieval through focused child chunk embeddings
- Rich context preservation through parent chunk references
- Efficient LLM processing with properly sized tokens
- Accurate provenance tracking for analysis augmentation

### Data Flow

1. **Chunking**: Session transcripts are processed by the annotated chunker, producing parent/child chunk pairs
2. **Embedding**: Child chunks are embedded via Ollama and stored in `vec_analysis_chunks`
3. **Indexing**: Chunks are indexed with readiness status for retrieval
4. **Retrieval**: Analysis queries use KNN search with configurable thresholds to find relevant chunks
5. **Augmentation**: Retrieved chunks augment the analysis context for richer insight generation
6. **Rendering**: Results are formatted with rich terminal visualizations

### Configuration

The retrieval layer supports configurable parameters:

- `threshold`: Minimum similarity score for retrieval (default: 0.75)
- `k`: Number of nearest neighbors to retrieve (default: 5)
- `contextWindow`: Size of context window for augmentation (default: 3)
- `dynamicQuery`: Enable/disable query adaptation based on session content

---

## Optimization System (GEPA)

### Purpose

Automatically evolve insight-generation prompts to maximize quality across multiple objectives, using the GEPA (Genetic-Pareto) algorithm from `@ax-llm/ax`.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ GEPA Optimization Pipeline & Production Runtime              │
│                                                              │
│  Sessions DB                                                 │
│         │                                                    │
│         ▼                                                    │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │ Training    │    │ GEPA Loop                        │    │
│  │ Data Loader │───▶│                                  │    │
│  │ (last N     │    │  ┌──────────┐  ┌──────────────┐ │    │
│  │  days, min  │    │  │ Student  │  │ Teacher      │ │    │
│  │  messages)  │    │  │ Model    │  │ Model        │ │    │
│  └─────────────┘    │  │ (fast)   │  │ (strong)     │ │    │
│                      │  └────┬─────┘  └──────┬───────┘ │    │
│                      │       │               │         │    │
│                      │       ▼               ▼         │    │
│                      │  ┌──────────────────────────┐   │    │
│                      │  │ Multi-Objective Metric   │   │    │
│                      │  └──────────┬───────────────┘   │    │
│                      │             │                   │    │
│                      │             ▼                   │    │
│                      │  ┌──────────────────────────┐   │    │
│                      │  │ Pareto Frontier          │   │    │
│                      │  └──────────┬───────────────┘   │    │
│                      └─────────────┼───────────────────┘    │
│                                    │                        │
│                                    ▼                        │
│                      ┌──────────────────────────┐           │
│                      │ Local Prompt Registry    │           │
│                      │ ~/.code-insights/        │           │
│                      │   optimizations/         │           │
│                      └─────────────┬────────────┘           │
│                                    │                        │
│  ┌─────────────────────────────────┼─────────────────────┐  │
│  │ Analysis Runner Layer           ▼                     │  │
│  │                      ┌──────────────────────────┐     │  │
│  │  Target Registry ───▶│ resolveAnalysisPrompt()  │     │  │
│  │  (targets.ts)        │ (resolve-prompt.ts)      │     │  │
│  │                      └──────────┬───────────────┘     │  │
│  │                                 │                     │  │
│  │                                 ▼                     │  │
│  │                      ┌──────────────────────────┐     │  │
│  │  Student Identity ──▶│ Pipeline / Queue Worker  │     │  │
│  │  Engine              │ (Fallback Guard)         │     │  │
│  │  (identity.ts)       └──────────┬───────────────┘     │  │
│  │                                 │                     │  │
│  │                                 ▼                     │  │
│  │                      ┌──────────────────────────┐     │  │
│  │                      │ Schema V18 DB Persist    │     │  │
│  │                      │ (student_identity,       │     │  │
│  │                      │  prompt_version_id)      │     │  │
│  │                      └──────────────────────────┘     │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `targets.ts` | `cli/src/optimization/targets.ts` | Target Registry defining tuning boundaries (mutable vs frozen guidance) |
| `identity.ts` | `cli/src/optimization/identity.ts` | Student Identity Engine (`runner\|model\|variant`) for strict model provenance |
| `resolve-prompt.ts`| `cli/src/optimization/resolve-prompt.ts` | Resolves tuned prompt version matching the target and student identity |
| `optimize.ts` | `cli/src/commands/optimize.ts` | CLI command definitions |

### Optimization Objectives

| Objective | Description | Scoring |
|-----------|-------------|---------|
| `coverage` | % of session content captured in insights | Topic overlap + expected count |
| `precision` | % of non-trivial insights | Filler pattern detection |
| `actionability` | % with concrete takeaways | Action verb + specificity heuristics |
| `brevity` | Inverse of token count | Normalized length penalty |

### CLI Commands

| Command | Purpose |
|---------|---------|
| `optimize run` | Run GEPA optimization |
| `optimize status` | Show active version and scores |
| `optimize list` | List all versions |
| `optimize apply <id>` | Activate a version |
| `optimize compare [a] [b]` | A/B compare versions |
| `optimize delete <id>` | Delete a version |

### Training Data

Training examples are loaded from the sessions database:
- Sessions from the last N days (default: 30)
- Minimum message count filter (default: 10)
- Transcripts truncated to 8000 chars for cost efficiency
- 80/20 train/validation split

---

## Dependencies Added

| Package | Purpose | Version |
|---------|---------|---------|
| `@ax-llm/ax` | GEPA prompt optimization framework | ^22.0.2 |
| `sqlite-vec` | Vector similarity search for SQLite | ^0.1.9 |

---

## Privacy Considerations

- **Embeddings**: Text is sent to your configured Ollama instance for embedding computation. Vectors and source text are stored locally in SQLite. No data is sent to external embedding APIs.
- **Optimization**: Session transcripts are sent to your configured LLM provider (student + teacher models) for optimization. Optimized prompts are stored locally. No session data is retained by the optimization framework after the run completes.
- Both systems are entirely optional and can be disabled by simply not running the commands.
