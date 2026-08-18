<div align="center">
  <img src="docs/assets/logo.svg" width="120" height="120" alt="Code Insights logo" />
  <h1>Code Insights</h1>
  <p><strong>Turn your AI coding sessions into actionable knowledge with local-first analytics and self-optimizing LLM prompts.</strong></p>
  <p>
    <a href="https://deepwiki.com/b08x/code-insights"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
    <a href="https://zread.ai/b08x/code-insights" target="_blank"><img src="https://img.shields.io/badge/Ask_Zread-_.svg?style=flat&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff" alt="zread"/></a>
    <a href="https://github.com/melagiri/code-insights/blob/master/LICENSE"><img src="https://img.shields.io/github/license/melagiri/code-insights" alt="License" /></a>
    <a href="https://www.npmjs.com/package/@code-insights/cli"><img src="https://img.shields.io/npm/v/@code-insights/cli" alt="NPM Version" /></a>
    <a href="https://github.com/melagiri/code-insights/actions/workflows/ci.yml"><img src="https://github.com/melagiri/code-insights/actions/workflows/ci.yml/badge.svg" alt="Build Status" /></a>
  </p>
</div>

**Code Insights** is a local-first analytics platform that extracts structured decisions, learnings, and prompt quality scores from your AI coding sessions. Surfacing cross-session patterns, friction points, and cost tracking—all persisted locally in SQLite—it features a self-optimizing prompt engine powered by **`@ax-llm/ax`** to continually align and improve LLM insight extraction.

---

## Key Capabilities

- **Automated Session Discovery** — Automatically parse history from Claude Code, Cursor, Codex, Copilot, Gemini CLI, Hermes, OpenCode, and Crush.
- **Knowledge Journal** — Chronological timeline of learnings and decisions, grouped by ISO week with pattern indicators.
- **Weekly Pattern Synthesis & Configuration Artifacts** — Synthesize cross-session behaviors into shareable rules and agent instructions.
- **Self-Optimizing Prompts (GEPA)** — Automate prompt engineering using Gradient-free Evolutionary Prompt Adaptation powered by `@ax-llm/ax`.
- **Rage Loop & Friction Detection** — Identify temporal looping and context stasis ("Sunk Cost Alerts") via SFL (Systemic Functional Linguistics) criteria.
- **AI Fluency Scoring** — Evaluate your prompts using multi-dimensional prompt quality metrics.
- **Vector-Based Recurring Insights** — Group similar insights using local `sqlite-vec` KNN search + MMR deduplication (~90% token savings).
- **Privacy First** — Completely local SQLite backend with zero external dependencies (unless configuring cloud LLM models).

---

## Installation

### Prerequisites
- **Node.js** `>= 18.0.0`
- **Ollama** (optional, for local embeddings and zero-cost LLM analysis)

### Installation Methods

> [!TIP]
> Use `npx` to test Code Insights immediately without a permanent global installation.

```bash
# Option 1: Quick Start (npx)
npx @code-insights/cli

# Option 2: Global installation (NPM)
npm install -g @code-insights/cli

# Option 3: Global installation (pnpm)
pnpm add -g @code-insights/cli
```

---

## Primary Usage Workflow

Start Code Insights and launch the dashboard in a few commands:

```bash
code-insights install-hook    # Zero-latency hook for Claude Code
code-insights sync            # Scan and import new session history
code-insights reflect         # Synthesize cross-session weekly patterns & configuration artifacts
code-insights dashboard       # Start visual dashboard at http://localhost:7890
```

### CLI Command Reference

