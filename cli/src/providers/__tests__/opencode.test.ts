import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OpenCodeProvider } from '../opencode.js';

// Mock the config utilities
vi.mock('../../utils/config.js', async () => {
  const actual = await vi.importActual('../../utils/config.js') as any;
  return {
    ...actual,
    getOpenCodeDir: vi.fn(),
  };
});

import { getOpenCodeDir } from '../../utils/config.js';

describe('OpenCodeProvider', () => {
  let tempBaseDir: string;
  const provider = new OpenCodeProvider();

  beforeEach(() => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-test-'));
    vi.mocked(getOpenCodeDir).mockReturnValue(tempBaseDir);

    // Create directory structure
    fs.mkdirSync(path.join(tempBaseDir, 'storage', 'session', 'project-1'), { recursive: true });
    fs.mkdirSync(path.join(tempBaseDir, 'storage', 'message', 'ses-1'), { recursive: true });
    fs.mkdirSync(path.join(tempBaseDir, 'storage', 'part', 'msg-1'), { recursive: true });
    fs.mkdirSync(path.join(tempBaseDir, 'storage', 'part', 'msg-2'), { recursive: true });

    // Mock session
    fs.writeFileSync(
      path.join(tempBaseDir, 'storage', 'session', 'project-1', 'ses-1.json'),
      JSON.stringify({
        id: 'ses-1',
        slug: 'witty-cactus',
        directory: '/home/user/project',
        title: 'My OpenCode Session',
        time: { created: 1770834323879, updated: 1770834589098 }
      })
    );

    // Mock messages
    fs.writeFileSync(
      path.join(tempBaseDir, 'storage', 'message', 'ses-1', 'msg-1.json'),
      JSON.stringify({
        id: 'msg-1',
        sessionID: 'ses-1',
        role: 'user',
        time: { created: 1770834323879 }
      })
    );
    fs.writeFileSync(
      path.join(tempBaseDir, 'storage', 'message', 'ses-1', 'msg-2.json'),
      JSON.stringify({
        id: 'msg-2',
        sessionID: 'ses-1',
        role: 'assistant',
        time: { created: 1770834324886 },
        modelID: 'gpt-4',
        cost: 0.05,
        tokens: { input: 100, output: 50 }
      })
    );

    // Mock parts
    fs.writeFileSync(
      path.join(tempBaseDir, 'storage', 'part', 'msg-1', 'prt-1.json'),
      JSON.stringify({
        id: 'prt-1',
        messageID: 'msg-1',
        type: 'text',
        text: 'Hello OpenCode'
      })
    );
    fs.writeFileSync(
      path.join(tempBaseDir, 'storage', 'part', 'msg-2', 'prt-2.json'),
      JSON.stringify({
        id: 'prt-2',
        messageID: 'msg-2',
        type: 'text',
        text: 'Hello User'
      })
    );
    fs.writeFileSync(
      path.join(tempBaseDir, 'storage', 'part', 'msg-2', 'prt-3.json'),
      JSON.stringify({
        id: 'prt-3',
        messageID: 'msg-2',
        type: 'tool',
        tool: 'read_file',
        callID: 'call-1',
        state: { input: { path: 'a.txt' }, output: 'file content' }
      })
    );
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it('returns "opencode" as provider name', () => {
    expect(provider.getProviderName()).toBe('opencode');
  });

  describe('discover', () => {
    it('discovers session files in project subdirectories', async () => {
      const discovered = await provider.discover();
      expect(discovered).toContain(path.join(tempBaseDir, 'storage', 'session', 'project-1', 'ses-1.json'));
    });

    it('filters by project slug (directory name)', async () => {
      const discovered = await provider.discover({ projectFilter: 'project-1' });
      expect(discovered).toHaveLength(1);

      const filtered = await provider.discover({ projectFilter: 'none' });
      expect(filtered).toHaveLength(0);
    });
  });

  describe('parse', () => {
    it('parses a valid OpenCode session from the filesystem', async () => {
      const filePath = path.join(tempBaseDir, 'storage', 'session', 'project-1', 'ses-1.json');
      const session = await provider.parse(filePath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe('ses-1');
      expect(session!.projectName).toBe('My OpenCode Session');
      expect(session!.sourceTool).toBe('opencode');
      expect(session!.messageCount).toBe(2);
      expect(session!.userMessageCount).toBe(1);
      expect(session!.assistantMessageCount).toBe(1);
      expect(session!.toolCallCount).toBe(1);
      
      const userMsg = session!.messages.find(m => m.type === 'user');
      expect(userMsg!.content).toBe('Hello OpenCode');

      const assistantMsg = session!.messages.find(m => m.type === 'assistant');
      expect(assistantMsg!.content).toBe('Hello User');
      expect(assistantMsg!.toolCalls).toHaveLength(1);
      expect(assistantMsg!.toolResults).toHaveLength(1);
      expect(assistantMsg!.toolResults[0].output).toBe('file content');

      expect(session!.usage).not.toBeUndefined();
      expect(session!.usage!.totalInputTokens).toBe(100);
      expect(session!.usage!.totalOutputTokens).toBe(50);
      expect(session!.usage!.estimatedCostUsd).toBe(0.05);
    });
  });
});
