import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, SessionUsage } from '../types.js';
import { getHermesHomeDir } from '../utils/config.js';

/**
 * Hermes Agent session provider.
 * Discovers and parses sessions from Hermes Agent's SQLite database (~/.hermes/state.db).
 */
export class HermesAgentProvider implements SessionProvider {
  getProviderName(): string {
    return 'hermes-agent';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const homeDir = getHermesHomeDir();
    const dbPath = path.join(homeDir, 'state.db');

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      
      const sessions = db.prepare('SELECT id, title FROM sessions').all() as { id: string, title: string | null }[];
      
      const virtualPaths: string[] = [];
      for (const session of sessions) {
        // Apply project filter if specified (check title)
        if (options?.projectFilter && session.title && !session.title.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          continue;
        }
        virtualPaths.push(`${dbPath}#${session.id}`);
      }
      
      return virtualPaths;
    } catch (err) {
      console.error(`[hermes-agent] Failed to discover sessions: ${err}`);
      return [];
    } finally {
      db?.close();
    }
  }

  async parse(virtualPath: string): Promise<ParsedSession | null> {
    const hashIndex = virtualPath.lastIndexOf('#');
    if (hashIndex === -1) return null;

    const dbPath = virtualPath.slice(0, hashIndex);
    const sessionId = virtualPath.slice(hashIndex + 1);

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      const sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
      if (!sessionRow) return null;

      const messageRows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as any[];

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      for (const row of messageRows) {
        if (row.role === 'tool') {
          // Attach to the last assistant message as a tool result
          const lastAssistant = messages.reverse().find(m => m.type === 'assistant');
          messages.reverse(); // back to original order

          if (lastAssistant) {
            lastAssistant.toolResults.push({
              toolUseId: row.tool_call_id || `tool-${row.id}`,
              output: row.content || '',
            });
            continue;
          }
        }

        const type = row.role === 'assistant' ? 'assistant' : (row.role === 'user' ? 'user' : 'system');
        const toolCalls: ToolCall[] = [];
        if (row.tool_calls) {
          try {
            const parsedCalls = JSON.parse(row.tool_calls);
            if (Array.isArray(parsedCalls)) {
              for (const tc of parsedCalls) {
                toolCalls.push({
                  id: tc.id,
                  name: tc.name || tc.function?.name || 'unknown',
                  input: tc.args || tc.function?.arguments || {},
                });
              }
            }
          } catch {
            // Ignore parse errors
          }
        }

        const parsedMsg: ParsedMessage = {
          id: `hermes-${row.id}`,
          sessionId: `hermes-agent:${sessionId}`,
          type,
          content: row.content || '',
          thinking: row.reasoning || null,
          toolCalls,
          toolResults: [],
          usage: row.token_count ? {
            inputTokens: 0, // Hermes doesn't seem to store per-message input tokens in the messages table
            outputTokens: row.token_count,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            model: sessionRow.model || 'unknown',
            estimatedCostUsd: 0, // Will be calculated at session level
          } : null,
          timestamp: new Date(row.timestamp * 1000),
          parentId: null,
        };

        if (parsedMsg.type === 'user') userMessageCount++;
        if (parsedMsg.type === 'assistant') assistantMessageCount++;
        toolCallCount += toolCalls.length;

        messages.push(parsedMsg);
      }

      const sessionUsage: SessionUsage = {
        totalInputTokens: sessionRow.input_tokens || 0,
        totalOutputTokens: sessionRow.output_tokens || 0,
        cacheCreationTokens: sessionRow.cache_write_tokens || 0,
        cacheReadTokens: sessionRow.cache_read_tokens || 0,
        estimatedCostUsd: sessionRow.actual_cost_usd || sessionRow.estimated_cost_usd || 0,
        modelsUsed: sessionRow.model ? [sessionRow.model] : [],
        primaryModel: sessionRow.model || 'unknown',
        usageSource: 'session',
      };

      return {
        id: `hermes-agent:${sessionId}`,
        projectPath: '', // Hermes Agent sessions are global or project-unaware in the DB
        projectName: sessionRow.title || 'hermes-agent-session',
        summary: null,
        generatedTitle: sessionRow.title || null,
        titleSource: sessionRow.title ? 'insight' : null,
        sessionCharacter: null,
        startedAt: new Date(sessionRow.started_at * 1000),
        endedAt: sessionRow.ended_at ? new Date(sessionRow.ended_at * 1000) : new Date(sessionRow.started_at * 1000),
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: null,
        sourceTool: 'hermes-agent',
        usage: sessionUsage,
        messages,
      };
    } catch (err) {
      console.error(`[hermes-agent] Failed to parse session ${sessionId}: ${err}`);
      return null;
    } finally {
      db?.close();
    }
  }
}
