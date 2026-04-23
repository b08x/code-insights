import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { SessionProvider } from './types.js';
import type { ParsedSession, ParsedMessage, SessionUsage } from '../types.js';
import { getGeminiHomeDir } from '../utils/config.js';
import { generateTitle, detectSessionCharacter } from '../parser/titles.js';

/**
 * Antigravity session provider.
 * Discovers .pb files in ~/.gemini/antigravity/conversations/
 * Parses readable artifacts in ~/.gemini/antigravity/brain/<uuid>/
 */
export class AntigravityProvider implements SessionProvider {
  getProviderName(): string {
    return 'antigravity';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const convDir = path.join(getGeminiHomeDir(), 'antigravity', 'conversations');
    
    if (!fs.existsSync(convDir)) {
      return [];
    }

    try {
      const files = fs.readdirSync(convDir)
        .filter(f => f.endsWith('.pb'))
        .map(f => path.join(convDir, f));
      
      // Filter by project is tricky here since the filename is just a UUID.
      // We'll rely on parse() to filter or just return all for now.
      return files;
    } catch (err) {
      console.error(`[antigravity] Failed to discover sessions: ${err}`);
      return [];
    }
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    const sessionId = path.basename(filePath, '.pb');
    const brainDir = path.join(getGeminiHomeDir(), 'antigravity', 'brain', sessionId);

    if (!fs.existsSync(brainDir)) {
      // If there's no brain directory, we might not have enough info to parse
      // unless we want to try to decrypt the .pb file (which we can't easily do yet)
      return null;
    }

    try {
      const messages: ParsedMessage[] = [];
      let projectName = 'unknown';
      let projectPath = '';
      let startedAt = new Date();
      let endedAt = new Date();

      // Get metadata from brain files if possible
      const walkthroughPath = path.join(brainDir, 'walkthrough.md');
      const walkthroughMetaPath = path.join(brainDir, 'walkthrough.md.metadata.json');
      const taskPath = path.join(brainDir, 'task.md');
      const planPath = path.join(brainDir, 'implementation_plan.md');

      if (fs.existsSync(walkthroughMetaPath)) {
        const meta = JSON.parse(fs.readFileSync(walkthroughMetaPath, 'utf-8'));
        if (meta.updatedAt) {
          endedAt = new Date(meta.updatedAt);
          // Assuming session started within a reasonable time before
          startedAt = new Date(endedAt.getTime() - 1000 * 60 * 30); // 30 min before as fallback
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
          timestamp: new Date(startedAt.getTime() + 1000 * 60 * 15), // halfway between start and end
          parentId: null,
        });
      }

      // Try to extract project info from walkthrough if it exists
      if (fs.existsSync(walkthroughPath)) {
        const content = fs.readFileSync(walkthroughPath, 'utf-8');
        // Look for file:/// paths
        const fileMatch = content.match(/\[.*?\]\(file:\/\/(.*?)\)/);
        if (fileMatch && fileMatch[1]) {
          projectPath = path.dirname(fileMatch[1]);
          projectName = path.basename(projectPath);
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
        userMessageCount: 0, // We don't have exact counts without .pb parsing
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
      console.error(`[antigravity] Failed to parse ${filePath}: ${err}`);
      return null;
    }
  }
}
