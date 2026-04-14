# Architecture — Code Insights

> Technical architecture reference. Linked from [CLAUDE.md](../CLAUDE.md).

---

## Data Flow

```
Source tool session files -> Provider (discover + parse) -> SQLite -> Dashboard (localhost:7890)
                                                         -> CLI stats commands
                                                         -> Analysis Queue -> Background Worker -> LLM Analysis
```

---

## Repository Structure

```
code-insights/
├── cli/                    # Node.js CLI (Commander.js, SQLite, providers)
│   └── src/
│       ├── commands/       # CLI commands (init, sync, status, stats, dashboard, config, insights)
│       ├── commands/stats/ # Stats command suite (4-layer architecture)
│       ├── analysis/       # Prompt builders, response parsers, normalizers, runner interface (shared by CLI + server)
│       ├── providers/      # Source tool providers (claude-code, cursor, codex, copilot, copilot-cli, crush, opencode, hermes-agent, gemini-cli)
│       ├── parser/         # JSONL parsing, title generation
│       ├── db/             # SQLite schema, migrations, queries
│       ├── utils/          # Config, device, paths, telemetry
│       ├── types.ts        # Type definitions (SINGLE SOURCE OF TRUTH)
│       └── index.ts        # CLI entry point
├── dashboard/              # Vite + React SPA
│   └── src/
│       ├── components/     # React components (shadcn/ui)
│       │   ├── empty-states/  # Guided empty states (EmptyDashboard, EmptySessions, EmptyInsights)
│       │   ├── patterns/      # Patterns page components (WeekAtAGlanceStrip, WeekSelector)
│       │   └── sessions/      # Session management components (RenameSessionDialog)
│       ├── hooks/          # React Query hooks (useAnalysisQueue, useQueuedSessionIds)
│       ├── lib/            # LLM providers, utilities, telemetry
│       │   ├── share-card-utils.ts   # Canvas 2D share card rendering (drawShareCard, downloadShareCard)
│       │   ├── share-card-icons.ts   # Lucide icon + tool logo rendering for Canvas 2D
│       │   └── prompt-quality-utils.ts  # PQ category labels, strength set detection
│       └── App.tsx         # SPA entry point
│   └── public/
│       └── icons/          # Source tool logos (Claude Code SVG, Cursor PNG, Codex PNG, Copilot PNG)
├── server/                 # Hono API server
│   └── src/
│       ├── routes/         # REST API endpoints
│       ├── llm/            # LLM client, reflect synthesis, export, cost tracking; prompt builders re-exported from cli/src/analysis/
│       └── index.ts        # Server entry point
├── docs/                   # Product docs, plans, roadmap
│   └── plans/              # Design plans (pending implementation only)
└── .claude/                # Agent definitions, commands, hookify rules
    ├── agents/             # Agent definitions (engineer, TA, PM, etc.)
    └── commands/           # Team commands (start-feature, start-review)
```

### CLI Directory Detail (`/cli/src/`)

- `commands/` — CLI commands (init, sync, status, dashboard, reset, install-hook, config, reflect, telemetry, insights)
- `commands/stats/` — Stats command suite (4-layer architecture):
  - `data/types.ts` — `StatsDataSource` interface, `SessionRow`, error classes
  - `data/source.ts` — Data source factory
  - `data/local.ts` — SQLite data source implementation
  - `data/aggregation.ts` — Pure compute functions (overview, cost, projects, today, models)
  - `data/fuzzy-match.ts` — Levenshtein distance for `--project` name matching
  - `render/` — Terminal rendering (colors, format, charts, layout)
  - `actions/` — Action handlers for each subcommand + shared error handler
  - `index.ts` — Command tree with lazy imports
  - `shared.ts` — Shared CLI flags
