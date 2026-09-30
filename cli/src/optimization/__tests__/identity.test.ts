import { describe, it, expect } from 'vitest';
import {
  identityKey, parseIdentityKey, currentIdentity, identityFromRunner, identityFromRunResult, providerIdentity,
} from '../identity.js';
import type { ClaudeInsightConfig } from '../../types.js';

const config = (llm?: { provider: string; model: string }) =>
  ({ sync: { claudeDir: '', excludeProjects: [] }, dashboard: llm ? { llm } : {} }) as unknown as ClaudeInsightConfig;

describe('identityKey', () => {
  it.each([
    [{ runner: 'codex-native', model: 'gpt-5', variant: 'high' }, 'codex-native|gpt-5|high'],
    [{ runner: 'claude-code-native', model: null, variant: null }, 'claude-code-native||'],
    [{ runner: 'provider:openrouter', model: 'a/b:free', variant: null }, 'provider:openrouter|a/b:free|'],
  ])('%j -> %s and round-trips', (identity, key) => {
    expect(identityKey(identity)).toBe(key);
    expect(parseIdentityKey(key)).toEqual(identity);
  });

  it('distinguishes identities that differ in any component', () => {
    const base = { runner: 'r', model: 'm', variant: 'v' };
    const keys = new Set([base, { ...base, runner: 'x' }, { ...base, model: 'x' }, { ...base, variant: null }].map(identityKey));
    expect(keys.size).toBe(4);
  });

  it('rejects malformed keys', () => {
    expect(parseIdentityKey('nope')).toBeNull();
    expect(parseIdentityKey('|m|v')).toBeNull();
  });
});

describe('currentIdentity', () => {
  it('server path: provider:<llm.provider> / <llm.model>', () => {
    expect(currentIdentity(config({ provider: 'mistral', model: 'mistral-small' })))
      .toEqual({ runner: 'provider:mistral', model: 'mistral-small', variant: null });
  });

  it('null when nothing is configured', () => {
    expect(currentIdentity(null)).toBeNull();
    expect(currentIdentity(config())).toBeNull();
  });

  it('CLI path: native runner uses its own name', () => {
    expect(currentIdentity(config({ provider: 'mistral', model: 'm' }), { name: 'codex-native' }))
      .toEqual({ runner: 'codex-native', model: null, variant: null });
  });

  it('CLI path: provider-backed runner matches the server-path identity for the same provider/model', () => {
    const viaRunner = currentIdentity(null, { name: 'provider', provider: 'mistral', model: 'm' });
    expect(viaRunner).toEqual(providerIdentity('mistral', 'm'));
    expect(identityKey(viaRunner!)).toBe(identityKey(currentIdentity(config({ provider: 'mistral', model: 'm' }))!));
  });
});

describe('identity from a run result', () => {
  it('provider-backed: same shape as the server path', () => {
    expect(identityFromRunResult({ provider: 'openai', model: 'gpt-4.1' }, { providerBacked: true }))
      .toEqual({ runner: 'provider:openai', model: 'gpt-4.1', variant: null });
  });

  it('native: the reporting runner and model, with the configured variant', () => {
    expect(identityFromRunResult({ provider: 'codex-native', model: 'gpt-5' }, { providerBacked: false, variant: 'high' }))
      .toEqual({ runner: 'codex-native', model: 'gpt-5', variant: 'high' });
  });

  it('identityFromRunner mirrors identityFromRunResult for provider runners', () => {
    expect(identityFromRunner({ name: 'p', provider: 'openai', model: 'gpt-4.1' }))
      .toEqual(identityFromRunResult({ provider: 'openai', model: 'gpt-4.1' }, { providerBacked: true }));
  });
});
