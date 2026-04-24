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

    it('discovers bundled session directories and skips their parent files', async () => {
      const projectDir = path.join(tempBaseDir, 'storage', 'session', 'project-bundle');
      fs.mkdirSync(projectDir, { recursive: true });
      
      const parentFile = path.join(projectDir, 'bundle-1.json');
      fs.writeFileSync(parentFile, JSON.stringify({ id: 'bundle-1' }));
      
      const bundleDir = path.join(projectDir, 'bundle-1');
      fs.mkdirSync(bundleDir, { recursive: true });
      
      const discovered = await provider.discover({ projectFilter: 'project-bundle' });
      expect(discovered).toContain(bundleDir);
      expect(discovered).not.toContain(parentFile);
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

    it('parses a bundled session with aggregated messages', async () => {
      const sessionId = 'bundle-ses';
      const projectDir = path.join(tempBaseDir, 'storage', 'session', 'project-bundle');
      fs.mkdirSync(projectDir, { recursive: true });
      
      const parentFile = path.join(projectDir, `${sessionId}.json`);
      fs.writeFileSync(parentFile, JSON.stringify({
        id: sessionId,
        title: 'Parent Session',
        time: { created: 1714000000000 }
      }));
      
      const messagesDir = path.join(tempBaseDir, 'storage', 'message', sessionId);
      fs.mkdirSync(messagesDir, { recursive: true });
      fs.writeFileSync(path.join(messagesDir, 'msg-parent.json'), JSON.stringify({
        id: 'msg-parent',
        role: 'user',
        time: { created: 1714000000000 }
      }));

      const bundleDir = path.join(projectDir, sessionId);
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(path.join(bundleDir, 'sub-1.json'), JSON.stringify({
        id: 'sub-1-id',
        title: 'Sub Session',
        time: { created: 1714000001000 }
      }));
      
      const subMessagesDir = path.join(tempBaseDir, 'storage', 'message', 'sub-1-id');
      fs.mkdirSync(subMessagesDir, { recursive: true });
      fs.writeFileSync(path.join(subMessagesDir, 'msg-sub.json'), JSON.stringify({
        id: 'msg-sub',
        role: 'assistant',
        time: { created: 1714000001000 }
      }));

      const session = await provider.parse(bundleDir);
      
      expect(session).not.toBeNull();
      expect(session!.messageCount).toBe(2);
      expect(session!.messages[0].id).toBe('msg-parent');
      expect(session!.messages[1].id).toBe('msg-sub');
      expect(session!.startedAt.getTime()).toBe(1714000000000);
      expect(session!.endedAt.getTime()).toBe(1714000001000);
    });

    it('handles missing timestamps with Date.now() fallback', async () => {
      const filePath = path.join(tempBaseDir, 'storage', 'session', 'project-1', 'ses-1.json');
      // Modify file to have 0 timestamps
      fs.writeFileSync(filePath, JSON.stringify({
        id: 'ses-1',
        time: { created: 0, updated: 0 }
      }));
      
      const session = await provider.parse(filePath);
      if (session) {
        expect(session.startedAt.getTime()).toBeGreaterThan(0);
        expect(session.endedAt.getTime()).toBeGreaterThan(0);
      }
    });
  });
});