- `providers/` — Source tool providers (claude-code, cursor, codex, copilot, copilot-cli, crush, opencode, hermes-agent, gemini-cli)
- `providers/types.ts` — `SessionProvider` interface
- `providers/registry.ts` — Provider registration and lookup
- `parser/jsonl.ts` — JSONL file parsing (used by ClaudeCodeProvider)
- `parser/titles.ts` — Smart session title generation (5-tier fallback strategy)
- `db/` — SQLite schema, migrations, query functions
- `db/queue.ts` — Analysis queue operations (enqueue, claim, mark completed/failed, status)
- `analysis/queue-worker.ts` — Background worker for processing analysis queue items
- `utils/config.ts` — Configuration management (~/.code-insights/config.json)
- `utils/device.ts` — Device ID generation, git remote detection, stable project IDs
- `utils/paths.ts` — Virtual path handling (shared by sync and stats)
- `utils/telemetry.ts` — PostHog telemetry (opt-out model, 14 event types)
- `types.ts` — TypeScript type definitions (SINGLE SOURCE OF TRUTH)
- `index.ts` — CLI entry point (Commander.js)

---

## Provider Architecture

All source tools are integrated via the `SessionProvider` interface (`providers/types.ts`):

```typescript
interface SessionProvider {
  getProviderName(): string;                                    // e.g. 'claude-code', 'cursor'
  discover(options?: { projectFilter?: string }): Promise<string[]>;  // Find session files
  parse(filePath: string): Promise<ParsedSession | null>;       // Parse into common format
}
```

Providers are registered in `providers/registry.ts`. To add a new source tool:
1. Create `providers/<name>.ts` implementing `SessionProvider`
2. Register it in `providers/registry.ts`
3. Add color entry to dashboard `SOURCE_TOOL_COLORS`
4. Add avatar case to dashboard `getAssistantConfig()`
5. Add tool name aliases if tool names differ
6. Add option to source filter dropdown

---

## SQLite Database

- **Location:** `~/.code-insights/data.db`
- **Mode:** WAL (concurrent reads during CLI sync)
- **Driver:** better-sqlite3 (synchronous, fast, no async overhead)
- **Schema:** Versioned migrations (V1–V9) applied on startup
- **Timestamps:** ISO 8601 strings

### Tables

| Table | Purpose | Schema Version |
|-------|---------|---------------|
| `projects` | Project metadata (id = hash of git remote URL or path) | V1 |
| `sessions` | Session metadata, titles, character classification, `deleted_at` soft-delete; V6 adds `compact_count INTEGER`, `auto_compact_count INTEGER`, `slash_commands TEXT` | V1, V5, V6 |
| `messages` | Full message content (stored during sync) | V1 |
| `insights` | LLM-generated insights (5 types) | V1, V2 (index) |
| `usage_stats` | Global usage aggregation | V1 |
| `session_facets` | Cross-session facet data (friction, patterns, workflow) | V3 |
| `reflect_snapshots` | Cached synthesis results, composite PK `(period, project_id, source_tool)` | V4 |
| `analysis_usage` | Per-session LLM analysis cost data, composite PK `(session_id, analysis_type)` | V7, V8 |
| `analysis_queue` | Analysis job queue for background processing, PK `session_id`, status lifecycle: pending → processing → completed/failed with retry logic | V9 |
| `schema_version` | Migration tracking | V1 |

---

## Type Architecture (CRITICAL)

Types are defined **once** in `cli/src/types.ts`. This is the single source of truth for the entire monorepo.

```
CLI (cli/src/types.ts)       -> Writes to SQLite
Server (server/src/)         -> Reads from SQLite, exposes via API
Dashboard (dashboard/src/)   -> Reads from Server API
```

**Rules:**
- New SQLite columns MUST have defaults or be nullable (backward compatible)
- Type changes in `types.ts` must be reflected in SQLite migrations
- TA owns this contract — flag all type changes to `technical-architect`

### Key Types (`cli/src/types.ts`)

| Type | Purpose |
|------|---------|
| `ClaudeMessage` | Individual message entry |
| `ParsedSession` | Aggregated session with metadata, title, character |
| `Insight` | Types: summary, decision, learning, technique, prompt_quality; source: 'llm' |
| `FrictionPoint` | Friction with category, severity, resolution, description; optional `attribution` field (`'user-actionable' \| 'ai-capability' \| 'environmental'`) |
| `EffectivePattern` | Pattern with required `category`, `description`, `confidence`; optional `driver` field (`'user-driven' \| 'ai-driven' \| 'collaborative'`); CoT `_reasoning` scratchpad stored in JSON blob |
| `SessionCharacter` | 7 classifications: deep_focus, bug_hunt, feature_build, exploration, refactor, learning, quick_task |
| `ClaudeInsightConfig` | Config format |
| `PQDimensionScores` | Per-dimension PQ averages (overall, context_provision, request_specificity, scope_management, information_timing, correction_quality); used by share card |
| `SyncState` | File modification tracking for incremental sync |

