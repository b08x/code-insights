import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as readline from 'readline';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, MessageUsage, SessionUsage } from '../types.js';
import { getGeminiHomeDir, getGeminiTmpDir } from '../utils/config.js';
import { calculateCost } from '../utils/pricing.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

/**
 * Gemini CLI session provider.
 * Discovers and parses JSON/JSONL session files from ~/.gemini/tmp/<project_hash>/chats/
 */
export class GeminiCliProvider implements SessionProvider {
  getProviderName(): string {
    return 'gemini-cli';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const tmpDir = getGeminiTmpDir();
    const projectsFile = path.join(getGeminiHomeDir(), 'projects.json');

    if (!fs.existsSync(tmpDir)) {
      return [];
    }

    const sessionFiles: string[] = [];
    const projectMappings: Record<string, string> = {};

    // 1. Load project mappings from projects.json if available
    if (fs.existsSync(projectsFile)) {
      try {
        const content = fs.readFileSync(projectsFile, 'utf-8');
        const data = JSON.parse(content);
        if (data.projects) {
          Object.assign(projectMappings, data.projects);
        }
      } catch (err) {
        console.warn(`[gemini-cli] Failed to read projects.json: ${err}`);
      }
    }

    // 2. Scan tmp directory for project folders (hash or name)
    const entries = fs.readdirSync(tmpDir);
    for (const entry of entries) {
      const projectDir = path.join(tmpDir, entry);
      if (!fs.statSync(projectDir).isDirectory()) continue;

      // Check if it's a project we care about if filter is provided
      if (options?.projectFilter && !entry.toLowerCase().includes(options.projectFilter.toLowerCase())) {
        // We might still care if the real project name (from mapping) matches
        const realName = projectMappings[entry] || entry;
        if (!realName.toLowerCase().includes(options.projectFilter.toLowerCase())) {
          continue;
        }
      }

      const chatsDir = path.join(projectDir, 'chats');
      if (fs.existsSync(chatsDir) && fs.statSync(chatsDir).isDirectory()) {
        const chatEntries = fs.readdirSync(chatsDir, { withFileTypes: true });
        
        // Pre-scan for directories to handle bundling
        const subAgentDirs = chatEntries.filter(e => e.isDirectory()).map(e => e.name);

        for (const chatEntry of chatEntries) {
          const fullPath = path.join(chatsDir, chatEntry.name);
          if (chatEntry.isDirectory()) {
            // This is a sub-agent directory.
            sessionFiles.push(fullPath);
          } else if (chatEntry.isFile() && (chatEntry.name.endsWith('.json') || chatEntry.name.endsWith('.jsonl'))) {
            // Check if this file has a corresponding sub-agent directory.
            // Truncated IDs in filenames (8 chars) often match the start of the full UUID directory name.
            const sessionId = this.extractSessionIdFromFilename(chatEntry.name);
            const hasSubDir = subAgentDirs.some(dirName => dirName.startsWith(sessionId));
            
            if (hasSubDir) {
              // Skip the parent file here; it will be processed when we handle the sub-agent directory.
              continue;
            }
            sessionFiles.push(fullPath);
          }
        }
      }
    }

    return sessionFiles;
  }

