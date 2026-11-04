import { FileToolPanel } from './panels/FileToolPanel';
import { TerminalToolPanel } from './panels/TerminalToolPanel';
import { SearchToolPanel } from './panels/SearchToolPanel';
import { AgentToolPanel } from './panels/AgentToolPanel';
import { AskUserQuestionPanel } from './panels/AskUserQuestionPanel';
import { GenericToolPanel } from './panels/GenericToolPanel';
import type { ComponentType } from 'react';
import type { ToolCall, ToolResult } from '@/lib/types';

import { TOOL_ALIASES } from '@/lib/tool-aliases';
export { TOOL_ALIASES };

const TOOL_COMPONENTS: Record<string, ComponentType<ToolPanelProps>> = {
  Read: FileToolPanel,
  Write: FileToolPanel,
  Edit: FileToolPanel,
  Bash: TerminalToolPanel,
  Glob: SearchToolPanel,
  Grep: SearchToolPanel,
  Task: AgentToolPanel,
  AskUserQuestion: AskUserQuestionPanel,
};

interface ToolPanelProps {
  toolCall: ToolCall;
  result?: ToolResult;
}

export function ToolPanel({ toolCall, result }: ToolPanelProps) {
  const canonicalName = TOOL_ALIASES[toolCall.name] ?? toolCall.name;
  const Panel = TOOL_COMPONENTS[canonicalName] ?? GenericToolPanel;
  return <Panel toolCall={toolCall} result={result} />;
}

export { FileToolPanel } from './panels/FileToolPanel';
export { TerminalToolPanel } from './panels/TerminalToolPanel';
export { SearchToolPanel } from './panels/SearchToolPanel';
export { AgentToolPanel } from './panels/AgentToolPanel';
export { AskUserQuestionPanel } from './panels/AskUserQuestionPanel';
export { GenericToolPanel } from './panels/GenericToolPanel';
