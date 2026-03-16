# Code Insights Roadmap

## Overview

This roadmap outlines the development phases for Code Insights. Timelines are flexible—progress is driven by priorities and availability.

---

## Phases 1–6 (Complete)

| Phase | Goal | Key Deliverables |
|-------|------|-----------------|
| **1. Foundation** ✅ | End-to-end flow | CLI sync, SQLite schema, Claude Code parser, basic dashboard |
| **2. Integration** ✅ | Workflow integration | Claude Code hook (`install-hook`), CLI stats suite (5 subcommands) |
| **3. Intelligence** ✅ | LLM-powered insights | Multi-provider LLM (OpenAI, Anthropic, Gemini, Ollama), session analysis, 4 insight types |
| **4. Feature Parity** ✅ | Local SPA + multi-source | Vite + React SPA, 5 providers (claude-code, cursor, codex-cli, copilot-cli, copilot), session-level export |
| **5. Telemetry** ✅ | Anonymous usage signals | PostHog (opt-out model, 14 event types, anonymous device ID) |
| **6. Distribution** ✅ | npm publish + docs | `@code-insights/cli` on npm, landing page at code-insights.app |

### Pending from earlier phases
- **2.3 Enhanced Filtering** — Full-text search, saved filters/bookmarks
- **3.4 Learning Journal** — Auto-generated "lessons learned" from sessions
- **5.2 Slash Commands** — `/insights`, `/insights today`, `/insights decisions`
- **6.3 Plugin Architecture** — Custom insight extractors, dashboard widget API (deferred)

---

## Phase 7: Export & Knowledge Pipeline ✅

**Goal:** Turn session insights into actionable knowledge artifacts via LLM-powered synthesis

### Milestones

- [x] **7.1 Session-Level Export Templates** (v3.5.1) ✅
  - Knowledge Base template (human-readable markdown with full insight content)
  - Agent Rules template (imperative instructions for CLAUDE.md/.cursorrules)
  - Prompt quality analysis in exports (efficiency scores, anti-patterns, wasted turns)
  - Template selector + Copy to Clipboard in dashboard

- [x] **7.2 LLM-Powered Export Page** (v3.6.0) ✅
  - Cross-session insight synthesis via LLM (not just template formatting)
  - Deduplicates overlapping learnings, resolves conflicting decisions
  - Uses existing multi-provider LLM abstraction
  - 3 depth presets (Essential/Standard/Comprehensive)
  - SSE streaming with progress phases, AbortSignal support, token budget guard

- [x] **7.3 Multi-Format Export** (v3.6.0) ✅
  - Agent Rules (CLAUDE.md / .cursorrules / codex config)
  - Knowledge Brief (general purpose markdown, shareable)
  - Obsidian (markdown + YAML frontmatter, tags, wikilinks)
  - Notion (Notion-compatible markdown with toggle blocks, callouts, tables)

### Deliverables
- ✅ Session-level export with two templates
- ✅ LLM-powered cross-session synthesis
- ✅ Multi-format output (Agent Rules, Knowledge Brief, Obsidian, Notion)

---

## Phase 8: Reflect & Patterns ✅

**Goal:** Cross-session pattern detection and synthesis — turning individual session facets into actionable insights about friction, effective patterns, and working style

### Milestones

- [x] **8.1 Session Facets Infrastructure** (v3.6.1) ✅
  - New `session_facets` SQLite table (Schema V3 migration)
  - Per-session structured metadata: outcome, workflow, friction, effective patterns, course correction
  - Facet extraction integrated into existing analysis prompt

- [x] **8.2 Friction Normalization** (v3.6.1) ✅
  - Canonical friction categories defined in analysis prompt
  - Levenshtein distance matching (exact → distance ≤ 2 → substring → passthrough)

- [x] **8.3 Server APIs** (v3.6.1) ✅
  - `GET /api/facets`, `GET /api/facets/aggregated`, `POST /api/facets/backfill`
  - `POST /api/reflect/generate` — SSE streaming LLM synthesis

- [x] **8.4 CLI Commands** (v3.6.1) ✅
  - `code-insights reflect` — Cross-session synthesis with LLM
  - `code-insights stats patterns` — Pattern summary in terminal

- [x] **8.5 Dashboard Patterns Page** (v3.6.1) ✅
  - Three-tab layout: Friction & Wins, Rules & Skills, Working Style
  - ARIA-accessible tab navigation, copy-to-clipboard

- [x] **8.6 Persistence & Guardrails** (v3.6.1) ✅
  - Schema V4: `reflect_snapshots` table with upsert semantics
  - 20-session minimum threshold, < 50% coverage warning
  - Snapshot auto-load, staleness indicator, project filter

- [x] **8.7 Facet Backfill CLI** (v3.6.1) ✅
  - `code-insights reflect backfill` for legacy session facet extraction
  - `GET /api/facets/missing` endpoint for backfill discovery

