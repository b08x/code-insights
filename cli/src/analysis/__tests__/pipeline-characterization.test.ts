/**
 * Characterization tests for the analysis entry points (Phase 1, steps 6a + 6d).
 *
 *   CLI path    cli/src/commands/insights.ts  (runInsightsCommand) + an AnalysisRunner
 *   server path server/src/llm/analysis.ts    (analyzeSession) + prompt-quality-analysis.ts
 *
 * Since 6d both entry points are thin wrappers over analyzeSessionPipeline (cli src copy for
 * the CLI, cli dist copy for the server). Both are driven end-to-end against an in-memory
 * SQLite DB with a stubbed LLM transport and the same canned model output, and the exact
 * prompt text, call sequence, retrieval arguments, parsed result, and persisted rows are
 * pinned as golden files under fixtures/pipeline/golden/. The goldens were recorded against
 * the two pre-unification pipelines in 6a and were changed deliberately in 6d (see the
 * "Golden changes" table in goals/gepa-optimization-dashboard/pipeline-map.md).
 * The "entry-point parity" block asserts the core 6d guarantee: the same session yields the
 * same prompt (and hash) regardless of entry point.
 *
 * Stubs (nothing in production code is modified):
 *  - DB:            getDb() of BOTH the cli/src copy and the cli/dist copy (the server imports
 *                   cli internals through dist via the workspace exports map) return one DB.
 *  - LLM transport: server `client.js` createLLMClient/isLLMConfigured/loadLLMConfig; CLI `_runner`.
 *  - Embeddings:    retrieval/analysis-pipeline/embed/store modules are partially mocked
 *                   (shouldUseRetrieval stays real so the long-session thresholds are exercised).
 *  - child_process: the CLI's `codebase-memory-mcp` architecture lookup.
 *
 * Prerequisite: `pnpm --filter @code-insights/cli build` (the server path consumes cli/dist).
 * The root `pnpm run build` -> `pnpm run test` order already guarantees that.
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadInput, loadResponse, seedSession, snapshotDb, capturePrompt, describeServerContent,
  stableJson, GOLDEN_DIR, type LoadedInput,
} from './fixtures/pipeline/harness.js';

// ── Hoisted shared state + absolute module paths ──────────────────────────────

const H = vi.hoisted(() => {
  const p = (rel: string) => new URL(rel, import.meta.url).pathname;
  return {
    paths: {
      cliSrc: (m: string) => p(`../../${m}`),
      cliDist: (m: string) => p(`../../../dist/${m}`),
      serverClient: p('../../../dist/llm/client.js'),
    },
    state: {
      db: null as unknown,
      chatCalls: [] as unknown[],
      /** stage + sha256 of the full user prompt of every runner call (parity checks; not in goldens). */
      hashes: [] as string[],
      retrieval: [] as unknown[],
      related: [] as unknown[],
      execCalls: [] as unknown[],
      architecture: '',
      relatedRows: [] as Array<{ id: string; distance: number }>,
    },
  };
});

const S = H.state;
const getDb = () => S.db;

vi.mock(H.paths.cliSrc('db/client.js'), () => ({ getDb: () => getDb(), closeDb: () => {} }));
vi.mock(H.paths.cliDist('db/client.js'), () => ({ getDb: () => getDb(), closeDb: () => {} }));