| Command | Action | Key Options |
|:---|:---|:---|
| `install-hook` | Zero-latency hook for Claude Code | `--runner [codex|claude|vibe|antigravity]` |
| `sync` | Discover & import sessions | `--source [claude\|cursor\|copilot]` |
| `insights [id]` | Run AI analysis on session | `--force`, `--claude`, `--native` |
| `reflect` | Compile cross-session synthesis | `--week [YYYY-W##]` |
| `stats` | Fast terminal analytics | `today`, `cost`, `projects` |
| `optimize` | Tune insight prompts via `@ax-llm/ax` | `run`, `status`, `list`, `apply`, `compare` |
| `embeddings` | Manage SQLite vector database | `backfill`, `status`, `recompute` |
| `search / vsearch / query` | Hybrid semantic search over messages | `--top-k` |

---

## Prompt Optimization with `@ax-llm/ax`

Prompt engineering for structured AI logs is notoriously brittle. Instead of manually tuning prompts, Code Insights leverages `@ax-llm/ax` to programmatically optimize prompt templates against a multi-objective metric.

```text
               ┌──────────────────────────────────────┐
               │    Training Data (Session Logs)      │
               └──────────────────┬───────────────────┘
                                  ▼
               ┌──────────────────────────────────────┐
               │     Optimizable Prompt Signature     │
               │   (root::instruction, description)   │
               └──────────────────┬───────────────────┘
                                  ▼
 ┌──────────────┐      ┌────────────────────┐      ┌──────────────┐
 │  Student AI  │ ◄─── │      AxGEPA        │ ───► │  Teacher AI  │
 │ (Fast/Cheap) │      │  Compiler Loop     │      │ (Strong/Val) │
 └──────────────┘      └─────────┬──────────┘      └──────────────┘
                                 │ Evolve Prompts
                                 ▼
               ┌──────────────────────────────────────┐
               │      Pareto Frontier Selection       │
               │ (Coverage, Precision, Actionability) │
               └──────────────────┬───────────────────┘
                                  ▼
               ┌──────────────────────────────────────┐
               │   Optimized CLAUDE.md Prompt Asset   │
               └──────────────────────────────────────┘
```

### 1. Declaring the Optimizable Program

Using `@ax-llm/ax`, we express our prompt optimization as a compiled flow signature in `flow.ts`:

```typescript
import { ax, type AxOptimizableComponent } from '@ax-llm/ax';

export class InsightProgram {
  private _instruction = INSIGHT_INSTRUCTION;
  private _description = INSIGHT_OUTPUT_FORMAT;
  private _program: any;

  constructor() {
    this._rebuild();
  }

  private _rebuild(): void {
    // Declarative schema structure
    this._program = ax(`sessionData:string -> insights:json, quality:number`, {
      description: `${this._instruction}\n\n${this._description}`
    });
  }

  // Expose components for evolutionary compilation
  getOptimizableComponents(): AxOptimizableComponent[] {
    return [
      { key: "root::instruction", current: this._instruction, kind: "instruction" },
      { key: "root::description", current: this._description, kind: "description" }
    ];
  }

  applyOptimizedComponents(optimizedProgram: any): void {
    const signature = optimizedProgram.signature;
    this.programDescription = signature.description;
  }
}
```

### 2. Evolving the Prompt Signature

We run **Gradient-free Evolutionary Prompt Adaptation (GEPA)** in `runner.ts` using `AxGEPA`. This instantiates a cheap **Student** model (e.g. `gpt-4o-mini`) to generate candidate responses, and a strong **Teacher** model (e.g. `claude-3-5-sonnet`) to score prompt quality:

```typescript
import { AxGEPA } from '@ax-llm/ax';

export class GEPARunner {
  async optimize(trainData: TrainingExample[], validationData: TrainingExample[]) {
    const program = new InsightProgram();

    // Define the multi-objective fitness metric
    const metricFn = (input) => {
      return multiObjectiveMetric(input); // evaluates coverage, precision, actionability, brevity
    };

    const optimizer = new AxGEPA({
      studentAI, // cheap student model
      teacherAI, // strong teacher model
      numTrials: 25,
      minibatch: true,
      minibatchSize: 6,
      earlyStoppingTrials: 8,
      seed: 42,
      onProgress: (p) => console.log(`Trial ${p.round}: score = ${p.currentScore}`)
    });

    // Evolve prompts in a transactional optimization loop
    const result = await optimizer.compile(program, trainData, metricFn, {
      validationExamples: validationData,
      maxMetricCalls: 200,
    });

    // Apply the best prompt configuration from the Pareto frontier
    if (result.optimizedProgram) {
      program.applyOptimizedComponents(result.optimizedProgram);
    }
  }
}
```

