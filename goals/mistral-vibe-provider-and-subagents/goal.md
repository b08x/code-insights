# Goal: Mistral Vibe Provider Attribution & Subagent Runs

## Articulated Goal

Ensure assistant message attribution in the conversation view accurately represents the provider (mapping `mistral-vibe` and `antigravity` to dedicated avatars and names instead of defaulting to Claude), dynamically highlights subagent roles (`agent_type`) when available, and integrates Mistral Vibe subagent runs through both parent session chronological message bundling and linkable child session hierarchy.

## Shared Understanding

- **Facts**: [facts.md](facts.md)
- **Metadata**: [facts.meta.json](facts.meta.json)

## Execution Plan

- **Plan**: [plan.md](plan.md)

## Done Condition

- `MessageBubble.tsx` correctly attributes `mistral-vibe`, `antigravity`, and `crush`, displaying the specific `agent_type` when present.
- `server/src/routes/sessions.ts` and `dashboard/src/lib/types.ts` include `parent_session_id` and `agent_type` in session API responses and types.
- `ToolPanel.tsx` and `AgentToolPanel.tsx` map and normalize subagent execution tools (`agents.spawn`, `subagent.spawn`, `task`, `delegate_task`).
- `MistralVibeProvider` bundles child subagent messages chronologically into parent sessions while aggregating token metrics and preserving standalone child sessions.
- Automated tests pass across CLI, server, and dashboard packages (`pnpm vitest run cli/src/providers/__tests__/mistral-vibe.test.ts`, `pnpm vitest run server/src/routes/sessions.test.ts`, `pnpm build`).