// Server LLM client: transport stub. Provider/model are fixed so cost math is deterministic.
vi.mock(H.paths.serverClient, () => ({
  isLLMConfigured: () => true,
  loadLLMConfig: () => ({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' }),
  createLLMClient: () => ({
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    estimateTokens: (t: string) => Math.ceil(t.length / 4),
    chat: (messages: unknown, options: unknown) => (S as any).serverChat(messages, options),
  }),
}));

// Config: null => the pipeline uses its default retrieval settings.
vi.mock(H.paths.cliDist('utils/config.js'), () => ({ loadConfig: () => null }));
vi.mock(H.paths.cliSrc('utils/config.js'), () => ({ loadConfig: () => null }));

// Retrieval + embeddings. One factory, tagged by which copy (server=dist, cli=src) was called.
function retrievalMock(tag: 'server' | 'cli') {
  return async (importActual: () => Promise<any>) => {
    const actual = await importActual();
    return {
      ...actual,
      retrieveAnalysisChunks: async (...args: any[]) => {
        S.retrieval.push({
          path: tag, fn: 'retrieveAnalysisChunks',
          sessionId: args[0], formattedMessagesLength: args[1]?.length, sessionSummary: args[2],
          projectName: args[3], sessionMeta: args[4] ?? null, config: args[5] ?? 'DEFAULT_RETRIEVAL (module default)',
          embeddingConfigPassed: args[6] !== undefined,
        });
        return { usedRetrieval: true, augmentedChunks: '<retrieved_segments>STUB-RETRIEVED-CONTEXT</retrieved_segments>', positionTags: [], estimatedTokens: 1234, chunkCount: 3 };
      },
    };
  };
}
function pipelineMock(tag: 'server' | 'cli') {
  return async () => ({
    checkEmbeddingReadiness: () => ({ ready: false, status: { total: 0 } }),
    chunkAndEmbedSession: async (...args: any[]) => {
      S.retrieval.push({ path: tag, fn: 'chunkAndEmbedSession', sessionId: args[0], messageCount: args[1]?.length, embeddingConfigPassed: args[2] !== undefined });
      return { embedded: true };
    },
  });
}
vi.mock(H.paths.cliDist('embeddings/retrieval.js'), async (io) => retrievalMock('server')(io as any));
vi.mock(H.paths.cliSrc('embeddings/retrieval.js'), async (io) => retrievalMock('cli')(io as any));
vi.mock(H.paths.cliDist('embeddings/analysis-pipeline.js'), pipelineMock('server'));
vi.mock(H.paths.cliSrc('embeddings/analysis-pipeline.js'), pipelineMock('cli'));
const embeddingsClientMock = async (io: () => Promise<any>) => ({
  ...(await io()),
  embedOne: async (_cfg: unknown, id: string, text: string) => {
    S.related.push({ fn: 'embedOne', id, textLength: text.length });
    return { vector: new Float32Array(4) };
  },
});
const embeddingsStoreMock = async (io: () => Promise<any>) => ({
  ...(await io()),
  loadVectorExtension: () => {},
  querySimilarFiltered: (_db: unknown, entity: string, vec: Float32Array, topK: number, projectId: string) => {
    S.related.push({ fn: 'querySimilarFiltered', entity, vectorLength: vec.length, topK, projectId });
    return S.relatedRows;
  },
});
vi.mock(H.paths.cliDist('embeddings/client.js'), async (io) => embeddingsClientMock(io as any));
vi.mock(H.paths.cliSrc('embeddings/client.js'), async (io) => embeddingsClientMock(io as any));
vi.mock(H.paths.cliDist('embeddings/store.js'), async (io) => embeddingsStoreMock(io as any));
vi.mock(H.paths.cliSrc('embeddings/store.js'), async (io) => embeddingsStoreMock(io as any));

vi.mock('child_process', () => ({
  // The pipeline gathers architecture context with async execFile (request JSON goes to stdin).
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, out?: string) => void) => {
    if (cmd !== 'codebase-memory-mcp') throw new Error(`unexpected execFile(${cmd}) in pipeline matrix test`);
    const call = { cmd, args, input: null as string | null };
    S.execCalls.push(call);
    queueMicrotask(() => (S.architecture ? cb(null, S.architecture) : cb(new Error('not installed'))));
    return { stdin: { on: () => {}, end: (input: string) => { call.input = input; } } };
  },
}));

// ── Modules under test (imported after mocks are registered) ──────────────────

const { runMigrations } = await import('../../db/schema.js');
const { runInsightsCommand } = await import('../../commands/insights.js');
const { analyzeSession, analyzePromptQuality } = await import('../../../../server/src/llm/analysis.js');

// ── Canned LLM behaviour ──────────────────────────────────────────────────────

const USAGE = { inputTokens: 1000, outputTokens: 200, cacheCreationTokens: 50, cacheReadTokens: 10 };

type Stage = 'session' | 'prompt_quality' | 'facets_only';

function detectStage(promptText: string): Stage {
  if (promptText.includes("Analyze the user's input messages")) return 'prompt_quality';
  if (promptText.includes('cross-session facet aggregation')) return 'facets_only';
  return 'session';
}

interface Canned {
  analysis: string;          // file in responses/
  chunkVariants?: boolean;   // server chunk calls get distinct per-chunk responses (no facets)
}

