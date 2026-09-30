import { describe, it, expect, vi, beforeEach } from 'vitest';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

import { listRunnerModels, parseModelList, isRunnerName, ANALYSIS_RUNNER_NAMES } from './runner-models.js';

beforeEach(() => { execFileMock.mockReset(); });

describe('parseModelList', () => {
  it('keeps one model id per line and drops blanks, headers, bullets, ANSI and descriptions', () => {
    const out = '\x1b[1mAvailable models:\x1b[0m\n- gemini-3-pro  (default)\n* gemini-3-flash\n\nopenrouter/qwen/qwen3-coder:free\n';
    expect(parseModelList(out)).toEqual(['gemini-3-pro', 'gemini-3-flash', 'openrouter/qwen/qwen3-coder:free']);
  });

  it('dedupes and rejects tokens that are not model ids', () => {
    expect(parseModelList('a/b\na/b\n--help\n(none)\n')).toEqual(['a/b']);
  });
});

describe('listRunnerModels', () => {
  it('runs the fixed command with a timeout', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(null, 'x/y\n', ''));
    expect(await listRunnerModels('opencode', 1234)).toEqual(['x/y']);
    expect(execFileMock).toHaveBeenCalledWith('opencode', ['models'], expect.objectContaining({ timeout: 1234 }), expect.any(Function));
  });

  it('returns [] on error, when execFile throws, and for runners without a list command', async () => {
    execFileMock.mockImplementation((_c, _a, _o, cb) => cb(new Error('timeout'), '', ''));
    expect(await listRunnerModels('antigravity')).toEqual([]);
    execFileMock.mockImplementation(() => { throw new Error('spawn failed'); });
    expect(await listRunnerModels('antigravity')).toEqual([]);
    execFileMock.mockReset();
    expect(await listRunnerModels('claude')).toEqual([]);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('uses the CLI allowlist', () => {
    expect(ANALYSIS_RUNNER_NAMES).toContain('opencode');
    expect(isRunnerName('opencode')).toBe(true);
    expect(isRunnerName('sh')).toBe(false);
  });
});
