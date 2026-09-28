# Code Insights Vision

## Philosophy

**Cognitive telemetry, systemic linguistic auditing, and local-first agent memory.**

Code Insights is an open-source **Agent Cognitive Engine & Telemetry Infrastructure Platform**. It moves beyond passive retrospective journaling to transform raw human-agent conversations into structured semantic intelligence, rigorous linguistic evaluations, and autonomous agent memories.

Built on the principle of absolute data sovereignty, all cognitive artifacts, vector embeddings, and concept matrices remain 100% local on your machine.

---

## Core Pillars

### 1. Cognitive Architecture & Runtime Continuity
Unlike tools that merely build a retrospective "mirror" or focus on social publishing, Code Insights provides the foundational substrate for agent runtime intelligence:
- **Systemic Functional Linguistics (SFL):** Deconstructs human-AI collaboration across three metafunctions: *Ideational* (logical domain content), *Interpersonal* (power dynamics, directive vs. collaborative agency), and *Textual* (cohesion and structural framing).
- **Formal Concept Analysis (FCA):** Captures sequential execution episodes into structured step matrices (`session_steps`), deriving concept lattices over canonical binary attributes (test verification, tool execution, course correction, targeting).
- **Decision Attribution:** Distinguishes human intent from agent execution (`user` vs `agent` vs `collaborative`) grounded in verifiable turn-level evidence citations (`User#N` vs `Assistant#N`).

### 2. Genetic Prompt Evolution (GEPA)
Through deep integration with `@ax-llm/ax`, Code Insights treats prompt engineering as an empirical, automated science. The **Gradient-free Evolutionary Prompt Adaptation (GEPA)** engine continually optimizes extraction and analysis signatures against multi-objective fitness functions (coverage, precision, brevity, actionability).

### 3. Hybrid Semantic Memory (RAG)
Trapped conversational history is unlocked through a unified multi-strategy retrieval pipeline:
- High-performance **`sqlite-vec`** vector similarity search with cosine distance.
- **FTS5 BM25** full-text search indexing messages, tool calls, and tool execution outputs.
- **Reciprocal Rank Fusion (RRF)** merging sparse lexical and dense semantic signals.
- **Parent/Child RAG Chunking** (`entity_chunks`) preserving granular semantic citations alongside macro-session context.
- **Interactive Agent Chat** (`RagChatPage`) with streaming SSE and AxAgent memory integration.

### 4. Zero-Cost Data Hygiene & Sovereignty
- **Zero-Cost Reprocessing:** Schema upgrades (such as step matrix extraction and decision backfilling) run purely against local SQLite metadata at **$0.00 API cost**.
- **Permanent Tombstoning:** Schema v16 `deleted_sessions` guards permanently prevent purged sessions from being resurrected during sync.
- **Economic Leverage:** Computes true developer leverage by contrasting flat subscription fees against raw token consumption.

---

## Long-Term Direction

### Phases 1–10: Foundation to Reflect & UX ✅
- **Phase 1–4**: CLI sync, SQLite schema (V1–V5), multi-source parsers (Claude Code, Cursor, Codex, Copilot), Vite+React SPA, Hono server.
- **Phase 5–7**: Anonymous telemetry (opt-out), npm distribution, Knowledge Base & Agent Rules export, prompt quality analysis.
- **Phase 8–10**: Session facets (Schema V3/V4), ISO week navigation, message classification (Schema V6), LLM cost tracking (Schema V7), shareable AI Fluency cards.

### Phase 11: GEPA Prompt Optimization (`@ax-llm/ax`) ✅
- Gradient-free Evolutionary Prompt Adaptation engine for auto-tuning insight extraction.
- Multi-objective fitness evaluations (coverage, precision, actionability, brevity).
- 12 comprehensive AxAgent skills and `code-insights optimize` CLI command suite.

### Phase 12: Native Analysis & Multi-Level Runner Chains ✅
- Zero-config headless session analysis using locally installed CLIs.
- Robust fallback chains: **Codex → Claude Code → Antigravity → Mistral Vibe**.
- Automatic limit detection with mid-stream runner switching.

### Phase 13: Sub-Agent Hierarchies & Multi-Provider Ingestion ✅
- First-class support for nested sub-agent architectures (Mistral Vibe recursive hierarchy).
- Multi-profile SQLite WAL ingestion for Hermes Agent.
- Protocol buffer decoding and CLI runner integration for Google Antigravity.
- Resilient SQLite extraction with JSON repair for OpenCode.

### Phase 14: SFL Linguistic Auditing & Rage Loop Detection ✅
- Hard SFL constraint scoring (0=catastrophic, 50=baseline, 100=flawless).
- Pre-analysis heuristic rage loop detector (`loop-detector.ts`) and Sunk Cost Alert dashboard banner.
- Methodological narrative enforcement forbidding superficial file listing.

### Phase 15: Hybrid Vector & BM25 Search Engine ✅
- Integration of `sqlite-vec` for local KNN embedding similarity.
- Schema v12 & v13 FTS5 virtual tables indexing content, tool calls, and tool results.
- Reciprocal Rank Fusion (RRF) combining vector and BM25 rank lists.
- Parent/child chunking (`entity_chunks` table, Schema v14) with dynamic Ollama dimension auto-detection.
- Interactive RAG Agent Chat (`/chat`) with SSE streaming and codebase context.

### Phase 16: Formal Concept Analysis (FCA) & Decision Attribution ✅
- Relational `session_steps` table (Schema v15) recording milestone steps, drivers, targets, and tool runs.
- Evidence-based decision attribution classifying decisions by agency (`user`, `agent`, `collaborative`).
- Export endpoints for formal concept lattice derivation and Rails ActiveRecord ingestion.

### Phase 17: Zero-Cost Reprocessing & Permanent Tombstoning ✅
- `code-insights reprocess`: zero-cost local schema and step backfilling without LLM API spend.
- `deleted_sessions` tombstone table (Schema v16) preventing zombie resurrection on sync.
- Subscription plan leverage economics calculation.

---

## What's Next

- **Concept Lattice Visualization:** Interactive FCA concept lattice explorer in the dashboard showing structural workflows and skill progression.
- **Cross-Session Agent Trajectory Handoff:** Exporting cognitive state directly to runtime agent contexts (e.g. MCP memory servers, Claude Code memory).
- **Autonomous Prompt Synthesis Sidecar:** Real-time background prompt refinement injecting dynamic suggestions into active IDE workflows.

---

## Non-Goals

- **Not a social distribution / blogging platform:** Unlike upstream's Dispatch feature, this project does not prioritize generating public LinkedIn posts or blog summaries.
- **Not a centralized cloud platform:** No hosted accounts, no multi-tenant Supabase database. Everything remains local.
- **No paid API lock-in for data maintenance:** Schema evolutions and structural normalization must always support zero-cost local backfilling.

---

## Success Looks Like

An engineer or autonomous agent launches Code Insights and gains:
1. Complete, queryable cognitive telemetry across every AI coding tool on their system.
2. Verifiable attribution of every architectural decision and milestone step.
3. Sub-second hybrid semantic retrieval across all historical conversations and tool executions.
4. Continuous, self-optimizing prompt performance grounded in systemic functional linguistics.

