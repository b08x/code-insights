import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HermesAgentProvider } from '../hermes-agent.js';

// Mock better-sqlite3
vi.mock('better-sqlite3', () => {
  class MockDatabase {
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
  let dbPath: string;
  const provider = new HermesAgentProvider();

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
    dbPath = path.join(tempHomeDir, 'state.db');
    fs.writeFileSync(dbPath, ''); // Create dummy file

    vi.mocked(getHermesHomeDir).mockReturnValue(tempHomeDir);
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('returns "hermes-agent" as provider name', () => {
    expect(provider.getProviderName()).toBe('hermes-agent');
  });

  describe('discover', () => {
    it('discovers session virtual paths from the database', async () => {
      const discovered = await provider.discover();
      expect(discovered).toContain(`${dbPath}#session-1`);
    });

    it('filters sessions by title', async () => {
      const discovered = await provider.discover({ projectFilter: 'Test' });
      expect(discovered).toContain(`${dbPath}#session-1`);

      const filtered = await provider.discover({ projectFilter: 'None' });
      expect(filtered).not.toContain(`${dbPath}#session-1`);
    });
  });

  describe('parse', () => {
    it('parses a valid Hermes Agent session from the database', async () => {
      const virtualPath = `${dbPath}#session-1`;
      const session = await provider.parse(virtualPath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe('hermes-agent:session-1');
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

    it('returns null for non-existent session', async () => {
      const virtualPath = `${dbPath}#non-existent`;
      const session = await provider.parse(virtualPath);
      expect(session).toBeNull();
    });
  });
});
