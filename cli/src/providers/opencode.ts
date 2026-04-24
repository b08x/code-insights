import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { jsonrepair } from 'jsonrepair';
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
  private debug = process.env.DEBUG?.includes('opencode') || process.env.DEBUG?.includes('*');

  getProviderName(): string {
    return 'opencode';
  }

  /**
   * Robust JSON parsing with error recovery
   */
  private parseJsonSafely(content: string, context: string): any {
    try {
      return JSON.parse(content);
    } catch (err) {
      if (this.debug) {
        console.warn(`[opencode] JSON parse failed for ${context}, attempting repair: ${err}`);
      }
      try {
        const repaired = jsonrepair(content);
        return JSON.parse(repaired);
      } catch (repairErr) {
        console.error(`[opencode] Failed to parse/repair JSON for ${context}: ${repairErr}`);
        throw repairErr;
      }
    }
  }

  /**
   * Enhanced logging helper
   */
  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: any): void {
    if (level === 'debug' && !this.debug) return;

    const prefix = `[opencode]`;
    switch (level) {
      case 'debug':
        console.debug(`${prefix} ${message}`, data || '');
        break;
      case 'info':
        console.info(`${prefix} ${message}`, data || '');
        break;
      case 'warn':
        console.warn(`${prefix} ${message}`, data || '');
        break;
      case 'error':
        console.error(`${prefix} ${message}`, data || '');
        break;
    }
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
      this.log('debug', `Database not found at ${dbPath}`);
      return [];
    }

    this.log('debug', `Discovering database sessions from ${dbPath}`);

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      // Check if session table exists
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const hasSessionTable = tables.some(t => t.name === 'session');

      if (!hasSessionTable) {
        this.log('error', 'Database missing session table', { tables: tables.map(t => t.name) });
        return [];
      }

      const sessions = db.prepare('SELECT id, title FROM session').all() as { id: string, title: string | null }[];
      this.log('debug', `Found ${sessions.length} sessions in database`);

      const virtualPaths: string[] = [];
      for (const session of sessions) {
        if (options?.projectFilter && session.title && !session.title.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          this.log('debug', `Filtering out session ${session.id} (title: ${session.title})`);
          continue;
        }
        // Format: dbPath#sessionId
        virtualPaths.push(`${dbPath}#${session.id}`);
        this.log('debug', `Added database session: ${session.id} (${session.title || 'untitled'})`);
      }

      this.log('info', `Discovered ${virtualPaths.length} database sessions`);
      return virtualPaths;
    } catch (err) {
      this.log('error', 'Failed to discover sessions from database', err);
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
      this.log('debug', `JSON session directory not found at ${sessionsDir}`);
      return [];
    }

    this.log('debug', `Discovering JSON sessions from ${sessionsDir}`);

    const sessionFiles: string[] = [];
    let totalProjects = 0;
    let skippedFiles = 0;

    try {
      // session directory contains project-id subdirectories
      const projectDirs = fs.readdirSync(sessionsDir);
      this.log('debug', `Found ${projectDirs.length} project directories`);

      for (const projectDir of projectDirs) {
        if (options?.projectFilter && !projectDir.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          this.log('debug', `Filtering out project directory ${projectDir}`);
          continue;
        }

        const projectPath = path.join(sessionsDir, projectDir);

        let stat;
        try {
          stat = fs.statSync(projectPath);
        } catch (statErr) {
          this.log('warn', `Cannot stat project directory ${projectDir}`, statErr);
          continue;
        }

        if (!stat.isDirectory()) {
          this.log('debug', `Skipping non-directory ${projectDir}`);
          continue;
        }

        totalProjects++;

        const entries = fs.readdirSync(projectPath, { withFileTypes: true });
        const subDirs = entries.filter(e => e.isDirectory()).map(e => e.name);

        for (const entry of entries) {
          const fullPath = path.join(projectPath, entry.name);

          if (entry.isDirectory()) {
            sessionFiles.push(fullPath);
            this.log('debug', `Added bundled JSON session directory: ${fullPath}`);
          } else if (entry.isFile() && entry.name.endsWith('.json')) {
            const sessionId = entry.name.replace('.json', '');
            if (subDirs.includes(sessionId)) {
              this.log('debug', `Skipping parent file ${entry.name}, will be bundled via directory`);
              continue;
            }

            // Basic validation - check if file is readable
            try {
              fs.accessSync(fullPath, fs.constants.R_OK);
              sessionFiles.push(fullPath);
              this.log('debug', `Added JSON session: ${fullPath}`);
            } catch (accessErr) {
              this.log('warn', `Cannot read session file ${fullPath}`, accessErr);
              skippedFiles++;
            }
          }
        }
      }

      this.log('info', `Discovered ${sessionFiles.length} JSON sessions from ${totalProjects} projects (${skippedFiles} skipped)`);
    } catch (err) {
      this.log('error', 'Failed to discover JSON sessions', err);
    }

    return sessionFiles;
  }

  async parse(virtualPath: string): Promise<ParsedSession | null> {
    if (fs.existsSync(virtualPath) && fs.statSync(virtualPath).isDirectory()) {
      return this.parseBundledSession(virtualPath);
    }

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

  private async parseBundledSession(dirPath: string): Promise<ParsedSession | null> {
    try {
      const sessionId = path.basename(dirPath);
      const parentDir = path.dirname(dirPath);
      const parentFile = path.join(parentDir, `${sessionId}.json`);

      if (!fs.existsSync(parentFile)) return null;

      const parentSession = await this.parseJsonSession(parentFile);
      if (!parentSession) return null;

      const subFiles = this.findFiles(dirPath, ['.json']);
      for (const subFile of subFiles) {
        const subSession = await this.parseJsonSession(subFile);
        if (subSession && subSession.messages.length > 0) {
          for (const msg of subSession.messages) {
            msg.sessionId = parentSession.id;
          }
          parentSession.messages.push(...subSession.messages);
          
          if (subSession.startedAt < parentSession.startedAt) parentSession.startedAt = subSession.startedAt;
          if (subSession.endedAt > parentSession.endedAt) parentSession.endedAt = subSession.endedAt;
        }
      }

      parentSession.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      parentSession.messageCount = parentSession.messages.length;
      parentSession.userMessageCount = parentSession.messages.filter(m => m.type === 'user').length;
      parentSession.assistantMessageCount = parentSession.messages.filter(m => m.type === 'assistant').length;
      parentSession.toolCallCount = parentSession.messages.reduce((sum, m) => sum + m.toolCalls.length, 0);
      parentSession.usage = this.calculateSessionUsage(parentSession.messages);

      return parentSession;
    } catch (err) {
      this.log('error', `Failed to parse bundled session ${dirPath}`, err);
      return null;
    }
  }

  private findFiles(dir: string, extensions: string[]): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.findFiles(fullPath, extensions));
      } else if (extensions.some(ext => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  private calculateSessionUsage(messages: ParsedMessage[]): SessionUsage {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheReadTokens = 0;
    const modelsUsed = new Set<string>();
    let totalCost = 0;

    for (const msg of messages) {
      if (msg.usage) {
        totalInputTokens += msg.usage.inputTokens;
        totalOutputTokens += msg.usage.outputTokens;
        cacheReadTokens += msg.usage.cacheReadTokens;
        totalCost += msg.usage.estimatedCostUsd;
        modelsUsed.add(msg.usage.model);
      }
    }

    const primaryModel = Array.from(modelsUsed)[0] || 'unknown';

    return {
      totalInputTokens,
      totalOutputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      estimatedCostUsd: totalCost,
      modelsUsed: Array.from(modelsUsed),
      primaryModel,
      usageSource: 'session',
    };
  }

  /**
   * Parse a session from the SQLite database
   */
  private async parseDatabaseSession(virtualPath: string): Promise<ParsedSession | null> {
    const hashIndex = virtualPath.lastIndexOf('#');
    const dbPath = virtualPath.slice(0, hashIndex);
    const sessionId = virtualPath.slice(hashIndex + 1);

    this.log('debug', `Parsing database session ${sessionId} from ${dbPath}`);

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });

      const sessionRow = db.prepare('SELECT * FROM session WHERE id = ?').get(sessionId) as any;
      if (!sessionRow) {
        this.log('warn', `Session ${sessionId} not found in database`);
        return null;
      }

      this.log('debug', `Found session ${sessionId}: ${sessionRow.title || sessionRow.slug || 'untitled'}`);

      // Check if message and part tables exist
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
      const hasMessageTable = tables.some(t => t.name === 'message');
      const hasPartTable = tables.some(t => t.name === 'part');

      if (!hasMessageTable) {
        this.log('error', `Database missing message table for session ${sessionId}`);
        return null;
      }

      if (!hasPartTable) {
        this.log('warn', `Database missing part table for session ${sessionId}, proceeding without parts`);
      }

      // In OpenCode, messages are split into 'message' and 'part' tables
      const messageRows = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC').all(sessionId) as any[];
      this.log('debug', `Found ${messageRows.length} messages for session ${sessionId}`);

      const messages: ParsedMessage[] = [];

      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      for (const msgRow of messageRows) {
        let msgUsage: any = null;
        let msgData: any = {};
        if (msgRow.data) {
          try {
            msgData = this.parseJsonSafely(msgRow.data, `message ${msgRow.id} data`);
          } catch (e) {
            this.log('warn', `Failed to parse message data for ${msgRow.id}`, e);
          }
        }

        const role = msgData.role || msgRow.role || 'system';
        this.log('debug', `Processing message ${msgRow.id} (role: ${role})`);

        // Validate required message fields
        if (!msgRow.id) {
          this.log('warn', `Message missing ID in session ${sessionId}, skipping`);
          continue;
        }

        // Load parts for this message
        let partRows: any[] = [];
        if (hasPartTable) {
          try {
            partRows = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id ASC').all(msgRow.id) as any[];
            this.log('debug', `Found ${partRows.length} parts for message ${msgRow.id}`);
          } catch (partErr) {
            this.log('error', `Failed to load parts for message ${msgRow.id}`, partErr);
          }
        }

        let content = '';
        let thinking: string | null = null;
        const toolCalls: ToolCall[] = [];
        const toolResults: ToolResult[] = [];

        for (const partRow of partRows) {
          let partData: any = {};
          if (partRow.data) {
            try {
              partData = this.parseJsonSafely(partRow.data, `part ${partRow.id} data`);
            } catch (e) {
              this.log('warn', `Failed to parse part data for ${partRow.id}`, e);
            }
          }

          const partType = partData.type || partRow.type;
          const partText = partData.text || partRow.text;
          const partTool = partData.tool || partRow.tool;
          const partState = partData.state || (partRow.state ? this.parseJsonSafely(partRow.state, `part ${partRow.id} state`) : null);

          this.log('debug', `Processing part ${partRow.id} (type: ${partType})`);

          if ((partType === 'text' || partType === 'markdown') && partText) {
            content += (content ? '\n' : '') + partText;
          } else if ((partType === 'thinking' || partType === 'reasoning') && partText) {
            thinking = (thinking ? thinking + '\n' : '') + partText;
          } else if (partType === 'tool') {
            const tcId = partData.callID || partRow.call_id || `tool-${partRow.id}`;
            let toolInput = {};

            if (partState) {
              toolInput = partState.input || {};

              if (partState.output) {
                toolResults.push({
                  toolUseId: tcId,
                  output: typeof partState.output === 'string' ? partState.output : JSON.stringify(partState.output),
                });
              }
            }

            toolCalls.push({
              id: tcId,
              name: partTool || 'unknown',
              input: toolInput,
            });
          } else if (partType === 'step-finish' && partData.tokens) {
            // Some tokens might be in step-finish parts in newer versions
            if (!msgRow.tokens_input && !msgRow.tokens) {
              const model = msgData.modelID || (msgData.model?.modelID) || msgRow.model_id || 'unknown';
              msgUsage = {
                inputTokens: partData.tokens.input || 0,
                outputTokens: partData.tokens.output || 0,
                cacheCreationTokens: partData.tokens.cache?.write || 0,
                cacheReadTokens: partData.tokens.cache?.read || 0,
                model,
                estimatedCostUsd: partData.cost || 0,
              };
            }
          }
        }

        const model = msgData.modelID || (msgData.model?.modelID) || msgRow.model_id || 'unknown';

        // Usage data might be in JSON format in the database row, separate columns, or already parsed from parts
        if (!msgUsage) {
          if (msgRow.tokens_input !== undefined) {
             msgUsage = {
               inputTokens: msgRow.tokens_input || 0,
               outputTokens: msgRow.tokens_output || 0,
               cacheCreationTokens: msgRow.tokens_cache_write || 0,
               cacheReadTokens: msgRow.tokens_cache_read || 0,
               model,
               estimatedCostUsd: msgRow.cost || 0,
             };
          } else if (msgRow.tokens || msgData.tokens) {
             try {
               const tokens = msgData.tokens || this.parseJsonSafely(msgRow.tokens, `message ${msgRow.id} tokens`);
               msgUsage = {
                 inputTokens: tokens.input || 0,
                 outputTokens: tokens.output || 0,
                 cacheCreationTokens: tokens.cache?.write || 0,
                 cacheReadTokens: tokens.cache?.read || 0,
                 model,
                 estimatedCostUsd: msgData.cost || msgRow.cost || 0,
               };
             } catch (tokensErr) {
               this.log('warn', `Failed to parse tokens JSON for message ${msgRow.id}`, tokensErr);
             }
          }
        }

        const type = role === 'assistant' ? 'assistant' : (role === 'user' ? 'user' : 'system');
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
          timestamp: new Date(msgRow.time_created || Date.now()),
          parentId: msgData.parentID || msgRow.parent_id || null,
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
        startedAt: new Date(sessionRow.time_created || (messages.length > 0 ? messages[0].timestamp : Date.now())),
        endedAt: new Date(sessionRow.time_updated || (messages.length > 0 ? messages[messages.length - 1].timestamp : Date.now())),
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
        usage: this.calculateSessionUsage(messages),
        messages,
      };

      if (!session.generatedTitle) {
        const titleResult = generateTitle(session);
        session.generatedTitle = titleResult.title;
        session.titleSource = titleResult.source;
        session.sessionCharacter = titleResult.character || detectSessionCharacter(session);
      }

      this.log('info', `Successfully parsed database session ${sessionId}`, {
        messages: messages.length,
        userMessages: userMessageCount,
        assistantMessages: assistantMessageCount,
        toolCalls: toolCallCount
      });

      return session;
    } catch (err) {
      this.log('error', `Failed to parse database session ${sessionId}`, err);
      return null;
    } finally {
      db?.close();
    }
  }

  /**
   * Parse a session from a JSON file
   */
  private async parseJsonSession(filePath: string): Promise<ParsedSession | null> {
    this.log('debug', `Parsing JSON session from ${filePath}`);

    try {
      const rawSession = fs.readFileSync(filePath, 'utf-8');
      const sessionData = this.parseJsonSafely(rawSession, `session file ${filePath}`);

      if (!sessionData.id) {
        this.log('warn', `Session file ${filePath} missing ID field`);
        return null;
      }

      this.log('debug', `Found JSON session ${sessionData.id}: ${sessionData.title || sessionData.slug || 'untitled'}`);

      const baseDir = getOpenCodeDir();
      const messagesDir = path.join(baseDir, 'storage', 'message', sessionData.id);
      const partsDir = path.join(baseDir, 'storage', 'part');

      // Validate directory structure
      if (!fs.existsSync(messagesDir)) {
        this.log('error', `Messages directory not found: ${messagesDir}`);
        return null;
      }

      if (!fs.existsSync(partsDir)) {
        this.log('warn', `Parts directory not found: ${partsDir}, proceeding without parts`);
      }

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      this.log('debug', `Found ${messageFiles.length} message files in ${messagesDir}`);

      for (const msgFile of messageFiles) {
        const msgPath = path.join(messagesDir, msgFile);
        this.log('debug', `Processing message file: ${msgFile}`);

        let msgData;
        try {
          const rawMessage = fs.readFileSync(msgPath, 'utf-8');
          msgData = this.parseJsonSafely(rawMessage, `message file ${msgPath}`);
        } catch (readErr) {
          this.log('error', `Failed to read message file ${msgPath}`, readErr);
          continue;
        }

        // Validate message data
        if (!msgData.id) {
          this.log('warn', `Message file ${msgFile} missing ID, skipping`);
          continue;
        }

        this.log('debug', `Processing message ${msgData.id} (role: ${msgData.role})`);

        const msgPartsDir = path.join(partsDir, msgData.id);
        let content = '';
        let thinking: string | null = null;
        let msgUsage: any = null;
        const toolCalls: ToolCall[] = [];
        const toolResults: ToolResult[] = [];

        if (fs.existsSync(msgPartsDir)) {
          const partFiles = fs.readdirSync(msgPartsDir).filter(f => f.endsWith('.json'));
          this.log('debug', `Found ${partFiles.length} part files for message ${msgData.id}`);

          for (const partFile of partFiles) {
            const partPath = path.join(msgPartsDir, partFile);
            this.log('debug', `Processing part file: ${partFile}`);

            let partData;
            try {
              const rawPart = fs.readFileSync(partPath, 'utf-8');
              partData = this.parseJsonSafely(rawPart, `part file ${partPath}`);
            } catch (partReadErr) {
              this.log('error', `Failed to read part file ${partPath}`, partReadErr);
              continue;
            }
            if ((partData.type === 'text' || partData.type === 'markdown') && partData.text) {
              content += (content ? '\n' : '') + partData.text;
            } else if ((partData.type === 'thinking' || partData.type === 'reasoning') && partData.text) {
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
            } else if (partData.type === 'step-finish' && partData.tokens) {
              // Extract usage from step-finish if not present in message
              if (!msgData.tokens) {
                msgUsage = {
                  inputTokens: partData.tokens.input || 0,
                  outputTokens: partData.tokens.output || 0,
                  cacheCreationTokens: partData.tokens.cache?.write || 0,
                  cacheReadTokens: partData.tokens.cache?.read || 0,
                  model: msgData.modelID || (msgData.model?.modelID) || 'unknown',
                  estimatedCostUsd: partData.cost || 0,
                };
              }
            } else {
              this.log('debug', `Unknown part type ${partData.type} in ${partFile}`);
            }
          }
        } else {
          this.log('debug', `No parts directory found for message ${msgData.id}`);
        }

        const model = msgData.modelID || (msgData.model?.modelID) || 'unknown';

        let usage = msgUsage || null;
        if (!usage && msgData.tokens) {
          usage = {
            inputTokens: msgData.tokens.input || 0,
            outputTokens: msgData.tokens.output || 0,
            cacheCreationTokens: msgData.tokens.cache?.write || 0,
            cacheReadTokens: msgData.tokens.cache?.read || 0,
            model,
            estimatedCostUsd: msgData.cost || 0,
          };
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
          timestamp: new Date(msgData.time?.created || sessionData.time?.created || Date.now()),
          parentId: msgData.parentID || null,
        });

        this.log('debug', `Added message ${msgData.id}: ${content.length} chars, ${toolCalls.length} tools`);
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
        startedAt: new Date(sessionData.time?.created || (messages.length > 0 ? messages[0].timestamp.getTime() : Date.now())),
        endedAt: new Date(sessionData.time?.updated || (messages.length > 0 ? messages[messages.length - 1].timestamp.getTime() : Date.now())),
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
        usage: this.calculateSessionUsage(messages),
        messages,
      };

      if (!session.generatedTitle) {
        const titleResult = generateTitle(session);
        session.generatedTitle = titleResult.title;
        session.titleSource = titleResult.source;
        session.sessionCharacter = titleResult.character || detectSessionCharacter(session);
      }

      this.log('info', `Successfully parsed JSON session ${sessionData.id}`, {
        messages: messages.length,
        userMessages: userMessageCount,
        assistantMessages: assistantMessageCount,
        toolCalls: toolCallCount
      });

      return session;
    } catch (err) {
      this.log('error', `Failed to parse JSON session ${filePath}`, err);
      return null;
    }
  }
}
