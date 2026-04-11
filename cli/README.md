<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/logo.svg" width="80" height="80" alt="Code Insights logo" />
</p>

<h1 align="center">Code Insights CLI</h1>

Extract decisions, learnings, and prompt quality scores from your AI coding sessions. Detect cross-session patterns. Get better at working with AI. Stores structured data in a local SQLite database and serves a built-in browser dashboard with LLM-powered synthesis.

**Local-first. No accounts. No cloud. No data leaves your machine.**

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/code-insights-ai-fluency-score.png" alt="AI Fluency Score — your coding fingerprint across tools" width="600" />
</p>

## Quick Start

```bash
# Try instantly (no install needed)
npx @code-insights/cli

# Or install globally
npm install -g @code-insights/cli
code-insights                          # sync sessions + open dashboard
```

The dashboard opens at `http://localhost:7890` and shows your sessions, analytics, and LLM-powered insights.

### Individual commands

```bash
code-insights stats                    # terminal analytics (no dashboard needed)
code-insights stats today              # today's sessions

code-insights dashboard                # start dashboard server (auto-syncs first)
code-insights dashboard --no-sync      # start dashboard without syncing
code-insights sync                     # sync sessions only
code-insights queue status             # check analysis queue
code-insights insights check           # find unanalyzed sessions
code-insights init                     # customize settings (optional)
```

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/session-insight-light.png" alt="Session detail — insights, learnings, decisions, and conversation" width="800" />
</p>

## Supported Tools

| Tool | Data Location |
|------|---------------|
| **Claude Code** | `~/.claude/projects/**/*.jsonl` |
| **Cursor** | Workspace storage SQLite (macOS, Linux, Windows) |
| **Codex CLI** | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| **Copilot CLI** | `~/.copilot/session-state/{id}/events.jsonl` |
| **VS Code Copilot Chat** | Platform-specific Copilot Chat storage |

Sessions from all tools are discovered automatically during sync.

## Dashboard

```bash
code-insights dashboard
```

Opens the built-in React dashboard at `http://localhost:7890`. The dashboard provides:

- **Session Browser** — global search (`Cmd+K`), advanced filters (date range, outcome, saved presets), soft-delete, and full session details with chat view
- **Analytics** — usage patterns, cost trends, activity charts
- **LLM Insights** — AI-generated summaries, decisions, learnings, and prompt quality analysis (7 deficit + 3 strength categories with dimension scores)
- **Patterns** — weekly cross-session synthesis: friction points (with attribution), effective patterns (with driver classification), working style rules, and shareable AI Fluency Score card (downloadable 1200×630 PNG with score circle, fingerprint bars, and effective patterns)
- **Export** — LLM-powered cross-session synthesis in 4 formats (Agent Rules, Knowledge Brief, Obsidian, Notion)
- **Settings** — configure your LLM provider for analysis

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/patterns-light.png" alt="Patterns — friction points, effective patterns, working style profile" width="800" />
</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/analytics-light.png" alt="Analytics — activity charts, model usage, cost breakdown, project table" width="800" />
</p>

### Options

```bash
code-insights dashboard --port 8080    # Custom port
code-insights dashboard --no-open      # Start server without opening browser
```

## CLI Commands

### Setup & Configuration

```bash
# Sync sessions and open dashboard — no setup required
code-insights

# Customize settings (optional) — prompts for Claude dir, excluded projects, etc.
code-insights init

# Show current configuration
code-insights config

# Configure LLM provider for session analysis (interactive)
code-insights config llm

# Configure LLM provider with flags (non-interactive)
code-insights config llm --provider anthropic --model claude-sonnet-4-20250514 --api-key sk-ant-...

# Show current LLM configuration
code-insights config llm --show

# Set a config value (e.g., disable telemetry)
code-insights config set telemetry false
```

### Sync

