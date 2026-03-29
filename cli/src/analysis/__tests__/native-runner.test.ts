import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock child_process and fs before importing the module under test.
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { execFileSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { ClaudeNativeRunner } from '../native-runner.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockUnlinkSync = vi.mocked(unlinkSync);

describe('ClaudeNativeRunner.validate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not throw when claude is in PATH', () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from('claude 1.0.0'));
    expect(() => ClaudeNativeRunner.validate()).not.toThrow();
    expect(mockExecFileSync).toHaveBeenCalledWith('claude', ['--version'], { stdio: 'pipe' });
  });

  it('throws a helpful message when claude is not found', () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('ENOENT'); });
    expect(() => ClaudeNativeRunner.validate()).toThrow(/claude CLI not found in PATH/);
  });
});

describe('ClaudeNativeRunner.runAnalysis()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls execFileSync with correct args (no schema)', async () => {
    mockExecFileSync.mockReturnValueOnce('{"summary": {"title": "test", "content": "c", "bullets": []}}' as unknown as Buffer);
    const runner = new ClaudeNativeRunner();

    const result = await runner.runAnalysis({
      systemPrompt: 'You are an analyst.',
      userPrompt: 'Analyze this session.',
    });

    expect(mockExecFileSync).toHaveBeenCalledWith(
      'claude',
      expect.arrayContaining(['-p', '--output-format', 'json', '--append-system-prompt-file', expect.stringContaining('ci-prompt-'), '--bare']),
      expect.objectContaining({
        input: 'Analyze this session.',
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      })
    );

    // --json-schema flag must NOT appear when jsonSchema is not provided
    const callArgs = mockExecFileSync.mock.calls[0][1] as string[];
    expect(callArgs).not.toContain('--json-schema');
  });

  it('includes --json-schema arg when jsonSchema is provided', async () => {
    mockExecFileSync.mockReturnValueOnce('{"summary": {"title": "t", "content": "c", "bullets": []}}' as unknown as Buffer);
    const runner = new ClaudeNativeRunner();

    await runner.runAnalysis({
      systemPrompt: 'system',
      userPrompt: 'user',
      jsonSchema: { type: 'object', properties: {} },
    });

    const callArgs = mockExecFileSync.mock.calls[0][1] as string[];
    expect(callArgs).toContain('--json-schema');

    // Schema file path should be in args
    const schemaIndex = callArgs.indexOf('--json-schema');
    expect(callArgs[schemaIndex + 1]).toContain('ci-schema-');
  });

  it('returns correct result shape with zero tokens', async () => {
    const rawJson = '{"summary": {"title": "T", "content": "C", "bullets": []}}';
    mockExecFileSync.mockReturnValueOnce(rawJson as unknown as Buffer);
    const runner = new ClaudeNativeRunner();

    const result = await runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' });

    expect(result.rawJson).toBe(rawJson);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    expect(result.model).toBe('claude-native');
    expect(result.provider).toBe('claude-code-native');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes system prompt to a temp file', async () => {
    mockExecFileSync.mockReturnValueOnce('' as unknown as Buffer);
    const runner = new ClaudeNativeRunner();

    await runner.runAnalysis({ systemPrompt: 'SYSTEM_CONTENT', userPrompt: 'u' }).catch(() => {});

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining('ci-prompt-'),
      'SYSTEM_CONTENT',
      'utf-8'
    );
  });

  it('cleans up temp files when execFileSync succeeds', async () => {
    mockExecFileSync.mockReturnValueOnce('{}' as unknown as Buffer);
    const runner = new ClaudeNativeRunner();

    await runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' });

    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('ci-prompt-'));
  });

  it('cleans up temp files even when execFileSync throws', async () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('timeout'); });
    const runner = new ClaudeNativeRunner();

    await expect(runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow('timeout');

    expect(mockUnlinkSync).toHaveBeenCalledWith(expect.stringContaining('ci-prompt-'));
  });

  it('cleans up both temp files when schema is provided and execFileSync throws', async () => {
    mockExecFileSync.mockImplementationOnce(() => { throw new Error('fail'); });
    const runner = new ClaudeNativeRunner();

    await expect(
      runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u', jsonSchema: { type: 'object' } })
    ).rejects.toThrow('fail');

    const unlinkCalls = mockUnlinkSync.mock.calls.map(c => c[0] as string);
    expect(unlinkCalls.some(p => p.includes('ci-prompt-'))).toBe(true);
    expect(unlinkCalls.some(p => p.includes('ci-schema-'))).toBe(true);
  });

  it('has the correct runner name', () => {
    const runner = new ClaudeNativeRunner();
    expect(runner.name).toBe('claude-code-native');
  });
});
