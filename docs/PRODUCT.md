# Code Insights

## What It Is

**Code Insights** is a local-first **Agent Cognitive Engine & Telemetry Infrastructure Platform**. It ingests raw AI coding conversations across 9+ developer tools and autonomous agents, extracting structured decision networks, systemic linguistic breakdowns (SFL), concept lattices (FCA), and semantic vector memories—all persisted locally in SQLite.

## The Problem

Modern AI coding workflows generate vast amounts of trapped cognitive telemetry across disparate formats:
- Claude Code streams append-only JSONL files.
- Cursor stores state in SQLite databases.
- OpenCode, Hermes Agent, and Codex CLI maintain their own relational and JSON schemas.
- Autonomous sub-agents (Mistral Vibe, Antigravity) branch into hierarchical, multi-turn trees.

Without a unified cognitive infrastructure:
- **Zero Attribution:** Critical architectural trade-offs blur between human intent and autonomous agent hallucinations.
- **Rage Loops & Sunk Cost:** Developers waste hours trapped in circular context loops without early detection.
- **Lost Semantic Memory:** Prior problem-solving breakthroughs, bug resolutions, and codebase context remain siloed and unsearchable.
- **Static Prompts:** Analysis and extraction prompts remain rigid rather than adapting to complex codebase patterns.

## The Solution

Code Insights delivers a comprehensive, local-first intelligence stack:

1. **Multi-Source Ingestion & Sub-Agent Bundling** — Normalizes 9+ AI coding tools and recursively merges hierarchical sub-agent sessions.
2. **SFL-Compliant Analysis Pipeline** — Deconstructs sessions into Systemic Functional Linguistics metafunctions (*Ideational*, *Interpersonal*, *Textual*) with hard constraint scoring (0–100) and pre-analysis rage loop detection.
3. **Formal Concept Analysis (FCA) Step Matrix** — Extracts sequential milestone steps into structured relational matrices (`session_steps`), tracking drivers, target files, test executions, and tool calls.
4. **Decision Attribution** — Attributes every technical choice to `user`, `agent`, or `collaborative` drivers with verifiable turn citations (`User#N` vs `Assistant#N`).
5. **Self-Optimizing Prompts (GEPA)** — Evolves extraction prompts against multi-objective fitness functions via `@ax-llm/ax`.
6. **Hybrid Semantic Memory (RAG)** — Unifies BM25 (FTS5 across messages and tool calls) + `sqlite-vec` KNN embeddings via Reciprocal Rank Fusion (RRF) with parent/child chunking (`entity_chunks`).
7. **Interactive RAG Agent Chat** — Chat with historical sessions and codebase memory via SSE streaming.
8. **Zero-Cost Reprocessing & Tombstoning** — Rebuilds schemas and attributes historical data purely locally ($0.00 spend) while permanently tombstoning deleted sessions.


LLM analysis uses your own API key, stored in `~/.code-insights/config.json` (mode 0o600). API calls go directly from the local server to your chosen LLM provider — not through any Code Insights infrastructure.

**Telemetry:** Anonymous, aggregate usage signals via PostHog. Opt-out model (enabled by default). Respects `CODE_INSIGHTS_TELEMETRY_DISABLED` and `DO_NOT_TRACK` environment variables. No PII collected. See `code-insights telemetry` to manage.

## Core Features

### Multi-Source Support

| Source Tool | What's Captured |
|-------------|-----------------|
| **Claude Code** | JSONL sessions from `~/.claude/projects/` |
| **Cursor** | Sessions from Cursor's local SQLite state (`state.vscdb`) |
| **Codex CLI** | Rollout files from `~/.codex/sessions/` |
| **Copilot CLI** | Event files from `~/.copilot/session-state/` |
| **VS Code Copilot Chat** | Sessions from VS Code Copilot Chat local storage |
| **Mistral Vibe** | Sub-agent hierarchy, recursive child session discovery, tool trajectories |
| **Hermes Agent** | Multi-profile SQLite databases in WAL mode |
| **Google Antigravity** | Protocol buffer (.pb) session state and CLI runner automation |
| **OpenCode** | Multi-schema SQLite storage (column and JSON-in-data formats) with JSON repair |
| **Pi AI** | Structured local conversation state |
| **Claude Desktop** | Local agent mode conversation archives |

### Insight & Telemetry Categories

