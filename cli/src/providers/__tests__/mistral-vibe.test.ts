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

  // -------------------------------------------------------------
  // Legacy Session Discovery and Parsing (Fact 2 backward compat)
  // -------------------------------------------------------------

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

  it('discovers sessions recursively including nested subagents', async () => {
    const mainSessionDir = path.join(tempLogsDir, 'session_20260516_140021_d307c163');
    fs.mkdirSync(mainSessionDir, { recursive: true });
    fs.writeFileSync(path.join(mainSessionDir, 'meta.json'), JSON.stringify({
      session_id: 'main-123',
      start_time: '2026-05-16T14:00:21Z',
      end_time: '2026-05-16T14:05:00Z'
    }));
    fs.writeFileSync(path.join(mainSessionDir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'test' }));

    const subAgent1Dir = path.join(mainSessionDir, 'agents', 'hybrid-graphify-research_20260516_140129_38643c70');
    fs.mkdirSync(subAgent1Dir, { recursive: true });
    fs.writeFileSync(path.join(subAgent1Dir, 'meta.json'), JSON.stringify({
      session_id: 'sub1-456',
      start_time: '2026-05-16T14:01:29Z',
      end_time: '2026-05-16T14:03:00Z',
      parent_session_id: 'main-123',
      agent_type: 'hybrid-graphify-research'
    }));
    fs.writeFileSync(path.join(subAgent1Dir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'subagent task' }));

    const subAgent2Dir = path.join(subAgent1Dir, 'agents', 'hybrid-graphify-query_20260516_140208_1d913b6e');
    fs.mkdirSync(subAgent2Dir, { recursive: true });
    fs.writeFileSync(path.join(subAgent2Dir, 'meta.json'), JSON.stringify({
      session_id: 'sub2-789',
      start_time: '2026-05-16T14:02:08Z',
      end_time: '2026-05-16T14:02:30Z',
      parent_session_id: 'sub1-456',
      agent_type: 'hybrid-graphify-query'
    }));
    fs.writeFileSync(path.join(subAgent2Dir, 'messages.jsonl'), JSON.stringify({ role: 'user', content: 'nested query' }));

    const discovered = await provider.discover();

    expect(discovered).toHaveLength(3);
    expect(discovered.map(p => path.resolve(p))).toEqual(
      expect.arrayContaining([
        path.resolve(mainSessionDir),
        path.resolve(subAgent1Dir),
        path.resolve(subAgent2Dir)
      ])
    );
  });

  it('parses session with parent_session_id and agent_type', async () => {
    const sessionDir = path.join(tempLogsDir, 'agents', 'research_agent_123');
    fs.mkdirSync(sessionDir, { recursive: true });

    const meta = {
      session_id: 'agent-abc',
      start_time: '2026-05-16T10:00:00Z',
      end_time: '2026-05-16T10:05:00Z',
      parent_session_id: 'main-session-xyz',
      agent_type: 'research-agent',
      environment: {
        working_directory: '/home/user/project'
      }
    };

    const messages = [
      JSON.stringify({ role: 'user', content: 'search for docs', message_id: 'm1' }),
      JSON.stringify({ role: 'assistant', content: 'Found 3 results', message_id: 'm2', reasoning: 'I analyzed the query...' })
    ].join('\n');

    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(meta));
    fs.writeFileSync(path.join(sessionDir, 'messages.jsonl'), messages);

    const session = await provider.parse(sessionDir);

    expect(session).not.toBeNull();
    expect(session!.id).toBe('agent-abc');
    expect(session!.parentSessionId).toBe('main-session-xyz');
    expect(session!.agentType).toBe('research-agent');
    expect(session!.messages[1].thinking).toBe('I analyzed the query...');
  });

  it('discovers sessions with any folder prefix, not just session_', async () => {
    const customPrefixDir = path.join(tempLogsDir, 'custom_prefix_20260516_abc');
    fs.mkdirSync(customPrefixDir);
    fs.writeFileSync(path.join(customPrefixDir, 'meta.json'), JSON.stringify({ session_id: 'custom-123' }));
    fs.writeFileSync(path.join(customPrefixDir, 'messages.jsonl'), '');

    const discovered = await provider.discover();
    expect(discovered.map(p => path.resolve(p))).toContain(path.resolve(customPrefixDir));
  });

  // -------------------------------------------------------------
  // Fact 1 & 7: Modern Unified Store Discovery & Child Sessions
  // -------------------------------------------------------------

  it('discovers modern unified store sessions and child sessions in unified/', async () => {
    const unifiedDir = path.join(tempLogsDir, 'unified');
    const rootSessionDir = path.join(unifiedDir, 'root-uuid-101');
    const childSessionDir = path.join(unifiedDir, 'child-uuid-202');

    // Create root session
    createMockUnifiedSession(rootSessionDir, {
      sessionId: 'root-uuid-101',
      generation: '0000000000000001',
      executionState: 'quiescent',
    });

    // Create child session
    createMockUnifiedSession(childSessionDir, {
      sessionId: 'child-uuid-202',
      generation: '0000000000000002',
      executionState: 'quiescent',
      parentSessionId: 'root-uuid-101',
    });

    const discovered = await provider.discover();
    const resolvedDiscovered = discovered.map(p => path.resolve(p));

    expect(resolvedDiscovered).toContain(path.resolve(rootSessionDir));
    expect(resolvedDiscovered).toContain(path.resolve(childSessionDir));
  });

  // -------------------------------------------------------------
  // Fact 3: Skipping Active Sessions (Lockfiles and Execution State)
  // -------------------------------------------------------------

  it('skips active sessions with an active lockfile in active/ directory', async () => {
    const unifiedDir = path.join(tempLogsDir, 'unified');
    const activeDir = path.join(tempLogsDir, 'active');
    fs.mkdirSync(activeDir, { recursive: true });

    const activeSessionDir = path.join(unifiedDir, 'active-session-301');
    const quiescentSessionDir = path.join(unifiedDir, 'quiescent-session-302');

    createMockUnifiedSession(activeSessionDir, {
      sessionId: 'active-session-301',
      generation: '0000000000000001',
      executionState: 'quiescent',
    });
    createMockUnifiedSession(quiescentSessionDir, {
      sessionId: 'quiescent-session-302',
      generation: '0000000000000001',
      executionState: 'quiescent',
    });

    // Create active lock file for active-session-301
    fs.writeFileSync(path.join(activeDir, 'active-session-301.lock'), '');

    const discovered = await provider.discover();
    const resolvedDiscovered = discovered.map(p => path.resolve(p));

    expect(resolvedDiscovered).not.toContain(path.resolve(activeSessionDir));
    expect(resolvedDiscovered).toContain(path.resolve(quiescentSessionDir));
  });

  it('skips active sessions whose manifest execution_state is not quiescent', async () => {
    const unifiedDir = path.join(tempLogsDir, 'unified');
    const runningSessionDir = path.join(unifiedDir, 'running-session-303');
    const quiescentSessionDir = path.join(unifiedDir, 'quiescent-session-304');

    createMockUnifiedSession(runningSessionDir, {
      sessionId: 'running-session-303',
      generation: '0000000000000001',
      executionState: 'running', // Not quiescent!
    });
    createMockUnifiedSession(quiescentSessionDir, {
      sessionId: 'quiescent-session-304',
      generation: '0000000000000001',
      executionState: 'quiescent',
    });

    const discovered = await provider.discover();
    const resolvedDiscovered = discovered.map(p => path.resolve(p));

    expect(resolvedDiscovered).not.toContain(path.resolve(runningSessionDir));
    expect(resolvedDiscovered).toContain(path.resolve(quiescentSessionDir));
  });

  // -------------------------------------------------------------
  // Fact 4: Session Metadata & Token Usage Extraction
  // -------------------------------------------------------------

  it('extracts session metadata, title, and token usage from projection-state.json and meta.json', async () => {
    const sessionDir = path.join(tempLogsDir, 'unified', 'metadata-session-401');
    const chunkHash = 'chunk-meta-001';

    createMockUnifiedSession(sessionDir, {
      sessionId: 'metadata-session-401',
      generation: '0000000000000001',
      executionState: 'quiescent',
      title: 'Unified Store Refactoring',
      workingDirectory: '/home/user/workspace/code-insights',
      gitBranch: 'feat/vibe-3.0',
      startTime: '2026-10-15T12:00:00.000Z',
      endTime: '2026-10-15T12:15:00.000Z',
      tokenUsage: {
        inputTokens: 3200,
        outputTokens: 780,
        cachedInputTokens: 1400,
        totalTokens: 3980,
      },
      cost: 0.042,
      activeModel: 'mistral-large-latest',
      chunks: [
        {
          hash: chunkHash,
          items: [
            { type: 'message', role: 'user', content: 'Implement Vibe 3.0 support' },
            { type: 'message', role: 'assistant', content: 'Starting implementation now.' },
          ],
        },
      ],
    });

    const session = await provider.parse(sessionDir);

    expect(session).not.toBeNull();
    expect(session!.id).toBe('metadata-session-401');
    expect(session!.projectName).toBe('code-insights');
    expect(session!.projectPath).toBe('/home/user/workspace/code-insights');
    expect(session!.gitBranch).toBe('feat/vibe-3.0');
    expect(session!.generatedTitle).toBe('Unified Store Refactoring');
    expect(session!.startedAt.toISOString()).toBe('2026-10-15T12:00:00.000Z');
    expect(session!.endedAt.toISOString()).toBe('2026-10-15T12:15:00.000Z');
    expect(session!.usage).toEqual({
      totalInputTokens: 3200,
      totalOutputTokens: 780,
      cacheCreationTokens: 0,
      cacheReadTokens: 1400,
      estimatedCostUsd: 0.042,
      modelsUsed: ['mistral-large-latest'],
      primaryModel: 'mistral-large-latest',
      usageSource: 'session',
    });
  });

  // -------------------------------------------------------------
  // Fact 5: Message Reconstruction with Thoughts/Reasoning
  // -------------------------------------------------------------

  it('reconstructs conversation history preserving user prompts and assistant reasoning blocks', async () => {
    const sessionDir = path.join(tempLogsDir, 'unified', 'messages-session-501');
    const chunkHash = 'chunk-reasoning-001';

    createMockUnifiedSession(sessionDir, {
      sessionId: 'messages-session-501',
      generation: '0000000000000001',
      executionState: 'quiescent',
      chunks: [
        {
          hash: chunkHash,
          items: [
            {
              id: 'u-1',
              type: 'message',
              role: 'user',
              content: 'What is Systemic Functional Linguistics?',
              createdAt: 1790848000000,
            },
            {
              id: 'r-1',
              type: 'reasoning',
              text: 'Thinking through Hallidayan functional grammar...',
              createdAt: 1790848001000,
            },
            {
              id: 'a-1',
              type: 'message',
              role: 'assistant',
              content: 'SFL is a model that views language as a social semiotic resource.',
              createdAt: 1790848002000,
            },
          ],
        },
      ],
    });

    const session = await provider.parse(sessionDir);

    expect(session).not.toBeNull();
    expect(session!.messages).toHaveLength(2);
    expect(session!.userMessageCount).toBe(1);
    expect(session!.assistantMessageCount).toBe(1);

    expect(session!.messages[0].type).toBe('user');
    expect(session!.messages[0].content).toBe('What is Systemic Functional Linguistics?');

    expect(session!.messages[1].type).toBe('assistant');
    expect(session!.messages[1].content).toBe('SFL is a model that views language as a social semiotic resource.');
    expect(session!.messages[1].thinking).toBe('Thinking through Hallidayan functional grammar...');
  });

  // -------------------------------------------------------------
  // Fact 6: Tool Calls & Tool Results Mapping
  // -------------------------------------------------------------

  it('maps unified effects into ParsedMessage toolCalls and toolResults with arguments preserved', async () => {
    const sessionDir = path.join(tempLogsDir, 'unified', 'tools-session-601');
    const chunkHash = 'chunk-tools-001';

    createMockUnifiedSession(sessionDir, {
      sessionId: 'tools-session-601',
      generation: '0000000000000001',
      executionState: 'quiescent',
      chunks: [
        {
          hash: chunkHash,
          items: [
            {
              id: 'u-1',
              type: 'message',
              role: 'user',
              content: 'Read package.json file',
              createdAt: 1790848000000,
            },
            {
              id: 'r-1',
              type: 'reasoning',
              text: 'I should call file_system.read_file for package.json.',
              createdAt: 1790848001000,
            },
            {
              id: 'effect-read-1',
              type: 'effect',
              title: 'file_system.read_file',
              detail: {
                kind: 'tool',
                toolName: 'file_system.read_file',
                input: { path: '/home/user/app/package.json' },
              },
              state: {
                status: 'completed',
                output: {
                  structured_content: {
                    content: '{"name": "my-app", "version": "1.0.0"}',
                  },
                },
              },
              createdAt: 1790848002000,
            },
            {
              id: 'a-1',
              type: 'message',
              role: 'assistant',
              content: 'The package name is my-app.',
              createdAt: 1790848003000,
            },
          ],
        },
      ],
    });

    const session = await provider.parse(sessionDir);

    expect(session).not.toBeNull();
    expect(session!.toolCallCount).toBe(1);

    // Assistant message with the tool call
    const assistantWithTool = session!.messages.find(m => m.toolCalls.length > 0);
    expect(assistantWithTool).toBeDefined();
    expect(assistantWithTool!.toolCalls[0].name).toBe('file_system.read_file');
    expect(assistantWithTool!.toolCalls[0].input).toEqual({ path: '/home/user/app/package.json' });

    // User message containing the tool result
    const userWithResult = session!.messages.find(m => m.toolResults.length > 0);
    expect(userWithResult).toBeDefined();
    expect(userWithResult!.type).toBe('user');
    expect(userWithResult!.toolResults[0].toolUseId).toBe('effect-read-1');
    expect(userWithResult!.toolResults[0].output).toBe('{"name": "my-app", "version": "1.0.0"}');
  });

  // -------------------------------------------------------------
  // Fact 7 & 8: Child Session Linkage & Plugin Agent Attribution
  // -------------------------------------------------------------

  it('links child sessions with parentSessionId and namespaced plugin agent attribution (ruby-dev:verifier)', async () => {
    const unifiedDir = path.join(tempLogsDir, 'unified');
    const parentSessionDir = path.join(unifiedDir, 'parent-orchestrator-701');
    const childSessionDir = path.join(unifiedDir, 'child-verifier-702');

    // Create a mock plugin package for ruby-dev
    createMockPluginPackage(tempLogsDir, {
      name: 'ruby-dev',
      agents: ['verifier', 'cleaner', 'implementer', 'specifier', 'hardener'],
    });

    // Parent session with checkpoint notification and subagent record
    createMockUnifiedSession(parentSessionDir, {
      sessionId: 'parent-orchestrator-701',
      generation: '0000000000000001',
      executionState: 'quiescent',
      workingDirectory: '/home/user/ruby-project',
      notifications: [
        { id: 'subagent:child-verifier-702:verifier:1:completed', type: 'received' },
      ],
      subagentsChildren: {
        'verifier-agent': {
          agent_name: 'verifier-agent',
          agent_type: 'verifier',
          child_session_id: 'child-verifier-702',
        },
      },
    });

    // Child session
    createMockUnifiedSession(childSessionDir, {
      sessionId: 'child-verifier-702',
      generation: '0000000000000001',
      executionState: 'quiescent',
      parentSessionId: 'parent-orchestrator-701',
      chunks: [
        {
          hash: 'chunk-child-001',
          items: [
            { type: 'message', role: 'user', content: 'Run SIFT verification checks.' },
            { type: 'message', role: 'assistant', content: 'Verdict: GO (0 critical findings).' },
          ],
        },
      ],
    });

    const session = await provider.parse(childSessionDir);

    expect(session).not.toBeNull();
    expect(session!.id).toBe('child-verifier-702');
    expect(session!.parentSessionId).toBe('parent-orchestrator-701');
    expect(session!.agentType).toBe('ruby-dev:verifier');
    expect(session!.projectName).toBe('ruby-project');
    expect(session!.activePlugins).toContain('ruby-dev');
  });

  // -------------------------------------------------------------
  // Fact 9: Active Plugins Detection
  // -------------------------------------------------------------

  it('detects active plugins from runtime-state core_plugins and data logs', async () => {
    const sessionDir = path.join(tempLogsDir, 'unified', 'plugins-session-901');

    // Create mock plugin data directory
    const pluginDataDir = path.join(tempLogsDir, 'plugins', 'data', 'plugins-session-901', 'git-flow');
    fs.mkdirSync(pluginDataDir, { recursive: true });

    createMockUnifiedSession(sessionDir, {
      sessionId: 'plugins-session-901',
      generation: '0000000000000001',
      executionState: 'quiescent',
      corePlugins: [{ name: 'vibe' }, { name: 'archify' }],
      chunks: [
        {
          hash: 'chunk-p-001',
          items: [
            { type: 'message', role: 'user', content: 'Hello' },
            { type: 'message', role: 'assistant', content: 'World' },
          ],
        },
      ],
    });

    const session = await provider.parse(sessionDir);

    expect(session).not.toBeNull();
    expect(session!.activePlugins).toBeDefined();
    expect(session!.activePlugins).toEqual(expect.arrayContaining(['vibe', 'archify', 'git-flow']));
  });

  // -------------------------------------------------------------
  // Project Filter on Unified Store
  // -------------------------------------------------------------

  it('applies project filter to unified sessions during discover()', async () => {
    const unifiedDir = path.join(tempLogsDir, 'unified');
    const matchedSessionDir = path.join(unifiedDir, 'match-proj-session');
    const unmatchedSessionDir = path.join(unifiedDir, 'unmatch-proj-session');

    createMockUnifiedSession(matchedSessionDir, {
      sessionId: 'match-proj-session',
      generation: '0000000000000001',
      executionState: 'quiescent',
      workingDirectory: '/home/user/code-insights',
    });

    createMockUnifiedSession(unmatchedSessionDir, {
      sessionId: 'unmatch-proj-session',
      generation: '0000000000000001',
      executionState: 'quiescent',
      workingDirectory: '/home/user/another-project',
    });

    const discovered = await provider.discover({ projectFilter: 'code-insights' });
    const resolvedDiscovered = discovered.map(p => path.resolve(p));

    expect(resolvedDiscovered).toContain(path.resolve(matchedSessionDir));
    expect(resolvedDiscovered).not.toContain(path.resolve(unmatchedSessionDir));
  });
});

