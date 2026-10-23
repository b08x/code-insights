import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { SessionProvider } from './types.js';
import type { 
  ParsedSession, 
  ParsedMessage, 
  ToolCall, 
  ToolResult, 
  SessionUsage 
} from '../types.js';
import { getVibeLogsDir } from '../utils/config.js';
import { generateTitle } from '../parser/titles.js';

export interface VibeMeta {
  session_id: string;
  start_time: string;
  end_time: string;
  git_branch?: string;
  environment?: {
    working_directory?: string;
  };
  stats?: {
    session_prompt_tokens?: number;
    session_completion_tokens?: number;
    session_cost?: number;
    session_total_llm_tokens?: number;
    input_price_per_million?: number;
    output_price_per_million?: number;
  };
  title?: string;
  total_messages?: number;
  parent_session_id?: string;
  agent_type?: string;
  plugins?: Array<string | { name: string }>;
}

export interface VibeLegacyMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  message_id?: string;
  tool_call_id?: string;
  name?: string;
  injected?: boolean;
  reasoning?: string;
}

export interface VibeCurrentFile {
  generation: string;
  manifest_sha256?: string;
  session_id: string;
  snapshot_sequence?: number;
  store_format?: string;
  store_format_minor?: number;
}

export interface VibeManifest {
  checkpoint?: {
    checkpoint_version?: number;
    chunks?: string[];
    path?: string;
    sha256?: string;
  };
  created_at?: string;
  execution_state?: string;
  generation?: string;
  manifest_version?: number;
  projection_state?: {
    chunks?: string[];
    path?: string;
    sha256?: string;
  };
  runtime_state?: {
    chunks?: string[];
    path?: string;
    sha256?: string;
  };
  session_id?: string;
  snapshot_sequence?: number;
}

export interface VibeProjectionState {
  projection_state_version?: number;
  session_id?: string;
  snapshot?: {
    format?: string;
    session?: {
      id?: string;
      parentSessionId?: string | null;
      rootSessionId?: string | null;
      title?: string | null;
      titleSource?: string | null;
      createdAt?: number;
      updatedAt?: number;
      tokenUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        totalTokens?: number;
      } | null;
      contextUsage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
        totalTokens?: number;
      } | null;
      status?: {
        type?: string;
        message?: string;
      };
    };
    latestTurn?: {
      id?: string;
      startedAt?: number;
      completedAt?: number;
      status?: string;
      error?: {
        message?: string;
        code?: string;
      };
    };
  };
}

export interface VibeCheckpoint {
  checkpoint_version?: number;
  notifications?: Array<{
    id: string;
    type: string;
  }>;
  turn?: {
    outcome?: {
      output?: Array<{
        text?: string;
        type?: string;
      }>;
      type?: string;
    };
    turn_id?: string;
    type?: string;
  };
}

export interface VibeRuntimeState {
  session_id?: string;
  session_metadata?: {
    active_model?: string;
    agent_name?: string | null;
    agent_type?: string | null;
    cwd?: string;
    parent_session_id?: string | null;
    root_session_id?: string | null;
  };
  core_plugins?: Array<{
    name: string;
    path?: string;
    description?: string;
    capabilities?: {
      agent_types?: string[];
      skills?: string[];
      tool_groups?: string[];
    };
  }>;
  subagents?: {
    children?: Record<string, {
      agent_name?: string;
      agent_type?: string;
      child_session_id?: string;
      depth?: number;
    }>;
    policy_ceiling?: {
      workdir?: string;
      read_roots?: string[];
    };
  };
}

interface ParentSessionInfo {
  parentSessionId: string;
  projectPath?: string;
  gitBranch?: string;
  notifications?: any[];
  subagents?: any;
}

/**
 * Mistral Vibe session provider.
 * Discovers and parses session logs from ~/.vibe/logs/session/ (both modern unified and legacy flat formats).
 */
export class MistralVibeProvider implements SessionProvider {
  private storageDir?: string;
  private parentInfoCache = new Map<string, ParentSessionInfo | null>();
  private childToParentIndex: Map<string, ParentSessionInfo> | null = null;
  private pluginAgentMap: Map<string, string> | null = null;

  constructor(storageDir?: string) {
    this.storageDir = storageDir;
  }

  getProviderName(): string {
    return 'mistral-vibe';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const baseDir = this.storageDir || getVibeLogsDir();

    if (!fs.existsSync(baseDir)) {
      return [];
    }

    const discovered = new Set<string>();

    // 1. Check if baseDir itself is a unified session
    if (fs.existsSync(path.join(baseDir, 'CURRENT'))) {
      if (this.isValidUnifiedSession(baseDir, options)) {
        discovered.add(path.resolve(baseDir));
      }
    }

    // 2. Discover unified sessions in path.join(baseDir, 'unified')
    const unifiedDir = path.join(baseDir, 'unified');
    if (fs.existsSync(unifiedDir) && fs.statSync(unifiedDir).isDirectory()) {
      try {
        const entries = fs.readdirSync(unifiedDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const sessionPath = path.join(unifiedDir, entry.name);
            if (this.isValidUnifiedSession(sessionPath, options)) {
              discovered.add(path.resolve(sessionPath));
            }
          }
        }
      } catch {
        // Silently skip directory read errors
      }
    }

