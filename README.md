<div align="center">
  <img src="docs/assets/logo.svg" width="120" height="120" alt="Code Insights logo" />
  <h1>Code Insights</h1>
  <p><strong>Local-first Agent Cognitive Engine & Telemetry Platform: Systemic Linguistic Auditing (SFL), Formal Concept Analysis (FCA), and Self-Optimizing LLM Prompts (GEPA).</strong></p>
  <p>
    <a href="https://deepwiki.com/b08x/code-insights"><img src="https://deepwiki.com/badge.svg" alt="Ask DeepWiki"></a>
    <a href="https://zread.ai/b08x/code-insights" target="_blank"><img src="https://img.shields.io/badge/Ask_Zread-_.svg?style=flat&color=00b0aa&labelColor=000000&logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB3aWR0aD0iMTYiIGhlaWdodD0iMTYiIHZpZXdCb3g9IjAgMCAxNiAxNiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTQuOTYxNTYgMS42MDAxSDIuMjQxNTZDMS44ODgxIDEuNjAwMSAxLjYwMTU2IDEuODg2NjQgMS42MDE1NiAyLjI0MDFWNC45NjAxQzEuNjAxNTYgNS4zMTM1NiAxLjg4ODEgNS42MDAxIDIuMjQxNTYgNS42MDAxSDQuOTYxNTZDNS4zMTUwMiA1LjYwMDEgNS42MDE1NiA1LjMxMzU2IDUuNjAxNTYgNC45NjAxVjIuMjQwMUM1LjYwMTU2IDEuODg2NjQgNS4zMTUwMiAxLjYwMDEgNC45NjE1NiAxLjYwMDFaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00Ljk2MTU2IDEwLjM5OTlIMi4yNDE1NkMxLjg4ODEgMTAuMzk5OSAxLjYwMTU2IDEwLjY4NjQgMS42MDE1NiAxMS4wMzk5VjEzLjc1OTlDMS42MDE1NiAxNC4xMTM0IDEuODg4MSAxNC4zOTk5IDIuMjQxNTYgMTQuMzk5OUg0Ljk2MTU2QzUuMzE1MDIgMTQuMzk5OSA1LjYwMTU2IDE0LjExMzQgNS42MDE1NiAxMy43NTk5VjExLjAzOTlDNS42MDE1NiAxMC42ODY0IDUuMzE1MDIgMTAuMzk5OSA0Ljk2MTU2IDEwLjM5OTlaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik0xMy43NTg0IDEuNjAwMUgxMS4wMzg0QzEwLjY4NSAxLjYwMDEgMTAuMzk4NCAxLjg4NjY0IDEwLjM5ODQgMi4yNDAxVjQuOTYwMUMxMC4zOTg0IDUuMzEzNTYgMTAuNjg1IDUuNjAwMSAxMS4wMzg0IDUuNjAwMUgxMy43NTg0QzE0LjExMTkgNS42MDAxIDE0LjM5ODQgNS4zMTM1NiAxNC4zOTg0IDQuOTYwMVYyLjI0MDFDMTQuMzk4NCAxLjg4NjY0IDE0LjExMTkgMS42MDAxIDEzLjc1ODQgMS42MDAxWiIgZmlsbD0iI2ZmZiIvPgo8cGF0aCBkPSJNNCAxMkwxMiA0TDQgMTJaIiBmaWxsPSIjZmZmIi8%2BCjxwYXRoIGQ9Ik00IDEyTDEyIDQiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjUiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPgo8L3N2Zz4K&logoColor=ffffff" alt="zread"/></a>
    <a href="https://github.com/b08x/code-insights/blob/development/LICENSE"><img src="https://img.shields.io/github/license/b08x/code-insights" alt="License" /></a>
    <a href="https://www.npmjs.com/package/@code-insights/cli"><img src="https://img.shields.io/npm/v/@code-insights/cli" alt="NPM Version" /></a>
  </p>
</div>

**Code Insights** is a local-first **Agent Cognitive Engine & Telemetry Infrastructure Platform**. It transforms raw AI coding conversations across 9+ developer tools and autonomous agents into structured decision networks, Systemic Functional Linguistics (SFL) breakdowns, concept lattices (FCA), and semantic vector memories—all persisted locally in SQLite with a self-optimizing prompt engine powered by **`@ax-llm/ax`**.

---

## Key Capabilities