| Category | What It Captures |
|----------|-----------------|
| **Summary** | Methodological narrative of what was accomplished (strictly avoiding mechanical file lists) |
| **Decision** | Architecture choices, trade-offs, reasoning, and agency attribution (`user` vs `agent`) with turn citations |
| **Learning** | Technical discoveries, mistakes, and transferable principles with SFL structural breakdown |
| **Technique** | Problem-solving approaches, debugging workflows, and optimization heuristics |
| **Prompt Quality** | Hard SFL constraint scoring (0–100) across 5 dimensions, 7 deficit + 3 strength categories, and actionable prompt refinement |
| **Step Matrix (FCA)** | 4–10 sequential milestones tracking driver, target, state, test runs (`ran_tests`), and tool usage (`used_tools`) |


### Export

Two-tier export system for turning session knowledge into shareable and actionable artifacts:

**Session-level export** — per-session export of insights with two templates:
- **Knowledge Base** — Human-readable markdown with full insight content
- **Agent Rules** — Imperative instructions formatted for CLAUDE.md/.cursorrules

**Export Page** — LLM-powered cross-session synthesis:
- Reads across multiple sessions' insights to deduplicate, merge, and synthesize
- Generates agent rules via LLM (not just template formatting)
- 4 output formats: Agent Rules, Knowledge Brief, Obsidian (YAML frontmatter), Notion
- 3 depth presets: Essential (~25 insights), Standard (~80), Comprehensive (~200)
- SSE streaming with progress phases, AbortSignal support, token budget guard

### Reflect & Patterns

Cross-session pattern detection and synthesis, powered by session facets:

**Session Facets** — Structured metadata extracted during LLM analysis for each session:
- Outcome satisfaction (high/medium/low/abandoned)
- Workflow pattern (iterative, plan-then-execute, exploratory, debugging, etc.)
- Friction points with 10 canonical AI-session-focused categories: wrong-approach, knowledge-gap, stale-assumptions, incomplete-requirements, context-loss, scope-creep, repeated-mistakes, rage-loop, documentation-gap, tooling-limitation
- **Rage Loop Detection:** Pre-analysis heuristic flags temporal loops and context stasis, triggering "Sunk Cost Alerts" in the dashboard.
- Friction attribution model: each friction point is classified as user-actionable (better input would have prevented it), ai-capability (AI failed despite adequate input), or environmental (external constraint)
- Effective patterns (what worked well and why, with 8 canonical categories)
- Course correction tracking (whether the session changed direction and why)

**CLI Commands:**
- `code-insights reflect` — Generate cross-session synthesis with LLM (friction analysis, rules/skills, working style)
- `code-insights reflect backfill` — Backfill facets for sessions analyzed before facet support
- `code-insights stats patterns` — View pattern summary in the terminal

**Dashboard Patterns Page** — Three synthesis sections with built-in threshold gates (requires a minimum of 8 sessions, displaying coverage warnings if < 50% are analyzed):
- **Working Style** — LLM-generated narrative describing your developer archetype, workflow distribution, and outcome trends.
- **Rules & Skills** — Copyable `CLAUDE.md` / `.cursorrules` configurations, skill recommendations, and hook suggestions derived directly from your session history.
- **Friction & Wins** — Top friction categories ranked by frequency, and effective patterns that worked.

**Technical details:**
- Dedicated `session_facets` SQLite table (Schema V3) with indexed scalar columns and JSON arrays
- Facet extraction integrated into the existing analysis prompt (facets first, then insights)
- Lightweight facet-only backfill for previously-analyzed sessions (summary + first/last 20 messages); `reflect backfill` finds both missing and outdated sessions in one pass
- Friction category normalization via Levenshtein distance matching to 9 canonical categories, with alias mapping for legacy category migration
- Effective patterns use the `driver` field (`user-driven`/`ai-driven`/`collaborative`) to attribute who drove the pattern; CoT `_reasoning` scratchpad captured for prompt tuning
- Attribution model: each friction point classified as `user-actionable`, `ai-capability`, or `environmental`
- Synthesis prompts pre-aggregate data in code, then feed ranked summaries to LLM for narration
- Reflect uses ISO week navigation (e.g., `2026-W10`) rather than sliding windows; `--week` CLI flag, `GET /api/reflect/weeks` endpoint for week history
- Reflect snapshots cached in `reflect_snapshots` table (Schema V4); `period` column stores ISO week strings
- 8-session minimum threshold for weekly scope synthesis; coverage warning when < 50% analyzed

