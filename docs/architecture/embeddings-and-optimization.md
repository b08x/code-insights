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
{
  model: 'embeddinggemma:latest',
  baseUrl: process.env.OLLAMA_BASE_URL || 'http://tinybot:11434',
  dim: 768,
  batchSize: 50,
  rateLimitPerMinute: 0  // disabled
}
```

### Database Schema Changes (V11)

- `embedding_status` column added to `insights` and `messages` tables (`pending`, `computed`, `stale`, `failed`)
- `embedding_metadata` table for provenance
- `vec_insights` and `vec_messages` virtual tables via sqlite-vec

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

## Optimization System (GEPA)

### Purpose

Automatically evolve insight-generation prompts to maximize quality across multiple objectives, using the GEPA (Genetic-Pareto) algorithm from `@ax-llm/ax`.

### Architecture

```
┌──────────────────────────────────────────────────────────────┐
│ GEPA Optimization Pipeline                                   │
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
│                      │  │ - coverage               │   │    │
│                      │  │ - precision              │   │    │
│                      │  │ - actionability          │   │    │
│                      │  │ - brevity                │   │    │
│                      │  └──────────┬───────────────┘   │    │
│                      │             │                   │    │
│                      │             ▼                   │    │
│                      │  ┌──────────────────────────┐   │    │
│                      │  │ Pareto Frontier          │   │    │
│                      │  │ (non-dominated solutions)│   │    │
│                      │  └──────────┬───────────────┘   │    │
│                      └─────────────┼───────────────────┘    │
│                                    │                        │
│                                    ▼                        │
│                      ┌──────────────────────────┐           │
│                      │ Optimization Artifacts   │           │
│                      │ ~/.code-insights/        │           │
│                      │   optimizations/         │           │
│                      │     <version-id>/        │           │
│                      └──────────────────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

### Components

| Component | File | Purpose |
|-----------|------|---------|
| `flow.ts` | `cli/src/optimization/flow.ts` | AxFlow definition for insight generation |
| `metric.ts` | `cli/src/optimization/metric.ts` | Multi-objective metric (coverage, precision, actionability, brevity) |
| `runner.ts` | `cli/src/optimization/runner.ts` | GEPA optimization orchestration |
| `prompts.ts` | `cli/src/optimization/prompts.ts` | Save/load/version tracking for optimized prompts |
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
