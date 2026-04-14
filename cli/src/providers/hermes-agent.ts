import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, SessionUsage } from '../types.js';
import { getHermesHomeDir } from '../utils/config.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

/**
 * Hermes Agent session provider.
 * Discovers and parses sessions from Hermes Agent:
 * 1. Central SQLite database: ~/.hermes/state.db
 * 2. Profile SQLite databases: ~/.hermes/profiles/<profile_name>/state.db
 * 3. JSON session files: ~/.hermes/sessions/*.json
 * 4. Profile JSON session files: ~/.hermes/profiles/<profile_name>/sessions/*.json
 */
export class HermesAgentProvider implements SessionProvider {
  getProviderName(): string {
    return 'hermes-agent';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const virtualPaths: string[] = [];

    // 1. Discover database sessions (central and profiles)
    const dbSessions = await this.discoverAllDatabaseSessions(options);
    virtualPaths.push(...dbSessions);

    // 2. Discover JSON session files (central and profiles)
    const jsonSessions = await this.discoverAllJsonSessions(options);
    virtualPaths.push(...jsonSessions);

    return virtualPaths;
  }

  /**
   * Discover sessions from all known SQLite databases
   */
  private async discoverAllDatabaseSessions(options?: { projectFilter?: string }): Promise<string[]> {
    const homeDir = getHermesHomeDir();
    const virtualPaths: string[] = [];

    // Central database
    const centralDbPath = path.join(homeDir, 'state.db');
    if (fs.existsSync(centralDbPath)) {
      const sessions = await this.discoverSessionsFromDatabase(centralDbPath, options);
      virtualPaths.push(...sessions);
    }

    // Profile databases
    const profilesDir = path.join(homeDir, 'profiles');
    if (fs.existsSync(profilesDir)) {
      try {
        const profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);

        for (const profileName of profiles) {
          const profileDbPath = path.join(profilesDir, profileName, 'state.db');
          if (fs.existsSync(profileDbPath)) {
            const sessions = await this.discoverSessionsFromDatabase(profileDbPath, options);
            virtualPaths.push(...sessions);
          }
        }
      } catch (err) {
        console.error(`[hermes-agent] Failed to discover profile database sessions: ${err}`);
      }
    }