- [x] **8.8 Effective Pattern Normalization** (PR #125) ✅
  - 8 canonical effective pattern categories with confidence filtering
  - Pattern normalizer with Levenshtein matching (mirrors friction normalizer)

- [x] **8.9 Patterns Page Refinement** (v3.6.1) ✅
  - Outcome badge and usage stats on session detail
  - Source tool badge for all sessions

- [x] **8.10 Friction Taxonomy Revision** (PR #127) ✅
  - 15 generic categories → 9 AI-session-focused categories (wrong-approach, knowledge-gap, stale-assumptions, incomplete-requirements, context-loss, scope-creep, repeated-mistakes, documentation-gap, tooling-limitation)
  - 11 legacy alias remappings for backward compatibility
  - Attribution model: each friction point classified as user-actionable, ai-capability, or environmental
  - Contrastive classification guidance with evidence-based decision tree
  - Friction bar chart → category+description list (matching effective patterns layout)

### Deliverables
- ✅ Session facets with Schema V3 migration
- ✅ Cross-session pattern synthesis via LLM
- ✅ CLI reflect command and stats patterns subcommand
- ✅ Dashboard Patterns page with three synthesis sections
- ✅ Snapshot caching, guardrails, backfill CLI
- ✅ Friction taxonomy revision (15→9) with attribution model

---

## Phase 8.5: Taxonomy & Classification Refinement ✅

**Goal:** Deepen the quality of facet classification with richer taxonomy, attribution model, and ISO week navigation

### Milestones

- [x] **8.5.1 Effective Pattern Taxonomy Revision** (PR #129) ✅
  - `driver` field on `EffectivePattern`: `user-driven` / `ai-driven` / `collaborative`
  - Contrastive classification guidance with in-session signal detection
  - Outdated detection for sessions missing `driver` or `category`

- [x] **8.5.2 Prompt Quality Taxonomy Revision** (PR #136) ✅
  - 7 deficit categories + 3 strength categories (replacing efficiency scores)
  - 5 dimension scores: `context_provision`, `request_specificity`, `scope_management`, `information_timing`, `correction_quality`
  - Two-layer output: user takeaways (before/after) + categorized findings for Reflect aggregation

- [x] **8.5.3 ISO Week Navigation for Reflect** (PR #132) ✅
  - Replaced sliding windows (7d/30d/90d) with ISO week navigation (`2026-W10`)
  - `GET /api/reflect/weeks` returns last 8 weeks with session counts and snapshot status
  - `MIN_FACETS_FOR_REFLECT` lowered from 20 → 8 for weekly scope

- [x] **8.5.4 Attribution Rewrite** (PR #138) ✅
  - CoT `_reasoning` scratchpad field forces model to reason before classifying
  - Actor-neutral friction category definitions
  - User infrastructure recognition in pattern driver decision tree

---

## Phase 9: Infrastructure & Reliability ✅

**Goal:** Strengthen the data pipeline with message classification, prompt caching, and cost tracking

### Milestones

- [x] **9.1 Message Classification V6 Schema** (PRs #151, #154) ✅
  - `compact_count`, `auto_compact_count`, `slash_commands` columns on sessions
  - Analysis prompt updated to use V6 context signals

- [x] **9.2 Prompt Caching** (PR #180) ✅
  - Provider-native shared prefix caching for Anthropic
  - Cache creation/read token counts tracked in `analysis_usage`

- [x] **9.3 LLM Cost Tracking V7 Schema** (PR #181) ✅
  - `analysis_usage` table: per-session cost with provider, model, tokens, duration
  - Pricing calculator for OpenAI, Anthropic, Gemini, Ollama
  - Dashboard cost UI on session detail and `/api/analysis/usage` endpoint

---

## Version Milestones

| Version | Phase | Key Features | Status |
|---------|-------|--------------|--------|
| 0.1.0 | 1 | CLI sync, SQLite schema, basic dashboard | ✅ Done |
| 0.2.0 | 1 | Smart titles, session classification | ✅ Done |
| 0.3.0 | 2 | Claude Code hook, CLI stats commands | ✅ Done |
| 0.4.0 | 3 | Multi-LLM analysis, bulk analyze | ✅ Done |
| 0.5.0 | 4 | Vite SPA + Hono server, embedded dashboard | ✅ Done |
| 0.6.0 | 4 | Multi-source support (Cursor, Codex, Copilot CLI, VS Code Copilot Chat) | ✅ Done |
| 3.0.0 | 6 | npm publish, local-first migration, README rewrite | ✅ Done |
| 3.1.0 | 6 | Server runtime deps fix, dashboard path fallback | ✅ Done |
| 3.2.0 | 4 | Dashboard polish — skeletons, ErrorCard, toasts, bundle audit | ✅ Done |
| 3.3.0 | 5 | PostHog anonymous telemetry (opt-out model) | ✅ Done |
| 3.4.0 | — | Multi-source parser fixes (Codex, Cursor, Copilot), agent message rendering | ✅ Done |
| 3.5.1 | 7 | Session-level export templates (Knowledge Base, Agent Rules), prompt quality | ✅ Done |
| 3.6.0 | 7 | LLM-powered Export Page (cross-session synthesis, 4 formats, SSE streaming) | ✅ Done |
| 4.0.0 | 8–9 | Reflect & Patterns, taxonomy revisions, ISO weeks, prompt caching, cost tracking (Schema V7) | ✅ Done |

---

## What's Next

- Progress tracking: weekly snapshots, friction-to-pattern affinity map (ships here, not in taxonomy PR), transformation detection, `driver`-based filtering for user growth signals
- Test suite expansion (Vitest)
- Session merging across tools (linking related sessions from different AI tools)
- Gamification and shareable badges (see `docs/plans/2026-03-08-gamification-shareable-badges.md`)

---

## Contributing

This is an open source project. Contributions welcome!

- **Issues**: Bug reports, feature requests
- **PRs**: Code contributions (please discuss first for large changes)
- **Docs**: Improvements to documentation
- **Providers**: New source tool providers

See CONTRIBUTING.md for guidelines.
