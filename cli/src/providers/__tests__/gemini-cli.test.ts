import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GeminiCliProvider } from '../gemini-cli.js';

// Mock the config utilities
vi.mock('../../utils/config.js', async () => {
  const actual = await vi.importActual('../../utils/config.js') as any;
  return {
    ...actual,
    getGeminiHomeDir: vi.fn(),
    getGeminiTmpDir: vi.fn(),
  };
});

import { getGeminiHomeDir, getGeminiTmpDir } from '../../utils/config.js';

const VALID_GEMINI_SESSION = {
  sessionId: "test-session-uuid",
  projectHash: "test-project-hash",
  startTime: "2026-04-02T03:37:53.413Z",
  lastUpdated: "2026-04-02T03:44:00.253Z",
  messages: [
    {
      id: "m1",
      timestamp: "2026-04-02T03:37:53.413Z",
      type: "user",
      content: [
        { text: "Hello Gemini" }
      ]
    },
    {
      id: "m2",
      timestamp: "2026-04-02T03:38:07.782Z",
      type: "gemini",
      content: "Hello! How can I help you today?",
      thoughts: [
        {
          subject: "Greeting",
          description: "User said hello, I should respond appropriately.",
          timestamp: "2026-04-02T03:38:03.739Z"
        }
      ],
      tokens: {
        input: 100,
        output: 50,
        cached: 10,
        total: 160
      },
      model: "gemini-1.5-pro",
      toolCalls: []
    }
  ]
};

describe('GeminiCliProvider', () => {
  let tempHomeDir: string;
  let tempTmpDir: string;
  const provider = new GeminiCliProvider();

  beforeEach(() => {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-home-'));
    tempTmpDir = path.join(tempHomeDir, 'tmp');
    fs.mkdirSync(tempTmpDir);

    vi.mocked(getGeminiHomeDir).mockReturnValue(tempHomeDir);
    vi.mocked(getGeminiTmpDir).mockReturnValue(tempTmpDir);
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
  });

  it('returns "gemini-cli" as provider name', () => {
    expect(provider.getProviderName()).toBe('gemini-cli');
  });

  describe('discover', () => {
    it('discovers session files in hashed directories', async () => {
      const projectHash = '566bb2a8ae4604bf4ed6f1606f2a1401987f961737a1e39455da5183d58aa75b';
      const projectDir = path.join(tempTmpDir, projectHash);
      const chatsDir = path.join(projectDir, 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      
      const sessionFile = path.join(chatsDir, 'session-1.json');
      fs.writeFileSync(sessionFile, JSON.stringify(VALID_GEMINI_SESSION));

      const discovered = await provider.discover();
      expect(discovered).toContain(sessionFile);
    });

    it('discovers session files in named directories', async () => {
      const projectName = 'my-cool-project';
      const projectDir = path.join(tempTmpDir, projectName);
      const chatsDir = path.join(projectDir, 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      
      const sessionFile = path.join(chatsDir, 'session-1.json');
      fs.writeFileSync(sessionFile, JSON.stringify(VALID_GEMINI_SESSION));

      const discovered = await provider.discover();
      expect(discovered).toContain(sessionFile);
    });

    it('filters discovered files by project name', async () => {
      const project1Dir = path.join(tempTmpDir, 'project-alpha', 'chats');
      const project2Dir = path.join(tempTmpDir, 'project-beta', 'chats');
      fs.mkdirSync(project1Dir, { recursive: true });
      fs.mkdirSync(project2Dir, { recursive: true });
      
      const file1 = path.join(project1Dir, 'session.json');
      const file2 = path.join(project2Dir, 'session.json');
      fs.writeFileSync(file1, JSON.stringify(VALID_GEMINI_SESSION));
      fs.writeFileSync(file2, JSON.stringify(VALID_GEMINI_SESSION));

      const discovered = await provider.discover({ projectFilter: 'alpha' });
      expect(discovered).toContain(file1);
      expect(discovered).not.toContain(file2);
    });
  });

  describe('parse', () => {
    it('parses a valid Gemini session file', async () => {
      const projectDir = path.join(tempTmpDir, 'test-project');
      const chatsDir = path.join(projectDir, 'chats');
      fs.mkdirSync(chatsDir, { recursive: true });
      
      // Create .project_root
      const projectRoot = '/Users/test/projects/my-project';
      fs.writeFileSync(path.join(projectDir, '.project_root'), projectRoot);

      const filePath = path.join(chatsDir, 'session.json');
      fs.writeFileSync(filePath, JSON.stringify(VALID_GEMINI_SESSION));

      const session = await provider.parse(filePath);

      expect(session).not.toBeNull();
      expect(session!.id).toBe(VALID_GEMINI_SESSION.sessionId);
      expect(session!.projectPath).toBe(projectRoot);
      expect(session!.projectName).toBe('my-project');
      expect(session!.sourceTool).toBe('gemini-cli');
      expect(session!.messageCount).toBe(2);
      expect(session!.userMessageCount).toBe(1);
      expect(session!.assistantMessageCount).toBe(1);
      
      const assistantMsg = session!.messages.find(m => m.type === 'assistant');
      expect(assistantMsg!.content).toBe(VALID_GEMINI_SESSION.messages[1].content);
      expect(assistantMsg!.thinking).toContain('Greeting');
      expect(assistantMsg!.usage).not.toBeNull();
      expect(assistantMsg!.usage!.inputTokens).toBe(100);
      expect(assistantMsg!.usage!.outputTokens).toBe(50);
    });

    it('returns null for invalid session files', async () => {
      const filePath = path.join(tempTmpDir, 'invalid.json');
      fs.writeFileSync(filePath, JSON.stringify({ foo: 'bar' }));

      const session = await provider.parse(filePath);
      expect(session).toBeNull();
    });
  });
});
