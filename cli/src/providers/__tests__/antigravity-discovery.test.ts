import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AntigravityProvider } from '../antigravity.js';

describe('AntigravityProvider', () => {
  it('should discover .pb session files in ~/.gemini/antigravity/conversations', async () => {
    const provider = new AntigravityProvider();
    const sessions = await provider.discover();
    
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]).toMatch(/\.pb$/);
    expect(sessions[0]).toContain('.gemini/antigravity/conversations');
  });

  it('should parse a session if brain directory exists', async () => {
    const provider = new AntigravityProvider();
    const sessions = await provider.discover();
    
    // Find a session that has a brain directory
    let parsedSession = null;
    for (const sessionPath of sessions) {
      parsedSession = await provider.parse(sessionPath);
      if (parsedSession) break;
    }
    
    if (parsedSession) {
      expect(parsedSession.id).toBeDefined();
      expect(parsedSession.sourceTool).toBe('antigravity');
      expect(parsedSession.messages.length).toBeGreaterThan(0);
      console.log(`Successfully parsed session: ${parsedSession.id}`);
      console.log(`Project: ${parsedSession.projectName}`);
      console.log(`Title: ${parsedSession.generatedTitle}`);
    } else {
      console.warn('No sessions with brain directories found to test parsing');
    }
  });
});
