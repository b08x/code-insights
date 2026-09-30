import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'child_process';
import {
  buildRunner, configuredRunner, explicitRunnerName, isRunnerName, runnerConfigFor, selectRunner,
} from '../runner-selection.js';
import type { ClaudeInsightConfig, AnalysisRunnerSetting } from '../../types.js';

const withRunner = (runner: AnalysisRunnerSetting | Record<string, unknown>): ClaudeInsightConfig => ({
  sync: { claudeDir: '', excludeProjects: [] },
  dashboard: { analysis: { runner: runner as AnalysisRunnerSetting } },
});

beforeEach(() => vi.clearAllMocks());

describe('selectRunner', () => {
  it('uses the saved runner with its model and variant when no flag is given', () => {
    const sel = selectRunner({}, withRunner({ name: 'opencode', model: 'openrouter/qwen', variant: 'high' }));
    expect(sel).toEqual({ name: 'opencode', runnerConfig: { model: 'openrouter/qwen', variant: 'high' }, source: 'config' });
  });

  it('an explicit flag wins over the saved runner and runs with CLI defaults', () => {
    const sel = selectRunner({ codex: true }, withRunner({ name: 'opencode', model: 'openrouter/qwen' }));
    expect(sel).toEqual({ name: 'codex', runnerConfig: {}, source: 'flag' });
  });

  it('an explicit flag for the saved runner keeps the saved model/variant', () => {
    const sel = selectRunner({ claude: true }, withRunner({ name: 'claude', model: 'claude-sonnet-4-6', variant: 'high' }));
    expect(sel?.runnerConfig).toEqual({ model: 'claude-sonnet-4-6', variant: 'high' });
    expect(sel?.source).toBe('flag');
  });

  it('plain --native keeps the caller default even when a runner is saved', () => {
    expect(selectRunner({ native: true }, withRunner({ name: 'opencode' }))).toBeNull();
  });

  it('returns null when nothing is flagged or saved', () => {
    expect(selectRunner({}, null)).toBeNull();
    expect(selectRunner({}, { sync: { claudeDir: '', excludeProjects: [] } })).toBeNull();
  });

  it('ignores an unknown saved runner name', () => {
    expect(configuredRunner(withRunner({ name: 'cursor' }))).toBeNull();
    expect(selectRunner({}, withRunner({ name: 'cursor' }))).toBeNull();
  });

  it('drops blank model/variant', () => {
    expect(runnerConfigFor('codex', withRunner({ name: 'codex', model: '  ', variant: '' }))).toEqual({});
  });

  it('selects the provider runner from config', () => {
    expect(selectRunner({}, withRunner({ name: 'provider' }))?.name).toBe('provider');
  });
});

describe('explicitRunnerName / isRunnerName', () => {
  it('maps flags to names and ignores --native alone', () => {
    expect(explicitRunnerName({ opencode: true })).toBe('opencode');
    expect(explicitRunnerName({ vibe: true })).toBe('vibe');
    expect(explicitRunnerName({ antigravity: true })).toBe('antigravity');
    expect(explicitRunnerName({ claude: true })).toBe('claude');
    expect(explicitRunnerName({ codex: true })).toBe('codex');
    expect(explicitRunnerName({ native: true })).toBeNull();
  });

  it('accepts only the allowlisted names', () => {
    for (const n of ['claude', 'codex', 'antigravity', 'vibe', 'opencode', 'provider']) expect(isRunnerName(n)).toBe(true);
    expect(isRunnerName('rm -rf')).toBe(false);
    expect(isRunnerName(undefined)).toBe(false);
  });
});

describe('buildRunner', () => {
  it('builds native runners with model and variant from RunnerConfig', () => {
    vi.mocked(execFileSync).mockReturnValue('1.0.0');
    const claude = buildRunner('claude', { model: 'claude-opus-4-6', variant: 'high' });
    expect(claude.name).toBe('claude-code-native');
    expect(claude.model).toBe('claude-opus-4-6');
    expect(claude.variant).toBe('high');

    const opencode = buildRunner('opencode', { model: 'anthropic/claude-sonnet-4-6', variant: 'max' });
    expect(opencode.name).toBe('opencode');
    expect(opencode.model).toBe('anthropic/claude-sonnet-4-6');
    expect(opencode.variant).toBe('max');

    // antigravity has no variant flag, so a configured variant is not part of its identity
    const agy = buildRunner('antigravity', { model: 'gemini-3-pro', variant: 'high' });
    expect(agy.model).toBe('gemini-3-pro');
    expect(agy.variant).toBeUndefined();
  });

  it('throws when the CLI is missing', () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('ENOENT'); });
    expect(() => buildRunner('codex')).toThrow();
  });
});