function cannedResponse(stage: Stage, path: 'server' | 'cli', callIndex: number, canned: Canned): string {
  if (stage === 'prompt_quality') return loadResponse('pq-ok.json');
  if (stage === 'facets_only') return loadResponse('facets-messy.txt');
  if (path === 'server' && canned.chunkVariants) {
    const n = callIndex + 1;
    return JSON.stringify({
      summary: { title: `Chunk ${n} summary`, content: `content ${n}`, bullets: [`b${n}`] },
      decisions: [
        { title: 'Shared decision', situation: 's', choice: 'c', reasoning: 'r', confidence: 80 },
        { title: `Decision A from chunk ${n}`, situation: 's', choice: 'c', reasoning: 'r', confidence: 80 },
        { title: `Decision B from chunk ${n}`, situation: 's', choice: 'c', reasoning: 'r', confidence: 80 },
      ],
      learnings: [
        { title: 'Shared learning', takeaway: 't', confidence: 70 },
        { title: `Learning A from chunk ${n}`, takeaway: 't', confidence: 70 },
        { title: `Learning B from chunk ${n}`, takeaway: 't', confidence: 70 },
        { title: `Learning C from chunk ${n}`, takeaway: 't', confidence: 70 },
      ],
    });
  }
  return loadResponse(canned.analysis);
}

/** Attach call hashes as a non-enumerable property so they never leak into golden JSON. */
function withHashes<T extends object>(out: T): T & { hashes: string[] } {
  Object.defineProperty(out, 'hashes', { value: [...S.hashes], enumerable: false });
  return out as T & { hashes: string[] };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ── Drivers ───────────────────────────────────────────────────────────────────

interface ScenarioOptions {
  related?: boolean;
  architecture?: string;
  canned: Canned;
  /** Override messages (failure/gate scenarios); session row is unchanged. */
  messages?: (all: LoadedInput['messages']) => LoadedInput['messages'];
  analysisResponseOverride?: string;
}

function freshDb(input: LoadedInput, opts: ScenarioOptions): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  const effective = { ...input, messages: opts.messages ? opts.messages(input.messages) : input.messages };
  seedSession(db, effective);
  if (opts.related) {
    db.prepare(`INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count, source_tool)
                VALUES ('sess-old', ?, ?, ?, '2025-12-01T10:00:00Z', '2025-12-01T11:00:00Z', 2, 'claude-code')`)
      .run(input.session.project_id, input.session.project_name, input.session.project_path);
    const ins = db.prepare(`INSERT INTO insights (id, session_id, project_id, project_name, type, title, content, summary, confidence, timestamp)
                            VALUES (?, 'sess-old', ?, ?, ?, ?, ?, ?, ?, '2025-12-01T11:00:00Z')`);
    // source stays 'llm' (default) so snapshotDb filters by session_id only.
    ins.run('rel-1', input.session.project_id, input.session.project_name, 'learning', 'Related one', 'Short related content.', 's', 90);
    ins.run('rel-2', input.session.project_id, input.session.project_name, 'decision', 'Below threshold', 'Should be filtered (similarity 0.6).', 's', 70);
    ins.run('rel-3', input.session.project_id, input.session.project_name, 'learning', 'Related long', 'L'.repeat(400), 's', 60);
    db.exec('CREATE TABLE vec_insights (x INTEGER)');
    S.relatedRows = [{ id: 'rel-1', distance: 0.1 }, { id: 'rel-2', distance: 0.4 }, { id: 'rel-3', distance: 0.2 }];
  }
  return db;
}

function resetState(db: Database.Database, opts: ScenarioOptions) {
  S.db = db;
  S.chatCalls = []; S.hashes = []; S.retrieval = []; S.related = []; S.execCalls = [];
  S.architecture = opts.architecture ?? '';
  if (!opts.related) S.relatedRows = [];
}

function loadRows(db: Database.Database, sessionId: string) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as any;
  const messages = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId) as any[];
  return { session, messages };
}

function summarizeResult(r: any) {
  return {
    success: r.success,
    ...(r.error ? { error: r.error } : {}),
    ...(r.error_type ? { error_type: r.error_type } : {}),
    ...(r.response_length !== undefined ? { response_length: r.response_length } : {}),
    ...(r.response_preview !== undefined ? { response_preview: r.response_preview } : {}),
    insightCount: r.insights?.length ?? 0,
    insightTypes: (r.insights ?? []).map((i: any) => i.type),
    usage: r.usage ?? null,
  };
}

