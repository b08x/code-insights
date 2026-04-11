import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HermesAgentProvider } from '../hermes-agent.js';

// Mock better-sqlite3
vi.mock('better-sqlite3', () => {
  class MockDatabase {
    constructor(dbPath: string, options?: any) {
      // Check if the database file exists for non-existent file test
      if (!fs.existsSync(dbPath)) {
        throw new Error(`ENOENT: no such file or directory, open '${dbPath}'`);
      }
    }

    prepare = vi.fn().mockImplementation((query) => {
      return {
        all: vi.fn().mockImplementation((arg) => {
          if (query.includes('FROM sessions')) {
            return [{ id: 'session-1', title: 'Test Session' }];
          }
          if (query.includes('FROM messages')) {
            return [
              { id: 1, role: 'user', content: 'Hello Hermes', timestamp: 1774880260 },
              { id: 2, role: 'assistant', content: null, tool_calls: JSON.stringify([{ id: 'tc-1', name: 'search', args: { query: 'test' } }]), timestamp: 1774880265 },
              { id: 3, role: 'tool', content: '{"result": "found nothing"}', tool_call_id: 'tc-1', timestamp: 1774880266 },
              { id: 4, role: 'assistant', content: 'I found nothing.', timestamp: 1774880270, token_count: 20 }
            ];
          }
          return [];
        }),
        get: vi.fn().mockImplementation((arg) => {
          if (query.includes('FROM sessions')) {
            if (arg === 'non-existent') return null;
            return {
              id: 'session-1',
              source: 'cli',
              model: 'openai/gpt-4.1-nano',
              started_at: 1774880258,
              ended_at: 1774880438,
              title: 'Test Session',
              input_tokens: 100,
              output_tokens: 50,
              actual_cost_usd: 0.01
            };
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

// Mock the config utilities
vi.mock('../../utils/config.js', async () => {
  const actual = await vi.importActual('../../utils/config.js') as any;
  return {
    ...actual,
    getHermesHomeDir: vi.fn(),
  };
});

import { getHermesHomeDir } from '../../utils/config.js';

describe('HermesAgentProvider', () => {
  let tempHomeDir: string;
  let centralDbPath: string;
  let profileDbPath: string;
  const provider = new HermesAgentProvider();

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));

    // Setup central database
    centralDbPath = path.join(tempHomeDir, 'state.db');
    fs.writeFileSync(centralDbPath, ''); // Create dummy file

    // Setup profile directory structure
    const profilesDir = path.join(tempHomeDir, 'profiles');
    const profileDir = path.join(profilesDir, 'testuser');
    fs.mkdirSync(profileDir, { recursive: true });

    profileDbPath = path.join(profileDir, 'state.db');
    fs.writeFileSync(profileDbPath, ''); // Create dummy file

    vi.mocked(getHermesHomeDir).mockReturnValue(tempHomeDir);
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('returns "hermes-agent" as provider name', () => {
    expect(provider.getProviderName()).toBe('hermes-agent');
  });

  describe('discover', () => {
    it('discovers sessions from central database', async () => {
      const discovered = await provider.discover();
      expect(discovered).toContain(`central:${centralDbPath}#session-1`);
    });

    it('discovers sessions from profile databases', async () => {
      const discovered = await provider.discover();
      expect(discovered).toContain(`testuser:${profileDbPath}#session-1`);
    });

    it('discovers sessions from both central and profile databases', async () => {
      const discovered = await provider.discover();

      expect(discovered).toHaveLength(2); // One from central, one from profile
      expect(discovered).toContain(`central:${centralDbPath}#session-1`);
      expect(discovered).toContain(`testuser:${profileDbPath}#session-1`);
    });

    it('filters sessions by title in central database', async () => {
      const discovered = await provider.discover({ projectFilter: 'Test' });
      expect(discovered).toContain(`central:${centralDbPath}#session-1`);

      const filtered = await provider.discover({ projectFilter: 'None' });
      expect(filtered).not.toContain(`central:${centralDbPath}#session-1`);
    });

    it('handles missing central database gracefully', async () => {
      fs.unlinkSync(centralDbPath); // Remove central database

      const discovered = await provider.discover();

      // Should still find profile database
      expect(discovered).toContain(`testuser:${profileDbPath}#session-1`);
      expect(discovered).not.toContain(`central:${centralDbPath}#session-1`);
    });

    it('handles missing profiles directory gracefully', async () => {
      fs.rmSync(path.join(tempHomeDir, 'profiles'), { recursive: true, force: true });

      const discovered = await provider.discover();

      // Should still find central database
      expect(discovered).toContain(`central:${centralDbPath}#session-1`);
      expect(discovered).toHaveLength(1);
    });

    it('handles profiles without state.db files', async () => {
      // Create a profile without state.db
      const emptyProfileDir = path.join(tempHomeDir, 'profiles', 'emptyprofile');
      fs.mkdirSync(emptyProfileDir, { recursive: true });

      const discovered = await provider.discover();

      // Should find central + testuser profile (not empty profile)
      expect(discovered).toHaveLength(2);
      expect(discovered).not.toContain(`emptyprofile:`);
    });
  });

  describe('parse', () => {
    it('parses a valid session from central database', async () => {
      const virtualPath = `central:${centralDbPath}#session-1`;
      const session = await provider.parse(virtualPath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe('hermes-agent-central:session-1');
      expect(session!.projectName).toBe('Test Session');
      expect(session!.sourceTool).toBe('hermes-agent');
      expect(session!.messageCount).toBe(3); // user, assistant (with tool result), assistant
      expect(session!.userMessageCount).toBe(1);
      expect(session!.assistantMessageCount).toBe(2);
      expect(session!.toolCallCount).toBe(1);

      const firstAssistant = session!.messages[1];
      expect(firstAssistant.type).toBe('assistant');
      expect(firstAssistant.toolCalls).toHaveLength(1);
      expect(firstAssistant.toolResults).toHaveLength(1);
      expect(firstAssistant.toolResults[0].output).toBe('{"result": "found nothing"}');

      expect(session!.usage).not.toBeUndefined();
      expect(session!.usage!.totalInputTokens).toBe(100);
      expect(session!.usage!.totalOutputTokens).toBe(50);
      expect(session!.usage!.estimatedCostUsd).toBe(0.01);
    });

    it('parses a valid session from profile database', async () => {
      const virtualPath = `testuser:${profileDbPath}#session-1`;
      const session = await provider.parse(virtualPath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe('hermes-agent-testuser:session-1');
      expect(session!.projectName).toBe('hermes-profile-testuser');
      expect(session!.sourceTool).toBe('hermes-agent');
      expect(session!.messageCount).toBe(3);
      expect(session!.userMessageCount).toBe(1);
      expect(session!.assistantMessageCount).toBe(2);
      expect(session!.toolCallCount).toBe(1);

      // Message IDs should include the source
      expect(session!.messages[0].id).toBe('hermes-testuser-1');
      expect(session!.messages[0].sessionId).toBe('hermes-agent-testuser:session-1');
    });

    it('supports backward compatibility for database sessions without source prefix', async () => {
      const virtualPath = `${centralDbPath}#session-1`;
      const session = await provider.parse(virtualPath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe('hermes-agent-central:session-1');
    });

    it('returns null for non-existent session in central database', async () => {
      const virtualPath = `central:${centralDbPath}#non-existent`;
      const session = await provider.parse(virtualPath);
      expect(session).toBeNull();
    });

    it('returns null for non-existent session in profile database', async () => {
      const virtualPath = `testuser:${profileDbPath}#non-existent`;
      const session = await provider.parse(virtualPath);
      expect(session).toBeNull();
    });

    it('returns null for malformed virtual path', async () => {
      const session = await provider.parse('invalid-path');
      expect(session).toBeNull();
    });

    it('returns null for non-existent database file', async () => {
      const nonExistentPath = '/tmp/non-existent.db';
      const virtualPath = `central:${nonExistentPath}#session-1`;
      const session = await provider.parse(virtualPath);
      expect(session).toBeNull();
    });
  });
});