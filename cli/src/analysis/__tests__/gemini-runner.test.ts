import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import { GeminiNativeRunner } from '../gemini-runner.js';

// Mock child_process
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe('GeminiNativeRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has the correct runner name', () => {
    const runner = new GeminiNativeRunner();
    expect(runner.name).toBe('gemini-native');
  });

  it('calls gemini -p with correct args', async () => {
    const runner = new GeminiNativeRunner();
    const mockJson = JSON.stringify({
      response: '{"summary": "test"}',
      stats: {
        models: {
          'gemini-flash': {
            tokens: { input: 100, candidates: 50 }
          }
        }
      }
    });
    
    mockedExecFileSync.mockReturnValue(mockJson);

    const result = await runner.runAnalysis({
      systemPrompt: 'sys',
      userPrompt: 'user',
    });

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'gemini',
      expect.arrayContaining(['-p', '-', '-o', 'json', '--approval-mode', 'plan']),
      expect.objectContaining({
        input: expect.stringContaining('sys'),
        encoding: 'utf-8',
        timeout: 300000,
        maxBuffer: 30 * 1024 * 1024,
      })
    );
    expect(result.rawJson).toBe('{"summary": "test"}');
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(50);
  });

  it('strips <json> tags and leading text', async () => {
    const runner = new GeminiNativeRunner();
    const mockResponse = 'Some leading info text...\n{"response": "<json>{\\"test\\": true}</json>"}';
    mockedExecFileSync.mockReturnValue(mockResponse);

    const result = await runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.rawJson).toBe('{"test": true}');
  });

  it('throws on usage limit error in stderr', async () => {
    const runner = new GeminiNativeRunner();
    const err: any = new Error('Command failed');
    err.stderr = Buffer.from('rateLimitExceeded');
    mockedExecFileSync.mockImplementation(() => { throw err; });

    await expect(runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/Gemini CLI usage limit reached/);
  });
});
