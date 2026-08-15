import * as fs from 'fs';
import * as path from 'path';
import type { SessionProvider } from './types.js';
import type { ParsedSession } from '../types.js';
import { parseJsonlFile } from '../parser/jsonl.js';
import { getClaudeDesktopDir } from '../utils/config.js';

/**
 * Claude Desktop Provider.
 * Discovers and parses local agent mode sessions from Claude Desktop app.
 */
export class ClaudeDesktopProvider implements SessionProvider {
  getProviderName(): string {
    return 'claude-desktop';
  }

  async discover(options?: { projectFilter?: string }): Promise<string[]> {
    const baseDir = getClaudeDesktopDir();

    if (!fs.existsSync(baseDir)) {
      return [];
    }

    const files: string[] = [];
    
    // Directory structure: <account_uuid>/<project_uuid>/<session_id>/audit.jsonl
    const accounts = fs.readdirSync(baseDir);
    for (const account of accounts) {
      if (account.startsWith('.')) continue;
      const accountPath = path.join(baseDir, account);
      if (!fs.statSync(accountPath).isDirectory()) continue;
      
      const projects = fs.readdirSync(accountPath);
      for (const project of projects) {
        if (project.startsWith('.')) continue;
        const projectPath = path.join(accountPath, project);
        if (!fs.statSync(projectPath).isDirectory()) continue;
        
        // Optional project filter (matches against project UUID for now)
        if (options?.projectFilter && !project.includes(options.projectFilter)) {
          continue;
        }
        
        const sessions = fs.readdirSync(projectPath);
        for (const session of sessions) {
          if (session.startsWith('.')) continue;
          const sessionPath = path.join(projectPath, session);
          if (!fs.statSync(sessionPath).isDirectory()) continue;
          
          const auditPath = path.join(sessionPath, 'audit.jsonl');
          if (fs.existsSync(auditPath)) {
            files.push(auditPath);
          }
        }
      }
    }
    
    return files;
  }

  async parse(filePath: string): Promise<ParsedSession | null> {
    const session = await parseJsonlFile(filePath);
    if (!session) return null;

    session.sourceTool = 'claude-desktop';

    // Enrich with metadata from <session_id>.json
    try {
      const parentDir = path.dirname(filePath);
      const sessionId = path.basename(parentDir);
      const projectDir = path.dirname(parentDir);
      const metaPath = path.join(projectDir, `${sessionId}.json`);
      
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
        if (meta.title) session.customTitle = meta.title;
        
        // Enhance project path extraction: audit.jsonl messages lack cwd
        if (meta.userSelectedFolders && meta.userSelectedFolders.length > 0) {
          session.projectPath = meta.userSelectedFolders[0];
          session.projectName = path.basename(meta.userSelectedFolders[0]) || 'unknown';
        } else if (meta.cwd) {
          session.projectPath = meta.cwd;
          session.projectName = path.basename(meta.cwd) || 'unknown';
        }
      }
    } catch (err) {
      // Ignore errors reading metadata
      console.warn(`[claude-desktop] Error reading metadata for ${filePath}: ${err}`);
    }

    return session;
  }
}
