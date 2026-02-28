# Code Insights Roadmap

## Overview

This roadmap outlines the development phases for Code Insights. Timelines are flexible—progress is driven by priorities and availability.

---

## Phase 1: Foundation ✅

**Goal:** Working end-to-end flow from AI session files to local dashboard

### Milestones

- [x] **1.1 Project Setup**
  - Single-repo pnpm workspace monorepo (`cli/`, `dashboard/`, `server/`)
  - TypeScript strict mode, ES Modules
  - Configuration system at `~/.code-insights/config.json`

- [x] **1.2 Claude Code Parser**
  - Parse Claude Code session files from `~/.claude/projects/`
  - Extract: sessions, messages, tool calls, timestamps
  - Smart session title generation (5-tier fallback)
  - Session character classification (7 types)
  - CLI command: `code-insights sync`

- [x] **1.3 SQLite Schema & Sync**
  - Local database at `~/.code-insights/data.db` (WAL mode)
  - Tables: projects, sessions, messages, insights
  - Incremental sync (tracks file modification times in `sync-state.json`)
  - Stable project IDs derived from git remote URLs
  - CLI command: `code-insights init`

- [x] **1.4 Basic Dashboard**
  - Session list view with filters (project, date)
  - Session detail view with message display
  - Insights display by type
  - Analytics page with Recharts charts

### Deliverables
- ✅ CLI tool that syncs sessions to local SQLite
- ✅ Local web dashboard served by `code-insights dashboard`

---

## Phase 2: Integration ✅

**Goal:** Seamless integration with Claude Code workflow and terminal analytics

### Milestones

- [x] **2.1 Claude Code Hook**
  - Post-session hook that triggers sync automatically
  - Quiet mode for background processing (`sync -q`)
  - `code-insights install-hook` / `code-insights uninstall-hook`

- [x] **2.2 CLI Stats Command Suite**
  - Terminal analytics: `stats`, `stats cost`, `stats projects`, `stats today`, `stats models`
  - Powered by local SQLite — zero external dependencies
  - Unicode sparklines, bar charts, semantic colors, responsive layout
  - Shared flags: `--period`, `--project`, `--source`, `--no-sync`

- [ ] **2.3 Enhanced Filtering**
  - Full-text search across sessions
  - Filter by: project, git branch, date range, insight type, source tool
  - Saved filters / bookmarks

### Deliverables
- ✅ Auto-sync via Claude Code hook
- ✅ CLI stats command suite with local analytics
- Enhanced filtering (pending)

---

## Phase 3: Intelligence ✅

**Goal:** LLM-powered deeper insights

### Milestones

- [x] **3.1 Multi-Provider LLM Integration**
  - Pluggable provider system (factory pattern)
  - OpenAI (gpt-4o, gpt-4o-mini, gpt-4-turbo)
  - Anthropic (claude-sonnet, claude-haiku, claude-opus)
  - Google Gemini (gemini-2.0-flash, gemini-1.5-pro/flash)
  - Ollama for local models (llama3.2, mistral, codellama)
  - LLM calls proxied server-side via Hono API (no browser CORS)
  - Token input capped at 80k

- [x] **3.2 Session Analysis**
  - "Analyze" button on session detail page
  - Bulk analyze for unanalyzed sessions
  - Generates 4 insight types: summary, decision, learning, technique
  - Analysis versioning for re-analysis

- [ ] **3.3 Cross-Session Patterns**
  - Cross-session pattern detection
  - Project-level and overall-level insights
  - Recurring pattern identification

- [ ] **3.4 Learning Journal**
  - Auto-generate "lessons learned" from sessions
  - Track recurring patterns and mistakes
  - Suggest areas for improvement

### Deliverables
- ✅ Multi-provider LLM insight generation
- ✅ On-demand and bulk session analysis
- Cross-session patterns (pending)
- Learning journal (pending)

---

## Phase 4: Feature Parity ✅

**Goal:** Port all dashboard features to the embedded local SPA and add multi-source support

### Milestones

- [x] **4.1 Vite + React SPA Foundation**
  - Vite SPA replacing Next.js (no SSR needed for localhost)
  - Hono API server embedding the SPA
  - React Query for server state, Tailwind CSS 4 + shadcn/ui

- [x] **4.2 Multi-Source Provider Support**
  - `SessionProvider` interface for source tool abstraction
  - Providers: `claude-code`, `cursor`, `codex-cli`, `copilot-cli`
  - `--source` filter flag in all stats and sync commands
  - Source tool display in dashboard (colors, avatars, filters)

- [x] **4.3 Dashboard Feature Parity**
  - Sessions list with source, project, date, character filters
  - Session detail with full message display and analyze button
  - Analytics page with cost, models, projects breakdown
  - Stats overview and project cards

- [ ] **4.4 Markdown Export**
  - Export by: session, day, week, project
  - Formats: Plain Markdown, Obsidian (with wikilinks), Notion
  - Export page in dashboard

### Deliverables
- ✅ Embedded local dashboard via `code-insights dashboard`
- ✅ Multi-source support (Claude Code, Cursor, Codex CLI, Copilot CLI)
- ✅ Full feature parity with original hosted dashboard
- Markdown export (in progress)

---

## Phase 5: Telemetry (In Progress)

**Goal:** Anonymous, opt-in usage signals to improve the tool without compromising privacy

### Milestones

- [ ] **5.1 Anonymous Aggregate Signals**
  - Opt-in only, disabled by default
  - Local export only — no phone-home during normal usage
  - Depth metrics: sessions analyzed, insights generated

- [ ] **5.2 Slash Commands**
  - `/insights` — Quick summary of recent sessions
  - `/insights today` — What you worked on today
  - `/insights decisions` — Recent architectural decisions

### Deliverables
- Anonymous telemetry (opt-in, pending)
- Slash commands (pending)

---

## Phase 6: Polish & Distribution

**Goal:** Production-ready distribution and community foundation

### Milestones

- [ ] **6.1 npm Distribution**
  - Publish as `@code-insights/cli`
  - Binary: `code-insights`
  - Pre-built dashboard SPA bundled in the package

- [ ] **6.2 Plugin Architecture**
  - Custom insight extractors
  - Dashboard widget API
  - Theme support

- [ ] **6.3 Community**
  - Static landing page at `code-insights.app`
  - Comprehensive setup guide and API documentation
  - Community-contributed export templates

### Deliverables
- Published npm package
- Plugin architecture foundation
- Community documentation

---

## Version Milestones

| Version | Phase | Key Features | Status |
|---------|-------|--------------|--------|
| 0.1.0 | 1 | CLI sync, SQLite schema, basic dashboard | ✅ Done |
| 0.2.0 | 1 | Smart titles, session classification | ✅ Done |
| 0.3.0 | 2 | Claude Code hook, CLI stats commands | ✅ Done |
| 0.4.0 | 3 | Multi-LLM analysis, bulk analyze | ✅ Done |
| 0.5.0 | 4 | Vite SPA + Hono server, embedded dashboard | ✅ Done |
| 0.6.0 | 4 | Multi-source support (Cursor, Codex, Copilot CLI) | ✅ Done |
| 0.7.0 | 4-5 | Markdown export, slash commands | Planned |
| 1.0.0 | 6 | npm publish, plugin architecture | Planned |

---

## Contributing

This is an open source project. Contributions welcome!

- **Issues**: Bug reports, feature requests
- **PRs**: Code contributions (please discuss first for large changes)
- **Docs**: Improvements to documentation
- **Providers**: New source tool providers

See CONTRIBUTING.md for guidelines.
