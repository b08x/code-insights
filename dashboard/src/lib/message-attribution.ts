export function getAssistantConfig(sourceTool?: string): { name: string; avatarColor: string } {
  switch (sourceTool) {
    case 'claude-code':
      return { name: 'Claude Code', avatarColor: 'bg-orange-500' };
    case 'cursor':
      return { name: 'Cursor', avatarColor: 'bg-blue-500' };
    case 'codex-cli':
      return { name: 'Codex CLI', avatarColor: 'bg-green-500' };
    case 'copilot':
      return { name: 'Copilot', avatarColor: 'bg-violet-500' };
    case 'copilot-cli':
      return { name: 'Copilot CLI', avatarColor: 'bg-cyan-500' };
    case 'gemini-cli':
      return { name: 'Gemini CLI', avatarColor: 'bg-teal-500' };
    case 'hermes-agent':
      return { name: 'Hermes Agent', avatarColor: 'bg-fuchsia-500' };
    case 'opencode':
      return { name: 'OpenCode', avatarColor: 'bg-amber-500' };
    case 'crush':
      return { name: 'Crush', avatarColor: 'bg-rose-500' };
    case 'mistral-vibe':
      return { name: 'Mistral Vibe', avatarColor: 'bg-orange-600' };
    case 'antigravity':
      return { name: 'Antigravity', avatarColor: 'bg-blue-600' };
    default:
      return { name: 'Claude', avatarColor: 'bg-purple-500' };
  }
}
