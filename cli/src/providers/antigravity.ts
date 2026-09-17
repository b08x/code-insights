import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult } from '../types.js';
import { getGeminiHomeDir } from '../utils/config.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

function findProjectRoot(filePath: string): string | null {
  let currentDir = fs.statSync(filePath, { throwIfNoEntry: false })?.isDirectory() 
    ? filePath 
    : path.dirname(filePath);
    
  // Don't walk higher than these bases
  const bases = ['/home/b08x/WorkspaceV3', '/home/b08x/Workspace', '/home/b08x/.syncopated'];
  
  while (currentDir && currentDir !== '/' && currentDir !== '/home/b08x') {
    if (fs.existsSync(path.join(currentDir, '.git'))) {
      return currentDir;
    }
    if (bases.includes(path.dirname(currentDir))) {
      return currentDir;
    }
    currentDir = path.dirname(currentDir);
  }
  return null;
}

/**
 * Antigravity session provider.
 * Discovers SQLite database (.db) and Protobuf (.pb) files in ~/.gemini/antigravity-cli/conversations/
 * Parses readable transcripts in ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl
 */
export class AntigravityProvider implements SessionProvider {
  getProviderName(): string {
    return 'antigravity';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const convDir = path.join(getGeminiHomeDir(), 'antigravity-cli', 'conversations');
    
    if (!fs.existsSync(convDir)) {
      return [];
    }

    try {
      const files = fs.readdirSync(convDir)
        .filter(f => f.endsWith('.pb') || f.endsWith('.db'))
        .map(f => path.join(convDir, f));
      
      return files;
    } catch (err) {
      console.error(`[antigravity] Failed to discover sessions: ${err}`);
      return [];
    }
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    const ext = path.extname(filePath);
    const sessionId = path.basename(filePath, ext);
    const brainDir = path.join(getGeminiHomeDir(), 'antigravity-cli', 'brain', sessionId);

    // Try to parse using the transcript.jsonl file inside the brain log directory
    const transcriptPath = path.join(brainDir, '.system_generated', 'logs', 'transcript.jsonl');
    const transcriptFull = path.join(brainDir, '.system_generated', 'logs', 'transcript_full.jsonl');
    
    const targetTranscript = fs.existsSync(transcriptPath) ? transcriptPath : (fs.existsSync(transcriptFull) ? transcriptFull : null);
    
    if (targetTranscript) {
      return this.parseTranscript(sessionId, targetTranscript);
    }

    // Fallback to legacy markdown parsing (looking in ~/.gemini/antigravity/brain/)
    const legacyBrainDir = path.join(getGeminiHomeDir(), 'antigravity', 'brain', sessionId);
    if (fs.existsSync(legacyBrainDir)) {
      return this.parseLegacyMarkdown(sessionId, legacyBrainDir);
    }

    return null;
  }