### Friction & Pattern Normalization

Both friction points and effective patterns use canonical category taxonomies with Levenshtein-based normalization (`server/src/llm/friction-normalize.ts`, `server/src/llm/pattern-normalize.ts`).

**Friction categories (9 canonical):** `wrong-approach`, `knowledge-gap`, `stale-assumptions`, `incomplete-requirements`, `context-loss`, `scope-creep`, `repeated-mistakes`, `documentation-gap`, `tooling-limitation`

**Effective pattern categories (8 canonical):** `structured-planning`, `incremental-implementation`, `verification-workflow`, `systematic-debugging`, `self-correction`, `context-gathering`, `domain-expertise`, `effective-tooling`

**Normalization pipeline:** exact match → alias lookup → Levenshtein (distance ≤ 2) → substring match → pass-through (novel category). Normalization runs at write time in `saveFacetsToDb()` and at read time as a belt-and-suspenders guard.

**Legacy alias remapping:** 11 old friction categories (from the original 15-category taxonomy) are aliased to the current 9. See `FRICTION_ALIASES` in `friction-normalize.ts`.

**Attribution model:** Each friction point carries an optional `attribution` field classifying who contributed: `user-actionable` (better input would have prevented it), `ai-capability` (AI failed despite adequate input), or `environmental` (external constraint). Old data without attribution is detected by the `/api/facets/outdated` endpoint.

---

## Server API Routes

### Core Resources

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/health` | GET | Server health check |
| `/api/projects` | GET | List all projects |
| `/api/projects/:id` | GET | Project detail |
| `/api/sessions` | GET | Session list with filters |
| `/api/sessions/:id` | GET | Session detail |
| `/api/sessions/:id` | PATCH | Update session (custom title, soft delete) |
| `/api/sessions/:id` | DELETE | Soft-delete a session |
| `/api/sessions/deleted/count` | GET | Count of soft-deleted sessions |
| `/api/messages/:sessionId` | GET | Message content for a session |
| `/api/insights` | GET | Browse generated insights |
| `/api/insights` | POST | Create an insight |
| `/api/insights/:id` | DELETE | Delete an insight |

### Analytics & Stats

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/analytics/dashboard` | GET | Analytics overview aggregation |
| `/api/analytics/usage` | GET | Global usage stats |

### Analysis (LLM-Powered)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/analysis/usage` | GET | Analysis cost/usage data per session |
| `/api/analysis/session` | POST | Trigger session analysis with LLM |
| `/api/analysis/session/stream` | GET | SSE streaming for session analysis |
| `/api/analysis/prompt-quality` | POST | Trigger prompt quality analysis |
| `/api/analysis/prompt-quality/stream` | GET | SSE streaming for PQ analysis |
| `/api/analysis/recurring` | POST | Find recurring insight patterns |
| `/api/analysis/queue` | GET | Analysis queue status for dashboard polling |

### Export

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/export/markdown` | POST | Session-level markdown export (Knowledge Base / Agent Rules templates) |
| `/api/export/generate` | POST | LLM-powered cross-session export synthesis (supports `dateFrom`/`dateTo` parameters for datetime range filtering) |
| `/api/export/generate/stream` | GET | SSE streaming for export generation |

**Export Filtering:** The export system supports datetime range filtering via optional `dateFrom`/`dateTo` parameters. Filtering is applied server-side on `insights.timestamp` using half-open interval semantics. See [ADR-export-datetime-range-filter.md](./architecture/decisions/ADR-export-datetime-range-filter.md) for implementation details.

### Facets

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/facets` | GET | Session facets data |
| `/api/facets/aggregated` | GET | Pre-aggregated friction/patterns |
| `/api/facets/missing` | GET | Sessions with insights but no facets |
| `/api/facets/outdated` | GET | Sessions missing `effective_patterns.category`/`driver` or `friction_points.attribution` |
| `/api/facets/backfill` | POST | Backfill facets for legacy sessions (`force` option) |
| `/api/facets/missing-pq` | GET | Sessions missing prompt quality analysis |
| `/api/facets/outdated-pq` | GET | Sessions with outdated prompt quality insights |
| `/api/facets/backfill-pq` | POST | Backfill prompt quality for sessions |

