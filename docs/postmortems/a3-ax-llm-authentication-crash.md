═══════════════════════════════════════════════════════════════
                    A3 PROBLEM ANALYSIS
═══════════════════════════════════════════════════════════════

TITLE: Ax-LLM OpenRouter Authentication & ESM Crash
OWNER: Knowledge Agent (Backend)
DATE: 2026-08-10

┌─────────────────────────────────────────────────────────────┐
│ 1. BACKGROUND                                               │
├─────────────────────────────────────────────────────────────┤
│ • The Knowledge Agent (`/api/agent`) interacts with LLMs    │
│   via the `@ax-llm/ax` framework.                           │
│ • Users configure their `agent` and `embedding` settings    │
│   (provider, model, base URL) in the dashboard settings,    │
│   which persists to `config.json`.                          │
│ • The system experienced complete failures with OpenRouter  │
│   and Gemini connections, followed by fatal server crashes. │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. CURRENT CONDITION                                        │
├─────────────────────────────────────────────────────────────┤
│ • The CLI's `saveConfig` utility used a strict whitelist    │
│   that dropped `agent` and `embedding` objects, causing     │
│   UI configurations to disappear upon saving.               │
│ • `@ax-llm/ax` threw "Unknown AI" because it expects        │
│   `google-gemini` instead of the UI's `gemini` identifier.  │
│ • OpenRouter connections failed with "Authentication Failed"│
│   because mapping `openrouter` to `openai` (to appease ax)  │
│   routed traffic to OpenAI due to a missing default URL.    │
│ • When the agent encountered any error, the server crashed  │
│   with `ReferenceError: require is not defined`.            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 3. GOAL/TARGET                                              │
├─────────────────────────────────────────────────────────────┤
│ • Ensure UI configurations correctly persist to disk.       │
│ • Seamlessly map all dashboard UI providers to their        │
│   internal `@ax-llm/ax` equivalents.                        │
│ • Correctly default to OpenRouter APIs when applicable.     │
│ • Remove all CommonJS patterns from the ESM codebase to     │
│   prevent fatal error-handling crashes.                     │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 4. ROOT CAUSE ANALYSIS                                      │
├─────────────────────────────────────────────────────────────┤
│ 5 Whys:                                                     │
│ Problem: Config wouldn't save, and testing threw crashes.   │
│ Why 1: Config wouldn't save because `cli/src/utils/config`  │
│        had a hardcoded save whitelist.                      │
│ Why 2: "Unknown AI" appeared because `ai({ name })` was     │
│        passed the UI string directly without mapping.       │
│ Why 3: Authentication failed because falling back to `openai`│
│        defaults to api.openai.com without an override URL.  │
│ Why 4: The server crashed upon catching the stream error    │
│        because it called `require('fs')` for logging.       │
│ Why 5: The developer forgot the project is strictly ESM     │
│        (ECMAScript Modules) where `require` does not exist. │
│                                                             │
│ ROOT CAUSE: Poorly aligned abstraction boundaries between   │
│             UI configuration objects and third-party library│
│             types, combined with un-tested error handlers.  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 5. COUNTERMEASURES                                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Whitelist `agent` and `embedding` in config save logic.  │
│ 2. Explicitly map `gemini` to `google-gemini`.              │
│ 3. Map `openrouter` and `ollama` to `openai`.               │
│ 4. Explicitly set `apiURL = 'https://openrouter.ai/api/v1'` │
│    when OpenRouter is selected without a custom base URL.   │
│ 5. Replace inline `require('fs')` with ESM `import * as fs` │
│    at the top of `server/src/routes/agent.ts`.              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 6. IMPLEMENTATION PLAN                                      │
├─────────────────────────────────────────────────────────────┤
│ • [DONE] Update `cli/src/utils/config.ts`                   │
│ • [DONE] Update `server/src/routes/agent.ts`                │
│ • [DONE] Update `server/src/routes/config.ts`               │
│ • [DONE] Run full `pnpm build` across the workspace         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 7. FOLLOW-UP                                                │
├─────────────────────────────────────────────────────────────┤
│ Prevention:                                                 │
│ • ESM projects should run linting rules to entirely forbid  │
│   the use of `require()`.                                   │
│ • Type checking in typescript must be explicitly verified   │
│   when mapping external strings to strict library enums.    │
└─────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
