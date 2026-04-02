import * as fs from 'fs';
import * as path from 'path';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, ToolCall, ToolResult, SessionUsage } from '../types.js';
import { getOpenCodeDir } from '../utils/config.js';

/**
 * OpenCode session provider.
 * Discovers and parses JSON session files from ~/.local/share/opencode/storage/
 */
export class OpenCodeProvider implements SessionProvider {
  getProviderName(): string {
    return 'opencode';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const baseDir = getOpenCodeDir();
    const sessionsDir = path.join(baseDir, 'storage', 'session');

    if (!fs.existsSync(sessionsDir)) {
      return [];
    }

    const sessionFiles: string[] = [];
    
    // session directory contains project-slug subdirectories
    const projectDirs = fs.readdirSync(sessionsDir);
    for (const projectDir of projectDirs) {
      const projectPath = path.join(sessionsDir, projectDir);
      if (!fs.statSync(projectPath).isDirectory()) continue;

      // Filter by project slug if requested
      if (options?.projectFilter && !projectDir.toLowerCase().includes(options.projectFilter.toLowerCase())) {
        // We'll also check titles inside parse() but for discovery, slug-based filter is a good start
        continue;
      }

      const files = fs.readdirSync(projectPath).filter(f => f.endsWith('.json'));
      for (const file of files) {
        sessionFiles.push(path.join(projectPath, file));
      }
    }

    return sessionFiles;
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    try {
      const rawSession = fs.readFileSync(filePath, 'utf-8');
      const sessionData = JSON.parse(rawSession);

      if (!sessionData.id) return null;

      const baseDir = getOpenCodeDir();
      const messagesDir = path.join(baseDir, 'storage', 'message', sessionData.id);
      const partsDir = path.join(baseDir, 'storage', 'part');

      if (!fs.existsSync(messagesDir)) {
        return null; // A session without messages is not very useful
      }

      const messageFiles = fs.readdirSync(messagesDir).filter(f => f.endsWith('.json'));
      const messages: ParsedMessage[] = [];
      
      let userMessageCount = 0;
      let assistantMessageCount = 0;
      let toolCallCount = 0;
      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let totalCost = 0;
      const modelsUsed = new Set<string>();

      for (const msgFile of messageFiles) {
        const msgPath = path.join(messagesDir, msgFile);
        const msgData = JSON.parse(fs.readFileSync(msgPath, 'utf-8'));
        
        // Load parts for this message
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

      // Sort messages by timestamp
      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      const sessionUsage: SessionUsage = {
        totalInputTokens,
        totalOutputTokens,
        cacheCreationTokens: 0, // already added to input if write? no, usually separate
        cacheReadTokens: 0,
        estimatedCostUsd: totalCost,
        modelsUsed: Array.from(modelsUsed),
        primaryModel: Array.from(modelsUsed)[0] || 'unknown',
        usageSource: 'session',
      };

      return {
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
        usage: sessionUsage,
        messages,
      };
    } catch (err) {
      console.error(`[opencode] Failed to parse session ${filePath}: ${err}`);
      return null;
    }
  }
}
