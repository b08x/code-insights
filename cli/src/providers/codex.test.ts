import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodexProvider } from './codex.js';

// ---------------------------------------------------------------------------
// Helpers to build JSONL fixture content
// ---------------------------------------------------------------------------

function sessionMeta(id = 'test-session-1', cwd = '/home/user/myproject'): string {
  return JSON.stringify({
    type: 'session_meta',
    payload: { id, timestamp: '2026-01-01T10:00:00Z', cwd, model: 'o4-mini', cli_version: '0.104.0' },
  });
}

function userMessageLine(message: string, id = 'msg-u1'): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-01-01T10:01:00Z',
    payload: { type: 'user_message', id, message },
  });
}

function assistantLine(text: string): string {
  return JSON.stringify({
    type: 'response_item',
    timestamp: '2026-01-01T10:02:00Z',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  });
}

function taskCompleteLine(): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-01-01T10:03:00Z',
    payload: { type: 'task_complete', usage: { input_tokens: 100, output_tokens: 50 } },
  });
}

function buildJSONL(lines: string[]): string {
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexProvider — Format A system context filtering', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('parses a minimal valid session with one user + one assistant message', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('What is 2 + 2?'),
      assistantLine('The answer is 4.'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-test.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.userMessageCount).toBe(1);
    expect(session!.assistantMessageCount).toBe(1);
  });

  it('filters out <permissions> system context messages', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('<permissions>read_only</permissions>'),
      userMessageLine('What is 2 + 2?'),
      assistantLine('The answer is 4.'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-permissions.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    // Only the genuine user message should be counted
    expect(session!.userMessageCount).toBe(1);
  });

  it('filters out <environment_context> system context messages', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('<environment_context>OS: Linux, shell: bash</environment_context>'),
      userMessageLine('Hello, please help me refactor this code.'),
      assistantLine('Sure! What would you like to change?'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-env-context.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.userMessageCount).toBe(1);
  });

  it('filters out # AGENTS.md system context messages', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('# AGENTS.md\n\nThis is the agents configuration file...'),
      userMessageLine('Add a new feature to the codebase.'),
      assistantLine('I will help you add that feature.'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-agents-md.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.userMessageCount).toBe(1);
  });

  it('filters out multiple consecutive system context messages before first real prompt', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('<permissions>read_write</permissions>'),
      userMessageLine('<environment_context>cwd: /home/user/project</environment_context>'),
      userMessageLine('## Shell\nbash 5.1'),
      userMessageLine('Now fix the bug in src/main.ts'),
      assistantLine("I'll fix that bug right away."),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-multi-system.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    // 3 system context messages filtered + 1 real user message
    expect(session!.userMessageCount).toBe(1);
  });

  it('preserves normal user messages that happen to contain XML-like text', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('Can you explain the <permissions> model in OAuth 2.0?'),
      assistantLine('OAuth 2.0 uses scopes to define permissions...'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-xml-in-user-msg.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    // Message asks ABOUT permissions (not a system context injection — doesn't START with the tag)
    expect(session!.userMessageCount).toBe(1);
  });

  it('returns null when session has no real messages after system context filtering', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('<permissions>read_only</permissions>'),
      userMessageLine('<environment_context>cwd: /tmp</environment_context>'),
      // No actual user message or assistant response follows
    ]);

    const filePath = path.join(tempDir, 'rollout-only-system.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    // buildSession returns null when messages.length === 0
    expect(session).toBeNull();
  });

  it('counts messageCount as userMessageCount + assistantMessageCount', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('<environment_context>cwd: /tmp</environment_context>'),
      userMessageLine('First real question'),
      assistantLine('First answer'),
      taskCompleteLine(),
      userMessageLine('Second question'),
      assistantLine('Second answer'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-message-count.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.userMessageCount).toBe(2);
    expect(session!.assistantMessageCount).toBe(2);
    expect(session!.messageCount).toBe(session!.userMessageCount + session!.assistantMessageCount);
  });

  it('includes compactCount, autoCompactCount, and slashCommands with zero/empty defaults', async () => {
    const content = buildJSONL([
      sessionMeta(),
      userMessageLine('Run the tests please'),
      assistantLine('Running tests now...'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-v6-fields.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.compactCount).toBe(0);
    expect(session!.autoCompactCount).toBe(0);
    expect(session!.slashCommands).toEqual([]);
  });

  it('extracts gitBranch, turn_context model, token_count usage, compacted count, and web_search_call', async () => {
    const content = buildJSONL([
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'modern-session-1',
          timestamp: '2026-11-20T10:00:00Z',
          cwd: '/home/user/myproject',
          cli_version: '0.165.0',
          git: { branch: 'feat/codex-update', commit_hash: 'abc1234' },
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-11-20T10:00:01Z',
        payload: { model: 'gpt-5.4', cwd: '/home/user/myproject' },
      }),
      userMessageLine('Search for codex rollout format'),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-20T10:01:30Z',
        payload: {
          type: 'web_search_call',
          id: 'ws_123',
          status: 'completed',
          action: { type: 'search', query: 'codex rollout jsonl' },
        },
      }),
      assistantLine('Here is what I found.'),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-20T10:02:00Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 1200,
              cached_input_tokens: 300,
              output_tokens: 150,
            },
          },
        },
      }),
      JSON.stringify({
        type: 'compacted',
        timestamp: '2026-11-20T10:02:30Z',
        payload: { message: 'Compacted history' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-11-20T10:03:00Z',
        payload: { type: 'task_complete' },
      }),
    ]);

    const filePath = path.join(tempDir, 'rollout-modern.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.gitBranch).toBe('feat/codex-update');
    expect(session!.compactCount).toBe(1);
    expect(session!.usage?.primaryModel).toBe('gpt-5.4');
    expect(session!.usage?.modelsUsed).toEqual(['gpt-5.4']);
    expect(session!.usage?.totalInputTokens).toBe(1200);
    expect(session!.usage?.cacheReadTokens).toBe(300);
    expect(session!.usage?.totalOutputTokens).toBe(150);
    expect(session!.toolCallCount).toBe(1);
    expect(session!.messages[1].toolCalls[0]).toEqual({
      id: 'ws_123',
      name: 'web_search',
      input: { type: 'search', query: 'codex rollout jsonl' },
    });
  });

  it('captures response_item/message(role=user) when event_msg/user_message is absent and deduplicates when both fire', async () => {
    const content = buildJSONL([
      sessionMeta(),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-20T10:01:00Z',
        payload: {
          type: 'message',
          id: 'msg-u1',
          role: 'user',
          content: [{ type: 'input_text', text: 'First prompt without event_msg' }],
        },
      }),
      assistantLine('First reply.'),
      JSON.stringify({
        type: 'response_item',
        timestamp: '2026-11-20T10:02:00Z',
        payload: {
          type: 'message',
          id: 'msg-u2',
          role: 'user',
          content: [{ type: 'input_text', text: 'Second prompt with both' }],
        },
      }),
      userMessageLine('Second prompt with both', 'msg-u2-ev'),
      assistantLine('Second reply.'),
      taskCompleteLine(),
    ]);

    const filePath = path.join(tempDir, 'rollout-user-dedup.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);

    expect(session).not.toBeNull();
    expect(session!.userMessageCount).toBe(2);
    expect(session!.assistantMessageCount).toBe(2);
  });

  it('resolves projectName from parent folder when cwd ends in tmp or unknown, and from turn_context.cwd', async () => {
    const content = buildJSONL([
      sessionMeta('tmp-parent-1', '/home/user/ruby-dev/tmp'),
      userMessageLine('Hello'),
      assistantLine('Hi!'),
      taskCompleteLine(),
    ]);
    const filePath = path.join(tempDir, 'rollout-tmp-parent.jsonl');
    fs.writeFileSync(filePath, content);

    const provider = new CodexProvider();
    const session = await provider.parse(filePath);
    expect(session).not.toBeNull();
    expect(session!.projectName).toBe('ruby-dev');

    const content2 = buildJSONL([
      sessionMeta('tmp-turn-1', '/tmp'),
      JSON.stringify({
        type: 'turn_context',
        timestamp: '2026-11-20T10:00:01Z',
        payload: { model: 'gpt-5.4', cwd: '/home/user/WorkspaceV3/Syncopated/antigravity-cli/plugins/ruby-dev' },
      }),
      userMessageLine('Hello'),
      assistantLine('Hi!'),
      taskCompleteLine(),
    ]);
    const filePath2 = path.join(tempDir, 'rollout-tmp-turn.jsonl');
    fs.writeFileSync(filePath2, content2);

    const session2 = await provider.parse(filePath2);
    expect(session2).not.toBeNull();
    expect(session2!.projectName).toBe('ruby-dev');
  });
});
