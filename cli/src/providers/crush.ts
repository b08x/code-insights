import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Database from 'better-sqlite3';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, SessionUsage } from '../types.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

/**
 * Crush session provider.
 * Discovers and parses sessions from project-specific .crush/crush.db SQLite databases.
 */
export class CrushProvider implements SessionProvider {
  getProviderName(): string {
    return 'crush';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const home = os.homedir();
    const searchRoots = [
      home,
      path.join(home, 'Workspace'),
      path.join(home, 'Projects'),
      path.join(home, 'Notebook'),
      path.join(home, 'Tools'),
      process.cwd(),
    ];

    const dbPaths: string[] = [];
    const seen = new Set<string>();

    for (const root of searchRoots) {
      if (!fs.existsSync(root)) continue;
      
      try {
        // Check if root itself has .crush/crush.db
        const directDb = path.join(root, '.crush', 'crush.db');
        if (fs.existsSync(directDb) && !seen.has(directDb)) {
          dbPaths.push(directDb);
          seen.add(directDb);
        }

        // Scan subdirectories (one level deep) for .crush/crush.db
        const entries = fs.readdirSync(root);
        for (const entry of entries) {
          const fullPath = path.join(root, entry);
          try {
            if (fs.statSync(fullPath).isDirectory()) {
              const dbPath = path.join(fullPath, '.crush', 'crush.db');
              if (fs.existsSync(dbPath) && !seen.has(dbPath)) {
                dbPaths.push(dbPath);
                seen.add(dbPath);
              }
            }
          } catch {
            // Ignore stat errors
          }
        }
      } catch {
        // Ignore readdir errors
      }
    }

    const virtualPaths: string[] = [];
    for (const dbPath of dbPaths) {
      let db: InstanceType<typeof Database> | null = null;
      try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const sessions = db.prepare('SELECT id, title FROM sessions').all() as { id: string, title: string }[];
        
        for (const session of sessions) {
          if (options?.projectFilter && !session.title.toLowerCase().includes(options.projectFilter.toLowerCase())) {
            continue;
          }
          virtualPaths.push(`${dbPath}#${session.id}`);
        }
      } catch (err) {
        console.warn(`[crush] Failed to read ${dbPath}: ${err}`);
      } finally {
        db?.close();
      }
    }

    return virtualPaths;
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

      const messageRows = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as any[];

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      for (const row of messageRows) {
        if (row.role === 'tool') {
          // Attach to last assistant message
          const lastAssistant = messages.slice().reverse().find(m => m.type === 'assistant');
          if (lastAssistant) {
            try {
              const parts = JSON.parse(row.parts || '[]');
              for (const part of parts) {
                if (part.type === 'tool_result' && part.data) {
                  lastAssistant.toolResults.push({
                    toolUseId: part.data.tool_call_id || `tool-${row.id}`,
                    output: typeof part.data.content === 'string' ? part.data.content : JSON.stringify(part.data),
                  });
                }
              }
            } catch {
              // Ignore parse errors
            }
            continue;
          }
        }

        let content = '';
        let thinking: string | null = null;
        const toolCalls: ToolCall[] = [];
        const toolResults: ToolResult[] = [];

        try {
          const parts = JSON.parse(row.parts || '[]');
          for (const part of parts) {
            if (part.type === 'text' && part.data?.text) {
              content += (content ? '\n' : '') + part.data.text;
            } else if (part.type === 'reasoning' && part.data?.thinking) {
              thinking = (thinking ? thinking + '\n' : '') + part.data.thinking;
            } else if (part.type === 'tool_call' && part.data) {
              toolCalls.push({
                id: part.data.id || `call-${row.id}`,
                name: part.data.name || 'unknown',
                input: part.data.arguments || {},
              });
            } else if (part.type === 'tool_result' && part.data) {
              toolResults.push({
                toolUseId: part.data.tool_call_id || `tool-${row.id}`,
                output: typeof part.data.content === 'string' ? part.data.content : JSON.stringify(part.data),
              });
            }
          }
        } catch {
          // Fallback to row content if parts fail
          content = row.content || '';
        }

        const type = row.role === 'assistant' ? 'assistant' : (row.role === 'user' ? 'user' : 'system');
        if (type === 'user') userMessageCount++;
        if (type === 'assistant') assistantMessageCount++;
        toolCallCount += toolCalls.length;

        // Fix: Crush stores timestamps in seconds or milliseconds. 
        // 1.7e12 is ms (2024+), 1.7e9 is seconds.
        const rawTs = row.created_at || row.timestamp || 0;
        const timestamp = rawTs > 1e11 ? new Date(rawTs) : new Date(rawTs * 1000);

        messages.push({
          id: `crush-${row.id}`,
          sessionId: `crush:${sessionId}`,
          type,
          content,
          thinking,
          toolCalls,
          toolResults,
          usage: null,
          timestamp,
          parentId: null,
        });
      }

      // Infer project path from files table
      let projectPath = '';
      try {
        const fileRow = db.prepare('SELECT path FROM files WHERE session_id = ? LIMIT 1').get(sessionId) as { path: string } | undefined;
        if (fileRow?.path) {
          projectPath = path.dirname(fileRow.path);
          const crushIdx = projectPath.indexOf('/.crush');
          if (crushIdx !== -1) {
            projectPath = projectPath.slice(0, crushIdx);
          } else {
            const dbDir = path.dirname(path.dirname(dbPath));
            if (fileRow.path.startsWith(dbDir)) {
              projectPath = dbDir;
            }
          }
        } else {
          projectPath = path.dirname(path.dirname(dbPath));
        }
      } catch {
        projectPath = path.dirname(path.dirname(dbPath));
      }

      const sessionUsage: SessionUsage = {
        totalInputTokens: sessionRow.prompt_tokens || 0,
        totalOutputTokens: sessionRow.completion_tokens || 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        estimatedCostUsd: sessionRow.cost || 0,
        modelsUsed: sessionRow.model ? [sessionRow.model] : [],
        primaryModel: sessionRow.model || 'unknown',
        usageSource: 'session',
      };

      const rawStartedAt = sessionRow.created_at || (messages.length > 0 ? messages[0].timestamp.getTime() : 0);
      const startedAt = rawStartedAt > 1e11 ? new Date(rawStartedAt) : new Date(rawStartedAt * 1000);
      
      const rawEndedAt = sessionRow.updated_at || rawStartedAt;
      const endedAt = rawEndedAt > 1e11 ? new Date(rawEndedAt) : new Date(rawEndedAt * 1000);

      const session: ParsedSession = {
        id: `crush:${sessionId}`,
        projectPath,
        projectName: sessionRow.title || 'crush-session',
        summary: null,
        generatedTitle: sessionRow.title || null,
        titleSource: (sessionRow.title && sessionRow.title !== 'Untitled Session' && sessionRow.title !== 'New Session') ? 'insight' : null,
        sessionCharacter: null,
        startedAt,
        endedAt,
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: null,
        sourceTool: 'crush',
        usage: sessionUsage,
        messages,
      };

      if (!session.generatedTitle || session.titleSource === null) {
        const titleResult = generateTitle(session);
        session.generatedTitle = titleResult.title;
        session.titleSource = titleResult.source;
        session.sessionCharacter = titleResult.character || detectSessionCharacter(session);
      }

      return session;
    } catch (err) {
      console.error(`[crush] Failed to parse session ${sessionId}: ${err}`);
      return null;
    } finally {
      db?.close();
    }
  }
}