  private extractSessionIdFromFilename(filename: string): string {
    // session-YYYY-MM-DDTHH-MM-ID.jsonl
    const match = filename.match(/session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-(.*)\.(json|jsonl)$/);
    return match ? match[1] : filename.replace(/\.(json|jsonl)$/, '');
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

  async parse(filePath: string): Promise<ParsedSession | null> {
    if (fs.statSync(filePath).isDirectory()) {
      return this.parseBundledSession(filePath);
    }

    if (filePath.endsWith('.jsonl')) {
      return this.parseJsonl(filePath);
    }

    return this.parseJsonFile(filePath);
  }

  private async parseBundledSession(dirPath: string): Promise<ParsedSession | null> {
    try {
      const parentSessionId = path.basename(dirPath);
      const chatsDir = path.dirname(dirPath);
      
      const allFiles = fs.readdirSync(chatsDir);
      // Find the parent session file. It might contain the truncated ID or the full ID.
      const parentFile = allFiles.find(f => 
        (f.endsWith('.json') || f.endsWith('.jsonl')) && 
        (f.includes(parentSessionId) || parentSessionId.startsWith(this.extractSessionIdFromFilename(f)))
      );
      
      if (!parentFile) return null;

      const parentPath = path.join(chatsDir, parentFile);
      // Directly call parseJsonl or parseJsonFile to avoid directory-check loop
      const parentSession = parentPath.endsWith('.jsonl') 
        ? await this.parseJsonl(parentPath)
        : await this.parseJsonFile(parentPath);

      if (!parentSession) return null;

      // Find all sub-agent files
      const subFiles = this.findFiles(dirPath, ['.json', '.jsonl']);
      for (const subFile of subFiles) {
        const subSession = subFile.endsWith('.jsonl')
          ? await this.parseJsonl(subFile)
          : await this.parseJsonFile(subFile);

        if (subSession && subSession.messages.length > 0) {
          // IMPORTANT: Override sessionId on all messages to point to parent
          for (const msg of subSession.messages) {
            msg.sessionId = parentSession.id;
          }

          parentSession.messages.push(...subSession.messages);
          
          parentSession.messageCount += subSession.messageCount;
          parentSession.userMessageCount += subSession.userMessageCount;
          parentSession.assistantMessageCount += subSession.assistantMessageCount;
          parentSession.toolCallCount += subSession.toolCallCount;
          
          if (subSession.startedAt < parentSession.startedAt) {
            parentSession.startedAt = subSession.startedAt;
          }
          if (subSession.endedAt > parentSession.endedAt) {
            parentSession.endedAt = subSession.endedAt;
          }

          if (subSession.usage && parentSession.usage) {
            parentSession.usage.totalInputTokens += subSession.usage.totalInputTokens;
            parentSession.usage.totalOutputTokens += subSession.usage.totalOutputTokens;
            parentSession.usage.cacheReadTokens += subSession.usage.cacheReadTokens;
            parentSession.usage.estimatedCostUsd += subSession.usage.estimatedCostUsd;
            
            for (const model of subSession.usage.modelsUsed) {
              if (!parentSession.usage.modelsUsed.includes(model)) {
                parentSession.usage.modelsUsed.push(model);
              }
            }
          } else if (subSession.usage && !parentSession.usage) {
            parentSession.usage = subSession.usage;
          }
        }
      }

      parentSession.messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      return parentSession;
    } catch (err) {
      console.error(`[gemini-cli] Failed to parse bundled session ${dirPath}: ${err}`);
      return null;
    }
  }

  private async parseJsonFile(filePath: string): Promise<ParsedSession | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (!data.sessionId || !Array.isArray(data.messages)) {
        return null;
      }

      const projectDir = this.findProjectDir(filePath);
      const projectId = path.basename(projectDir);
      let projectPath = '';
      let projectName = projectId;

      const projectRootFile = path.join(projectDir, '.project_root');
      if (fs.existsSync(projectRootFile)) {
        projectPath = fs.readFileSync(projectRootFile, 'utf-8').trim();
        projectName = path.basename(projectPath);
      }

      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      for (const msg of data.messages) {
        if (msg.type === 'info') continue;

        const parsedMsg: ParsedMessage = {
          id: msg.id || crypto.randomUUID(),
          sessionId: data.sessionId,
          type: msg.type === 'gemini' ? 'assistant' : (msg.type === 'user' ? 'user' : 'system'),
          content: this.extractContent(msg),
          thinking: this.extractThinking(msg),
          toolCalls: this.extractToolCalls(msg),
          toolResults: this.extractToolResults(msg),
          usage: this.extractUsage(msg),
          timestamp: new Date(msg.timestamp),
          parentId: null,
        };

        if (parsedMsg.type === 'user') userMessageCount++;
        if (parsedMsg.type === 'assistant') assistantMessageCount++;
        toolCallCount += parsedMsg.toolCalls.length;

        messages.push(parsedMsg);
      }

      if (messages.length === 0) return null;

      const sessionUsage = this.calculateSessionUsage(messages);

      const session: ParsedSession = {
        id: data.sessionId,
        projectPath,
        projectName,
        summary: null,
        generatedTitle: null,
        titleSource: null,
        sessionCharacter: null,
        startedAt: new Date(data.startTime || (messages.length > 0 ? messages[0].timestamp : new Date())),
        endedAt: new Date(data.lastUpdated || (messages.length > 0 ? messages[messages.length - 1].timestamp : new Date())),
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: null,
        sourceTool: 'gemini-cli',
        usage: sessionUsage,
        messages,
      };

      const titleResult = generateTitle(session);
      session.generatedTitle = titleResult.title;
      session.titleSource = titleResult.source;
      session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

      return session;
    } catch (err) {
      return null;
    }
  }

  private async parseJsonl(filePath: string): Promise<ParsedSession | null> {
    try {
      const fileStream = fs.createReadStream(filePath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      let sessionData: any = null;
      const messages: ParsedMessage[] = [];
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;

      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          
          if (!sessionData && entry.sessionId) {
            sessionData = entry;
            continue;
          }

          if (entry.$set) {
            if (sessionData) {
              Object.assign(sessionData, entry.$set);
            }
            continue;
          }

          if (entry.type && entry.id) {
            if (entry.type === 'info') continue;

            const parsedMsg: ParsedMessage = {
              id: entry.id,
              sessionId: sessionData?.sessionId || 'unknown',
              type: entry.type === 'gemini' ? 'assistant' : (entry.type === 'user' ? 'user' : 'system'),
              content: this.extractContent(entry),
              thinking: this.extractThinking(entry),
              toolCalls: this.extractToolCalls(entry),
              toolResults: this.extractToolResults(entry),
              usage: this.extractUsage(entry),
              timestamp: new Date(entry.timestamp),
              parentId: null,
            };

            if (parsedMsg.type === 'user') userMessageCount++;
            if (parsedMsg.type === 'assistant') assistantMessageCount++;
            toolCallCount += parsedMsg.toolCalls.length;

            messages.push(parsedMsg);
          }
        } catch (e) {
        }
      }

      if (!sessionData || messages.length === 0) return null;

      const projectDir = this.findProjectDir(filePath);
      const projectId = path.basename(projectDir);
      let projectPath = '';
      let projectName = projectId;

      const projectRootFile = path.join(projectDir, '.project_root');
      if (fs.existsSync(projectRootFile)) {
        projectPath = fs.readFileSync(projectRootFile, 'utf-8').trim();
        projectName = path.basename(projectPath);
      }

      const sessionUsage = this.calculateSessionUsage(messages);

      const session: ParsedSession = {
        id: sessionData.sessionId,
        projectPath,
        projectName,
        summary: null,
        generatedTitle: null,
        titleSource: null,
        sessionCharacter: null,
        startedAt: new Date(sessionData.startTime || (messages.length > 0 ? messages[0].timestamp : new Date())),
        endedAt: new Date(sessionData.lastUpdated || (messages.length > 0 ? messages[messages.length - 1].timestamp : new Date())),
        messageCount: messages.length,
        userMessageCount,
        assistantMessageCount,
        toolCallCount,
        compactCount: 0,
        autoCompactCount: 0,
        slashCommands: [],
        gitBranch: null,
        claudeVersion: null,
        sourceTool: 'gemini-cli',
        usage: sessionUsage,
        messages,
      };

      const titleResult = generateTitle(session);
      session.generatedTitle = titleResult.title;
      session.titleSource = titleResult.source;
      session.sessionCharacter = titleResult.character || detectSessionCharacter(session);

      return session;
    } catch (err) {
      console.error(`[gemini-cli] Failed to parse JSONL ${filePath}: ${err}`);
      return null;
    }
  }

  private findProjectDir(filePath: string): string {
    let current = path.dirname(filePath);
    while (current !== path.dirname(current)) {
      if (path.basename(current) === 'chats') {
        return path.dirname(current);
      }
      current = path.dirname(current);
    }
    return path.dirname(path.dirname(filePath));
  }

  private extractContent(msg: any): string {
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content.map((c: any) => c.text || '').join('\n');
    }
    return '';
  }

  private extractThinking(msg: any): string | null {
    if (Array.isArray(msg.thoughts) && msg.thoughts.length > 0) {
      return msg.thoughts.map((t: any) => `[${t.subject}] ${t.description}`).join('\n\n');
    }
    return null;
  }

  private extractToolCalls(msg: any): ToolCall[] {
    if (Array.isArray(msg.toolCalls)) {
      return msg.toolCalls.map((tc: any) => ({
        id: tc.id,
        name: tc.name,
        input: tc.args || {},
      }));
    }
    return [];
  }

  private extractToolResults(msg: any): ToolResult[] {
    if (Array.isArray(msg.toolCalls)) {
      const results: ToolResult[] = [];
      for (const tc of msg.toolCalls) {
        if (tc.result) {
          const output = Array.isArray(tc.result) 
            ? tc.result.map((r: any) => JSON.stringify(r.functionResponse?.response || r)).join('\n')
            : JSON.stringify(tc.result);
          
          results.push({
            toolUseId: tc.id,
            output,
          });
        }
      }
      return results;
    }
    return [];
  }

  private extractUsage(msg: any): MessageUsage | null {
    if (msg.tokens && msg.type === 'gemini') {
      const input = msg.tokens.input || 0;
      const output = msg.tokens.output || 0;
      const cacheRead = msg.tokens.cached || 0;
      const model = msg.model || 'unknown';

      const cost = calculateCost([{
        model,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_read_input_tokens: cacheRead,
        }
      }]);

      return {
        inputTokens: input,
        outputTokens: output,
        cacheCreationTokens: 0,
        cacheReadTokens: cacheRead,
        model,
        estimatedCostUsd: cost,
      };
    }
    return null;
  }

  private calculateSessionUsage(messages: ParsedMessage[]): SessionUsage {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let cacheReadTokens = 0;
    const modelsUsed = new Set<string>();

    for (const msg of messages) {
      if (msg.usage) {
        totalInputTokens += msg.usage.inputTokens;
        totalOutputTokens += msg.usage.outputTokens;
        cacheReadTokens += msg.usage.cacheReadTokens;
        modelsUsed.add(msg.usage.model);
      }
    }

    const primaryModel = Array.from(modelsUsed)[0] || 'unknown';

    const estimatedCostUsd = calculateCost(Array.from(modelsUsed).map(model => ({
      model,
      usage: {
        input_tokens: messages.filter(m => m.usage?.model === model).reduce((sum, m) => sum + (m.usage?.inputTokens || 0), 0),
        output_tokens: messages.filter(m => m.usage?.model === model).reduce((sum, m) => sum + (m.usage?.outputTokens || 0), 0),
        cache_read_input_tokens: messages.filter(m => m.usage?.model === model).reduce((sum, m) => sum + (m.usage?.cacheReadTokens || 0), 0),
      }
    })));

    return {
      totalInputTokens,
      totalOutputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      estimatedCostUsd,
      modelsUsed: Array.from(modelsUsed),
      primaryModel,
      usageSource: 'session',
    };
  }
}
