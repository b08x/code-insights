import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

interface VibeMeta {
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
}

interface VibeMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  message_id?: string;
  tool_call_id?: string;
  name?: string; // tool name
  injected?: boolean;
}

/**
 * Mistral Vibe session provider.
 * Discovers and parses session logs from ~/.vibe/logs/session/
 */
export class MistralVibeProvider implements SessionProvider {
  private storageDir?: string;

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

    const sessionDirs = fs.readdirSync(baseDir);
    const discovered: string[] = [];

    for (const dir of sessionDirs) {
      if (!dir.startsWith('session_')) continue;

      const fullPath = path.join(baseDir, dir);
      if (!fs.statSync(fullPath).isDirectory()) continue;

      const metaPath = path.join(fullPath, 'meta.json');
      const messagesPath = path.join(fullPath, 'messages.jsonl');

      if (fs.existsSync(metaPath) && fs.existsSync(messagesPath)) {
        // Apply project filter if possible by reading meta.json
        if (options?.projectFilter) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as VibeMeta;
            const projectPath = meta.environment?.working_directory || '';
            const projectName = path.basename(projectPath);
            if (!projectName.toLowerCase().includes(options.projectFilter.toLowerCase())) {
              continue;
            }
          } catch (e) {
            // If we can't read meta, we'll still include it and let parse() handle errors
          }
        }
        discovered.push(fullPath);
      }
    }

    return discovered;
  }

  async parse(sessionDirPath: string): Promise<ParsedSession | null> {
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
        const rawMsg = JSON.parse(line) as VibeMessage;
        const sessionId = meta.session_id;

        if (rawMsg.role === 'tool') {
          pendingToolResults.push({
            toolUseId: rawMsg.tool_call_id || 'unknown',
            output: rawMsg.content,
          });
          continue;
        }

        // If we have tool results pending and this is NOT a tool message,
        // we should flush them. Standard behavior in this app is to attach 
        // tool results to a user message.
        if (pendingToolResults.length > 0 && (rawMsg.role === 'user' || rawMsg.role === 'assistant')) {
          // If the next message is a user message, we can attach them to it.
          // If it's an assistant message, we create a synthetic user message.
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
               timestamp: new Date(), // We don't have per-message timestamps in messages.jsonl usually, will fix below
               parentId: null,
             });
             userMessageCount++;
             pendingToolResults = [];
          } else if (rawMsg.role === 'user') {
            // We'll attach them to the actual user message that follows
            // But wait, in Mistral Vibe, the tool result message IS the user turn effectively.
          }
        }

        const { text, toolCalls } = this.parseContent(rawMsg.content);
        
        const type = rawMsg.role === 'system' ? 'system' : (rawMsg.role === 'assistant' ? 'assistant' : 'user');
        
        const parsedMsg: ParsedMessage = {
          id: rawMsg.message_id || `msg-${messages.length}`,
          sessionId,
          type,
          content: text,
          thinking: null, // Mistral Vibe doesn't seem to separate thinking in logs yet
          toolCalls,
          toolResults: rawMsg.role === 'user' ? [...pendingToolResults] : [],
          usage: null, // Per-message usage not in messages.jsonl
          timestamp: new Date(meta.start_time), // Fallback, will distribute below
          parentId: null,
        };

        if (rawMsg.role === 'user') {
          userMessageCount++;
          pendingToolResults = []; // Cleared because we attached them
        } else if (rawMsg.role === 'assistant') {
          assistantMessageCount++;
        }
        
        toolCallCount += toolCalls.length;
        messages.push(parsedMsg);

      } catch (e) {
        continue;
      }
    }

    // Flush any remaining tool results
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

    // Distribute timestamps between start and end time
    const startTime = new Date(meta.start_time).getTime();
    const endTime = new Date(meta.end_time).getTime();
    const duration = endTime - startTime;
    const interval = messages.length > 1 ? duration / (messages.length - 1) : 0;

    messages.forEach((msg, i) => {
      msg.timestamp = new Date(startTime + i * interval);
    });

    const projectPath = meta.environment?.working_directory || sessionDirPath;
    const projectName = path.basename(projectPath);

    const usage: SessionUsage = {
      totalInputTokens: meta.stats?.session_prompt_tokens || 0,
      totalOutputTokens: meta.stats?.session_completion_tokens || 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      estimatedCostUsd: meta.stats?.session_cost || 0,
      modelsUsed: [], // Can't easily tell from meta, maybe parse config?
      primaryModel: 'mistral-vibe',
      usageSource: 'session',
    };

    const session: ParsedSession = {
      id: meta.session_id,
      projectPath,
      projectName,
      summary: null,
      generatedTitle: meta.title || null,
      titleSource: meta.title ? 'claude' : null,
      sessionCharacter: null,
      startedAt: new Date(meta.start_time),
      endedAt: new Date(meta.end_time),
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

  private parseContent(content: string): { text: string; toolCalls: ToolCall[] } {
    if (!content) return { text: '', toolCalls: [] };

    // Mistral Vibe encodes tool calls as a JSON array of objects with "type": "function"
    if (content.trim().startsWith('[')) {
      try {
        // We need to find the balanced closing bracket for the array
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
      } catch (e) {
        // Fallback to text if parsing fails
      }
    }

    return { text: content, toolCalls: [] };
  }
}