- **Automated Session Discovery & Sub-Agent Bundling** — Automatically parse history and recursively bundle nested sub-agents across Claude Code, Cursor, Codex, Copilot, Gemini CLI, Hermes Agent, Mistral Vibe, Google Antigravity, OpenCode, and Pi AI.
- **SFL Linguistic Auditing & Prompt Quality** — Deconstruct interactions into Systemic Functional Linguistics metafunctions (*Ideational*, *Interpersonal*, *Textual*) with hard constraint scoring (0–100) and actionable prompt refinement.
- **Formal Concept Analysis (FCA) & Step Matrix** — Extract sequential milestone steps into structured relational matrices (`session_steps`), tracking drivers, target files, test executions (`ran_tests`), tool calls (`used_tools`), and course corrections.
- **Verifiable Decision Attribution** — Attribute technical decisions to `user`, `agent`, or `collaborative` agency, backed by concrete turn citations (`User#N` vs `Assistant#N`).
- **Rage Loop & Sunk Cost Detection** — Identify temporal looping and context stasis ("Sunk Cost Alerts") via pre-analysis heuristic loop detection.
- **Self-Optimizing Prompts (GEPA)** — Automate prompt engineering using Gradient-free Evolutionary Prompt Adaptation powered by `@ax-llm/ax`.
- **Hybrid Semantic Memory (RAG)** — Combine local `sqlite-vec` KNN cosine similarity + FTS5 BM25 search via Reciprocal Rank Fusion (RRF) with parent/child chunking (`entity_chunks`).
- **Interactive RAG Agent Chat** — Chat with your historical session memory and codebase context via streaming SSE.
- **Multi-Level Native Runner Fallbacks** — Headless, zero-config local analysis supporting automatic failover chains: Codex → Claude → Antigravity → Mistral Vibe.
- **Zero-Cost Reprocessing & Permanent Tombstoning** — Backfill schemas and attribute historical data locally ($0.00 API spend) while permanently tombstoning deleted sessions via Schema v16.
- **Developer Leverage Economics** — Measure ROI by comparing flat-rate subscriptions against pay-as-you-go token consumption.
- **Privacy by Architecture** — Completely local SQLite backend with zero cloud dependencies.


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
| `install-hook` | Zero-latency hook for tools | `--runner [codex|claude|vibe|antigravity]`, `--target [claude|vibe|opencode]` |
| `uninstall-hook` | Remove auto-sync hooks | `--target [claude|vibe|opencode]` |
| `sync` | Discover & import sessions | `--source [claude\|cursor\|copilot]` |
| `insights [id]` | Run AI analysis on session | `--force`, `--claude`, `--native`, `--format [rich|json|quiet]` |
| `reflect` | Compile cross-session synthesis | `--week [YYYY-W##]` |
| `stats` | Fast terminal analytics & comparison | `overview`, `cost`, `compare`, `today`, `projects` |
| `config` | Configure providers & subscription plans | `plans`, `plans --set <id>.monthlyFee=<amt>` |
| `optimize` | Tune insight prompts via `@ax-llm/ax` | `run`, `status`, `list`, `apply`, `compare` |
| `embeddings` | Manage SQLite vector database | `backfill`, `status`, `recompute` |
| `reprocess` | Zero-cost local schema & step backfill | `--dry-run`, `--resync`, `--no-fts` |
| `purge [id]` | Hard-delete session & register tombstone | `-y`, `--reason` |
| `search / vsearch / query` | Hybrid semantic search over messages | `--top-k` |

---

## Zero-Cost Schema Reprocessing & Session Tombstoning

When database schemas evolve (such as extracting relational `session_steps` for Formal Concept Analysis or attributing historical decision makers), re-running multi-thousand-token LLM analysis passes across thousands of historical sessions is prohibitively slow and expensive. Code Insights provides zero-cost local backfilling and permanent session tombstoning:

### Zero-Cost Reprocessing
```bash
# Preview what would be backfilled and attributed without modifying the database
code-insights reprocess --dry-run

# Run local zero-cost backfill and index rebuild ($0.00 API spend)
code-insights reprocess
```
- **Relational Step Backfill**: Extracts and normalizes 4–10 step episodes from existing `summary` insight metadata into `session_steps` (Schema v15), deriving co-occurring flags (`ran_tests`, `used_tools`, `has_course_correction`, `targets`).
- **Legacy Decision Attribution**: Analyzes evidence turn citations (`User#N` vs `Assistant#N`) in historical decision insights to classify unassigned decisions into `user`, `agent`, or `collaborative`.
- **FTS5 Index Rebuild**: Automatically resynchronizes full-text search across messages, tool calls, and tool results.

### Permanent Session Tombstoning (Hard Deletes)
When testing tools or cleaning up malformed or unwanted sessions, soft-deletes or simple SQLite row deletions leave raw session logs on disk—which causes standard sync tools to re-import them as new sessions.

