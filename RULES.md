# CLAUDE.md / GEMINI.md

## Core Architecture

### Database & Storage
- **USE SQLite with WAL mode** for all local persistence. Configure with:
  ```js
  db.pragma('journal_mode = WAL');
  db.busyTimeout(5000); // 5-second timeout for locks
  ```
  - Document WAL mode requirement in `GEMINI.md` under "Development Conventions"
  - Add verification step in integration tests: `PRAGMA journal_mode` should return `wal`

- **WHEN handling JSON data in SQLite**, DO:
  ```js
  const data = JSON.parse(row.json_field); // Always parse explicitly
  const validated = Schema.parse(data);    // Validate with Zod/Joi
  ```
  - DO NOT assume `better-sqlite3` returns parsed JSON

- **FOR multi-provider data locations**, USE this directory priority:
  1. Profile-specific: `~/.hermes/profiles/<profile>/state.db`
  2. Central legacy: `~/.hermes/state.db`
  - Document both locations in README with "primary/fallback" labels

### Provider System
- **IMPLEMENT all providers using the Strategy Pattern**:
  ```ts
  interface SessionProvider {
    discover(): Promise<DiscoveredSession[]>;
    parse(session: DiscoveredSession): Promise<ParsedSession>;
  }
  ```
  - Register providers in `registry.ts` with unique IDs
  - USE `COALESCE(custom_title, generated_title) AS title` for title consistency

- **WHEN adding new providers**, DO:
  1. Add to `source-tool-format-analysis.md` with storage format details
  2. Update `README.md` "Supported AI Tools" table
  3. Implement fallback logic in `discover()` for missing fields

- **FOR virtual paths**, USE format: `source:dbPath#sessionId`
  - DO NOT include `source:` prefix in filesystem operations
  - REVISIT when adding new source types

### CLI Integration
- **USE `@path` file references for CLI prompts >2KB**:
  ```bash
  gemini -p @/path/to/prompt.txt
  ```
  - Clean up temp files after execution
  - REVISIT if CLI adds native large-prompt support

- **FOR native analysis**, USE this fallback chain:
  1. Codex (default)
  2. Claude
  3. Gemini
  - Document in `insights --help` with `--codex`, `--claude`, `--gemini` flags

## Data Processing

### JSON Handling
- **USE `jsonrepair` for all LLM-generated JSON**:
  ```js
  import { repair } from 'jsonrepair';
  const safeJson = repair(rawOutput);
  ```
  - Document in `GEMINI.md` under "Parsing" section
  - Log repair events to `~/.code-insights/debug/`

- **IMPLEMENT balanced-brace JSON extraction**:
  ```ts
  function extractJsonPayload(text: string): string {
    // Stack-based balanced brace matching
    // Fallback to first { if no balanced block found
  }
  ```
  - Test with nested quotes, arrays, and markdown code blocks

- **FOR JSON preprocessing**, USE a state machine that:
  1. Tracks string boundaries and escape sequences
  2. Validates quote roles with lookahead (comma must be followed by key/terminator)
  3. Escapes literal newlines to `\n`

### Session Parsing
- **WHEN parsing sessions**, DO:
  1. Cross-reference SQLite and JSON sources
  2. Generate missing titles from first message or timestamp
  3. Use placeholder values for missing metrics with `usageSource: 'session'`

- **FOR malformed session data**, DO:
  ```ts
  try {
    const session = SessionSchema.parse(rawData);
    return session;
  } catch (error) {
    console.warn(`Skipping corrupted session: ${error}`);
    return null;
  }
  ```
  - Log warnings but continue processing valid sessions

## API & Frontend

### Server Implementation
- **USE Hono for API routes**:
  ```ts
  const app = new Hono();
  app.post('/api/config/llm/models', async (c) => {
    const { provider } = await c.req.json();
    // Provider-specific discovery
  });
  ```
  - Add validation middleware for date ranges and required fields

- **FOR real-time updates**, USE Server-Sent Events (SSE):
  ```ts
  // Frontend
  const eventSource = new EventSource('/api/analysis/progress');
  eventSource.onmessage = (e) => {
    const { progress, current, total } = JSON.parse(e.data);
    // Update UI
  };
  ```

### React Components
- **FOR dialog state management**, DO:
  ```tsx
  const [open, setOpen] = useState(false);
  const dialogRef = useRef(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      dialogRef.current?.close();
    };
  }, []);
  ```
  - Avoid mixing `DialogTrigger` with manual `onClick` handlers

- **FOR bulk operations**, IMPLEMENT:
  1. Sequential processing with progress updates
  2. Stop button with `stopRequested` ref
  3. Time estimates based on rolling averages

## Documentation

### Project Overview
- **DOCUMENT these as first-class components**:
  1. Analysis queue system (background worker + dashboard polling)
  2. SQLite database schema
  3. Provider registry pattern

- **FOR provider documentation**, USE this structure:
  ```markdown
  ### [Provider Name]
  - **Data Location**: `~/.tool/path` (format)
  - **Environment Variables**:
    ```env
    TOOL_API_KEY=...
    ```
  - **Limitations**: [e.g., "No token usage metrics"]
  ```

### Environment Configuration
- **LIST all provider API keys**:
  ```markdown
  | Provider     | Environment Variable       | Required |
  |--------------|----------------------------|----------|
  | OpenAI       | OPENAI_API_KEY             | Yes      |
  | Anthropic    | ANTHROPIC_API_KEY          | No       |
  | OpenRouter   | OPENROUTER_API_KEY         | No       |
  | Mistral      | MISTRAL_API_KEY            | No       |
  | Gemini       | GEMINI_API_KEY             | No       |
  ```
  - Note variable precedence rules

## Testing

### Database Tests
- **USE in-memory SQLite for regression tests**:
  ```ts
  test('getTrivialSessions handles title precedence', () => {
    const db = new Database(':memory:');
    // Seed test data
    const result = getTrivialSessions(db);
    // Assertions
  });
  ```

### JSON Parsing Tests
- **TEST with these edge cases**:
  1. Nested quotes: `"outer "inner" quote"`
  2. Quotes followed by colons: `"key: value"`
  3. Arrays with quoted strings: `["item with "nested" quotes"]`
  4. Truncated JSON blocks

## Prompt Hygiene

### Anti-Patterns
- **DO NOT use vague requests**:
  - ❌ "test"
  - ✅ "Run unit tests for the `cli` package and summarize failures in the `analysis/` module"

- **DO NOT introduce late constraints**:
  - ❌ "Also make codex the default runner" (after implementation)
  - ✅ "Default to codex with fallbacks to claude → gemini"

- **DO NOT assume file access**:
  - ❌ "Use the file at /external/path"
  - ✅ "Here's the content of /external/path: [pasted content]"

### Best Practices
- **ALWAYS include for debugging tasks**:
  1. Complete error stack traces
  2. Relevant file contents
  3. Environment context (Node version, OS)

- **WHEN refactoring prompts**, DO:
  1. Grep for old persona strings across all packages
  2. Update both system prompt AND user task description
  3. Test with edge cases that previously failed

- **FOR multi-step tasks**, USE:
  ```markdown
  ## Objective
  [Clear goal]

  ## Constraints
  - [Constraint 1]
  - [Constraint 2]

  ## Implementation Steps
  1. [Step 1]
  2. [Step 2]
  ```

- **WHEN documenting changes**, FOLLOW Conventional Commits:
  - `docs:` for all documentation changes
  - `feat:` for new runtime features
  - `refactor:` for code structure changes
  - Include scope (e.g., `feat(api):`) when relevant
