# GEMINI.md

## Project Overview

**Code Insights** is a local-first analytics platform designed to turn AI coding sessions into actionable knowledge. It extracts structured insights, decisions, learnings, and prompt quality scores from tools like **Claude Code, Cursor, Codex CLI, Copilot CLI, Gemini CLI, Hermes Agent, OpenCode, Crush, and Google Antigravity**.

- **Purpose:** Help developers understand their AI coding patterns, track costs, and improve their AI fluency through automated session analysis and background processing.
- **Architecture:**
  - **`cli/`**: Node.js CLI (TypeScript) responsible for session discovery, parsing, and SQLite persistence. Includes a background **Analysis Queue** for asynchronous LLM processing.
  - **`server/`**: Hono-based API server (TypeScript) that proxies LLM requests, serves the dashboard, and manages the analysis worker.
  - **`dashboard/`**: React SPA (Vite + TypeScript) for visualizing sessions, analytics, cross-session patterns, and real-time analysis status.
- **Database:** Local SQLite database stored at `~/.code-insights/data.db`. Uses WAL mode for concurrent access. See `RULES.md` for database integrity and performance standards.

## Building and Running

The project uses `pnpm` workspaces for dependency management.

### Key Commands

- **Install Dependencies:** `pnpm install`
- **Build All Packages:** `pnpm build`
- **Run Tests:** `pnpm test`
- **CLI Usage:**
  ```bash
  code-insights sync           # Discover and import new sessions
  code-insights insights       # View or generate insights from the terminal
  code-insights queue          # Manage the background analysis queue
  code-insights reflect        # Generate cross-session synthesis (weekly/project)
  code-insights dashboard      # Start the web dashboard (default: localhost:7890)
  code-insights config         # Configure LLM providers and preferences
  ```
- **CLI Development:**
  ```bash
  cd cli
  pnpm dev                     # Watch mode for CLI
  npm link                     # Link code-insights command locally
  ```

## Development Conventions

- **Monorepo Management:** Uses `pnpm` workspaces. Always run `pnpm install` from the root.
- **Type Safety:** Strict TypeScript usage. `cli/src/types.ts` is the **single source of truth**.
- **Database:** Uses `better-sqlite3`. Schema is defined in `cli/src/db/schema.ts`. V9 introduces the `analysis_queue` table for robust background processing.
- **Analysis Queue:** Asynchronous job system for LLM tasks. Managed via `cli/src/db/queue.ts` and processed by `cli/src/analysis/queue-worker.ts`. Supports multi-level native fallbacks (Codex → Claude → Gemini).
- **Testing:** `vitest` is the primary test runner. Tests are in `__tests__/` directories adjacent to source.
- **Privacy:** Local-first. No session data is sent to the cloud except to user-configured LLMs for analysis.
- **Parsing:** Robust structural lookahead and `jsonrepair` for handling malformed LLM responses.
- **Hooks:** Automate sync and analysis via `code-insights install-hook`. Includes `session-end` hook for immediate background queueing.

## LLM Providers

Code Insights supports multiple providers for analysis and synthesis.

- **Native Runners:** Zero-config analysis using locally installed CLIs. Supports **Codex** (default native), **Claude Code**, and **Gemini CLI**. Features automatic usage-limit fallback: `Codex` → `Claude` → `Gemini`.
- **Supported Providers:** OpenAI (GPT-4o), Anthropic (Claude 3.5), Google Gemini (2.0 Flash), OpenRouter, Mistral (Codestral), and Ollama (Local).
- **Dynamic Discovery:** Supports fetching latest models via `POST /api/config/llm/models`.
- **Cost Tracking:** Per-session and per-analysis cost tracking stored in `analysis_usage`.

### Reference SDKs (Context7)

- **OpenRouter:** `/openrouterteam/typescript-sdk`
- **Mistral:** `/mistralai/client-ts`
- **Anthropic:** `/anthropics/anthropic-sdk-typescript`
- **OpenAI:** `/openai/openai-node`
- **Google Gemini:** `/google/generative-ai`

## Key Files & Directories

- `cli/src/index.ts`: CLI entry point (Commander.js).
- `cli/src/db/schema.ts`: SQLite schema and migrations (V1–V7).
- `cli/src/db/queue.ts`: Analysis queue operations.
- `cli/src/analysis/queue-worker.ts`: Background worker logic.
- `cli/src/providers/`: implementations for 9+ source tool providers.
- `server/src/index.ts`: Hono server and API route mounting.
- `dashboard/src/App.tsx`: Main dashboard entry.
- `docs/ARCHITECTURE.md`: Detailed system architecture.
- `docs/DEVELOPMENT.md`: Comprehensive development guide.
