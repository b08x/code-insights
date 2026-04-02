import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, MessageUsage, SessionUsage } from '../types.js';
import { getGeminiHomeDir, getGeminiTmpDir } from '../utils/config.js';
import { calculateCost } from '../utils/pricing.js';

/**
 * Gemini CLI session provider.
 * Discovers and parses JSON session files from ~/.gemini/tmp/<project_hash>/chats/
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
        const files = fs.readdirSync(chatsDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
          sessionFiles.push(path.join(chatsDir, file));
        }
      }
    }

    return sessionFiles;
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(content);

      if (!data.sessionId || !Array.isArray(data.messages)) {
        return null;
      }

      // Resolve project info
      const projectDir = path.dirname(path.dirname(filePath));
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
        if (msg.type === 'info') continue; // Skip info messages

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
          parentId: null, // Gemini CLI format doesn't seem to have explicit parents in the JSON
        };

        if (parsedMsg.type === 'user') userMessageCount++;
        if (parsedMsg.type === 'assistant') assistantMessageCount++;
        toolCallCount += parsedMsg.toolCalls.length;

        messages.push(parsedMsg);
      }

      if (messages.length === 0) return null;

      const sessionUsage = this.calculateSessionUsage(messages);

      return {
        id: data.sessionId,
        projectPath,
        projectName,
        summary: null,
        generatedTitle: null,
        titleSource: null,
        sessionCharacter: null,
        startedAt: new Date(data.startTime || messages[0].timestamp),
        endedAt: new Date(data.lastUpdated || messages[messages.length - 1].timestamp),
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
    } catch (err) {
      console.error(`[gemini-cli] Failed to parse ${filePath}: ${err}`);
      return null;
    }
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
          // result is often an array of functionResponse objects
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