```bash
# Sync new and modified sessions (incremental)
code-insights sync

# Force re-sync all sessions
code-insights sync --force

# Preview what would be synced (no changes made)
code-insights sync --dry-run

# Sync only from a specific tool
code-insights sync --source cursor
code-insights sync --source claude-code
code-insights sync --source codex-cli
code-insights sync --source copilot-cli

# Sync only sessions from a specific project
code-insights sync --project "my-project"

# Quiet mode (useful for hooks)
code-insights sync -q

# Show diagnostic warnings from providers
code-insights sync --verbose

# Regenerate titles for all sessions
code-insights sync --regenerate-titles

# Soft-delete sessions (preview + confirm)
code-insights sync prune
```

### Terminal Analytics

```bash
# Overview: sessions, cost, activity (last 7 days)
code-insights stats

# Cost breakdown by project and model
code-insights stats cost

# Per-project detail cards
code-insights stats projects

# Today's sessions with time, cost, and model details
code-insights stats today

# Model usage distribution and cost chart
code-insights stats models

# Cross-session patterns summary
code-insights stats patterns
```

<p align="center">
  <img src="https://raw.githubusercontent.com/melagiri/code-insights/master/docs/assets/screenshots/stats.png" alt="Terminal stats — sessions, cost, activity chart, top projects" width="500" />
</p>

**Shared flags for all `stats` subcommands:**

| Flag | Description |
|------|-------------|
| `--period 7d\|30d\|90d\|all` | Time range (default: `7d`) |
| `--project <name>` | Scope to a specific project (fuzzy matching) |
| `--source <tool>` | Filter by source tool |
| `--no-sync` | Skip auto-sync before displaying stats |

### Reflect & Patterns

Cross-session pattern detection and synthesis. Requires an LLM provider to be configured.

```bash
# Generate weekly cross-session synthesis (current week)
code-insights reflect

# Reflect on a specific ISO week
code-insights reflect --week 2026-W11

# Scope to a specific project
code-insights reflect --project "my-project"

# Backfill facets for sessions that were synced before Reflect existed
code-insights reflect backfill

# Backfill prompt quality analysis
code-insights reflect backfill --prompt-quality
```

The Reflect feature analyzes your sessions to surface:
- **Friction points** — recurring obstacles classified into 9 categories with attribution (user-actionable, AI capability, environmental)
- **Effective patterns** — working strategies across 8 categories with driver classification (user-driven, AI-driven, collaborative)
- **Prompt quality** — how well you communicate with AI tools (7 deficit + 3 strength categories)
- **Working style** — rules and skills derived from your sessions

### Status & Maintenance

```bash
# Show sync statistics (sessions, projects, last sync)
code-insights status

# Open the local dashboard in your browser
code-insights open
code-insights open --project           # Open filtered to the current project

# Delete all local data and reset sync state
code-insights reset --confirm
```

### Session Analysis

Generate AI-powered insights for individual sessions. Requires an LLM provider to be configured.

```bash
# Analyze a specific session using configured LLM provider
code-insights insights <session_id>

# Analyze using Claude native (no API key needed)
code-insights insights <session_id> --native

# Check for unanalyzed sessions (last 7 days)
code-insights insights check
```

### Queue Management

The analysis queue runs session insights asynchronously to prevent blocking hooks and the UI.

```bash
# Show queue status (pending, processing, completed, failed counts)
code-insights queue status

# Machine-readable JSON output
code-insights queue status --quiet

# Process pending items in foreground
code-insights queue process

# Retry failed analysis for a specific session
code-insights queue retry <session_id>

# Retry all failed items
code-insights queue retry --all

# Remove completed/failed items older than N days (default: 7)
code-insights queue prune
code-insights queue prune --days 14
```

**Queue States:**
- `pending` — waiting to be processed
- `processing` — currently running analysis
- `completed` — successfully analyzed
- `failed` — analysis failed (retry available)

### Hook Integration