Code Insights introduces the Schema v16 `deleted_sessions` tombstone registry:
```bash
# Permanently purge all soft-deleted sessions and record tombstones
code-insights purge -y

# Purge a specific session and prevent future re-sync
code-insights purge <session-id> -y

# Prune trivial sessions (≤2 messages) and permanently tombstone them
code-insights sync prune --hard
```
- **Ingestion Guards**: `code-insights sync` (even with `--force`) checks `deleted_sessions` and skips tombstoned session IDs before parsing or writing, without touching your original raw tool logs on disk.

---

## Subscription Plans & Cost Comparison

Developers often use flat-rate monthly subscriptions (e.g. Claude Pro, Google AI Premium / Antigravity, Mistral Pro) rather than paying raw API token bills. Code Insights natively tracks this duality:
- **Actual Spend**: Flat monthly subscription fees allocated across your selected time window.
- **Pay-As-You-Go API Equivalent**: What the raw token usage would cost if billed via public API endpoints.
- **Compute Leverage & Absorbed Value**: Quantifies the unmetered exploratory compute and leverage enabled by your subscriptions (freeing you to prototype, educate, and vibe code without per-token anxiety).

```bash
# Compare subscription plan fees against pay-as-you-go API value and compute leverage
code-insights stats compare --period 30d

# View cost breakdown with compute leverage and absorbed value metrics
code-insights stats cost --period 30d

# Inspect or adjust subscription plan monthly fees
code-insights config plans
code-insights config plans --set claude-pro.monthlyFee=21.00
code-insights config plans --set google-ai-premium.monthlyFee=19.99
code-insights config plans --set mistral-pro.monthlyFee=14.99
```

---

## Retrieval-Augmented Analysis

Code Insights now uses a sophisticated retrieval-augmented generation (RAG) pipeline for session analysis:

- **Annotated Chunking**: Intelligent segmentation respecting role boundaries, with parent/child splitting for long messages
- **Context Augmentation**: Retrieves relevant historical context (window + neighbors) to enhance analysis quality
- **Dynamic Query**: Adapts search queries based on session content and context needs

```bash
# Use rich terminal output for detailed analysis
code-insights insights <session_id> --format rich

# Or get JSON output for programmatic use
code-insights insights <session_id> --format json

# Quiet mode for scripting
code-insights insights <session_id> --format quiet
```

The rich format includes:
- **Score Bars**: Visual representation of insight quality scores
- **Severity Dots**: Indication of friction/importance levels
- **Emoji Headers**: Categorized insight types
- **Dimension Breakdown**: Coverage, precision, actionability metrics
- **Metrics Footer**: Session statistics and analysis summary

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
# Index messages and insights with Ollama (embeddinggemma:latest)
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
> Embeddings are configured via `OLLAMA_BASE_URL` (default: `http://127.0.0.1:11434`). It leverages `sqlite-vec` for native, lightning-fast in-database vector operations, and `FTS5` for BM25 keyword matching.

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
      │ SQLite DB (V13)                     │  ~/.code-insights/data.db
      │  ┌──────────┐  ┌──────────────────┐ │
      │  ┌──────────┐  ┌──────────────────┐ │
      │  │ Tables   │  │ Search Tables    │ │
      │  │ projects │  │ vec_insights     │ │
      │  │ sessions │  │ vec_messages     │ │
      │  │ messages │  │ messages_fts     │ │
      │  │ insights │  │ vec_analysis_chunks│ │
      │  └──────────┘  └──────────────────┘ │
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

── Retrieval-Augmented Analysis Pipeline ──
┌──────────────────────────────────────────────────────────────┐
│                                                                  │
│  Session Transcript                                             │
│        │                                                        │
│        ▼                                                        │
│  ┌──────────────────┐  ┌──────────────────────────┐            │
│  │ Annotated        │  │ Analysis Pipeline         │            │
│  │ Chunker          │───▶│ (embedding, readiness)    │            │
│  │ - role boundary   │  │                          │            │
│  │ - phase/signific  │  └──────────┬───────────────┘            │
│  │ - parent/child    │             │                            │
│  └──────────────────┘             ▼                            │
│                             ┌──────────────────────┐            │
│                             │ vec_analysis_chunks   │            │
│                             │ (KNN search)         │            │
│                             └──────────┬───────────┘            │
│                                        │                            │
│                                        ▼                            │
│                             ┌──────────────────────┐            │
│                             │ Retrieval Layer       │            │
│                             │ - threshold config    │            │
│                             │ - dynamic query       │            │
│                             │ - context window      │            │
│                             └──────────┬───────────┘            │
│                                        │                            │
│                                        ▼                            │
│                             ┌──────────────────────┐            │
│                             │ Rich Terminal Render  │            │
│                             │ - score bars          │            │
│                             │ - severity dots        │            │
│                             │ - dimension breakdown  │            │
│                             └──────────────────────┘            │
└──────────────────────────────────────────────────────────────┘
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
