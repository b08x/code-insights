import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, SessionUsage } from '../types.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';
import { calculateCost } from '../utils/pricing.js';

function getPiSessionsDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'sessions');
}

export class PiProvider implements SessionProvider {
  getProviderName(): string {
    return 'pi';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const baseDir = getPiSessionsDir();
    if (!fs.existsSync(baseDir)) return [];

    const files: string[] = [];
    let dirs: string[] = [];
    try {
      dirs = fs.readdirSync(baseDir);
    } catch {
      return [];
    }

    for (const dir of dirs) {
      if (dir.startsWith('.')) continue;
      const dirPath = path.join(baseDir, dir);
      
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue;
        
        let decodedPath = dir;
        if (dir.startsWith('--') && dir.endsWith('--')) {
          decodedPath = dir.slice(2, -2).replace(/-/g, '/');
          if (process.platform !== 'win32' && !decodedPath.startsWith('/')) {
            decodedPath = '/' + decodedPath;
          }
        }
        
        if (options?.projectFilter && !decodedPath.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          continue;
        }

        const projectFiles = fs.readdirSync(dirPath);
        for (const file of projectFiles) {
          if (file.endsWith('.jsonl')) {
            files.push(path.join(dirPath, file));
          }
        }
      } catch {
        // Ignore errors
      }
    }

    return files;
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    const entries: any[] = [];
    
    try {
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        if (line.trim()) {
          try { entries.push(JSON.parse(line)); } catch { }
        }
      }
    } catch (e) {
      return null;
    }

    if (entries.length === 0) return null;

    const sessionId = path.basename(filePath, '.jsonl');
    let projectPath = '';
    
    const parentDirName = path.basename(path.dirname(filePath));
    if (parentDirName.startsWith('--') && parentDirName.endsWith('--')) {
      projectPath = parentDirName.slice(2, -2).replace(/-/g, '/');
      if (process.platform !== 'win32' && !projectPath.startsWith('/')) {
        projectPath = '/' + projectPath;
      }
    }

    const messages: ParsedMessage[] = [];
    let userMessageCount = 0;
    let assistantMessageCount = 0;
    let toolCallCount = 0;
    let compactCount = 0;

    const usageEntries: any[] = [];

    for (const entry of entries) {
      if (entry.type === 'session') {
        if (entry.cwd) projectPath = entry.cwd;
        continue;
      }

      if (entry.type === 'compaction') {
        compactCount++;
        continue;
      }

      if (entry.type === 'message' && entry.message) {
        const role = entry.message.role;
        if (role === 'custom' || role === 'branchSummary') continue;
        
        let type: 'user' | 'assistant' | 'system' = 'user';
        if (role === 'assistant') type = 'assistant';
        
        if (type === 'user') userMessageCount++;
        else if (type === 'assistant') assistantMessageCount++;

        let contentStr = '';
        let thinking: string | null = null;
        const toolCalls: ToolCall[] = [];
        const toolResults: ToolResult[] = [];

        if (role === 'bashExecution') {
          toolResults.push({
            toolUseId: `bash-${entry.id}`,
            output: entry.message.output || '',
          });
          contentStr = `> ${entry.message.command}\n${entry.message.output || ''}`;
        } else if (role === 'toolResult') {
          toolResults.push({
            toolUseId: entry.message.toolCallId || entry.id,
            output: this.extractPiText(entry.message.content)
          });
        } else if (entry.message.content) {
          if (typeof entry.message.content === 'string') {
            contentStr = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            for (const part of entry.message.content) {
              if (part.type === 'text') contentStr += (contentStr ? '\n' : '') + part.text;
              else if (part.type === 'thinking') thinking = (thinking ? thinking + '\n' : '') + part.thinking;
              else if (part.type === 'toolCall') {
                toolCalls.push({
                  id: part.id,
                  name: part.name,
                  input: part.arguments || {}
                });
              } else if (part.type === 'image') {
                contentStr += (contentStr ? '\n' : '') + '[Image]';
              }
            }
          }
        }

        toolCallCount += toolCalls.length;

        let msgUsage = null;
        if (role === 'assistant' && entry.message.usage) {
          const u = entry.message.usage;
          const model = entry.message.model || 'unknown';
          const costEntries = [{ model, usage: {
            input_tokens: u.input || 0,
            output_tokens: u.output || 0,
            cache_creation_input_tokens: u.cacheWrite || 0,
            cache_read_input_tokens: u.cacheRead || 0
          }}];
          msgUsage = {
            inputTokens: u.input || 0,
            outputTokens: u.output || 0,
            cacheCreationTokens: u.cacheWrite || 0,
            cacheReadTokens: u.cacheRead || 0,
            model,
            estimatedCostUsd: calculateCost(costEntries)
          };
          usageEntries.push(costEntries[0]);
        }

        messages.push({
          id: entry.id,
          sessionId,
          type,
          content: contentStr,
          thinking,
          toolCalls,
          toolResults,
          usage: msgUsage,
          timestamp: new Date(entry.timestamp),
          parentId: entry.parentId || null
        });
      }
    }

    if (messages.length === 0) return null;

    let usage: SessionUsage | undefined;
    if (usageEntries.length > 0) {
      const totalInputTokens = usageEntries.reduce((sum, e) => sum + (e.usage.input_tokens ?? 0), 0);
      const totalOutputTokens = usageEntries.reduce((sum, e) => sum + (e.usage.output_tokens ?? 0), 0);
      const cacheCreationTokens = usageEntries.reduce((sum, e) => sum + (e.usage.cache_creation_input_tokens ?? 0), 0);
      const cacheReadTokens = usageEntries.reduce((sum, e) => sum + (e.usage.cache_read_input_tokens ?? 0), 0);

      const modelCounts = new Map<string, number>();
      for (const e of usageEntries) {
        modelCounts.set(e.model, (modelCounts.get(e.model) ?? 0) + 1);
      }
      const modelsUsed = [...modelCounts.keys()];
      const primaryModel = [...modelsUsed].sort((a, b) =>
        (modelCounts.get(b) ?? 0) - (modelCounts.get(a) ?? 0)
      )[0] ?? 'unknown';

      usage = {
        totalInputTokens,
        totalOutputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        estimatedCostUsd: calculateCost(usageEntries),
        modelsUsed,
        primaryModel,
        usageSource: 'jsonl',
      };
    }

    const timestamps = messages.map(m => m.timestamp.getTime());
    const session: ParsedSession = {
      id: sessionId,
      projectPath,
      projectName: path.basename(projectPath) || 'unknown',
      summary: null,
      generatedTitle: null,
      titleSource: null,
      sessionCharacter: null,
      startedAt: new Date(Math.min(...timestamps)),
      endedAt: new Date(Math.max(...timestamps)),
      messageCount: userMessageCount + assistantMessageCount,
      userMessageCount,
      assistantMessageCount,
      toolCallCount,
      compactCount,
      autoCompactCount: 0,
      slashCommands: [],
      gitBranch: null,
      claudeVersion: null,
      sourceTool: 'pi',
      messages,
      usage
    };

    const titleResult = generateTitle(session);
    session.generatedTitle = titleResult.title;
    session.titleSource = titleResult.source;
    session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

    return session;
  }

  private extractPiText(content: any): string {
    if (!content) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    }
    return '';
  }
}