```bash
# Install unified session-end hook (replaces old two-hook system)
code-insights install-hook

# Install only sync hook (no analysis)
code-insights install-hook --sync-only

# Install only analysis hook (no sync)
code-insights install-hook --analysis-only

# Remove all hooks
code-insights uninstall-hook

# Session-end hook entry point (used internally by Claude Code)
code-insights session-end
```

The `session-end` command replaces the previous two-hook system:
1. **Syncs** the session file to SQLite (foreground, ~50-200ms)
2. **Enqueues** the session for async analysis (<1ms)
3. **Spawns** a detached worker process for background analysis
4. **Exits immediately** — hook completes quickly

Worker logs are written to `~/.code-insights/hook-analysis.log`.

### Telemetry

Anonymous usage telemetry is opt-out. No PII is collected.

```bash
code-insights telemetry status   # Check current status
code-insights telemetry disable  # Disable telemetry
code-insights telemetry enable   # Re-enable telemetry
```

Alternatively, set the environment variable:

```bash
CODE_INSIGHTS_TELEMETRY_DISABLED=1 code-insights sync
```

## LLM Configuration

Session analysis (summaries, decisions, learnings, facets) and Reflect synthesis require an LLM provider. Configure it via CLI or the dashboard Settings page.

```bash
code-insights config llm
```

**Supported providers:**

| Provider | Models | Requires API Key |
|----------|--------|-----------------|
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, etc. | Yes |
| OpenAI | gpt-4o, gpt-4o-mini, etc. | Yes |
| Google Gemini | gemini-2.0-flash, gemini-2.0-pro, etc. | Yes |
| Ollama | llama3.2, qwen2.5-coder, etc. | No (local) |

API keys are stored in `~/.code-insights/config.json` (mode 0o600, readable only by you).

## Troubleshooting

### Queue Issues

**Check queue status:**
```bash
code-insights queue status
```

**View worker logs:**
```bash
tail -f ~/.code-insights/hook-analysis.log
```

**Common solutions:**

| Problem | Solution |
|---------|----------|
| Analysis stuck in "processing" | `code-insights queue retry --all` |
| Multiple failed items | Check LLM provider config: `code-insights config llm --show` |
| Hook not triggering | Reinstall: `code-insights uninstall-hook && code-insights install-hook` |
| Worker process issues | Check logs and verify LLM provider connectivity |

**Reset everything:**
```bash
# Clear all queue items and restart
code-insights queue prune --days 0
code-insights sync
```

### Session Analysis

**No insights generated:**
1. Verify LLM provider is configured: `code-insights config llm --show`
2. Check queue status: `code-insights queue status`
3. Try manual analysis: `code-insights insights <session_id> --native`

**Analysis timeouts:**
- Use `--native` flag for local Claude processing
- Check network connectivity for cloud providers
- Verify API key validity

## Development

This is a pnpm workspace monorepo with three packages: `cli`, `dashboard`, and `server`.

```bash
# Clone
git clone https://github.com/melagiri/code-insights.git
cd code-insights

# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Link CLI for local testing
cd cli && npm link
code-insights --version

# Watch mode (CLI only)
cd cli && pnpm dev
```

### Workspace Structure

```
code-insights/
├── cli/        # This package — Node.js CLI, SQLite, providers
├── dashboard/  # Vite + React SPA
└── server/     # Hono API server (serves dashboard + REST API)
```

### Contributing

See [CONTRIBUTING.md](https://github.com/melagiri/code-insights/blob/master/CONTRIBUTING.md) for code style, PR guidelines, and how to add a new source tool provider.

## Privacy

- All session data is stored in `~/.code-insights/data.db` (SQLite) on your machine
- No cloud accounts required
- No data is transmitted anywhere (unless you explicitly use an LLM provider with a remote API key)
- Anonymous telemetry collects only aggregate usage counts — no session content, no file paths

## License

MIT — see [LICENSE](https://github.com/melagiri/code-insights/blob/master/LICENSE) for details.