**Upcoming:** Progress tracking — "Am I getting better?" Weekly snapshots comparing friction trends and pattern emergence over time, helping developers see how their AI collaboration skills evolve.

### Share Card (AI Fluency Score)

A shareable 1200×630 PNG image (OG standard for Twitter/X, LinkedIn, Slack, Discord) that visualizes a developer's AI coding fluency. Downloaded from the Patterns page.

**What's on the card:**
- **Archetype tagline** — LLM-generated identity label and subtitle descriptor from working-style synthesis (e.g., "The Methodical Achiever")
- **AI Fluency Score** — Composite 0–100 score derived from 5 Prompt Quality dimension averages, displayed as a hero circle with gradient arc
- **Fingerprint bars** — 5 rainbow-colored dimension bars showing per-dimension PQ scores:
  - Context (context_provision), Clarity (request_specificity), Focus (scope_management), Timing (information_timing), Orchestration (correction_quality)
- **Evidence lines** — "Score from N sessions · XK tokens · last 4 weeks" + "N lifetime sessions · [tool logos]"
- **Effective pattern pills** — Top 3 patterns by frequency (if data exists)
- **Tool logos** — Deduplicated source tool icons (Claude Code, Cursor, Codex CLI, GitHub Copilot)
- **CTA footer** — code-insights.app + `npx @code-insights/cli`

**Scoring window:** 4-week rolling window (last 4 ISO weeks) for stable, representative scores. Lifetime session count is all-time.

**Technical details:**
- Canvas 2D rendering at 2× DPR (2400×1260 internal) exported as 1200×630 PNG
- Dark gradient background with subtle radial glows
- System font stack with monospace fallback for code elements
- Tool logos loaded from `dashboard/public/icons/` static assets

### Zero-Config First Run

Running `code-insights` with no arguments works immediately — auto-creates the database, syncs sessions, and opens the dashboard. No `init` required. The dashboard includes guided empty states with CLI command snippets for first-time users.

### Knowledge Journal

The Journal page (`/journal`) provides a structured 2-tab layout for extracting insights over time:

- **Timeline Tab** — Chronological view grouped by ISO week with visual indicators (yellow dots for learnings, blue for decisions). Includes week headers showing total counts, newest-first ordering, and guided empty states when no data exists.
- **Patterns Tab** — LLM-powered pattern synthesis revealing recurring behaviors, with guided navigation to trigger cross-session analysis.

### Chat View Enhancements

Session detail chat view includes robust system event rendering across 7 user message kinds:
- **Message Kind Classification** — Distinct rendering for `human` (text input), `auto-compact` & `user-compact` (context break dividers), `slash-command` & `exit-command` (inline event chips), `skill-load` (tooling alerts), and `command-frame` (system execution boundaries).
- **Multi-Provider Avatars** — Distinct user and AI avatars based on the source tool (Claude, Cursor, Copilot, etc.).
- **Raw Message Toggle** — Seamlessly switch between the filtered human-readable view and the complete, raw conversation data.
- **Agent Message Rendering** — Task notifications (amber) and teammate messages (colored border).

### Dashboard Views

- **Dashboard** — Overview with activity charts, telemetry vitestrips, and active project scopes
- **Sessions** — Session list with source, project, date, and character filters
- **Session Detail** — Full session view featuring Rage Loop alerts, FCA step matrix, conversation search & pagination, structured exports, missing facet backfilling, and chat view enhancements
- **RAG Chat** — Interactive agent conversation interface powered by SSE streaming, AxAgent memories API, codebase memory tools, and hybrid vector+BM25 context
- **Insights** — Browse and search generated insights, decisions, and takeaways
- **Analytics** — Charts showing effort distribution, cost, models, projects, and subscription leverage
- **Patterns** — Cross-session pattern synthesis (Friction & Wins, Rules & Skills, Working Style) + Share Card download + Week-at-a-Glance strip
- **Export** — LLM-powered export wizard (4 formats, 3 depths, including Rails/FCA step matrices)
- **Journal** — Chronological timeline of learnings and decisions by ISO week
- **Settings** — Configuration UI for LLM providers, embedding models, and subscription plans