### 3. CLI Optimization Commands

Manage evolved prompt versions directly from your terminal:

```bash
# Evolve prompt instructions on local session history
code-insights optimize run

# List, inspect, and apply generated Pareto points
code-insights optimize list
code-insights optimize apply <version-id>
code-insights optimize compare
```

---

## Local Embeddings & Semantic Search

Code Insights uses local vector and hybrid search to match similar insights and find related messages from your history.

```bash
# Index messages and insights with Ollama (qwen3-embedding:0.6b)
code-insights embeddings backfill --entity messages

# Verify coverage and storage stats
code-insights embeddings status

# Execute fast keyword search via FTS5
code-insights search "auth middleware refactor"

# Execute KNN vector search via sqlite-vec
code-insights vsearch "how to fix the deployment pipeline"

# Execute full Hybrid search (BM25 + Vector + Reciprocal Rank Fusion)
code-insights query "database migrations connection error"
```

> [!NOTE]
> Embeddings are configured via `OLLAMA_BASE_URL` (default: `http://tinybot:11434`). It leverages `sqlite-vec` for native, lightning-fast in-database vector operations, and `FTS5` for BM25 keyword matching.

---

## Configuration

Settings are maintained in `~/.code-insights/config.json`:

```json
{
  "sync": {
    "autoAnalyze": true,
    "sources": ["claude", "cursor", "copilot"]
  },
  "dashboard": {
    "port": 7890,
    "llm": {
      "provider": "anthropic",
      "model": "claude-3-5-sonnet-latest"
    }
  }
}
```

---

## Architecture

```text
Session Sources (Claude, Cursor, Copilot, Gemini CLI, Hermes, OpenCode, Crush)
             │
             ▼
      ┌─────────────┐
      │ CLI Engine  │  Discovery, Parsing, DB Persistence
      └──────┬──────┘
             │
             ▼
      ┌─────────────────────────────────────┐
      │ SQLite DB (V12)                     │  ~/.code-insights/data.db
      │  ┌──────────┐  ┌──────────────────┐ │
      │  │ Tables   │  │ Search Tables    │ │
      │  │ projects │  │ vec_insights     │ │
      │  │ sessions │  │ vec_messages     │ │
      │  │ messages │  │ messages_fts     │ │
      │  │ insights │  └──────────────────┘ │
      │  └──────────┘                       │
      └──────┬──────────────────────────────┘
             │
      ┌──────┴───────────────┐
      ▼                      ▼
┌────────────┐        ┌──────────────┐
│ Terminal   │        │ Hono Server  │  LLM Proxy, REST API
│ Analytics  │        └──────┬───────┘
└────────────┘               │
                             ▼
                      ┌──────────────┐
                      │ React SPA    │  Visual Dashboard
                      └──────────────┘

── Cognitive Services ──
┌────────────┐  ┌──────────────┐  ┌─────────────┐
│ Ollama     │  │ LLM Provider │  │ GEPA        │
│ Embeddings │  │ (Analysis)   │  │ Optimization│
│ (1024-dim) │  │              │  │ (@ax-llm/ax)│
└────────────┘  └──────────────┘  └─────────────┘
```

---

## Privacy & Security

All analysis, data storage, and embedding computations are performed **locally** by default. Telemetry consists of simple, anonymized usage metrics, which can be turned off entirely with:
```bash
code-insights telemetry disable
```

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) to understand the PNPM monorepo structure and local development guidelines.

---

## License

MIT — Copyright (c) 2026 Srikanth Rao M
