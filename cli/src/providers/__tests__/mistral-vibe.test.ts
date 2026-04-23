import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MistralVibeProvider } from '../mistral-vibe.js';

describe('MistralVibeProvider', () => {
  let tempBaseDir: string;
  let tempLogsDir: string;
  let provider: MistralVibeProvider;

  beforeEach(() => {
    tempBaseDir = path.join(os.tmpdir(), 'vibe-test-logs-' + Math.random().toString(36).substring(7));
    tempLogsDir = path.join(tempBaseDir, 'session');
    fs.mkdirSync(tempLogsDir, { recursive: true });
    provider = new MistralVibeProvider(tempLogsDir);
  });

  afterEach(() => {
    fs.rmSync(tempBaseDir, { recursive: true, force: true });
  });

  it('returns "mistral-vibe" as provider name', () => {
    expect(provider.getProviderName()).toBe('mistral-vibe');
  });

  it('discovers session directories', async () => {
    const sessionDir = path.join(tempLogsDir, 'session_20260415_123456_abc');
    fs.mkdirSync(sessionDir);
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify({ session_id: 'abc' }));
    fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), '');

    const discovered = await provider.discover();
    expect(discovered.map(p => path.resolve(p))).toContain(path.resolve(sessionDir));
  });

  it('parses a valid mistral-vibe session', async () => {
    const sessionDir = path.join(tempLogsDir, 'session_20260415_123456_abc');
    fs.mkdirSync(sessionDir);
    
    const meta = {
      session_id: 'abc-123',
      start_time: '2026-04-15T10:00:00Z',
      end_time: '2026-04-15T10:05:00Z',
      environment: {
        working_directory: '/home/user/project'
      },
      stats: {
        session_prompt_tokens: 1000,
        session_completion_tokens: 500,
        session_cost: 0.01
      },
      title: 'Test Session'
    };
    
    const messages = [
      JSON.stringify({ role: 'user', content: 'hello', message_id: 'm1' }),
      JSON.stringify({ role: 'assistant', content: 'hi there', message_id: 'm2' }),
      JSON.stringify({ role: 'user', content: 'run tool', message_id: 'm3' }),
      JSON.stringify({ role: 'assistant', content: '[{"type": "function", "function": {"name": "ls", "parameters": {"path": "."}}}]', message_id: 'm4' }),
      JSON.stringify({ role: 'tool', content: 'file1.txt', tool_call_id: 'tc-0', name: 'ls' }),
      JSON.stringify({ role: 'assistant', content: 'I see file1.txt', message_id: 'm5' })
    ].join('\n');

    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), messages);

    const session = await provider.parse(sessionDir);

    expect(session).not.toBeNull();
    expect(session!.id).toBe('abc-123');
    expect(session!.projectName).toBe('project');
    expect(session!.userMessageCount).toBe(3); // 2 real + 1 synthetic for tool results
    expect(session!.assistantMessageCount).toBe(3);
    expect(session!.toolCallCount).toBe(1);
    expect(session!.messages[3].toolCalls).toHaveLength(1);
    expect(session!.messages[3].toolCalls[0].name).toBe('ls');
    
    // Check tool result attachment
    const toolResultMsg = session!.messages[4];
    expect(toolResultMsg.type).toBe('user');
    expect(toolResultMsg.toolResults).toHaveLength(1);
    expect(toolResultMsg.toolResults[0].output).toBe('file1.txt');
  });

  it('handles mixed assistant content', async () => {
    const sessionDir = path.join(tempLogsDir, 'session_abc');
    fs.mkdirSync(sessionDir);
    
    const meta = {
      session_id: 'abc',
      start_time: '2026-04-15T10:00:00Z',
      end_time: '2026-04-15T10:05:00Z'
    };
    
    const messages = [
      JSON.stringify({ 
        role: 'assistant', 
        content: '[{"type": "function", "function": {"name": "ask", "parameters": {}}}]Wait for my answer.',
        message_id: 'm1' 
      })
    ].join('\n');

    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), messages);

    const session = await provider.parse(sessionDir);
    expect(session!.messages[0].toolCalls).toHaveLength(1);
    expect(session!.messages[0].content).toBe('Wait for my answer.');
  });
});