### Reflect (Cross-Session Synthesis)

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/reflect/generate` | POST | Cross-session LLM synthesis (SSE streaming) |
| `/api/reflect/results` | GET | Aggregated facet data without LLM synthesis |
| `/api/reflect/weeks` | GET | Last 8 ISO weeks with session counts and snapshot status |
| `/api/reflect/snapshot` | GET | Cached synthesis snapshot for a specific week/project |

### Configuration & Telemetry

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/config/llm` | GET | Current LLM configuration |
| `/api/config/llm` | PUT | Update LLM configuration |
| `/api/config/llm/test` | POST | Test LLM credentials |
| `/api/config/llm/ollama-models` | GET | Discover available Ollama models |
| `/api/telemetry/identity` | GET | Telemetry identity and opt-out status |

---

## Dashboard Pages

| Page | Route | Purpose |
|------|-------|---------|
| Dashboard | `/dashboard` | Overview with charts (`/` redirects here) |
| Sessions | `/sessions` | Session list with filters, inline session renaming via `RenameSessionDialog` |
| Session Detail | `/sessions/:id` | Full session with analyze button and session renaming capability |
| Insights | `/insights` | Browse generated insights |
| Analytics | `/analytics` | Charts: cost, models, projects |
| Patterns | `/patterns` | Cross-session synthesis (Friction & Wins, Rules & Skills, Working Style) |
| Export | `/export` | Enhanced 4-step wizard with datetime range filtering and format selection |
| Journal | `/journal` | Chronological timeline of learnings and decisions by ISO week |
| Settings | `/settings` | Configuration UI |

### Dashboard Architecture Enhancements

**Analysis Queue Integration:** All pages use the `useAnalysisQueue` hook for real-time polling of background analysis jobs. The hook polls `/api/analysis/queue` every 5 seconds when items are pending/processing, automatically invalidating `sessions` and `insights` queries when the queue drains.

**Session Management:** The `RenameSessionDialog` component provides inline session title editing across sessions list and detail pages. Uses the `PATCH /api/sessions/:id` endpoint with `customTitle` field. Empty titles revert to auto-generated titles.

**Enhanced Export Wizard:** The export page now features a 4-step wizard:
1. **Scope Selection:** All sessions vs. specific project
2. **Configure:** Format selection (markdown/json/notion/obsidian), depth (essential/standard/comprehensive), and datetime range filtering
3. **Generate:** Real-time streaming generation with progress tracking
4. **Review:** Download and copy capabilities with filename preview

**Queue Status Polling:** Multiple dashboard pages integrate queue polling for real-time "Analyzing..." badges and status updates. The `useQueuedSessionIds` hook provides session IDs currently in analysis queue for UI feedback.

### Key Dashboard Components & Hooks

**Analysis Queue Integration:**
- `useAnalysisQueue()` — Core polling hook with 5s intervals, smart cache invalidation
- `useQueuedSessionIds()` — Returns set of session IDs currently being analyzed
- Automatic query invalidation when queue drains to refresh sessions/insights

**Session Management:**
- `RenameSessionDialog` — Modal dialog for inline session title editing
- Supports custom titles with fallback to auto-generated titles
- Integrates with `PATCH /api/sessions/:id` endpoint

**Export Components:**
- Enhanced 4-step wizard with datetime range filtering
- Real-time progress tracking during LLM generation
- Format selection: markdown, JSON, Notion, Obsidian
- Depth controls with insight count previews

---

## Share Card Pipeline

The share card generates a 1200×630 PNG (OG image standard) from Canvas 2D:

