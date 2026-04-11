import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, SessionUsage } from '../types.js';
import { getHermesHomeDir } from '../utils/config.js';

/**
 * Hermes Agent session provider.
 * Discovers and parses sessions from Hermes Agent SQLite databases:
 * 1. Central database: ~/.hermes/state.db
 * 2. Profile databases: ~/.hermes/profiles/<profile_name>/state.db
 */
export class HermesAgentProvider implements SessionProvider {
  getProviderName(): string {
    return 'hermes-agent';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const virtualPaths: string[] = [];

    // Discover central database sessions
    const centralSessions = await this.discoverDatabaseSessions(options);
    virtualPaths.push(...centralSessions);

    // Discover profile database sessions
    const profileSessions = await this.discoverProfileDatabaseSessions(options);
    virtualPaths.push(...profileSessions);

    return virtualPaths;
  }

  /**
   * Discover sessions from the central SQLite database
   */
  private async discoverDatabaseSessions(options?: { projectFilter?: string }): Promise<string[]> {
    const homeDir = getHermesHomeDir();
    const dbPath = path.join(homeDir, 'state.db');

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    return this.discoverSessionsFromDatabase(dbPath, 'central', options);
  }

  /**
   * Discover sessions from profile SQLite databases
   */
  private async discoverProfileDatabaseSessions(options?: { projectFilter?: string }): Promise<string[]> {
    const homeDir = getHermesHomeDir();
    const profilesDir = path.join(homeDir, 'profiles');

    if (!fs.existsSync(profilesDir)) {
      return [];
    }

    const virtualPaths: string[] = [];

    try {
      const profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name);

      for (const profileName of profiles) {
        const profileDbPath = path.join(profilesDir, profileName, 'state.db');

        if (fs.existsSync(profileDbPath)) {
          const sessions = await this.discoverSessionsFromDatabase(profileDbPath, profileName, options);
          virtualPaths.push(...sessions);
        }
      }

      return virtualPaths;
    } catch (err) {
      console.error(`[hermes-agent] Failed to discover profile database sessions: ${err}`);
      return [];
    }
  }

  /**
   * Discover sessions from a specific SQLite database
   */
  private async discoverSessionsFromDatabase(
    dbPath: string,
    source: string,
    options?: { projectFilter?: string }
  ): Promise<string[]> {
    let db: InstanceType<typeof Database> | null = null;
    try {
      // Use WAL mode compatible options and timeout for active Hermes services
      db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 5000 // 5 second timeout for locks
      });

      // Set connection to be more tolerant of concurrent access
      db.pragma('busy_timeout = 5000');

      const sessions = db.prepare('SELECT id, title FROM sessions').all() as { id: string, title: string | null }[];

      const virtualPaths: string[] = [];
      for (const session of sessions) {
        // Apply project filter if specified (check title)
        if (options?.projectFilter && session.title && !session.title.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          continue;
        }
        virtualPaths.push(`${source}:${dbPath}#${session.id}`);
      }

      return virtualPaths;
    } catch (err) {
      console.error(`[hermes-agent] Failed to discover sessions from database ${dbPath}: ${err}`);
      return [];
    } finally {
      db?.close();
    }
  }

  async parse(virtualPath: string): Promise<ParsedSession | null> {
    // Parse virtualPath format: "source:dbPath#sessionId"
    const sourceEndIndex = virtualPath.indexOf(':');
    if (sourceEndIndex === -1) {
      // Backward compatibility: treat as central database
      return this.parseDatabaseSession('central', virtualPath);
    }

    const source = virtualPath.slice(0, sourceEndIndex);
    const pathWithSession = virtualPath.slice(sourceEndIndex + 1);

    return this.parseDatabaseSession(source, pathWithSession);
  }

  /**
   * Parse a session from any SQLite database
   */
  private async parseDatabaseSession(source: string, pathWithSession: string): Promise<ParsedSession | null> {
    const hashIndex = pathWithSession.lastIndexOf('#');
    if (hashIndex === -1) return null;

    const dbPath = pathWithSession.slice(0, hashIndex);
    const sessionId = pathWithSession.slice(hashIndex + 1);

    let db: InstanceType<typeof Database> | null = null;
    try {
      // Use WAL mode compatible options and timeout for active Hermes services
      db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 5000 // 5 second timeout for locks
      });

      // Set connection to be more tolerant of concurrent access
      db.pragma('busy_timeout = 5000');

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
          id: `hermes-${source}-${row.id}`,
          sessionId: `hermes-agent-${source}:${sessionId}`,
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

      // Generate appropriate project name based on source
      const projectName = source === 'central'
        ? sessionRow.title || 'hermes-agent-session'
        : `hermes-profile-${source}`;

      return {
        id: `hermes-agent-${source}:${sessionId}`,
        projectPath: '', // Hermes Agent sessions are global or project-unaware in the DB
        projectName,
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
      console.error(`[hermes-agent] Failed to parse session ${sessionId} from ${source}: ${err}`);
      return null;
    } finally {
      db?.close();
    }
  }
}