    // 3. Check immediate subdirectories of baseDir for unified sessions
    try {
      const entries = fs.readdirSync(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== 'unified' && entry.name !== 'active' && entry.name !== 'plugins') {
          const subPath = path.join(baseDir, entry.name);
          if (fs.existsSync(path.join(subPath, 'CURRENT'))) {
            if (this.isValidUnifiedSession(subPath, options)) {
              discovered.add(path.resolve(subPath));
            }
          }
        }
      }
    } catch {
      // Silently skip directory read errors
    }

    // 4. Discover legacy sessions recursively (meta.json + messages.jsonl)
    const legacyDiscovered: string[] = [];
    this.discoverLegacyRecursive(baseDir, legacyDiscovered, options);
    for (const p of legacyDiscovered) {
      discovered.add(path.resolve(p));
    }

    return Array.from(discovered);
  }

  /**
   * Validate whether a directory is a quiescent, non-active unified session matching any project filter.
   */
  private isValidUnifiedSession(sessionPath: string, options?: { projectFilter?: string }): boolean {
    const currentPath = path.join(sessionPath, 'CURRENT');
    if (!fs.existsSync(currentPath)) return false;

    let current: VibeCurrentFile;
    try {
      current = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
      if (!current.generation) return false;
    } catch {
      return false;
    }

    const manifestPath = path.join(sessionPath, 'generations', current.generation, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return false;

    let manifest: VibeManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch {
      return false;
    }

    const sessionId = current.session_id || path.basename(sessionPath);
    if (this.isSessionActive(sessionId, sessionPath, manifest)) {
      return false;
    }

    if (options?.projectFilter) {
      const projectPath = this.getProjectPath(sessionPath, current.generation);
      const projectName = path.basename(projectPath);
      if (!projectName.toLowerCase().includes(options.projectFilter.toLowerCase())) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if a session has an active lockfile in active/ or its manifest is not quiescent.
   */
  private isSessionActive(sessionId: string, sessionDir: string, manifest?: VibeManifest | null): boolean {
    const baseDir = this.storageDir || getVibeLogsDir();
    const candidateActiveDirs = [
      path.join(baseDir, 'active'),
      path.join(path.dirname(sessionDir), '..', 'active'),
      path.join(path.dirname(baseDir), 'active'),
    ];

    for (const activeDir of candidateActiveDirs) {
      if (fs.existsSync(activeDir)) {
        if (
          fs.existsSync(path.join(activeDir, `${sessionId}.lock`)) ||
          fs.existsSync(path.join(activeDir, `${sessionId}.lock.json`))
        ) {
          return true;
        }
      }
    }

    if (manifest && manifest.execution_state && manifest.execution_state !== 'quiescent') {
      return true;
    }

    return false;
  }

  /**
   * Determine project working directory for a unified session.
   */
  private getProjectPath(sessionPath: string, generation: string): string {
    const metaPath = path.join(sessionPath, 'meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as VibeMeta;
        if (meta.environment?.working_directory) {
          return meta.environment.working_directory;
        }
      } catch {}
    }

    const runtimePath = path.join(sessionPath, 'generations', generation, 'runtime-state.json');
    if (fs.existsSync(runtimePath)) {
      try {
        const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf-8')) as VibeRuntimeState;
        if (runtime.session_metadata?.cwd) return runtime.session_metadata.cwd;
        if (runtime.subagents?.policy_ceiling?.workdir) return runtime.subagents.policy_ceiling.workdir;
      } catch {}
    }

    return sessionPath;
  }

  /**
   * Recursively discover legacy session directories containing meta.json + messages.jsonl.
   */
  private discoverLegacyRecursive(
    currentDir: string,
    discovered: string[],
    options?: { projectFilter?: string }
  ): void {
    if (!fs.existsSync(currentDir) || !fs.statSync(currentDir).isDirectory()) {
      return;
    }

    // Skip unified store, active locks, and plugins folders from legacy scan
    const baseName = path.basename(currentDir);
    if (baseName === 'unified' || baseName === 'active' || baseName === 'plugins') {
      return;
    }

    // If directory has CURRENT, it's handled by unified store discovery
    if (fs.existsSync(path.join(currentDir, 'CURRENT'))) {
      return;
    }

    const metaPath = path.join(currentDir, 'meta.json');
    const messagesPath = path.join(currentDir, 'messages.jsonl');

    if (fs.existsSync(metaPath) && fs.existsSync(messagesPath)) {
      let meta: VibeMeta | null = null;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as VibeMeta;
      } catch {}

      const sessionId = meta?.session_id || path.basename(currentDir);
      if (this.isSessionActive(sessionId, currentDir, null)) {
        return;
      }

      if (options?.projectFilter) {
        const projectPath = meta?.environment?.working_directory || '';
        const projectName = path.basename(projectPath);
        if (!projectName.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          return;
        }
      }

      discovered.push(currentDir);
    }

    try {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subPath = path.join(currentDir, entry.name);
          this.discoverLegacyRecursive(subPath, discovered, options);
        }
      }
    } catch {
      // Silently skip unreadable directories
    }
  }

  async parse(sessionDirPath: string): Promise<ParsedSession | null> {
    if (fs.existsSync(path.join(sessionDirPath, 'CURRENT'))) {
      return this.parseUnifiedSession(sessionDirPath);
    }

    if (
      fs.existsSync(path.join(sessionDirPath, 'meta.json')) &&
      fs.existsSync(path.join(sessionDirPath, 'messages.jsonl'))
    ) {
      return this.parseLegacySession(sessionDirPath);
    }

    return null;
  }

  /**
   * Parse a modern unified store session (vibe 3.0+ unified store).
   */
  private async parseUnifiedSession(sessionDirPath: string): Promise<ParsedSession | null> {
    const currentPath = path.join(sessionDirPath, 'CURRENT');
    if (!fs.existsSync(currentPath)) return null;

    let current: VibeCurrentFile;
    try {
      current = JSON.parse(fs.readFileSync(currentPath, 'utf-8'));
    } catch (e) {
      console.error(`[mistral-vibe] Failed to parse CURRENT at ${currentPath}:`, e);
      return null;
    }

    const genDir = path.join(sessionDirPath, 'generations', current.generation);
    const manifestPath = path.join(genDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    let manifest: VibeManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    } catch (e) {
      console.error(`[mistral-vibe] Failed to parse manifest.json at ${manifestPath}:`, e);
      return null;
    }

    const projPath = path.join(genDir, 'projection-state.json');
    let projectionState: VibeProjectionState | null = null;
    if (fs.existsSync(projPath)) {
      try {
        projectionState = JSON.parse(fs.readFileSync(projPath, 'utf-8'));
      } catch {}
    }

    const metaPath = path.join(sessionDirPath, 'meta.json');
    let meta: VibeMeta | null = null;
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      } catch {}
    }

    const runtimePath = path.join(genDir, 'runtime-state.json');
    let runtimeState: VibeRuntimeState | null = null;
    if (fs.existsSync(runtimePath)) {
      try {
        runtimeState = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
      } catch {}
    }

    const chkPath = path.join(genDir, 'checkpoint.json');
    let checkpoint: VibeCheckpoint | null = null;
    if (fs.existsSync(chkPath)) {
      try {
        checkpoint = JSON.parse(fs.readFileSync(chkPath, 'utf-8'));
      } catch {}
    }

    const sessionId = current.session_id || projectionState?.session_id || meta?.session_id || path.basename(sessionDirPath);
    const isChild = sessionId.startsWith('child-') || path.basename(sessionDirPath).startsWith('child-');

    // Parent session linkage (Fact 7)
    let parentSessionId: string | null =
      projectionState?.snapshot?.session?.parentSessionId ||
      runtimeState?.session_metadata?.parent_session_id ||
      meta?.parent_session_id ||
      null;

    const parentInfo = parentSessionId
      ? this.findParentInfo(parentSessionId, sessionDirPath)
      : (isChild ? this.findParentByChildId(sessionId, sessionDirPath) : null);

    if (!parentSessionId && parentInfo?.parentSessionId) {
      parentSessionId = parentInfo.parentSessionId;
    }

    // Active plugins detection (Fact 9)
    const activePlugins = this.detectActivePlugins(sessionId, sessionDirPath, runtimeState, meta, parentSessionId);

    // Subagent agentType attribution (Fact 8)
    let rawAgentType: string | null =
      meta?.agent_type ||
      runtimeState?.session_metadata?.agent_name ||
      runtimeState?.session_metadata?.agent_type ||
      null;

    if (!rawAgentType && parentInfo?.notifications) {
      for (const n of parentInfo.notifications) {
        if (typeof n.id === 'string' && n.id.startsWith(`subagent:${sessionId}:`)) {
          const parts = n.id.split(':');
          if (parts.length >= 3 && parts[2]) {
            rawAgentType = parts[2];
            break;
          }
        }
      }
    }

    if (!rawAgentType && parentInfo?.subagents?.children) {
      for (const key of Object.keys(parentInfo.subagents.children)) {
        const child = parentInfo.subagents.children[key];
        if (child.child_session_id === sessionId) {
          rawAgentType = child.agent_type || child.agent_name || null;
          break;
        }
      }
    }

    const agentType = this.resolveAgentType(rawAgentType, sessionDirPath, activePlugins);
    if (agentType && agentType.includes(':')) {
      const pluginPrefix = agentType.split(':')[0];
      if (!activePlugins.includes(pluginPrefix)) {
        activePlugins.push(pluginPrefix);
      }
    }

    // Project directory and Git Branch resolution
    let projectPath =
      meta?.environment?.working_directory ||
      runtimeState?.session_metadata?.cwd ||
      runtimeState?.subagents?.policy_ceiling?.workdir ||
      parentInfo?.projectPath ||
      sessionDirPath;
    const projectName = path.basename(projectPath);

    const gitBranch =
      meta?.git_branch ||
      (runtimeState as any)?.git_branch ||
      parentInfo?.gitBranch ||
      null;

    // Timestamps
    const startedAt = meta?.start_time
      ? new Date(meta.start_time)
      : (projectionState?.snapshot?.session?.createdAt
        ? new Date(projectionState.snapshot.session.createdAt)
        : new Date());

    const endedAt = meta?.end_time
      ? new Date(meta.end_time)
      : (projectionState?.snapshot?.session?.updatedAt
        ? new Date(projectionState.snapshot.session.updatedAt)
        : startedAt);

    // Token usage (Fact 4)
    const tokenUsage = projectionState?.snapshot?.session?.tokenUsage || projectionState?.snapshot?.session?.contextUsage;
    const totalInputTokens = tokenUsage?.inputTokens ?? meta?.stats?.session_prompt_tokens ?? 0;
    const totalOutputTokens = tokenUsage?.outputTokens ?? meta?.stats?.session_completion_tokens ?? 0;
    const cacheReadTokens = tokenUsage?.cachedInputTokens ?? 0;
    const estimatedCostUsd = meta?.stats?.session_cost ?? 0;
    const primaryModel = runtimeState?.session_metadata?.active_model || 'mistral-vibe';
    const modelsUsed = runtimeState?.session_metadata?.active_model ? [runtimeState.session_metadata.active_model] : [];

    const usage: SessionUsage = {
      totalInputTokens,
      totalOutputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      estimatedCostUsd,
      modelsUsed,
      primaryModel,
      usageSource: 'session',
    };

    // Load Chunks (Facts 5 & 6)
    const chunksDir = path.join(sessionDirPath, 'chunks');
    const chunkHashes: string[] = [];

    if (manifest.projection_state?.chunks && manifest.projection_state.chunks.length > 0) {
      chunkHashes.push(...manifest.projection_state.chunks);
    } else if (manifest.checkpoint?.chunks && manifest.checkpoint.chunks.length > 0) {
      chunkHashes.push(...manifest.checkpoint.chunks);
    } else if (fs.existsSync(chunksDir)) {
      try {
        const files = fs.readdirSync(chunksDir).sort();
        chunkHashes.push(...files);
      } catch {}
    }

    const messages: ParsedMessage[] = [];
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let toolCallCount = 0;
    let pendingReasoning: string | null = null;
    let pendingToolResults: ToolResult[] = [];

    for (const hash of chunkHashes) {
      const candidatePaths = [
        path.join(chunksDir, hash.endsWith('.json') ? hash : `${hash}.json`),
        path.join(chunksDir, hash),
      ];

      let chunkData: any[] | null = null;
      for (const cp of candidatePaths) {
        if (fs.existsSync(cp)) {
          try {
            const raw = JSON.parse(fs.readFileSync(cp, 'utf-8'));
            if (Array.isArray(raw)) {
              chunkData = raw;
              break;
            }
          } catch {}
        }
      }

      if (!chunkData) continue;

      for (const item of chunkData) {
        const entry = item.message ? item.message : item;

        // 1. Standalone reasoning entry
        if (entry.type === 'reasoning') {
          const rText = this.extractText(entry);
          if (rText) {
            pendingReasoning = pendingReasoning ? `${pendingReasoning}\n${rText}` : rText;
          }
          continue;
        }

        // 2. Effect entry (tool execution & result)
        if (entry.type === 'effect') {
          const toolCallId = entry.id || `tc-${toolCallCount}`;
          const toolName = entry.detail?.toolName || entry.title || 'unknown';
          let toolInput = entry.detail?.input || {};
          if (typeof toolInput === 'string') {
            try {
              toolInput = JSON.parse(toolInput);
            } catch {
              toolInput = { raw: toolInput };
            }
          }

          const toolCall: ToolCall = {
            id: toolCallId,
            name: toolName,
            input: toolInput,
          };
          toolCallCount++;

          const output = this.extractToolOutput(entry.state);
          pendingToolResults.push({
            toolUseId: toolCallId,
            output,
          });

          // Attach tool call to assistant message
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.type === 'assistant') {
            lastMsg.toolCalls.push(toolCall);
            if (pendingReasoning && !lastMsg.thinking) {
              lastMsg.thinking = pendingReasoning;
              pendingReasoning = null;
            }
          } else {
            messages.push({
              id: `assistant-${toolCallId}`,
              sessionId,
              type: 'assistant',
              content: '',
              thinking: pendingReasoning,
              toolCalls: [toolCall],
              toolResults: [],
              usage: null,
              timestamp: entry.createdAt ? new Date(entry.createdAt) : new Date(startedAt),
              parentId: null,
            });
            assistantMessageCount++;
            pendingReasoning = null;
          }
          continue;
        }

        // 3. Message entry (user / assistant / tool)
        if (entry.type === 'message' || entry.role) {
          const role = entry.role || (entry.type === 'user' ? 'user' : (entry.type === 'assistant' ? 'assistant' : 'user'));

          if (role === 'tool') {
            pendingToolResults.push({
              toolUseId: entry.tool_call_id || entry.toolUseId || 'unknown',
              output: typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content),
            });
            continue;
          }

          let text = '';
          let thinking: string | null = pendingReasoning;
          const toolCalls: ToolCall[] = [];

          if (typeof entry.content === 'string') {
            const parsed = this.parseContent(entry.content);
            text = parsed.text;
            toolCalls.push(...parsed.toolCalls);
          } else if (Array.isArray(entry.content)) {
            for (const block of entry.content) {
              if (block.type === 'text') {
                text = text ? `${text}\n${block.text || ''}` : (block.text || '');
              } else if (block.type === 'reasoning') {
                const rText = this.extractText(block);
                if (rText) {
                  thinking = thinking ? `${thinking}\n${rText}` : rText;
                }
              } else if (block.type === 'tool_use' || block.type === 'tool_call' || block.type === 'function') {
                toolCalls.push({
                  id: block.id || `tc-${toolCallCount++}`,
                  name: block.name || block.function?.name || 'unknown',
                  input: typeof block.input === 'string'
                    ? JSON.parse(block.input)
                    : (block.input || block.function?.parameters || block.function?.arguments || {}),
                });
              }
            }
          }

          if (entry.reasoning) {
            thinking = thinking ? `${thinking}\n${entry.reasoning}` : entry.reasoning;
          }
          pendingReasoning = null;

          const msgTimestamp = entry.createdAt ? new Date(entry.createdAt) : new Date(startedAt);

          if (role === 'user') {
            messages.push({
              id: entry.id || entry.message_id || `msg-${messages.length}`,
              sessionId,
              type: 'user',
              content: text,
              thinking: null,
              toolCalls: [],
              toolResults: [...pendingToolResults],
              usage: null,
              timestamp: msgTimestamp,
              parentId: null,
            });
            userMessageCount++;
            pendingToolResults = [];
          } else if (role === 'assistant') {
            if (pendingToolResults.length > 0) {
              messages.push({
                id: `synthetic-user-${Date.now()}-${Math.random().toString(36).substring(7)}`,
                sessionId,
                type: 'user',
                content: '',
                thinking: null,
                toolCalls: [],
                toolResults: [...pendingToolResults],
                usage: null,
                timestamp: msgTimestamp,
                parentId: null,
              });
              userMessageCount++;
              pendingToolResults = [];
            }

            toolCallCount += toolCalls.length;
            messages.push({
              id: entry.id || entry.message_id || `msg-${messages.length}`,
              sessionId,
              type: 'assistant',
              content: text,
              thinking: thinking || null,
              toolCalls,
              toolResults: [],
              usage: null,
              timestamp: msgTimestamp,
              parentId: null,
            });
            assistantMessageCount++;
          }
        }
      }
    }

    // Flush any pending tool results
    if (pendingToolResults.length > 0) {
      messages.push({
        id: `synthetic-user-final-${Date.now()}`,
        sessionId,
        type: 'user',
        content: '',
        thinking: null,
        toolCalls: [],
        toolResults: [...pendingToolResults],
        usage: null,
        timestamp: new Date(endedAt),
        parentId: null,
      });
      userMessageCount++;
      pendingToolResults = [];
    }

    if (messages.length === 0) return null;

    // Distribute timestamps if not set accurately
    this.fixTimestamps(messages, startedAt, endedAt);

    const title = projectionState?.snapshot?.session?.title || meta?.title || null;
    const session: ParsedSession = {
      id: sessionId,
      projectPath,
      projectName,
      summary: null,
      generatedTitle: title,
      titleSource: title ? 'claude' : null,
      sessionCharacter: null,
      startedAt,
      endedAt,
      messageCount: userMessageCount + assistantMessageCount,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
      compactCount: 0,
      autoCompactCount: 0,
      slashCommands: [],
      gitBranch,
      claudeVersion: null,
      sourceTool: 'mistral-vibe',
      parentSessionId,
      agentType,
      activePlugins,
      usage,
      messages,
    };

    const titleResult = generateTitle(session);
    return {
      ...session,
      generatedTitle: session.generatedTitle || titleResult.title,
      titleSource: session.titleSource || titleResult.source,
      sessionCharacter: titleResult.character,
    };
  }

  /**
   * Parse a legacy session containing meta.json and messages.jsonl.
   */
  private async parseLegacySession(sessionDirPath: string): Promise<ParsedSession | null> {
    const metaPath = path.join(sessionDirPath, 'meta.json');
    const messagesPath = path.join(sessionDirPath, 'messages.jsonl');

    if (!fs.existsSync(metaPath) || !fs.existsSync(messagesPath)) {
      return null;
    }

    let meta: VibeMeta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch (e) {
      console.error(`[mistral-vibe] Failed to parse meta.json at ${metaPath}:`, e);
      return null;
    }

    const messages: ParsedMessage[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(messagesPath),
      crlfDelay: Infinity,
    });

    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let toolCallCount = 0;
    let pendingToolResults: ToolResult[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const rawMsg = JSON.parse(line) as VibeLegacyMessage;
        const sessionId = meta.session_id;

        if (rawMsg.role === 'tool') {
          pendingToolResults.push({
            toolUseId: rawMsg.tool_call_id || 'unknown',
            output: rawMsg.content,
          });
          continue;
        }

        if (pendingToolResults.length > 0 && (rawMsg.role === 'user' || rawMsg.role === 'assistant')) {
          if (rawMsg.role === 'assistant') {
            messages.push({
              id: `synthetic-user-${Date.now()}-${Math.random()}`,
              sessionId,
              type: 'user',
              content: '',
              thinking: null,
              toolCalls: [],
              toolResults: [...pendingToolResults],
              usage: null,
              timestamp: new Date(meta.start_time),
              parentId: null,
            });
            userMessageCount++;
            pendingToolResults = [];
          }
        }

        const { text, toolCalls } = this.parseContent(rawMsg.content);
        const type = rawMsg.role === 'system' ? 'system' : (rawMsg.role === 'assistant' ? 'assistant' : 'user');

        const parsedMsg: ParsedMessage = {
          id: rawMsg.message_id || `msg-${messages.length}`,
          sessionId,
          type,
          content: text,
          thinking: rawMsg.reasoning || null,
          toolCalls,
          toolResults: rawMsg.role === 'user' ? [...pendingToolResults] : [],
          usage: null,
          timestamp: new Date(meta.start_time),
          parentId: null,
        };

        if (rawMsg.role === 'user') {
          userMessageCount++;
          pendingToolResults = [];
        } else if (rawMsg.role === 'assistant') {
          assistantMessageCount++;
        }

        toolCallCount += toolCalls.length;
        messages.push(parsedMsg);
      } catch {
        continue;
      }
    }

    if (pendingToolResults.length > 0) {
      messages.push({
        id: `synthetic-user-final-${Date.now()}`,
        sessionId: meta.session_id,
        type: 'user',
        content: '',
        thinking: null,
        toolCalls: [],
        toolResults: pendingToolResults,
        usage: null,
        timestamp: new Date(meta.end_time),
        parentId: null,
      });
      userMessageCount++;
    }

    if (messages.length === 0) return null;

    const startedAt = new Date(meta.start_time);
    const endedAt = new Date(meta.end_time);
    this.fixTimestamps(messages, startedAt, endedAt);

    const projectPath = meta.environment?.working_directory || sessionDirPath;
    const projectName = path.basename(projectPath);

    const usage: SessionUsage = {
      totalInputTokens: meta.stats?.session_prompt_tokens || 0,
      totalOutputTokens: meta.stats?.session_completion_tokens || 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: meta.stats?.session_cost || 0,
      modelsUsed: [],
      primaryModel: 'mistral-vibe',
      usageSource: 'session',
    };

    const activePlugins: string[] = [];
    if (meta.plugins && Array.isArray(meta.plugins)) {
      for (const p of meta.plugins) {
        if (typeof p === 'string') activePlugins.push(p);
        else if (p && typeof p.name === 'string') activePlugins.push(p.name);
      }
    }

    const session: ParsedSession = {
      id: meta.session_id,
      projectPath,
      projectName,
      summary: null,
      generatedTitle: meta.title || null,
      titleSource: meta.title ? 'claude' : null,
      sessionCharacter: null,
      startedAt,
      endedAt,
      messageCount: userMessageCount + assistantMessageCount,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
      compactCount: 0,
      autoCompactCount: 0,
      slashCommands: [],
      gitBranch: meta.git_branch || null,
      claudeVersion: null,
      sourceTool: 'mistral-vibe',
      parentSessionId: meta.parent_session_id || null,
      agentType: meta.agent_type || null,
      activePlugins,
      usage,
      messages,
    };

    const titleResult = generateTitle(session);
    return {
      ...session,
      generatedTitle: session.generatedTitle || titleResult.title,
      titleSource: session.titleSource || titleResult.source,
      sessionCharacter: titleResult.character,
    };
  }

  /**
   * Helper to extract text from a block or entry.
   */
  private extractText(entry: any): string {
    if (!entry) return '';
    if (typeof entry.text === 'string') return entry.text;
    if (Array.isArray(entry.content)) {
      return entry.content.map((c: any) => this.extractText(c)).filter(Boolean).join('\n');
    }
    return '';
  }

  /**
   * Helper to extract tool output from an effect state.
   */
  private extractToolOutput(state: any): string {
    if (!state) return '';
    if (typeof state.outputText === 'string' && state.outputText) {
      return state.outputText;
    }
    if (state.output) {
      if (typeof state.output === 'string') {
        return state.output;
      }
      if (state.output.structured_content) {
        const sc = state.output.structured_content;
        if (typeof sc.content === 'string') return sc.content;
        if (typeof sc.value === 'string') return sc.value;
        if (typeof sc === 'string') return sc;
        return JSON.stringify(sc);
      }
      if (Array.isArray(state.output.content)) {
        return state.output.content
          .map((c: any) => (typeof c === 'string' ? c : c.text || JSON.stringify(c)))
          .join('\n');
      }
      return JSON.stringify(state.output);
    }
    return '';
  }

  /**
   * Distribute message timestamps across duration if timestamps are uniform or invalid.
   */
  private fixTimestamps(messages: ParsedMessage[], startedAt: Date, endedAt: Date): void {
    const startTime = startedAt.getTime();
    const endTime = endedAt.getTime();
    const duration = Math.max(0, endTime - startTime);

    const hasDistinctTimestamps =
      messages.length > 1 &&
      messages[0].timestamp.getTime() !== messages[messages.length - 1].timestamp.getTime();

    if (!hasDistinctTimestamps && messages.length > 0) {
      const interval = messages.length > 1 ? duration / (messages.length - 1) : 0;
      messages.forEach((msg, i) => {
        msg.timestamp = new Date(startTime + i * interval);
      });
    }
  }

  /**
   * Find parent session details by scanning known unified parent directories for childSessionId.
   */
  private findParentByChildId(
    childSessionId: string,
    sessionDirPath: string
  ): ParentSessionInfo | null {
    if (this.childToParentIndex === null) {
      this.childToParentIndex = new Map();
      const parentDir = path.dirname(sessionDirPath);
      if (fs.existsSync(parentDir)) {
        try {
          const entries = fs.readdirSync(parentDir, { withFileTypes: true });
          for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('child-')) continue;
            const candidateDir = path.join(parentDir, entry.name);
            const curPath = path.join(candidateDir, 'CURRENT');
            if (!fs.existsSync(curPath)) continue;

            const info = this.findParentInfo(entry.name, sessionDirPath);
            if (!info) continue;

            // Check if child is referenced in checkpoint notifications
            if (info.notifications) {
              for (const n of info.notifications) {
                if (typeof n.id === 'string' && n.id.startsWith('subagent:')) {
                  const parts = n.id.split(':');
                  if (parts.length >= 2 && parts[1]) {
                    this.childToParentIndex.set(parts[1], { ...info });
                  }
                }
              }
            }

            // Check if child is referenced in runtime-state subagents
            if (info.subagents?.children) {
              for (const key of Object.keys(info.subagents.children)) {
                const child = info.subagents.children[key];
                if (child.child_session_id) {
                  this.childToParentIndex.set(child.child_session_id, { ...info });
                }
              }
            }
          }
        } catch {}
      }
    }

    return this.childToParentIndex.get(childSessionId) || null;
  }

  /**
   * Find parent session details given its parentSessionId.
   */
  private findParentInfo(
    parentSessionId: string,
    sessionDirPath: string
  ): ParentSessionInfo | null {
    if (this.parentInfoCache.has(parentSessionId)) {
      return this.parentInfoCache.get(parentSessionId) || null;
    }

    const baseDir = this.storageDir || getVibeLogsDir();
    const candidateDirs = [
      path.join(path.dirname(sessionDirPath), parentSessionId),
      path.join(baseDir, 'unified', parentSessionId),
      path.join(baseDir, parentSessionId),
    ];

    for (const parentDir of candidateDirs) {
      if (!fs.existsSync(parentDir)) continue;

      try {
        const curPath = path.join(parentDir, 'CURRENT');
        let generation: string | null = null;
        if (fs.existsSync(curPath)) {
          const cur = JSON.parse(fs.readFileSync(curPath, 'utf-8')) as VibeCurrentFile;
          generation = cur.generation;
        }

        let projectPath: string | undefined;
        let gitBranch: string | undefined;

        const metaPath = path.join(parentDir, 'meta.json');
        if (fs.existsSync(metaPath)) {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
          projectPath = meta.environment?.working_directory;
          gitBranch = meta.git_branch;
        }

        let runtimeState: VibeRuntimeState | null = null;
        let checkpoint: VibeCheckpoint | null = null;

        if (generation) {
          const genDir = path.join(parentDir, 'generations', generation);
          const runtimePath = path.join(genDir, 'runtime-state.json');
          if (fs.existsSync(runtimePath)) {
            runtimeState = JSON.parse(fs.readFileSync(runtimePath, 'utf-8'));
            if (!projectPath) {
              projectPath = runtimeState?.session_metadata?.cwd || runtimeState?.subagents?.policy_ceiling?.workdir;
            }
          }

          const chkPath = path.join(genDir, 'checkpoint.json');
          if (fs.existsSync(chkPath)) {
            checkpoint = JSON.parse(fs.readFileSync(chkPath, 'utf-8'));
          }
        }

        const res: ParentSessionInfo = {
          parentSessionId,
          projectPath,
          gitBranch,
          notifications: checkpoint?.notifications,
          subagents: runtimeState?.subagents,
        };
        this.parentInfoCache.set(parentSessionId, res);
        return res;
      } catch {}
    }

    this.parentInfoCache.set(parentSessionId, null);
    return null;
  }

  /**
   * Attribute subagent agentType to source plugin (e.g. ruby-dev:verifier).
   */
  private resolveAgentType(
    agentType: string | null,
    sessionDirPath: string,
    activePlugins: string[]
  ): string | null {
    if (!agentType) return null;
    if (agentType.includes(':')) return agentType;

    if (!this.pluginAgentMap) {
      this.pluginAgentMap = new Map();
      const baseDir = this.storageDir || getVibeLogsDir();
      const candidatePluginsDirs = [
        path.join(baseDir, 'plugins'),
        path.join(path.dirname(sessionDirPath), '..', 'plugins'),
        path.join(path.dirname(baseDir), 'plugins'),
      ];

      for (const pDir of candidatePluginsDirs) {
        const pkgBase = path.join(pDir, 'packages');
        if (fs.existsSync(pkgBase) && fs.statSync(pkgBase).isDirectory()) {
          try {
            const shards = fs.readdirSync(pkgBase, { withFileTypes: true });
            for (const shard of shards) {
              if (!shard.isDirectory()) continue;
              const shardDir = path.join(pkgBase, shard.name);
              const pkgs = fs.readdirSync(shardDir, { withFileTypes: true });
              for (const pkg of pkgs) {
                if (!pkg.isDirectory()) continue;
                const pkgDir = path.join(shardDir, pkg.name);
                const pluginJsonPath = path.join(pkgDir, 'plugin.json');
                if (fs.existsSync(pluginJsonPath)) {
                  try {
                    const pJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
                    const pluginName = pJson.name;

                    const agentDirs = [
                      path.join(pkgDir, 'ai.mistral.vibe', 'agents'),
                      path.join(pkgDir, 'agents'),
                    ];
                    for (const aDir of agentDirs) {
                      if (fs.existsSync(aDir) && fs.statSync(aDir).isDirectory()) {
                        const aFiles = fs.readdirSync(aDir);
                        for (const af of aFiles) {
                          if (af.endsWith('.toml')) {
                            const aName = path.basename(af, '.toml');
                            this.pluginAgentMap.set(aName, `${pluginName}:${aName}`);
                          }
                        }
                      }
                    }

                    if (pluginName === 'ruby-dev') {
                      for (const a of ['specifier', 'implementer', 'cleaner', 'hardener', 'verifier', 'rubyist']) {
                        this.pluginAgentMap.set(a, `ruby-dev:${a}`);
                      }
                    }
                  } catch {}
                }
              }
            }
          } catch {}
        }
      }

      // Built-in ruby-dev agent mapping
      for (const a of ['specifier', 'implementer', 'cleaner', 'hardener', 'verifier', 'rubyist']) {
        if (!this.pluginAgentMap.has(a)) {
          this.pluginAgentMap.set(a, `ruby-dev:${a}`);
        }
      }
    }

    if (this.pluginAgentMap.has(agentType)) {
      return this.pluginAgentMap.get(agentType)!;
    }

    return agentType;
  }

  /**
   * Detect all active plugins for this session from runtime-state, data logs, and parent.
   */
  private detectActivePlugins(
    sessionId: string,
    sessionDirPath: string,
    runtimeState: VibeRuntimeState | null,
    meta: VibeMeta | null,
    parentSessionId?: string | null
  ): string[] {
    const plugins = new Set<string>();

    if (runtimeState?.core_plugins && Array.isArray(runtimeState.core_plugins)) {
      for (const p of runtimeState.core_plugins) {
        if (p.name) plugins.add(p.name);
      }
    }

    const baseDir = this.storageDir || getVibeLogsDir();
    const candidatePluginsDirs = [
      path.join(baseDir, 'plugins'),
      path.join(path.dirname(sessionDirPath), '..', 'plugins'),
      path.join(path.dirname(baseDir), 'plugins'),
    ];

    for (const pDir of candidatePluginsDirs) {
      const dataDir = path.join(pDir, 'data', sessionId);
      if (fs.existsSync(dataDir) && fs.statSync(dataDir).isDirectory()) {
        try {
          const entries = fs.readdirSync(dataDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              plugins.add(entry.name);
            }
          }
        } catch {}
      }

      if (parentSessionId) {
        const parentDataDir = path.join(pDir, 'data', parentSessionId);
        if (fs.existsSync(parentDataDir) && fs.statSync(parentDataDir).isDirectory()) {
          try {
            const entries = fs.readdirSync(parentDataDir, { withFileTypes: true });
            for (const entry of entries) {
              if (entry.isDirectory()) {
                plugins.add(entry.name);
              }
            }
          } catch {}
        }
      }
    }

    if (meta?.plugins && Array.isArray(meta.plugins)) {
      for (const p of meta.plugins) {
        if (typeof p === 'string') plugins.add(p);
        else if (p && typeof p.name === 'string') plugins.add(p.name);
      }
    }

    return Array.from(plugins);
  }

  private parseContent(content: string): { text: string; toolCalls: ToolCall[] } {
    if (!content) return { text: '', toolCalls: [] };

    if (content.trim().startsWith('[')) {
      try {
        let depth = 0;
        let jsonEnd = -1;
        for (let i = 0; i < content.length; i++) {
          if (content[i] === '[') depth++;
          else if (content[i] === ']') {
            depth--;
            if (depth === 0) {
              jsonEnd = i;
              break;
            }
          }
        }

        if (jsonEnd !== -1) {
          const possibleJson = content.substring(0, jsonEnd + 1);
          const parsed = JSON.parse(possibleJson);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type === 'function') {
            const toolCalls: ToolCall[] = parsed.map((tc: any, idx) => ({
              id: tc.id || `tc-${idx}`,
              name: tc.function?.name || 'unknown',
              input: typeof tc.function?.parameters === 'string' 
                ? JSON.parse(tc.function.parameters) 
                : (tc.function?.parameters || tc.function?.arguments || {}),
            }));
            const text = content.substring(jsonEnd + 1).trim();
            return { text, toolCalls };
          }
        }
      } catch {}
    }

    return { text: content, toolCalls: [] };
  }
}