async function runServer(input: LoadedInput, opts: ScenarioOptions) {
  const db = freshDb(input, opts);
  resetState(db, opts);
  let sessionCalls = 0;
  (S as any).serverChat = async (messages: any[], options: any) => {
    const flat = messages.map(m => (typeof m.content === 'string' ? m.content : m.content.map((b: any) => b.text).join(''))).join('\n');
    const stage = detectStage(flat);
    const userMessage = messages[1].content;
    S.hashes.push(`${stage}:${sha(typeof userMessage === 'string' ? userMessage : userMessage.map((b: any) => b.text).join(''))}`);
    S.chatCalls.push({
      stage,
      hasSignal: !!options?.signal,
      messages: messages.map(m => ({ role: m.role, content: describeServerContent(m.content) })),
    });
    const content = cannedResponse(stage, 'server', stage === 'session' ? sessionCalls++ : 0, opts.canned);
    return { content, usage: USAGE };
  };

  const { session, messages } = loadRows(db, input.session.id);
  const progress: unknown[] = [];
  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  const sessionResult = await analyzeSession(session, messages, { onProgress: p => progress.push(p) });
  const afterSession = snapshotDb(db, input.session.id);
  const pqProgress: unknown[] = [];
  const pqResult = await analyzePromptQuality(session, messages, { onProgress: p => pqProgress.push(p) });
  logger.mockRestore();

  const out = {
    entry: 'server/src/llm/analysis.ts analyzeSession, then prompt-quality-analysis.ts analyzePromptQuality',
    llmCalls: S.chatCalls,
    retrievalCalls: S.retrieval,
    relatedInsightCalls: S.related,
    results: {
      analyzeSession: { ...summarizeResult(sessionResult), progress },
      analyzePromptQuality: { ...summarizeResult(pqResult), progress: pqProgress },
    },
    dbAfterSessionPass: afterSession,
    dbAfterPromptQualityPass: snapshotDb(db, input.session.id),
  };
  db.close();
  return withHashes(out);
}

interface CliRunnerMeta {
  /** Declare runner metadata like a provider runner (parity checks); default is a native-style runner. */
  provider?: string;
  maxInputTokens?: number;
  /** Serve the canned responses the server path gets (chunk variants) so call sequences line up. */
  responsesAs?: 'server' | 'cli';
}

