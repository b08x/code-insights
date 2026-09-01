import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { AntigravityNativeRunner } from '../antigravity-runner.js';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('AntigravityNativeRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has the correct runner name', () => {
    const runner = new AntigravityNativeRunner();
    expect(runner.name).toBe('antigravity-native');
  });

  it('calls agy -p with correct args', async () => {
    const runner = new AntigravityNativeRunner();
    const mockOutput = '{"summary": "test"}';
    mockedExecFileSync.mockReturnValue(mockOutput);

    const result = await runner.runAnalysis({
      systemPrompt: 'sys',
      userPrompt: 'user',
    });

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'agy',
      expect.arrayContaining(['-p', expect.stringContaining('sys'), '--dangerously-skip-permissions']),
      expect.objectContaining({
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 30 * 1024 * 1024,
      })
    );
    expect(result.rawJson).toBe('{"summary": "test"}');
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });

  it('strips <json> tags and leading text', async () => {
    const runner = new AntigravityNativeRunner();
    const mockResponse = 'Some leading info text...\n<json>{"test": true}</json>';
    mockedExecFileSync.mockReturnValue(mockResponse);

    const result = await runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.rawJson).toBe('{"test": true}');
  });

  it('throws on usage limit error in stderr', async () => {
    const runner = new AntigravityNativeRunner();
    const err: any = new Error('Command failed');
    err.stderr = Buffer.from('rateLimitExceeded');
    mockedExecFileSync.mockImplementation(() => { throw err; });

    await expect(runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/Antigravity CLI usage limit reached/);
  });
});
