import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, SessionUsage } from '../types.js';
import { getOpenCodeDir } from '../utils/config.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

/**
 * OpenCode session provider.
 * Discovers and parses sessions from OpenCode storage:
 * 1. SQLite database: ~/.local/share/opencode/opencode.db
 * 2. JSON session files: ~/.local/share/opencode/storage/session/<project_id>/*.json
 */
export class OpenCodeProvider implements SessionProvider {
  getProviderName(): string {
    return 'opencode';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const virtualPaths: string[] = [];

    // 1. Discover sessions from SQLite database
    const dbSessions = await this.discoverDatabaseSessions(options);
    virtualPaths.push(...dbSessions);

    // 2. Discover JSON session files
    const jsonSessions = await this.discoverJsonSessions(options);
    virtualPaths.push(...jsonSessions);

    return virtualPaths;
  }

  /**
   * Discover sessions from the SQLite database
   */
  private async discoverDatabaseSessions(options?: { projectFilter?: string }): Promise<string[]> {
    const baseDir = getOpenCodeDir();
    const dbPath = path.join(baseDir, 'opencode.db');

    if (!fs.existsSync(dbPath)) {
      return [];
    }

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const sessions = db.prepare('SELECT id, title FROM session').all() as { id: string, title: string | null }[];

      const virtualPaths: string[] = [];
      for (const session of sessions) {
        if (options?.projectFilter && session.title && !session.title.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          continue;
        }
        // Format: dbPath#sessionId
        virtualPaths.push(`${dbPath}#${session.id}`);
      }

      return virtualPaths;
    } catch (err) {
      console.error(`[opencode] Failed to discover sessions from database: ${err}`);
      return [];
    } finally {
      db?.close();
    }
  }

  /**
   * Discover sessions from JSON files
   */
  private async discoverJsonSessions(options?: { projectFilter?: string }): Promise<string[]> {
    const baseDir = getOpenCodeDir();
    const sessionsDir = path.join(baseDir, 'storage', 'session');

    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const sessionFiles: string[] = [];
    
    try {
      // session directory contains project-id subdirectories
      const projectDirs = fs.readdirSync(sessionsDir);
      for (const projectDir of projectDirs) {
        const projectPath = path.join(sessionsDir, projectDir);
        if (!fs.statSync(projectPath).isDirectory()) continue;

        // Note: projectDir is a hash here, but we check title inside parse()
        // Discovery-level filtering is hard with hashes, so we return all.
        const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.json'));
        for (const file of files) {
          sessionFiles.push(path.join(projectPath, file));
        }
      }
    } catch (err) {
      console.error(`[opencode] Failed to discover JSON sessions: ${err}`);
    }

    return sessionFiles;
  }

  async parse(virtualPath: string): Promise<ParsedSession | null> {
    // 1. Handle database sessions
    if (virtualPath.includes('#')) {
      return this.parseDatabaseSession(virtualPath);
    }

    // 2. Handle JSON session files
    if (virtualPath.endsWith('.json')) {
      return this.parseJsonSession(virtualPath);
    }

    return null;
  }

  /**
   * Parse a session from the SQLite database
   */
  private async parseDatabaseSession(virtualPath: string): Promise<ParsedSession | null> {
    const hashIndex = virtualPath.lastIndexOf('#');
    const dbPath = virtualPath.slice(0, hashIndex);
    const sessionId = virtualPath.slice(hashIndex + 1);

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      const sessionRow = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) as any;
      if (!sessionRow) return null;

      // In OpenCode, messages are split into 'message' and 'part' tables
      const messageRows = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC').all(sessionId) as any[];
      const messages: ParsedMessage[] = [];
      
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;
      const modelsUsed = new Set<string>();

      for (const msgRow of messageRows) {
        // Load parts for this message
        const partRows = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id ASC').all(msgRow.id) as any[];
        
        let content = '';
        let thinking: string | null = null;
        const toolCalls: ToolCall[] = [];
        const toolResults: ToolResult[] = [];

        for (const partRow of partRows) {
          if (partRow.type === 'text' && partRow.text) {
            content += (content ? '\n' : '') + partRow.text;
          } else if (partRow.type === 'thinking' && partRow.text) {
            thinking = (thinking ? thinking + '\n' : '') + partRow.text;
          } else if (partRow.type === 'tool') {
            const tcId = partRow.call_id || `tool-${partRow.id}`;
            let toolInput = {};
            try {
               const state = partRow.state ? JSON.parse(partRow.state) : {};
               toolInput = state.input || {};
               if (state.output) {
                 toolResults.push({
                   toolUseId: tcId,
                   output: typeof state.output === 'string' ? state.output : JSON.stringify(state.output),
                 });
               }
            } catch { /* ignore */ }

            toolCalls.push({
              id: tcId,
              name: partRow.tool || 'unknown',
              input: toolInput,
            });
          }
        }

        const model = msgRow.model_id || 'unknown';
        if (model !== 'unknown') modelsUsed.add(model);

        // Usage data might be in JSON format in the database row or separate columns
        let msgUsage = null;
        if (msgRow.tokens_input !== undefined) {
           msgUsage = {
             inputTokens: msgRow.tokens_input || 0,
             outputTokens: msgRow.tokens_output || 0,
             cacheCreationTokens: msgRow.tokens_cache_write || 0,
             cacheReadTokens: msgRow.tokens_cache_read || 0,
             model,
             estimatedCostUsd: msgRow.cost || 0,
           };
        } else if (msgRow.tokens) {
           try {
             const tokens = JSON.parse(msgRow.tokens);
             msgUsage = {
               inputTokens: tokens.input || 0,
               outputTokens: tokens.output || 0,
               cacheCreationTokens: tokens.cache?.write || 0,
               cacheReadTokens: tokens.cache?.read || 0,
               model,
               estimatedCostUsd: msgRow.cost || 0,
             };
           } catch { /* ignore */ }
        }

        if (msgUsage) {
          totalInputTokens += msgUsage.inputTokens;
          totalOutputTokens += msgUsage.outputTokens;
          totalCost += msgUsage.estimatedCostUsd;
        }

        const type = msgRow.role === 'assistant' ? 'assistant' : (msgRow.role === 'user' ? 'user' : 'system');
        if (type === 'user') userMessageCount++;
        if (type === 'assistant') assistantMessageCount++;
        toolCallCount += toolCalls.length;

        messages.push({
          id: msgRow.id,
          sessionId,
          type,
          content,
          thinking,
          toolCalls,
          toolResults,
          usage: msgUsage,
          timestamp: new Date(msgRow.time_created),
          parentId: msgRow.parent_id || null,
        });
      }

      const session: ParsedSession = {
        id: sessionId,
        projectPath: sessionRow.directory || '',
        projectName: sessionRow.title || sessionRow.slug || 'opencode-session',
        summary: null,
        generatedTitle: sessionRow.title || null,
        titleSource: sessionRow.title ? 'insight' : null,
        sessionCharacter: null,
        startedAt: new Date(sessionRow.time_created),
        endedAt: new Date(sessionRow.time_updated),
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: sessionRow.version || null,
        sourceTool: 'opencode',
        usage: {
          totalInputTokens,
          totalOutputTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: totalCost,
          modelsUsed: Array.from(modelsUsed),
          primaryModel: Array.from(modelsUsed)[0] || 'unknown',
          usageSource: 'session',
        },
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
      console.error(`[opencode] Failed to parse database session ${sessionId}: ${err}`);
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
      const rawSession = fs.readFileSync(filePath, 'utf-8');
      const sessionData = JSON.parse(rawSession);

      if (!sessionData.id) return null;

      const baseDir = getOpenCodeDir();
      const messagesDir = path.join(baseDir, 'storage', 'message', sessionData.id);
      const partsDir = path.join(baseDir, 'storage', 'part');

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;
      const modelsUsed = new Set<string>();

      if (fs.existsSync(messagesDir)) {
        const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
        for (const msgFile of messageFiles) {
          const msgPath = path.join(messagesDir, msgFile);
          const msgData = JSON.parse(fs.readFileSync(msgPath, 'utf-8'));
          
          const msgPartsDir = path.join(partsDir, msgData.id);
          let content = '';
          let thinking: string | null = null;
          const toolCalls: ToolCall[] = [];
          const toolResults: ToolResult[] = [];

          if (fs.existsSync(msgPartsDir)) {
            const partFiles = fs.readdirSync(msgPartsDir).filter(f => f.endsWith('.json'));
            for (const partFile of partFiles) {
              const partData = JSON.parse(fs.readFileSync(path.join(msgPartsDir, partFile), 'utf-8'));
              
              if (partData.type === 'text' && partData.text) {
                content += (content ? '\n' : '') + partData.text;
              } else if (partData.type === 'thinking' && partData.text) {
                thinking = (thinking ? thinking + '\n' : '') + partData.text;
              } else if (partData.type === 'tool') {
                const tcId = partData.callID || `tool-${partData.id}`;
                toolCalls.push({
                  id: tcId,
                  name: partData.tool || 'unknown',
                  input: partData.state?.input || {},
                });
                
                if (partData.state?.output) {
                  toolResults.push({
                    toolUseId: tcId,
                    output: typeof partData.state.output === 'string' 
                      ? partData.state.output 
                      : JSON.stringify(partData.state.output),
                  });
                }
              }
            }
          }

          const model = msgData.modelID || (msgData.model?.modelID) || 'unknown';
          if (model !== 'unknown') modelsUsed.add(model);

          const usage = msgData.tokens ? {
            inputTokens: msgData.tokens.input || 0,
            outputTokens: msgData.tokens.output || 0,
            cacheCreationTokens: msgData.tokens.cache?.write || 0,
            cacheReadTokens: msgData.tokens.cache?.read || 0,
            model,
            estimatedCostUsd: msgData.cost || 0,
          } : null;

          if (usage) {
            totalInputTokens += usage.inputTokens;
            totalOutputTokens += usage.outputTokens;
            totalCost += usage.estimatedCostUsd;
          }

          const type = msgData.role === 'assistant' ? 'assistant' : (msgData.role === 'user' ? 'user' : 'system');
          if (type === 'user') userMessageCount++;
          if (type === 'assistant') assistantMessageCount++;
          toolCallCount += toolCalls.length;

          messages.push({
            id: msgData.id,
            sessionId: sessionData.id,
            type,
            content,
            thinking,
            toolCalls,
            toolResults,
            usage,
            timestamp: new Date(msgData.time?.created || sessionData.time?.created || 0),
            parentId: msgData.parentID || null,
          });
        }
      }

      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      const session: ParsedSession = {
        id: sessionData.id,
        projectPath: sessionData.directory || '',
        projectName: sessionData.title || sessionData.slug || 'opencode-session',
        summary: null,
        generatedTitle: sessionData.title || null,
        titleSource: sessionData.title ? 'insight' : null,
        sessionCharacter: null,
        startedAt: new Date(sessionData.time?.created || (messages.length > 0 ? messages[0].timestamp.getTime() : 0)),
        endedAt: new Date(sessionData.time?.updated || (messages.length > 0 ? messages[messages.length - 1].timestamp.getTime() : 0)),
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: sessionData.version || null,
        sourceTool: 'opencode',
        usage: {
          totalInputTokens,
          totalOutputTokens,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: totalCost,
          modelsUsed: Array.from(modelsUsed),
          primaryModel: Array.from(modelsUsed)[0] || 'unknown',
          usageSource: 'session',
        },
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
      console.error(`[opencode] Failed to parse JSON session ${filePath}: ${err}`);
      return null;
    }
  }
}
