# Facts

- MessageBubble maps provider 'mistral-vibe' to Mistral branding (name 'Mistral Vibe' and dedicated avatar styling) instead of falling back to 'Claude'.
- MessageBubble displays the specific agent_type (e.g., 'ruby-dev:cleaner' or role title) as the assistant name and badge when present on the message or session.
- MessageBubble includes explicit assistant configurations for 'antigravity' and verifies 'crush' to prevent falling back to 'Claude'.
- Server API endpoints in server/src/routes/sessions.ts include 'parent_session_id' and 'agent_type' in session list and detail JSON responses.
- Mistral Vibe provider bundles subagent run messages chronologically into parent sessions for holistic conversation review, aggregating token usage and tool call counts.
- Child subagent sessions remain accessible and identifiable via parent_session_id and agent_type metadata, supporting both bundled parent views and individual subagent session views.
- ToolPanel maps 'agents.spawn', 'subagent.spawn', and OpenCode 'task' / 'delegate_task' to AgentToolPanel instead of GenericToolPanel.
- AgentToolPanel normalizes agent spawn arguments, extracting agent/name, task/prompt, and description to render badges and collapsible task prompts.
