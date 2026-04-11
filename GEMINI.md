# GEMINI.md

## Project Overview

**Code Insights** is a local-first analytics platform designed to turn AI coding sessions into actionable knowledge. It extracts structured insights, decisions, learnings, and prompt quality scores from tools like **Claude Code, Cursor, Codex CLI, Copilot CLI, Gemini CLI, Hermes Agent, OpenCode, and Crush**.

- **Purpose:** Help developers understand their AI coding patterns, track costs, and improve their AI fluency through automated session analysis and background processing.
- **Architecture:**
  - **`cli/`**: Node.js CLI (TypeScript) responsible for session discovery, parsing, and SQLite persistence.
  - **`server/`**: Hono-based API server (TypeScript) that proxies LLM requests and serves the dashboard.
  - **`dashboard/`**: React SPA (Vite + TypeScript) for visualizing sessions, analytics, and cross-session patterns.
- **Database:** Local SQLite database stored at `~/.code-insights/data.db`.

## Building and Running

The project uses `pnpm` workspaces for dependency management.

### Key Commands

- **Install Dependencies:**
  ```bash
  pnpm install
  ```
- **Build All Packages:**
  ```bash
  pnpm build
  ```
- **Run Tests:**
  ```bash
  pnpm test          # Run all tests
  pnpm test:watch    # Run tests in watch mode
  ```
- **CLI Development:**
  ```bash
  cd cli
  pnpm dev           # Watch mode for CLI
  npm link           # Link code-insights command locally
  ```
- **Start Dashboard (Production):**
  ```bash
  code-insights dashboard
  ```

## Development Conventions

- **Monorepo Management:** Uses `pnpm` workspaces. Always run `pnpm install` from the root.
- **Type Safety:** Strict TypeScript usage across all packages. Avoid `any` and prefer interface/type definitions in `types.ts` or local `types/` directories.
- **Database:** Uses `better-sqlite3`. Schema is defined in `cli/src/db/schema.ts` and managed via migrations in `cli/src/db/migrate.ts`.
- **Testing:** `vitest` is the primary test runner. Tests are typically located in `__tests__/` directories adjacent to the source code.
- **CLI Framework:** Uses `commander` for command definitions and `inquirer` for interactive prompts.
- **Server Framework:** Uses `Hono` for its lightweight footprint and excellent TypeScript support.
- **Privacy:** Follow the "local-first" principle. Ensure no session data is sent to the cloud except to the user-configured LLM provider for analysis.
- **Parsing:** Employs `jsonrepair` and robust structural lookahead for preprocessing malformed or deeply nested JSON responses from LLM providers.
- **Hooks:** The project supports installing hooks into Claude Code to automate sync and background analysis (`code-insights install-hook`).

## LLM Providers

Code Insights supports multiple LLM providers for session analysis and insight generation.

- **Supported Providers:** OpenAI (GPT-4o), Anthropic (Claude 3.5), Google Gemini (2.0 Flash), OpenRouter, Mistral (Codestral), and Ollama (Local).
- **Environment Configuration:** API keys can be resolved via environment variables (e.g., `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) or configured persistently via `code-insights config`.
- **Dynamic Model Discovery:** The platform supports fetching the latest available models from cloud providers once an API key is validated. This is handled by the `POST /api/config/llm/models` endpoint in the server.

### Reference SDKs (Context7)

Documentation and API patterns for these providers are referenced via the following Context7 library IDs:

- **OpenRouter:** `/openrouterteam/typescript-sdk`
- **Mistral:** `/mistralai/client-ts`
- **Anthropic:** `/anthropics/anthropic-sdk-typescript`
- **OpenAI:** `/openai/openai-node`
- **Google Gemini:** `/google/generative-ai`

## Key Files & Directories

- `cli/src/index.ts`: CLI entry point.
- `cli/src/db/schema.ts`: SQLite database schema definition.
- `cli/src/providers/`: Implementations for various AI tool session parsers.
- `server/src/index.ts`: Hono server entry point and API route mounting.
- `dashboard/src/App.tsx`: Main dashboard component.
- `docs/ARCHITECTURE.md`: Detailed system architecture.
- `docs/DEVELOPMENT.md`: Comprehensive development guide.
