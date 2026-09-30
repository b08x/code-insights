/**
 * Transport-level characterization (Phase 1, step 6a).
 *
 * pipeline-characterization.test.ts stubs the LLM client/runner, so it pins WHAT is asked.
 * This file stubs only `fetch` / `execFileSync`, so it pins HOW each path talks to a provider:
 *
 *   server path  analyzeSession/analyzePromptQuality -> server/src/llm/client.ts -> providers/*
 *   CLI provider insights.ts -> ProviderRunner (cli/src/analysis/provider-runner.ts make*Chat)
 *   CLI native   insights.ts -> ClaudeNativeRunner (`claude -p` via execFileSync)
 *
 * The native runner cannot be driven from the server path (the server has no AnalysisRunner
 * concept), so it has a CLI-only golden.
 *
 * Request bodies are stored with long strings replaced by length+hash (prompt text itself is
 * pinned in the pipeline goldens); structure, params (temperature, max_tokens, cache_control,
 * headers) are stored verbatim.
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  loadInput, loadResponse, seedSession, capturePrompt, redactLongStrings, stableJson, GOLDEN_DIR, type LoadedInput,
} from './fixtures/pipeline/harness.js';

const H = vi.hoisted(() => {
  const p = (rel: string) => new URL(rel, import.meta.url).pathname;
  return {
    paths: { cliSrc: (m: string) => p(`../../${m}`), cliDist: (m: string) => p(`../../../dist/${m}`) },
    state: {
      db: null as unknown,
      config: null as unknown,
      execHandler: null as null | ((cmd: string, args: string[], opts: any) => string),
    },
  };
});

vi.mock(H.paths.cliSrc('db/client.js'), () => ({ getDb: () => H.state.db, closeDb: () => {} }));
vi.mock(H.paths.cliDist('db/client.js'), () => ({ getDb: () => H.state.db, closeDb: () => {} }));
vi.mock(H.paths.cliDist('utils/config.js'), () => ({ loadConfig: () => H.state.config }));
// Short fixture: related-insights retrieval must find no vec table; keep the extension load inert.
vi.mock(H.paths.cliDist('embeddings/store.js'), async (io) => ({ ...(await (io as any)()), loadVectorExtension: () => {} }));
vi.mock('child_process', () => ({
  execFileSync: (cmd: string, args: string[], opts: any) => {
    if (!H.state.execHandler) throw new Error(`unexpected execFileSync(${cmd})`);
    return H.state.execHandler(cmd, args, opts);
  },
}));

const { runMigrations } = await import('../../db/schema.js');
const { runInsightsCommand } = await import('../../commands/insights.js');
const { ProviderRunner } = await import('../provider-runner.js');
const { analyzeSession, analyzePromptQuality } = await import('../../../../server/src/llm/analysis.js');

// ── fetch stub ────────────────────────────────────────────────────────────────

type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'openrouter' | 'mistral';
const PROVIDERS: Provider[] = ['openai', 'anthropic', 'gemini', 'ollama', 'openrouter', 'mistral'];

function envelope(provider: Provider, text: string) {
  switch (provider) {
    case 'anthropic':
      return { content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 50, cache_read_input_tokens: 10 } };
    case 'gemini':
      return { candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200 } };
    case 'ollama':
      return { message: { content: text }, prompt_eval_count: 1000, eval_count: 200 };
    default:
      return { choices: [{ message: { content: text } }], usage: { prompt_tokens: 1000, completion_tokens: 200 } };
  }
}

interface Recorded { url: string; method: string; headers: Record<string, string>; hasSignal: boolean; body: unknown }

function installFetchStub(provider: Provider, log: Recorded[]) {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const bodyText = String(init.body ?? '');
    log.push({
      url: String(url),
      method: init.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).sort()),
      hasSignal: !!init.signal,
      body: redactLongStrings(JSON.parse(bodyText)),
    });
    const isPq = bodyText.includes("Analyze the user's input messages");
    const text = isPq ? loadResponse('pq-ok.json') : loadResponse('analysis-ok.json');
    return new Response(JSON.stringify(envelope(provider, text)), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

function freshDb(input: LoadedInput) {
  const db = new Database(':memory:');
  runMigrations(db);
  seedSession(db, input);
  H.state.db = db;
  return db;
}

async function golden(name: string, value: unknown) {
  await expect(stableJson(value)).toMatchFileSnapshot(`${GOLDEN_DIR}/${name}.json`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  H.state.execHandler = null;
});

// ── Provider transport: server client vs ProviderRunner ───────────────────────

describe('provider transport characterization (short session)', () => {
  for (const provider of PROVIDERS) {
    it(`${provider}: server client request vs ProviderRunner request`, async () => {
      const input = loadInput('short');
      const model = `${provider}-fixture-model`;
      for (const v of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'MISTRAL_API_KEY']) {
        vi.stubEnv(v, 'test-key');
      }
      H.state.config = { dashboard: { llm: { provider, model, apiKey: 'test-key', ...(provider === 'ollama' ? { baseUrl: undefined } : {}) } } };
      vi.spyOn(console, 'error').mockImplementation(() => {});

      // Server path
      const serverLog: Recorded[] = [];
      installFetchStub(provider, serverLog);
      let db = freshDb(input);
      const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(input.session.id) as any;
      const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp').all(input.session.id) as any[];
      const s1 = await analyzeSession(session, messages);
      const s2 = await analyzePromptQuality(session, messages);
      db.close();

      // CLI ProviderRunner path
      const cliLog: Recorded[] = [];
      installFetchStub(provider, cliLog);
      db = freshDb(input);
      H.state.execHandler = () => { throw new Error('not installed'); }; // architecture lookup
      const runner = new ProviderRunner({ provider, model, apiKey: 'test-key' } as any, 'test-key');
      const raw = await runInsightsCommand({ sessionId: input.session.id, native: false, format: 'json', quiet: true, _runner: runner });
      const payload = JSON.parse(raw as string);
      db.close();

      await golden(`transport-${provider}`, {
        server: { success: [s1.success, s2.success], requests: serverLog },
        cliProviderRunner: { runnerName: runner.name, reportedModel: payload.meta.model, requests: cliLog },
      });
    });
  }
});

// ── Native runner (CLI only) ──────────────────────────────────────────────────

describe('native runner characterization (claude -p, short session)', () => {
  it('captures argv, options, system prompt file, schema file and stdin for both passes', async () => {
    const input = loadInput('short');
    freshDb(input);
    const calls: unknown[] = [];
    H.state.execHandler = (cmd, args, opts) => {
      if (cmd === 'codebase-memory-mcp') throw new Error('not installed');
      if (args[0] === '--version') return 'claude 0.0.0-fixture';
      const fileArg = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
      const promptFile = fileArg('--append-system-prompt-file');
      const schemaFile = fileArg('--json-schema');
      const userPrompt: string = opts.input;
      const isPq = userPrompt.includes("Analyze the user's input messages");
      calls.push({
        cmd,
        // tmp paths contain timestamps/random ids
        argv: args.map(a => (a === promptFile ? '<tmp system-prompt file>' : a === schemaFile ? '<tmp schema file>' : a)),
        options: { encoding: opts.encoding, timeout: opts.timeout, maxBuffer: opts.maxBuffer, stdio: opts.stdio },
        systemPromptFile: promptFile ? capturePrompt(readFileSync(promptFile, 'utf-8')) : null,
        jsonSchemaFileTopLevelKeys: schemaFile ? Object.keys(JSON.parse(readFileSync(schemaFile, 'utf-8'))).sort() : null,
        stdinUserPrompt: capturePrompt(userPrompt),
      });
      const result = isPq ? loadResponse('pq-ok.json') : loadResponse('analysis-ok.json');
      return JSON.stringify([{ type: 'result', subtype: 'success', is_error: false, result: `<json>\n${result}\n</json>` }]);
    };

    const raw = await runInsightsCommand({ sessionId: input.session.id, native: false, claude: true, format: 'json', quiet: true });
    const payload = JSON.parse(raw as string);
    const db = H.state.db as Database.Database;
    const usage = db.prepare('SELECT analysis_type, provider, model, input_tokens, output_tokens, estimated_cost_usd, session_message_count FROM analysis_usage ORDER BY analysis_type').all();
    db.close();

    await golden('transport-native-claude', { execFileSyncCalls: calls, payloadMeta: { ...payload.meta, durationMs: '<wall-clock>' }, analysisUsageRows: usage });
  });
});