```
PatternsPage → useFacetAggregation(period) → WeekAtAGlanceStrip → "Share" button
                                                                       ↓
                                              downloadShareCard() → drawShareCard()
                                                                       ↓
                                              Canvas 2D (2400×1260 @ 2× DPR) → toBlob() → PNG download
```

**Data sources for the card:**
- `computePQScores()` in `server/src/routes/shared-aggregation.ts` — 4-week rolling PQ dimension averages
- Working-style tagline from Reflect LLM synthesis
- Effective patterns from facet aggregation (top 3 by frequency)
- Lifetime session count (all-time, no date filter)
- Token sum from 4-week scoring window
- Source tools from sessions in scope

**Key files:**
- `dashboard/src/lib/share-card-utils.ts` — Canvas 2D drawing logic (`drawShareCard()`, `downloadShareCard()`)
- `dashboard/src/lib/share-card-icons.ts` — Lucide icon + tool logo rendering (`drawIcon()`, `drawToolIcon()`)
- `dashboard/src/components/patterns/WeekAtAGlanceStrip.tsx` — UI component with download trigger
- `dashboard/public/icons/` — Static tool logo assets (SVG/PNG)

---

## Analysis Queue Architecture

The analysis queue system provides asynchronous processing of session analysis requests through a background worker pattern:

```
Session End Hook → enqueue(sessionId) → analysis_queue table → Queue Worker → LLM Analysis
                                                             ↓
Dashboard Polling ← /api/analysis/queue ← getQueueStatus() ← Status Updates
```

### Queue Lifecycle

**Status Flow:** `pending` → `processing` → `completed` | `failed`
- Failed jobs retry up to 3 attempts before permanent failure
- Stale processing jobs (>10 minutes) reset to pending on worker startup
- Queue uses session_id as PRIMARY KEY (no duplicate jobs)

**Queue Operations (`cli/src/db/queue.ts`):**
- `enqueue(sessionId, runnerType)` — Add/replace session in queue
- `claimNext()` — Atomically claim next pending item
- `markCompleted(sessionId)` — Mark analysis successful
- `markFailed(sessionId, error)` — Mark failed and handle retries
- `resetStale()` — Reset stuck processing jobs to pending
- `getQueueStatus()` — Return counts and active items for dashboard polling

### Background Worker (`cli/src/analysis/queue-worker.ts`)

The queue worker processes items sequentially:
1. Reset any stale processing items from previous crashes
2. Claim next pending item atomically
3. Execute analysis using native runner (claude -p) or configured LLM provider
4. Mark completed/failed and continue until queue empty
5. Spawned as detached subprocess to avoid blocking CLI

**Hook Integration:**
- `session-end` hook enqueues analysis and spawns worker with `CODE_INSIGHTS_HOOK_ACTIVE=1`
- Environment variable prevents recursive hook triggering during analysis

### Dashboard Integration

Dashboard polls `/api/analysis/queue` at 5-second intervals when items are pending/processing. Returns queue status with counts by status and details for active items. Polling stops when queue is empty.

---

## Known Architectural Debt

Items identified during the production-grade audit (2026-03-21) and intentionally deferred. Revisit when their trigger conditions are met.

| Item | File | Trigger | Notes |
|------|------|---------|-------|
| Refactor `AnalysisContext` | `dashboard/src/components/analysis/AnalysisContext.tsx` (256 lines) | When parallel/concurrent analyses are needed | Currently mixes SSE streaming orchestration with React state management. Works correctly as a single-analysis state machine. Refactor into separate streaming hook + read-only context when concurrent analysis support is required. |
| Split `route-helpers.ts` | `server/src/routes/route-helpers.ts` (353 lines) | When SSE protocol or middleware evolves independently | 3 cohesive concerns (DB loading, middleware, SSE) always co-imported. Split only if concerns diverge. |
| Remaining `console.warn` monitors | `server/src/llm/response-parsers.ts` | After confirming classification quality is stable | 4 remaining monitors (`[friction-monitor]`, `[pattern-monitor]`) — add env toggle or remove once confident in LLM output quality. |
