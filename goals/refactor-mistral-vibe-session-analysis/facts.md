# Facts

- MistralVibeProvider.discover() discovers modern unified store sessions located in ~/.vibe/logs/session/unified/ by detecting valid CURRENT files and generation manifests.
- MistralVibeProvider.discover() continues to discover legacy sessions containing meta.json and messages.jsonl across ~/.vibe/logs/session/ for full backward compatibility.
- MistralVibeProvider.discover() skips active sessions that possess an active lockfile in ~/.vibe/logs/session/active/ or whose latest generation is not quiescent.
- MistralVibeProvider.parse() extracts session metadata (id, projectPath, projectName, gitBranch, startedAt, endedAt, title, and token usage) from unified generation projection-state.json and meta.json.
- MistralVibeProvider.parse() parses turn messages across referenced chunk files in chunks/, preserving user prompts, assistant thoughts/reasoning, and assistant text content.
- MistralVibeProvider.parse() maps unified tool calls and tool results from chunks into ParsedMessage toolCalls and toolResults with arguments and output preserved.
- Child sessions (child-* directories) are ingested as distinct session records with parentSessionId populated from projection-state.json and parent notifications.
- Subagent child sessions spawned by plugins are tagged with a namespaced agentType attributing them to their source plugin (e.g., ruby-dev:verifier).
- Active plugins loaded during the session are detected from session data and plugin packages and recorded in session metadata.
- Automated unit tests in cli/src/providers/__tests__/mistral-vibe.test.ts verify unified store discovery, message reconstruction, tool call parsing, child session linkage, and plugin attribution.