### CLI Command Reference

#### Setup & Sync

Running `code-insights` with no arguments automatically syncs sessions and opens the dashboard — no configuration required.

```bash
code-insights                              # Sync + open dashboard (zero-config)
code-insights init                         # Optional: customize settings (provider, API key)
code-insights sync                         # Sync sessions to SQLite
code-insights sync --force                 # Re-sync all sessions
code-insights sync --dry-run               # Preview without changes
code-insights sync -q                      # Quiet mode (for hook usage)
code-insights sync --source cursor         # Sync only from a specific tool
code-insights sync --verbose               # Verbose output
code-insights sync --regenerate-titles     # Regenerate session titles
code-insights sync prune                   # Soft-delete trivial sessions (≤2 messages, restorable with sync --force)
code-insights sync prune --hard            # Permanently purge and tombstone soft-deleted sessions
code-insights purge [id]                   # Permanently delete session(s) and record tombstone to prevent re-sync
code-insights reprocess                    # Zero-cost local backfill (v15 steps, decision attributions, FTS)
code-insights reprocess --dry-run          # Preview backfill counts without modifying database
code-insights status                       # Show sync statistics
code-insights install-hook                 # Auto-sync on session end (defaults to native codex and claude target)
code-insights install-hook --target vibe   # Install hook for Mistral Vibe
code-insights install-hook --target opencode # Install hook for OpenCode
code-insights install-hook --runner claude # Auto-sync using claude as runner
code-insights uninstall-hook               # Remove auto-sync hook from Claude
code-insights uninstall-hook --target vibe # Remove auto-sync hook from Mistral Vibe
code-insights uninstall-hook --target opencode # Remove auto-sync hook from OpenCode
code-insights insights [id]                # Run AI analysis on session (add --claude to use Claude Code)
code-insights insights check               # Check unanalyzed sessions (add --claude to use Claude Code)

```bash
code-insights dashboard                    # Start local server + open dashboard (auto-syncs first)
code-insights dashboard --no-sync          # Start server without syncing first
code-insights dashboard --port 8080        # Custom port (default: 7890)
code-insights dashboard --no-open          # Start server without opening browser
code-insights open                         # Open dashboard in browser (without starting server)
code-insights open --project               # Open filtered to the current project
```

#### Stats (Terminal Analytics)

```bash
code-insights stats                        # Overview (last 7 days)
code-insights stats cost                   # Cost breakdown by project and model
code-insights stats projects               # Per-project detail cards
code-insights stats today                  # Today's sessions with details
code-insights stats models                 # Model usage distribution
code-insights stats patterns               # Cross-session pattern summary
```

Stats shared flags:
- `--period 7d|30d|90d|all` — Time range (default: 7d)
- `--project <name>` — Scope to a specific project
- `--source <tool>` — Filter by source tool
- `--no-sync` — Skip auto-sync before showing stats

#### Reflect (Cross-Session Synthesis)

```bash
code-insights reflect                      # Cross-session LLM synthesis (current ISO week)
code-insights reflect --week 2026-W11      # Synthesis for a specific ISO week
code-insights reflect --section friction-wins   # Only generate one section
code-insights reflect --project myproject  # Scope to a specific project
code-insights reflect backfill             # Backfill facets for legacy sessions
code-insights reflect backfill --period 30d     # Backfill within time range (7d|30d|90d|all)
code-insights reflect backfill --project <name> # Backfill for specific project
code-insights reflect backfill --dry-run        # Show count without backfilling
code-insights reflect backfill --prompt-quality # Run prompt quality analysis instead of facets
```

Reflect `--section` values: `friction-wins`, `rules-skills`, `working-style`

#### Configuration

```bash
code-insights config                       # Show current configuration
code-insights config set <key> <value>     # Set config value (e.g., telemetry)
code-insights config llm                   # Configure LLM provider interactively
code-insights config llm --provider openai # Set provider directly
code-insights config llm --model gpt-4o   # Set model
code-insights config llm --api-key <key>  # Set API key
code-insights config llm --base-url <url> # Set custom base URL (Ollama, proxies)
code-insights config llm --show           # Show current LLM configuration
```

#### Telemetry

```bash
code-insights telemetry                    # Show telemetry status
code-insights telemetry status             # Show state and what data is collected
code-insights telemetry disable            # Disable anonymous telemetry
code-insights telemetry enable             # Enable anonymous telemetry
```

#### Other

```bash
code-insights reset --confirm              # Delete all local data
```

### LLM Cost Tracking

Per-session analysis costs are tracked in the `analysis_usage` SQLite table (Schema V7). Each analysis call records provider, model, token counts (including cache creation/read tokens), estimated USD cost, and duration. The dashboard shows cost per session after analysis runs. Cost data is also available via the `/api/analysis/usage` endpoint.

### Message Classification (Schema V6)

The `sessions` table tracks three context signals from Claude Code sessions: `compact_count` (explicit `/compact` invocations), `auto_compact_count` (auto-compact triggers), and `slash_commands` (all non-exit slash commands used). These signals feed into session characterization and are available for display in session detail views.

## Multi-Source Architecture

Code Insights uses a **provider abstraction** to support multiple AI coding tools through a common interface:

```
Source tool session files -> Provider (discover + parse) -> SQLite -> Dashboard / CLI stats
```

Each provider implements the `SessionProvider` interface (`discover()`, `parse()`, `getProviderName()`), normalizing tool-specific formats into the shared `ParsedSession` schema.

### How Each Tool Stores Sessions

| Tool | Format | Location (macOS) |
|------|--------|-----------------|
| **Claude Code** | JSONL (append-only, one JSON object per line) | `~/.claude/projects/<path>/<id>.jsonl` |
| **Cursor** | SQLite key-value (`state.vscdb`, JSON blobs) | `~/Library/Application Support/Cursor/User/` |
| **Codex CLI** | JSONL (event-based stream) | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **Copilot CLI** | JSONL (events) | `~/.copilot/session-state/{id}/events.jsonl` |
| **VS Code Copilot Chat** | JSON | Platform-specific Copilot Chat storage |

### Platform Paths

| Tool | macOS | Linux | Windows |
|------|-------|-------|---------|
| Claude Code | `~/.claude/projects/` | `~/.claude/projects/` | `%USERPROFILE%\.claude\projects\` |
| Cursor | `~/Library/Application Support/Cursor/User/` | `~/.config/Cursor/User/` | `%APPDATA%\Cursor\User\` |
| Codex CLI | `~/.codex/sessions/` | `~/.codex/sessions/` | `%USERPROFILE%\.codex\sessions\` |
| Copilot CLI | `~/.copilot/session-state/` | `~/.copilot/session-state/` | `%USERPROFILE%\.copilot\session-state\` |
| Mistral Vibe | `~/.vibe/logs/session/` | `~/.vibe/logs/session/` | `%USERPROFILE%\.vibe\logs\session\` |
| Hermes Agent | `~/.hermes/` | `~/.hermes/` | `%USERPROFILE%\.hermes\` |
| Antigravity | `~/.gemini/antigravity-cli/brain/` | `~/.gemini/antigravity-cli/brain/` | `%USERPROFILE%\.gemini\antigravity-cli\brain\` |
| OpenCode | `~/.local/share/opencode/` | `~/.local/share/opencode/` | `%APPDATA%\opencode\` |

Adding a new source tool requires implementing the `SessionProvider` interface in `cli/src/providers/`, registering it in the provider registry, and adding dashboard display support (colors, avatars, filter options).

## Tech Stack

- **CLI**: Node.js (ES2022, ES Modules), Commander.js, `@ax-llm/ax`
- **Database**: SQLite (`better-sqlite3`) with WAL mode at `~/.code-insights/data.db` — **Schema V16**
- **Vector Engine**: `sqlite-vec` native extension for KNN cosine embeddings
- **Server**: Hono — lightweight API server, serves dashboard SPA at `localhost:7890`
- **Dashboard**: Vite + React 19 SPA, Tailwind CSS 4 + shadcn/ui
- **AI & RAG**: Multi-provider — OpenAI, Anthropic, Gemini, Ollama, OpenRouter, Mistral (local-first proxy)
- **Telemetry**: PostHog (opt-out, anonymous device ID, no PII)
- **Package Manager**: pnpm (workspace monorepo: `cli/`, `dashboard/`, `server/`)


## Success Metrics

- Time to first insight: < 5 minutes from install
- User can answer "what did I work on this week?" in one click
- Decisions are searchable and linkable
- Zero cloud dependencies after install
