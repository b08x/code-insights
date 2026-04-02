import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CrushProvider } from '../crush.js';

// Mock os
vi.mock('os', async () => {
  const actual = await vi.importActual('os') as any;
  return {
    ...actual,
    homedir: vi.fn(),
  };
});

// Mock better-sqlite3
vi.mock('better-sqlite3', () => {
  class MockDatabase {
    prepare = vi.fn().mockImplementation((query) => {
      return {
        all: vi.fn().mockImplementation((arg) => {
          if (query.includes('FROM sessions')) {
            return [{ id: 'session-1', title: 'Test Crush Session' }];
          }
          if (query.includes('FROM messages')) {
            return [
              { id: 'm1', role: 'user', parts: JSON.stringify([{ type: 'text', data: { text: 'Hello Crush' } }]), created_at: 1771125396000 },
              { id: 'm2', role: 'assistant', parts: JSON.stringify([
                { type: 'reasoning', data: { thinking: 'Thinking...' } },
                { type: 'tool_call', data: { id: 'call-1', name: 'ls', arguments: {} } }
              ]), created_at: 1771125405000 },
              { id: 'm3', role: 'tool', parts: JSON.stringify([{ type: 'tool_result', data: { tool_call_id: 'call-1', content: 'file1.txt' } }]), created_at: 1771125406000 }
            ];
          }
          return [];
        }),
        get: vi.fn().mockImplementation((arg) => {
          if (query.includes('FROM sessions')) {
            return {
              id: 'session-1',
              title: 'Test Crush Session',
              prompt_tokens: 100,
              completion_tokens: 50,
              cost: 0.02,
              created_at: 1771125396000,
              updated_at: 1771125406000,
              model: 'gpt-4'
            };
          }
          if (query.includes('FROM files')) {
            return { path: '/home/user/project/main.py' };
          }
          return null;
        }),
      };
    });
    close = vi.fn();
  }
  return {
    default: MockDatabase,
  };
});

describe('CrushProvider', () => {
  let tempDir: string;
  const provider = new CrushProvider();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crush-test-'));
    // We'll mock os.homedir to point to our tempDir.
    vi.mocked(os.homedir).mockReturnValue(tempDir);
    
    // Create a .crush/crush.db file so discover finds it
    const projectDir = path.join(tempDir, 'my-project');
    const crushDir = path.join(projectDir, '.crush');
    fs.mkdirSync(crushDir, { recursive: true });
    fs.writeFileSync(path.join(crushDir, 'crush.db'), '');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns "crush" as provider name', () => {
    expect(provider.getProviderName()).toBe('crush');
  });

  describe('discover', () => {
    it('discovers crush.db files in project subdirectories', async () => {
      const discovered = await provider.discover();
      expect(discovered).toHaveLength(1);
      expect(discovered[0]).toContain('session-1');
    });
  });

  describe('parse', () => {
    it('parses a valid Crush session from the database', async () => {
      const virtualPath = `/any/path/crush.db#session-1`;
      const session = await provider.parse(virtualPath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe('crush:session-1');
      expect(session!.projectName).toBe('Test Crush Session');
      expect(session!.sourceTool).toBe('crush');
      expect(session!.messageCount).toBe(2); // user, assistant (with tool result)
      expect(session!.userMessageCount).toBe(1);
      expect(session!.assistantMessageCount).toBe(1);
      
      const assistantMsg = session!.messages.find(m => m.type === 'assistant');
      expect(assistantMsg!.content).toBe('');
      expect(assistantMsg!.thinking).toBe('Thinking...');
      expect(assistantMsg!.toolCalls).toHaveLength(1);
      expect(assistantMsg!.toolResults).toHaveLength(1);
      expect(assistantMsg!.toolResults[0].output).toBe('file1.txt');

      expect(session!.usage).not.toBeUndefined();
      expect(session!.usage!.totalInputTokens).toBe(100);
      expect(session!.usage!.totalOutputTokens).toBe(50);
      expect(session!.usage!.estimatedCostUsd).toBe(0.02);
    });
  });
});
