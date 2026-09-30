import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'child_process';
import { OpenCodeRunner, parseOpenCodeEvents } from '../opencode-runner.js';
import { extractJsonPayload } from '../response-parsers.js';

const exec = vi.mocked(execFileSync);
// Real recording of `opencode run -m opencode/big-pickle --format json` (opencode 1.18.33).
const fixture = readFileSync(
  join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'opencode-run.ndjson'), 'utf-8');

beforeEach(() => vi.clearAllMocks());

describe('parseOpenCodeEvents', () => {
  it('extracts the assistant text and token usage from the recorded fixture', () => {
    const p = parseOpenCodeEvents(fixture);
    expect(p.text).toBe('{"ok":true}');
    expect(p.inputTokens).toBe(41094);
    expect(p.outputTokens).toBe(7);
    expect(p.cacheReadTokens).toBe(1941);
  });

  it('uses only the last assistant message and joins its parts', () => {
    const ev = (messageID: string, text: string) =>
      JSON.stringify({ type: 'text', part: { messageID, type: 'text', text } });
    const out = [ev('m1', 'let me look'), ev('m2', '<json>\n{"a":'), ev('m2', '1}\n</json>')].join('\n');
    expect(parseOpenCodeEvents(out).text).toBe('{"a":1}');
  });

  it('throws on error events and on missing text', () => {
    const err = JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'bad key' } } });
    expect(() => parseOpenCodeEvents(err)).toThrow(/bad key/);
    expect(() => parseOpenCodeEvents('{"type":"step_start"}')).toThrow(/no assistant text/);
  });
});

describe('OpenCodeRunner', () => {
  it('builds argv, pipes the composed prompt, and yields parser-ready JSON', async () => {
    const analysis = '{"summary":{"title":"t"},"friction_points":[]}';
    const events = JSON.stringify({ type: 'text', part: { messageID: 'm', type: 'text', text: analysis } });
    exec.mockReturnValue(events);

    const r = await new OpenCodeRunner({ model: 'anthropic/claude-haiku-4-5', variant: 'high' })
      .runAnalysis({ systemPrompt: 'SYS', userPrompt: 'USR', jsonSchema: { type: 'object' } });

    const [cmd, args, opts] = exec.mock.calls[0] as unknown as [string, string[], Record<string, any>];
    expect(cmd).toBe('opencode');
    expect(args).toEqual(['run', '--format', 'json', '-m', 'anthropic/claude-haiku-4-5', '--variant', 'high']);
    expect(opts.input).toContain('SYS');
    expect(opts.input).toContain('USR');
    expect(opts.input).toContain('STRICT JSON SCHEMA');
    expect(r.model).toBe('anthropic/claude-haiku-4-5');
    expect(r.provider).toBe('opencode');
    expect(JSON.parse(extractJsonPayload(r.rawJson) ?? r.rawJson)).toEqual(JSON.parse(analysis));
  });

  it('omits -m/--variant when unconfigured', async () => {
    exec.mockReturnValue(fixture);
    const r = await new OpenCodeRunner().runAnalysis({ systemPrompt: 's', userPrompt: 'u' });
    const args = (exec.mock.calls[0] as unknown as [string, string[]])[1];
    expect(args).toEqual(['run', '--format', 'json']);
    expect(r.model).toBe('opencode-default');
    expect(r.rawJson).toBe('{"ok":true}');
  });

  it('maps rate-limit failures to a usage-limit error', async () => {
    exec.mockImplementation(() => { throw Object.assign(new Error('fail'), { stderr: 'HTTP 429 rate limit' }); });
    await expect(new OpenCodeRunner().runAnalysis({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/usage limit reached/);
  });
});
