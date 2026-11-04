# Plan: Mistral Vibe Provider Attribution & Subagent Runs

## Solution Approach

This goal resolves assistant provider attribution in the conversation view and implements subagent run support for Mistral Vibe, aligning it with the subagent bundling and linking patterns used across Code Insights:

1. **Assistant Provider Attribution & Avatars**:
   - Update `MessageBubble.tsx` to explicitly map `mistral-vibe` (orange theme) and `antigravity` (blue theme), verify `crush`, and eliminate the fallback to "Claude".
   - Support dynamic `agent_type` display (e.g. `ruby-dev:cleaner`, `architect`) in `MessageBubble.tsx`, `ChatConversation.tsx`, and `SessionDetailPanel.tsx`.
2. **Server & Dashboard Data Layer**:
   - Expose `parent_session_id` and `agent_type` in `server/src/routes/sessions.ts` session list and detail queries.
   - Update `Session` interface in `dashboard/src/lib/types.ts`.
3. **Subagent Tool Panel Mapping & Normalization**:
   - Map `agents.spawn`, `subagent.spawn`, `task`, and `delegate_task` to `AgentToolPanel` in `ToolPanel.tsx`.
   - Update `AgentToolPanel.tsx` to normalize heterogeneous argument shapes (`agent`, `task`, `prompt`, `description`).
4. **Mistral Vibe Subagent Bundling & Hierarchy**:
   - In `cli/src/providers/mistral-vibe.ts`, when parsing a parent unified session, discover and parse linked child sessions referenced in `runtimeState.subagents.children`.
   - Merge child messages into the parent session chronologically, and aggregate tool calls and token usage metrics.
   - Retain individual child session discovery and persistence with `parent_session_id` and `agent_type` so both the bundled parent conversation and standalone child sessions remain accessible.

---

## Ordered Steps

### Step 1: Update Dashboard Message Attribution & Assistant Configuration
- **Files**:
  - `dashboard/src/components/chat/message/MessageBubble.tsx`
  - `dashboard/src/components/chat/conversation/ChatConversation.tsx`
  - `dashboard/src/components/sessions/SessionDetailPanel.tsx`
- **Changes**:
  - In `MessageBubble.tsx`, add cases for `mistral-vibe` (`name: 'Mistral Vibe'`, `avatarColor: 'bg-orange-600'`) and `antigravity` (`name: 'Antigravity'`, `avatarColor: 'bg-blue-600'`), and verify `crush` (`bg-rose-500`).
  - Accept `agentType?: string` prop in `MessageBubbleProps` and `ChatConversationProps`.
  - When `agentType` is present, display the agent role (e.g., `ruby-dev:cleaner`) as a badge or stylized title alongside the provider.
  - In `SessionDetailPanel.tsx`, pass `agentType={session.agent_type ?? undefined}` to `ChatConversation`, and display `agent_type` badge in the session header vitals.
- **Verification**:
  - `pnpm --filter @code-insights/dashboard build`
  - Inspect test component renders for `mistral-vibe` with and without `agentType`.

### Step 2: Expose `parent_session_id` and `agent_type` in Server API and Dashboard Types
- **Files**:
  - `server/src/routes/sessions.ts`
  - `dashboard/src/lib/types.ts`
  - `server/src/routes/sessions.test.ts`
- **Changes**:
  - In `server/src/routes/sessions.ts`, add `parent_session_id` and `agent_type` to both `SELECT` queries (list endpoint and `:id` detail endpoint).
  - In `dashboard/src/lib/types.ts`, add `parent_session_id?: string | null` and `agent_type?: string | null` to `Session`.
  - Add test in `server/src/routes/sessions.test.ts` verifying that `parent_session_id` and `agent_type` are returned in API responses.
- **Verification**:
  - `pnpm vitest run server/src/routes/sessions.test.ts`
  - `pnpm --filter @code-insights/server build`

### Step 3: Map Subagent Spawn Tools to `AgentToolPanel` and Normalize Arguments
- **Files**:
  - `dashboard/src/components/chat/tools/ToolPanel.tsx`
  - `dashboard/src/components/chat/tools/panels/AgentToolPanel.tsx`
- **Changes**:
  - In `ToolPanel.tsx`, add aliases for `agents.spawn: 'Task'`, `subagent.spawn: 'Task'`, `task: 'Task'`, and `delegate_task: 'Task'`.
  - In `AgentToolPanel.tsx`, update argument extraction:
    - Agent Name: `input.name || input.agent || input.agent_type || input.subagent_type || 'Agent'`
    - Subagent Type: `input.subagent_type || input.agent_type || input.agent || input.category`
    - Prompt/Task: `input.prompt || input.task || input.instruction`
    - Description: `input.description || input.summary || (typeof input.task === 'string' ? input.task.slice(0, 80) : '')`
- **Verification**:
  - `pnpm --filter @code-insights/dashboard build`
  - Verify tool rendering with mock `agents.spawn` and `task` inputs.

### Step 4: Implement Subagent Bundling for Mistral Vibe Parent Sessions
- **Files**:
  - `cli/src/providers/mistral-vibe.ts`
  - `cli/src/providers/__tests__/mistral-vibe.test.ts`
- **Changes**:
  - In `MistralVibeProvider.parseUnifiedSession`, inspect `runtimeState?.subagents?.children`.
  - For each child session ID referenced, locate the child session directory (in `unified/` or adjacent directories), invoke child parsing, and:
    - Merge subagent messages into `parentSession.messages`.
    - Tag or preserve message identity and sort all messages by `timestamp ASC`.
    - Update parent session metrics: `messageCount`, `userMessageCount`, `assistantMessageCount`, `toolCallCount`.
    - Sum token usage (`totalInputTokens`, `totalOutputTokens`, `estimatedCostUsd`).
  - Ensure child sessions remain discovered so they are also saved independently in SQLite with `parent_session_id` and `agent_type`.
  - Add test in `cli/src/providers/__tests__/mistral-vibe.test.ts` verifying that parent sessions bundle subagent messages and aggregate metrics correctly.
- **Verification**:
  - `pnpm vitest run cli/src/providers/__tests__/mistral-vibe.test.ts`
  - `pnpm --filter @code-insights/cli build`

### Step 5: Full Regression Testing & End-to-End Build Verification
- **Verification Commands**:
  - `pnpm vitest run cli/src/providers/__tests__/mistral-vibe.test.ts`
  - `pnpm vitest run server/src/routes/sessions.test.ts`
  - `pnpm build`
  - Run sync dry-run or verify existing session in `~/.code-insights/data.db`.

---

## Risks and Open Questions

1. **Circular Subagent References**: If a subagent itself spawns subagents, recursive bundling could theoretically encounter deep trees. *Mitigation*: Track visited session IDs with a `Set<string>` during bundling to prevent any cycle.
2. **Duplicate Message Insertion on Re-sync**: If child messages are merged into the parent session in `ParsedSession`, ensure the database `insertMessages` step uses stable IDs or prefixes (e.g. child message ID prefixed or unchanged) so conflict resolution does not cause collisions.