async function runCli(input: LoadedInput, opts: ScenarioOptions, meta: CliRunnerMeta = {}) {
  const db = freshDb(input, opts);
  resetState(db, opts);
  let sessionCalls = 0;
  const runner = {
    name: 'stub-runner',
    ...(meta.provider && { provider: meta.provider, model: 'stub-model' }),
    ...(meta.maxInputTokens !== undefined && { maxInputTokens: meta.maxInputTokens }),
    async runAnalysis(params: { systemPrompt: string; userPrompt: string; jsonSchema?: object }) {
      const stage = detectStage(params.userPrompt);
      S.hashes.push(`${stage}:${sha(params.userPrompt)}`);
      S.chatCalls.push({
        stage,
        systemPrompt: capturePrompt(params.systemPrompt),
        userPrompt: capturePrompt(params.userPrompt),
        jsonSchemaTopLevelKeys: params.jsonSchema ? Object.keys(params.jsonSchema).sort() : null,
      });
      const rawJson = cannedResponse(stage, meta.responsesAs ?? 'cli', stage === 'session' ? sessionCalls++ : 0, opts.canned);
      return { rawJson, durationMs: 0, ...USAGE, model: 'stub-model', provider: 'stub-provider' };
    },
  };

  const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
  let payload: unknown = null;
  let error: string | null = null;
  try {
    const raw = await runInsightsCommand({ sessionId: input.session.id, native: false, format: 'json', quiet: true, _runner: runner });
    payload = raw ? JSON.parse(raw as string) : null;
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  logger.mockRestore();

  const out = {
    entry: 'cli/src/commands/insights.ts runInsightsCommand (one call = session pass + prompt-quality pass)',
    llmCalls: S.chatCalls,
    retrievalCalls: S.retrieval,
    relatedInsightCalls: S.related,
    architectureLookups: S.execCalls,
    thrown: error,
    returnedPayload: payload,
    db: snapshotDb(db, input.session.id),
  };
  db.close();
  return withHashes(out);
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

const ARCHITECTURE_STUB = 'modules: billing, ledger, exports\nentry: src/index.ts';

interface Scenario { name: string; input: string; opts: ScenarioOptions; why: string }

const SCENARIOS: Scenario[] = [
  { name: 'short', input: 'short', why: 'baseline short session; fenced+trailing-comma model output', opts: { canned: { analysis: 'analysis-messy.txt' } } },
  { name: 'short-related', input: 'short-related', why: 'related-insights retrieval (server only), compaction metadata, stored summary', opts: { related: true, canned: { analysis: 'analysis-ok.json' } } },
  { name: 'long-retrieval', input: 'long-retrieval', why: 'retrieval fires (>102.4k tokens) on both paths; server also chunks, CLI also injects architecture context', opts: { architecture: ARCHITECTURE_STUB, canned: { analysis: 'analysis-ok.json' } } },
  { name: 'long-chunked', input: 'long-chunked', why: '80k-102k tokens: server chunk+merge+facet pass without retrieval; CLI single call', opts: { canned: { analysis: 'analysis-ok.json', chunkVariants: true } } },
  { name: 'prompt-quality', input: 'prompt-quality', why: 'prompt-quality pass: human-message counting, tool-result rows, rage-loop signal', opts: { canned: { analysis: 'analysis-ok.json' } } },
];

async function golden(name: string, value: unknown) {
  await expect(stableJson(value)).toMatchFileSnapshot(`${GOLDEN_DIR}/${name}.json`);
}

beforeEach(() => {
  S.db = null;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('pipeline characterization (stubbed transport, both paths)', () => {
  for (const sc of SCENARIOS) {
    describe(sc.name, () => {
      it(`server path — ${sc.why}`, async () => {
        const out = await runServer(loadInput(sc.input), sc.opts);
        await golden(`${sc.name}.server`, out);
      });
      it(`cli path — ${sc.why}`, async () => {
        const out = await runCli(loadInput(sc.input), sc.opts);
        await golden(`${sc.name}.cli`, out);
      });
    });
  }

  describe('entry-point parity (6d)', () => {
    // Same session, same canned model output: the CLI (native-style runner, then a provider-style
    // runner with the server's budget) and the server must send byte-identical prompts.
    for (const sc of SCENARIOS) {
      it(`${sc.name}: server and CLI (provider-style runner) send identical prompts`, async () => {
        const server = await runServer(loadInput(sc.input), sc.opts);
        const cli = await runCli(loadInput(sc.input), sc.opts, { provider: 'anthropic', maxInputTokens: 80_000, responsesAs: 'server' });
        expect(server.hashes.length).toBeGreaterThan(1);
        expect(cli.hashes).toEqual(server.hashes);
      });
    }

    for (const name of ['short', 'short-related', 'prompt-quality']) {
      const sc = SCENARIOS.find(x => x.name === name)!;
      it(`${name}: a native-style runner (no budget, plain string) sends the same prompts as the server`, async () => {
        const server = await runServer(loadInput(sc.input), sc.opts);
        const cli = await runCli(loadInput(sc.input), sc.opts);
        expect(cli.hashes).toEqual(server.hashes);
      });
    }
  });

  describe('failure behavior', () => {
    it('model output that parses but has no summary: server returns a result object, CLI throws', async () => {
      // facets-messy.txt is valid JSON (after repair) without a `summary` field => invalid_structure on both paths.
      const opts: ScenarioOptions = { canned: { analysis: 'facets-messy.txt' } };
      const server = await runServer(loadInput('short'), opts);
      const cli = await runCli(loadInput('short'), opts);
      await golden('failure-invalid-structure', {
        server: { results: server.results, llmCallStages: server.llmCalls.map((c: any) => c.stage), dbAfterSessionPass: server.dbAfterSessionPass },
        cli: { thrown: cli.thrown, llmCallStages: cli.llmCalls.map((c: any) => c.stage), db: cli.db },
      });
    });

    it('prompt-quality gate with one human message: server refuses, CLI still analyzes', async () => {
      const opts: ScenarioOptions = {
        canned: { analysis: 'analysis-ok.json' },
        messages: all => all.slice(0, 2), // 1 human + 1 assistant
      };
      const server = await runServer(loadInput('short'), opts);
      const cli = await runCli(loadInput('short'), opts);
      await golden('gate-one-human', {
        server: { results: server.results, llmCallStages: server.llmCalls.map((c: any) => c.stage) },
        cli: { thrown: cli.thrown, llmCalls: cli.llmCalls, dbInsightTypes: cli.db.insights.map((i: any) => i.type) },
      });
    });
  });
});
