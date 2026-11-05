import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { CodexNativeRunner } from '../codex-runner.js';

// Mock child_process and fs
vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
}));
vi.mock('fs', () => ({
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import { execFileSync as mockExecFileSync } from 'child_process';
const mockedExecFileSync = vi.mocked(mockExecFileSync);
const mockedReadFileSync = vi.mocked(readFileSync);

describe('CodexNativeRunner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('has the correct runner name', () => {
    const runner = new CodexNativeRunner();
    expect(runner.name).toBe('codex-native');
  });

  it('calls codex exec with correct args', async () => {
    const runner = new CodexNativeRunner();
    const llmJson = '{"test": true}';
    
    mockedReadFileSync.mockReturnValue(llmJson);

    const result = await runner.runAnalysis({
      systemPrompt: 'sys',
      userPrompt: 'user',
    });

    expect(mockedExecFileSync).toHaveBeenCalledWith(
      'codex',
      expect.arrayContaining(['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-last-message', expect.any(String)]),
      expect.objectContaining({
        input: expect.stringContaining('sys'),
      })
    );
    expect(result.rawJson).toBe(llmJson);
  });

  it('strips <json> tags from output', async () => {
    const runner = new CodexNativeRunner();
    const llmJson = '{"test": true}';
    mockedReadFileSync.mockReturnValue(`<json>\n${llmJson}\n</json>`);

    const result = await runner.runAnalysis({ systemPrompt: 's', userPrompt: 'u' });
    expect(result.rawJson).toBe(llmJson);
  });

  it('normalizes jsonSchema using toStrictOpenAiSchema before writing to file', async () => {
    const runner = new CodexNativeRunner();
    mockedReadFileSync.mockReturnValue('{"result": 1}');

    const inputSchema = {
      type: 'object',
      properties: {
        step_matrix: { type: 'array' },
      },
      // missing step_matrix in required
      required: [],
    };

    await runner.runAnalysis({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonSchema: inputSchema,
    });

    const schemaWriteCall = vi.mocked(writeFileSync).mock.calls.find(call =>
      typeof call[0] === 'string' && (call[0] as string).includes('codex-schema-')
    );
    expect(schemaWriteCall).toBeDefined();

    const writtenSchema = JSON.parse(schemaWriteCall![1] as string);
    expect(writtenSchema.required).toContain('step_matrix');
    expect(writtenSchema.additionalProperties).toBe(false);
  });
});
