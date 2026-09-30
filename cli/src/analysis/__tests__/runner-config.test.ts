import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(() => '{"ok":true}'),
  unlinkSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { ClaudeNativeRunner } from '../native-runner.js';
import { CodexNativeRunner } from '../codex-runner.js';
import { AntigravityNativeRunner } from '../antigravity-runner.js';
import { MistralVibeRunner } from '../mistral-vibe-runner.js';

const exec = vi.mocked(execFileSync);
const params = { systemPrompt: 'sys', userPrompt: 'user' };

function call() {
  const [cmd, args, opts] = exec.mock.calls[0] as unknown as [string, string[], Record<string, any>];
  return { cmd, args, opts };
}
function after(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

beforeEach(() => vi.clearAllMocks());

describe('ClaudeNativeRunner model/variant', () => {
  const envelope = JSON.stringify([{ type: 'result', result: '{"ok":true}', is_error: false }]);

  it('passes --model and --effort and reports the model', async () => {
    exec.mockReturnValue(envelope);
    const r = await new ClaudeNativeRunner({ model: 'claude-sonnet-4-6', variant: 'high' }).runAnalysis(params);
    const { args } = call();
    expect(after(args, '--model')).toBe('claude-sonnet-4-6');
    expect(after(args, '--effort')).toBe('high');
    expect(r.model).toBe('claude-sonnet-4-6');
    expect(r.provider).toBe('claude-code-native');
  });

  it('omits the flags and keeps the legacy model label when unconfigured', async () => {
    exec.mockReturnValue(envelope);
    const r = await new ClaudeNativeRunner().runAnalysis(params);
    const { args } = call();
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
    expect(r.model).toBe('claude-native');
  });
});

describe('CodexNativeRunner model/variant', () => {
  it('passes -m and model_reasoning_effort and reports the model', async () => {
    const r = await new CodexNativeRunner({ model: 'gpt-5.4', variant: 'high' }).runAnalysis(params);
    const { args } = call();
    expect(after(args, '-m')).toBe('gpt-5.4');
    expect(after(args, '-c')).toBe('model_reasoning_effort="high"');
    expect(r.model).toBe('gpt-5.4');
  });

  it('no longer hardcodes a model', async () => {
    const r = await new CodexNativeRunner().runAnalysis(params);
    const { args } = call();
    expect(args).not.toContain('-m');
    expect(args).not.toContain('--model');
    expect(args).not.toContain('gpt-5.5');
    expect(args).not.toContain('-c');
    expect(r.model).toBe('codex-native');
  });
});

describe('AntigravityNativeRunner model', () => {
  it('passes --model and reports the model', async () => {
    exec.mockReturnValue('{"ok":true}');
    const r = await new AntigravityNativeRunner({ model: 'gemini-3-pro' }).runAnalysis(params);
    const { args } = call();
    expect(after(args, '--model')).toBe('gemini-3-pro');
    expect(r.model).toBe('gemini-3-pro');
  });

  it('omits --model when unconfigured', async () => {
    exec.mockReturnValue('{"ok":true}');
    const r = await new AntigravityNativeRunner().runAnalysis(params);
    expect(call().args).not.toContain('--model');
    expect(r.model).toBe('antigravity-native');
  });
});

describe('MistralVibeRunner model', () => {
  const out = JSON.stringify([{ role: 'assistant', content: '{"ok":true}' }]);

  it('sets VIBE_ACTIVE_MODEL in the child env and reports the model', async () => {
    exec.mockReturnValue(out);
    const r = await new MistralVibeRunner({ model: 'devstral-2' }).runAnalysis(params);
    const { opts } = call();
    expect(opts.env?.VIBE_ACTIVE_MODEL).toBe('devstral-2');
    expect(r.model).toBe('devstral-2');
  });

  it('does not override the environment when unconfigured', async () => {
    exec.mockReturnValue(out);
    const r = await new MistralVibeRunner().runAnalysis(params);
    expect(call().opts.env).toBeUndefined();
    expect(r.model).toBe('mistral-vibe');
  });
});

describe('blank model and unsupported variant', () => {
  it('treats an empty model as unset (no flag, legacy label)', async () => {
    exec.mockReturnValue(JSON.stringify([{ type: 'result', result: '{"ok":true}', is_error: false }]));
    const r = await new ClaudeNativeRunner({ model: '', variant: '' }).runAnalysis(params);
    expect(call().args).not.toContain('--model');
    expect(call().args).not.toContain('--effort');
    expect(r.model).toBe('claude-native');
  });

  it('antigravity and vibe pass no variant flag and expose no variant', async () => {
    exec.mockReturnValue('{"ok":true}');
    const agy = new AntigravityNativeRunner({ variant: 'high' });
    await agy.runAnalysis(params);
    expect(call().args.join(' ')).not.toContain('high');
    expect(agy.variant).toBeUndefined();

    vi.clearAllMocks();
    exec.mockReturnValue(JSON.stringify([{ role: 'assistant', content: '{"ok":true}' }]));
    const vibe = new MistralVibeRunner({ variant: 'high' });
    await vibe.runAnalysis(params);
    expect(call().args.join(' ')).not.toContain('high');
    expect(call().opts.env).toBeUndefined();
    expect(vibe.variant).toBeUndefined();
  });
});