  private async parseTranscript(sessionId: string, transcriptPath: string): Promise<ParsedSession | null> {
    try {
      const fileStream = fs.createReadStream(transcriptPath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;
      let startedAt: Date | null = null;
      let endedAt: Date | null = null;
      const slashCommands: string[] = [];

      // Project discovery
      const projectsJsonFile = path.join(getGeminiHomeDir(), 'antigravity-cli', 'cache', 'projects.json');
      let projectPaths: string[] = [];
      if (fs.existsSync(projectsJsonFile)) {
        try {
          const data = JSON.parse(fs.readFileSync(projectsJsonFile, 'utf-8'));
          projectPaths = Object.keys(data);
        } catch {}
      }
      let projectPath = '';
      let projectName = 'unknown';

      let lastAssistantMessage: ParsedMessage | null = null;

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          const timestamp = new Date(entry.created_at || entry.timestamp || Date.now());
          
          if (!startedAt) startedAt = timestamp;
          endedAt = timestamp;

          // Attempt to extract project path from any string in the entry
          const lineStr = JSON.stringify(entry);
          for (const projPath of projectPaths) {
            if (lineStr.includes(projPath)) {
              projectPath = projPath;
              projectName = path.basename(projPath);
              break;
            }
          }

          // Fallback: Use regex to find typical workspace paths if not found in projects.json
          if (projectName === 'unknown') {
            const workspaceMatch = lineStr.match(/(\/home\/b08x\/(?:Workspace|WorkspaceV3|\.syncopated)\/[^\/\\"']+)/);
            if (workspaceMatch && workspaceMatch[1]) {
              const root = findProjectRoot(workspaceMatch[1]);
              if (root) {
                projectPath = root;
                projectName = path.basename(projectPath);
              }
            }
          }

          if (entry.type === 'USER_INPUT' || entry.source === 'USER_EXPLICIT') {
            const prompt = entry.content || '';
            const msgId = entry.step_id || crypto.randomUUID();
            
            // Check for slash command
            if (prompt.startsWith('/')) {
              const cmd = prompt.split(' ')[0];
              slashCommands.push(cmd);
            }

            messages.push({
              id: msgId,
              sessionId,
              type: 'user',
              content: prompt,
              thinking: null,
              toolCalls: [],
              toolResults: [],
              usage: null,
              timestamp,
              parentId: null,
            });
            userMessageCount++;
            lastAssistantMessage = null; // Reset current assistant message
          } else if (entry.type === 'PLANNER_RESPONSE' && entry.source === 'MODEL') {
            const content = entry.content || '';
            const thinking = entry.thinking || null;
            const msgId = entry.step_id || crypto.randomUUID();

            const toolCalls: ToolCall[] = (entry.tool_calls || []).map((tc: any) => ({
              id: tc.id || crypto.randomUUID(),
              name: tc.name,
              input: typeof tc.args === 'string' ? JSON.parse(tc.args) : (tc.args || {}),
            }));

            toolCallCount += toolCalls.length;

            const assistantMsg: ParsedMessage = {
              id: msgId,
              sessionId,
              type: 'assistant',
              content,
              thinking,
              toolCalls,
              toolResults: [],
              usage: null,
              timestamp,
              parentId: null,
            };

            messages.push(assistantMsg);
            assistantMessageCount++;
            lastAssistantMessage = assistantMsg;
          } else if (lastAssistantMessage && entry.content && entry.type && entry.type !== 'GENERIC' && entry.type !== 'CHECKPOINT') {
            const toolNameMapping: Record<string, string> = {
              'LIST_DIRECTORY': 'list_dir',
              'VIEW_FILE': 'view_file',
              'WRITE_TO_FILE': 'write_to_file',
              'GREP_SEARCH': 'grep_search',
              'RUN_COMMAND': 'run_command',
              'CALL_MCP_TOOL': 'call_mcp_tool',
            };

            const mappedName = toolNameMapping[entry.type] || entry.type.toLowerCase();
            const tc = lastAssistantMessage.toolCalls.find(c => c.name === mappedName) || lastAssistantMessage.toolCalls[0];
            
            lastAssistantMessage.toolResults.push({
              toolUseId: tc ? tc.id : crypto.randomUUID(),
              output: entry.content,
            });
          }
        } catch (e) {
          // Ignore parse errors on individual lines
        }
      }

      if (messages.length === 0) return null;

      const session: ParsedSession = {
        id: sessionId,
        projectPath,
        projectName,
        summary: null,
        generatedTitle: null,
        titleSource: null,
        sessionCharacter: null,
        startedAt: startedAt || new Date(),
        endedAt: endedAt || new Date(),
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands,
        gitBranch: null,
        claudeVersion: null,
        sourceTool: 'antigravity',
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: 0,
          modelsUsed: [],
          primaryModel: 'unknown',
          usageSource: 'session',
        },
        messages,
      };

      const titleResult = generateTitle(session);
      session.generatedTitle = titleResult.title;
      session.titleSource = titleResult.source;
      session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

      return session;
    } catch (err) {
      console.error(`[antigravity] Failed to parse transcript ${transcriptPath}: ${err}`);
      return null;
    }
  }

  private async parseLegacyMarkdown(sessionId: string, brainDir: string): Promise<ParsedSession | null> {
    try {
      const messages: ParsedMessage[] = [];
      let projectName = 'unknown';
      let projectPath = '';
      let startedAt = new Date();
      let endedAt = new Date();

      const walkthroughPath = path.join(brainDir, 'walkthrough.md');
      const walkthroughMetaPath = path.join(brainDir, 'walkthrough.md.metadata.json');
      const taskPath = path.join(brainDir, 'task.md');
      const planPath = path.join(brainDir, 'implementation_plan.md');

      if (fs.existsSync(walkthroughMetaPath)) {
        const meta = JSON.parse(fs.readFileSync(walkthroughMetaPath, 'utf-8'));
        if (meta.updatedAt) {
          endedAt = new Date(meta.updatedAt);
          startedAt = new Date(endedAt.getTime() - 1000 * 60 * 30);
        }
      }

      if (fs.existsSync(planPath)) {
        const content = fs.readFileSync(planPath, 'utf-8');
        messages.push({
          id: crypto.randomUUID(),
          sessionId,
          type: 'assistant',
          content: `Implementation Plan:\n${content}`,
          thinking: null,
          toolCalls: [],
          toolResults: [],
          usage: null,
          timestamp: new Date(startedAt.getTime() + 1000 * 60 * 15),
          parentId: null,
        });
      }

      if (fs.existsSync(walkthroughPath)) {
        const content = fs.readFileSync(walkthroughPath, 'utf-8');
        const fileMatch = content.match(/\[.*?\]\(file:\/\/(.*?)\)/);
        if (fileMatch && fileMatch[1]) {
          const root = findProjectRoot(fileMatch[1]);
          if (root) {
            projectPath = root;
            projectName = path.basename(projectPath);
          } else {
            projectPath = path.dirname(fileMatch[1]);
            projectName = path.basename(projectPath);
          }
        } else {
          // Fallback regex for paths like /home/user/Workspace/project
          const workspaceMatch = content.match(/(\/home\/b08x\/(?:Workspace|WorkspaceV3|\.syncopated)\/[^\/\s"'\)]+)/);
          if (workspaceMatch && workspaceMatch[1]) {
            const root = findProjectRoot(workspaceMatch[1]);
            if (root) {
              projectPath = root;
              projectName = path.basename(projectPath);
            }
          }
        }

        messages.push({
          id: crypto.randomUUID(),
          sessionId,
          type: 'assistant',
          content,
          thinking: null,
          toolCalls: [],
          toolResults: [],
          usage: null,
          timestamp: endedAt,
          parentId: null,
        });
      }

      if (fs.existsSync(taskPath)) {
        const content = fs.readFileSync(taskPath, 'utf-8');
        messages.unshift({
          id: crypto.randomUUID(),
          sessionId,
          type: 'system',
          content: `Task Description:\n${content}`,
          thinking: null,
          toolCalls: [],
          toolResults: [],
          usage: null,
          timestamp: startedAt,
          parentId: null,
        });
      }

      if (messages.length === 0) return null;

      const session: ParsedSession = {
        id: sessionId,
        projectPath,
        projectName,
        summary: null,
        generatedTitle: null,
        titleSource: null,
        sessionCharacter: null,
        startedAt,
        endedAt,
        messageCount: messages.length,
        userMessageCount: 0,
        assistantMessageCount: messages.filter(m => m.type === 'assistant').length,
        toolCallCount: 0,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: null,
        sourceTool: 'antigravity',
        usage: {
          totalInputTokens: 0,
          totalOutputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          estimatedCostUsd: 0,
          modelsUsed: [],
          primaryModel: 'unknown',
          usageSource: 'session',
        },
        messages,
      };

      const titleResult = generateTitle(session);
      session.generatedTitle = titleResult.title;
      session.titleSource = titleResult.source;
      session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

      return session;
    } catch (err) {
      console.error(`[antigravity] Failed to parse legacy markdown ${brainDir}: ${err}`);
      return null;
    }
  }
}
