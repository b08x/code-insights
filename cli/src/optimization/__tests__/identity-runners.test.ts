/**
 * Identity consistency (found-5/7): for every runner, the identity used to resolve the prompt
 * before the first call equals the identity recorded from that call's result.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{"ok":true}'),
  unlinkSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { ClaudeNativeRunner } from '../../analysis/native-runner.js';
import { CodexNativeRunner } from '../../analysis/codex-runner.js';
import { AntigravityNativeRunner } from '../../analysis/antigravity-runner.js';
import { MistralVibeRunner } from '../../analysis/mistral-vibe-runner.js';
import { OpenCodeRunner } from '../../analysis/opencode-runner.js';
import { ProviderRunner } from '../../analysis/provider-runner.js';
import { FallbackNativeRunner } from '../../analysis/native-fallback.js';
import type { AnalysisRunner, RunnerConfig } from '../../analysis/runner-types.js';
import type { LLMClient } from '../../llm/types.js';
import { identityForCall, identityFromRunner, identityFromRunResult, identityKey } from '../identity.js';

const exec = vi.mocked(execFileSync);
const params = { systemPrompt: 'sys', userPrompt: 'user' };

const stdout: Record<string, string | undefined> = {
  claude: JSON.stringify([{ type: 'result', result: '{"ok":true}', is_error: false }]),
  codex: undefined, // codex writes its answer to a file (fs mocked)
  antigravity: '{"ok":true}',
  vibe: JSON.stringify([{ role: 'assistant', content: '{"ok":true}' }]),
  opencode: JSON.stringify({ type: 'text', part: { messageID: 'm1', type: 'text', text: '{"ok":true}' } }),
};

const factories: Record<string, (c: RunnerConfig) => AnalysisRunner> = {
  claude: c => new ClaudeNativeRunner(c),
  codex: c => new CodexNativeRunner(c),
  antigravity: c => new AntigravityNativeRunner(c),
  vibe: c => new MistralVibeRunner(c),
  opencode: c => new OpenCodeRunner(c),
};

function fakeClient(provider: string, model: string): LLMClient {
  return {
    provider,
    model,
    chat: vi.fn(async () => ({ content: '{"ok":true}', usage: { inputTokens: 1, outputTokens: 1 } })),
    estimateTokens: (t: string) => t.length,
  } as unknown as LLMClient;
}

async function expectConsistent(runner: AnalysisRunner) {
  const before = identityFromRunner(runner);
  const result = await runner.runAnalysis(params);
  const after = identityFromRunResult(result, { providerBacked: runner.provider !== undefined, variant: runner.variant ?? null });
  expect(after).toEqual(before);
  expect(identityKey(identityForCall(runner, result))).toBe(identityKey(before));
  return before;
}

beforeEach(() => vi.clearAllMocks());

describe('identityFromRunner(runner) equals identityFromRunResult(result)', () => {
  for (const name of Object.keys(factories)) {
    it(`${name}: unconfigured (legacy model label)`, async () => {
      exec.mockReturnValue(stdout[name] as never);
      const id = await expectConsistent(factories[name]({}));
      expect(id.model).toBeTruthy();
      expect(id.variant).toBeNull();
    });

    it(`${name}: configured model + variant`, async () => {
      exec.mockReturnValue(stdout[name] as never);
      const id = await expectConsistent(factories[name]({ model: 'm-1', variant: 'high' }));
      expect(id.model).toBe('m-1');
    });
  }

  it('claude/codex/opencode carry the variant; antigravity/vibe (no variant flag) do not', () => {
    expect(identityFromRunner(new ClaudeNativeRunner({ variant: 'high' })).variant).toBe('high');
    expect(identityFromRunner(new CodexNativeRunner({ variant: 'high' })).variant).toBe('high');
    expect(identityFromRunner(new OpenCodeRunner({ variant: 'high' })).variant).toBe('high');
    expect(identityFromRunner(new AntigravityNativeRunner({ variant: 'high' })).variant).toBeNull();
    expect(identityFromRunner(new MistralVibeRunner({ variant: 'high' })).variant).toBeNull();
  });

  it('provider runner', async () => {
    const id = await expectConsistent(ProviderRunner.fromClient(fakeClient('openai', 'gpt-4.1')));
    expect(id).toEqual({ runner: 'provider:openai', model: 'gpt-4.1', variant: null });
  });

  it('FallbackNativeRunner when the primary answers', async () => {
    exec.mockReturnValue(stdout.claude as never);
    const primary = new ClaudeNativeRunner({ model: 'claude-sonnet-4-6', variant: 'high' });
    const id = await expectConsistent(new FallbackNativeRunner(primary, () => {}));
    expect(id).toEqual({ runner: 'claude-code-native', model: 'claude-sonnet-4-6', variant: 'high' });
  });

  it('FallbackNativeRunner records the fallback runner, without the primary variant, when it answers', async () => {
    // claude call fails with a usage limit; agy --version and the agy call succeed.
    exec
      .mockImplementationOnce(() => { throw Object.assign(new Error('usage limit reached'), { stdout: '', stderr: '' }); })
      .mockReturnValue('{"ok":true}' as never);
    const runner = new FallbackNativeRunner(new ClaudeNativeRunner({ model: 'claude-sonnet-4-6', variant: 'high' }), () => {});
    const result = await runner.runAnalysis(params);
    expect(result.provider).not.toBe('claude-code-native');
    const recorded = identityForCall(runner, result);
    expect(recorded.runner).toBe(result.provider);
    expect(recorded.variant).toBeNull();
  });
});