    return virtualPaths;
  }

  /**
   * Discover sessions from all known JSON storage locations
   */
  private async discoverAllJsonSessions(options?: { projectFilter?: string }): Promise<string[]> {
    const homeDir = getHermesHomeDir();
    const jsonPaths: string[] = [];

    // Central sessions directory
    const centralSessionsDir = path.join(homeDir, 'sessions');
    if (fs.existsSync(centralSessionsDir)) {
      const files = this.discoverJsonFilesInDir(centralSessionsDir);
      jsonPaths.push(...files);
    }

    // Profile sessions directories
    const profilesDir = path.join(homeDir, 'profiles');
    if (fs.existsSync(profilesDir)) {
      try {
        const profiles = fs.readdirSync(profilesDir, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);

        for (const profileName of profiles) {
          const profileSessionsDir = path.join(profilesDir, profileName, 'sessions');
          if (fs.existsSync(profileSessionsDir)) {
            const files = this.discoverJsonFilesInDir(profileSessionsDir);
            jsonPaths.push(...files);
          }
        }
      } catch (err) {
        console.error(`[hermes-agent] Failed to discover profile JSON sessions: ${err}`);
      }
    }

    // Filter by project if needed (requires reading titles, but we'll defer to parse for efficiency
    // unless a heavy filter is requested. For now, we return all JSON files.)
    return jsonPaths;
  }

  private discoverJsonFilesInDir(dir: string): string[] {
    try {
      return fs.readdirSync(dir)
        .filter(file => file.startsWith('session_') && file.endsWith('.json'))
        .map(file => path.join(dir, file));
    } catch {
      return [];
    }
  }

  /**
   * Discover sessions from a specific SQLite database
   */
  private async discoverSessionsFromDatabase(
    dbPath: string,
    options?: { projectFilter?: string }
  ): Promise<string[]> {
    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 5000
      });
      db.pragma('busy_timeout = 5000');

      const sessions = db.prepare('SELECT id, title FROM sessions').all() as { id: string, title: string | null }[];

      const virtualPaths: string[] = [];
      for (const session of sessions) {
        if (options?.projectFilter && session.title && !session.title.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          continue;
        }
        // Format: dbPath#sessionId (Standard format used by Cursor too)
        virtualPaths.push(`${dbPath}#${session.id}`);
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
    // 1. Handle backward compatible virtualPath format: "source:dbPath#sessionId"
    if (virtualPath.includes(':') && virtualPath.includes('#') && !virtualPath.startsWith('/')) {
      const sourceEndIndex = virtualPath.indexOf(':');
      const source = virtualPath.slice(0, sourceEndIndex);
      const pathWithSession = virtualPath.slice(sourceEndIndex + 1);
      return this.parseDatabaseSession(source, pathWithSession);
    }

    // 2. Handle new standard database format: "dbPath#sessionId"
    if (virtualPath.includes('#')) {
      const hashIndex = virtualPath.lastIndexOf('#');
      const dbPath = virtualPath.slice(0, hashIndex);
      const sessionId = virtualPath.slice(hashIndex + 1);
      const source = this.getSourceFromPath(dbPath);
      return this.parseDatabaseSession(source, `${dbPath}#${sessionId}`);
    }

    // 3. Handle JSON session files: "path/to/session_*.json"
    if (virtualPath.endsWith('.json')) {
      return this.parseJsonSession(virtualPath);
    }

    return null;
  }

  private getSourceFromPath(dbOrJsonPath: string): string {
    const profilesMatch = dbOrJsonPath.match(/profiles\/([^/]+)/);
    return profilesMatch ? profilesMatch[1] : 'central';
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
      db = new Database(dbPath, {
        readonly: true,
        fileMustExist: true,
        timeout: 5000
      });
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
          const lastAssistant = messages.reverse().find(m => m.type === 'assistant');
          messages.reverse();

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
            inputTokens: 0,
            outputTokens: row.token_count,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            model: sessionRow.model || 'unknown',
            estimatedCostUsd: 0,
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

      const projectName = source === 'central'
        ? sessionRow.title || 'hermes-agent-session'
        : `hermes-profile-${source}`;

      const session: ParsedSession = {
        id: `hermes-agent-${source}:${sessionId}`,
        projectPath: '',
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

      if (!session.generatedTitle) {
        const titleResult = generateTitle(session);
        session.generatedTitle = titleResult.title;
        session.titleSource = titleResult.source;
        session.sessionCharacter = titleResult.character || detectSessionCharacter(session);
      }

      return session;
    } catch (err) {
      console.error(`[hermes-agent] Failed to parse session ${sessionId} from ${source}: ${err}`);
      return null;
    } finally {
      db?.close();
    }
  }

  /**
   * Parse a session from a JSON file
   */
  private async parseJsonSession(filePath: string): Promise<ParsedSession | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);
      const source = this.getSourceFromPath(filePath);
      const sessionId = data.session_id || path.basename(filePath, '.json').replace('session_', '');

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      if (Array.isArray(data.messages)) {
        for (let i = 0; i < data.messages.length; i++) {
          const msg = data.messages[i];
          
          if (msg.role === 'tool') {
            const lastAssistant = messages.reverse().find(m => m.type === 'assistant');
            messages.reverse();
            if (lastAssistant) {
              lastAssistant.toolResults.push({
                toolUseId: msg.tool_call_id || `tool-${i}`,
                output: msg.content || '',
              });
              continue;
            }
          }

          const toolCalls: ToolCall[] = [];
          if (Array.isArray(msg.tool_calls)) {
            for (const tc of msg.tool_calls) {
              toolCalls.push({
                id: tc.id,
                name: tc.function?.name || tc.name || 'unknown',
                input: typeof tc.function?.arguments === 'string' 
                  ? JSON.parse(tc.function.arguments) 
                  : (tc.args || tc.function?.arguments || {}),
              });
            }
          }

          const parsedMsg: ParsedMessage = {
            id: `hermes-json-${source}-${sessionId}-${i}`,
            sessionId: `hermes-agent-${source}:${sessionId}`,
            type: msg.role === 'assistant' ? 'assistant' : (msg.role === 'user' ? 'user' : 'system'),
            content: msg.content || '',
            thinking: msg.reasoning || null,
            toolCalls,
            toolResults: [],
            usage: null, // Per-message usage typically not in JSON dump
            timestamp: new Date(data.session_start), // Fallback to session start if not in message
            parentId: null,
          };

          if (parsedMsg.type === 'user') userMessageCount++;
          if (parsedMsg.type === 'assistant') assistantMessageCount++;
          toolCallCount += toolCalls.length;

          messages.push(parsedMsg);
        }
      }

      const session: ParsedSession = {
        id: `hermes-agent-${source}:${sessionId}`,
        projectPath: '',
        projectName: source === 'central' ? 'hermes-agent-session' : `hermes-profile-${source}`,
        summary: null,
        generatedTitle: null,
        titleSource: null,
        sessionCharacter: null,
        startedAt: new Date(data.session_start),
        endedAt: new Date(data.last_updated || data.session_start),
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
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: 0,
          modelsUsed: data.model ? [data.model] : [],
          primaryModel: data.model || 'unknown',
          usageSource: 'session',
        },
        messages,
      };

      // Generate title since JSON doesn't have one
      const titleResult = generateTitle(session);
      session.generatedTitle = titleResult.title;
      session.titleSource = titleResult.source;
      session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

      return session;
    } catch (err) {
      console.error(`[hermes-agent] Failed to parse JSON session ${filePath}: ${err}`);
      return null;
    }
  }
}
