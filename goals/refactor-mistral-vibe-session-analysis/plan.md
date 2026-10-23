# Plan: Refactor Mistral Vibe Session Analysis & Plugin Logs

## Solution Approach
Refactor `MistralVibeProvider` in `cli/src/providers/mistral-vibe.ts` to seamlessly support both the modern Mistral Vibe 3.0+ unified session store architecture (`mistral.vibe.unified-session-store/v1` in `~/.vibe/logs/session/unified/`) and legacy flat-file sessions (`session_YYYYMMDD_...` with `meta.json` + `messages.jsonl`).

The modern unified store organizes sessions into generation snapshots with chunked messages (`chunks/*.json`), projection states (`projection-state.json`), and checkpoint manifests (`manifest.json`). Subagent runs spawned by plugins (like `ruby-dev`'s `specifier`, `implementer`, `cleaner`, `hardener`, `verifier`) are stored as `child-*` sessions with parent linkage recorded in `projection-state.json` and parent `checkpoint.json` notifications.

The refactored provider will:
1. Auto-detect store formats (`unified` vs legacy `messages.jsonl`).
2. Filter out active/in-progress sessions based on lockfiles in `~/.vibe/logs/session/active/` and generation `execution_state`.
3. Parse unified generation snapshots: extracting exact token usage from `projection-state.json`, reconstructing full conversation history with thinking/reasoning blocks and structured tool calls from chunk files.
4. Establish parent-child subagent lineages and attribute child sessions with namespaced plugin agent types (e.g. `ruby-dev:verifier`).
5. Extract active plugin metadata from session capabilities and plugin data logs.

---

## Ordered Steps

### Step 1: TypeScript Interfaces for Unified Store & Plugin Structures
- **Files**: `cli/src/providers/mistral-vibe.ts`
- **Details**:
  - Define types for `CURRENT` file (`generation`, `manifest_sha256`, `session_id`, `store_format`, `snapshot_sequence`).
  - Define types for `manifest.json` (`execution_state`, `checkpoint.chunks`, `projection_state`).
  - Define types for `projection-state.json` (`snapshot.session` fields: `id`, `parentSessionId`, `rootSessionId`, `title`, `tokenUsage`, `contextUsage`, `createdAt`, `updatedAt`, `preview`).
  - Define types for `checkpoint.json` (`notifications` with subagent dispatches, `turn.outcome`).
  - Define types for chunk records and content blocks (`text`, `reasoning`, `tool_call`, `tool`).
- **Verification**: `pnpm -F cli exec tsc --noEmit`

### Step 2: Dual Discovery with Active Session Filtering
- **Files**: `cli/src/providers/mistral-vibe.ts`
- **Details**:
  - Update `discover()` to inspect both `path.join(baseDir, 'unified')` and `baseDir` for legacy sessions.
  - Scan `unified/` subdirectories: detect root sessions (UUIDs) and child sessions (`child-*`).
  - Implement active session guard: skip sessions that have an active lockfile in `~/.vibe/logs/session/active/${sessionId}.lock` or whose latest manifest `execution_state !== 'quiescent'`.
  - Maintain legacy recursive discovery for directories containing `meta.json` + `messages.jsonl`.
  - Support project filtering against `meta.json`, `projection-state.json`, or `runtime-state.json`.
- **Verification**: `pnpm -F cli test cli/src/providers/__tests__/mistral-vibe.test.ts` (discovery tests)

### Step 3: Unified Store Message & Usage Parser
- **Files**: `cli/src/providers/mistral-vibe.ts`
- **Details**:
  - Detect unified session by presence of `CURRENT` file.
  - Read `CURRENT` to identify latest generation, then load `generations/<gen>/manifest.json` and `projection-state.json`.
  - Extract session metadata: `id`, `parentSessionId`, `startedAt`, `endedAt`, `title`, and token metrics (`totalInputTokens`, `totalOutputTokens`, `cachedInputTokens`, `estimatedCostUsd`).
  - Iterate through chunk files in `manifest.checkpoint.chunks` (`chunks/<sha256>.json`).
  - Map each chunk message into `ParsedMessage`:
    - User turns (`role: 'user'`).
    - Assistant turns (`role: 'assistant'`) with extracted reasoning into `thinking` and `tool_call` blocks into `toolCalls`.
    - Tool output turns (`role: 'tool'`) attached into `toolResults`.
- **Verification**: `pnpm -F cli test cli/src/providers/__tests__/mistral-vibe.test.ts` (parsing tests)

### Step 4: Subagent Hierarchy & Plugin Attribution
- **Files**: `cli/src/providers/mistral-vibe.ts`
- **Details**:
  - When parsing child sessions (`child-*`), extract `parentSessionId` from `projection-state.json`.
  - Read parent session's `checkpoint.json` notifications to resolve subagent role (e.g. `subagent:child-<id>:<agent_type>:...`).
  - Cross-reference known plugin packages in `~/.vibe/logs/session/plugins/packages/` or active capabilities to namespace `agentType` (e.g., `ruby-dev:verifier`, `ruby-dev:implementer`).
  - Identify active plugins from `~/.vibe/logs/session/plugins/data/<session_id>/` and include in session metadata.
- **Verification**: `pnpm -F cli test cli/src/providers/__tests__/mistral-vibe.test.ts` (hierarchy & attribution tests)

### Step 5: Test Fixtures and Comprehensive Regression Suite
- **Files**: `cli/src/providers/__tests__/mistral-vibe.test.ts`
- **Details**:
  - Add realistic mock fixtures for:
    - Unified store root session with chunks, reasoning, and tool calls.
    - Active session with lockfile in `active/` to verify exclusion.
    - Plugin child session with parent linkage and `ruby-dev:verifier` agent attribution.
    - Legacy session with `messages.jsonl` to ensure 100% backward compatibility.
  - Run the full test suite and typechecks across the workspace.
- **Verification**: `pnpm test` && `pnpm build`

### Step 6: Documentation & Graphify Knowledge Graph Update
- **Files**: `docs/ARCHITECTURE.md`, `graphify-out/`
- **Details**:
  - Update architecture documentation to document Vibe 3.0+ unified store and plugin subagent support.
  - Run `graphify update .` to keep knowledge graph up to date.
- **Verification**: `git status --short`

---

## Risks & Open Questions
- **Risk**: Very large sessions with many chunks might incur I/O overhead during sync.
  - *Mitigation*: Read chunk files sequentially using lightweight JSON parsing, reusing cached parent checkpoint notifications when linking child sessions.
- **Risk**: Active sessions could transition from active to quiescent during a sync run.
  - *Mitigation*: The lockfile and manifest state checks ensure half-committed generations are safely skipped and picked up on the subsequent sync.