/**
 * Test Helper: Create mock unified session store on disk
 */
function createMockUnifiedSession(
  sessionDir: string,
  options: {
    sessionId: string;
    generation: string;
    executionState?: string;
    parentSessionId?: string | null;
    title?: string;
    workingDirectory?: string;
    gitBranch?: string;
    startTime?: string;
    endTime?: string;
    tokenUsage?: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      totalTokens: number;
    };
    cost?: number;
    activeModel?: string;
    corePlugins?: Array<{ name: string }>;
    notifications?: Array<{ id: string; type: string }>;
    subagentsChildren?: Record<string, any>;
    chunks?: Array<{ hash: string; items: any[] }>;
  }
) {
  const genDir = path.join(sessionDir, 'generations', options.generation);
  const chunksDir = path.join(sessionDir, 'chunks');
  fs.mkdirSync(genDir, { recursive: true });
  fs.mkdirSync(chunksDir, { recursive: true });

  // 1. CURRENT file
  const currentData = {
    generation: options.generation,
    manifest_sha256: 'mock-manifest-sha256',
    session_id: options.sessionId,
    snapshot_sequence: 1,
    store_format: 'mistral.vibe.unified-session-store/v1',
    store_format_minor: 8,
  };
  fs.writeFileSync(path.join(sessionDir, 'CURRENT'), JSON.stringify(currentData));

  // 2. Chunks
  const chunkHashes: string[] = [];
  if (options.chunks) {
    for (const chunk of options.chunks) {
      chunkHashes.push(chunk.hash);
      fs.writeFileSync(
        path.join(chunksDir, `${chunk.hash}.json`),
        JSON.stringify(chunk.items)
      );
    }
  }

  // 3. manifest.json
  const manifestData = {
    checkpoint: {
      checkpoint_version: 1,
      chunks: chunkHashes,
      path: 'checkpoint.json',
      sha256: 'mock-chk-sha',
    },
    created_at: options.startTime || new Date().toISOString(),
    execution_state: options.executionState || 'quiescent',
    generation: options.generation,
    projection_state: {
      chunks: chunkHashes,
      path: 'projection-state.json',
      sha256: 'mock-proj-sha',
    },
    runtime_state: {
      chunks: [],
      path: 'runtime-state.json',
      sha256: 'mock-run-sha',
    },
    session_id: options.sessionId,
    snapshot_sequence: 1,
  };
  fs.writeFileSync(path.join(genDir, 'manifest.json'), JSON.stringify(manifestData));

  // 4. projection-state.json
  const projectionStateData = {
    projection_state_version: 1,
    session_id: options.sessionId,
    snapshot: {
      format: 'harness.public-session-state/v1',
      session: {
        id: options.sessionId,
        parentSessionId: options.parentSessionId || null,
        rootSessionId: options.parentSessionId || options.sessionId,
        title: options.title || null,
        titleSource: options.title ? 'custom' : 'auto',
        createdAt: options.startTime ? new Date(options.startTime).getTime() : Date.now(),
        updatedAt: options.endTime ? new Date(options.endTime).getTime() : Date.now(),
        tokenUsage: options.tokenUsage || null,
      },
    },
  };
  fs.writeFileSync(path.join(genDir, 'projection-state.json'), JSON.stringify(projectionStateData));

  // 5. runtime-state.json
  const runtimeStateData = {
    session_id: options.sessionId,
    session_metadata: {
      active_model: options.activeModel || 'mistral-vibe',
      cwd: options.workingDirectory,
      parent_session_id: options.parentSessionId || null,
    },
    core_plugins: options.corePlugins || [{ name: 'vibe' }],
    subagents: {
      children: options.subagentsChildren || {},
      policy_ceiling: {
        workdir: options.workingDirectory,
      },
    },
  };
  fs.writeFileSync(path.join(genDir, 'runtime-state.json'), JSON.stringify(runtimeStateData));

  // 6. checkpoint.json
  const checkpointData = {
    checkpoint_version: 1,
    notifications: options.notifications || [],
  };
  fs.writeFileSync(path.join(genDir, 'checkpoint.json'), JSON.stringify(checkpointData));

  // 7. meta.json (at root of session dir)
  if (options.workingDirectory || options.gitBranch || options.cost !== undefined || options.title) {
    const metaData = {
      session_id: options.sessionId,
      start_time: options.startTime || new Date().toISOString(),
      end_time: options.endTime || new Date().toISOString(),
      git_branch: options.gitBranch,
      environment: {
        working_directory: options.workingDirectory,
      },
      stats: {
        session_cost: options.cost || 0,
      },
      title: options.title,
    };
    fs.writeFileSync(path.join(sessionDir, 'meta.json'), JSON.stringify(metaData));
  }
}

/**
 * Test Helper: Create mock plugin package in plugins/packages/
 */
function createMockPluginPackage(
  tempLogsDir: string,
  options: {
    name: string;
    agents: string[];
  }
) {
  const pkgDir = path.join(
    tempLogsDir,
    'plugins',
    'packages',
    '7d',
    '7d-mock-package'
  );
  const agentsDir = path.join(pkgDir, 'ai.mistral.vibe', 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });

  fs.writeFileSync(
    path.join(pkgDir, 'plugin.json'),
    JSON.stringify({ name: options.name, version: '1.0.0' })
  );

  for (const agent of options.agents) {
    fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `# Agent config for ${agent}`);
  }
}
