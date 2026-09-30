/**
 * analyzeSessionPipeline — the single implementation of session analysis.
 *
 * CLI (`insights`), the queue worker, the dashboard/server routes and (later) the GEPA
 * adapter all analyze a session through this function, so the same session produces the
 * same prompt text regardless of entry point. The caller supplies only an AnalysisRunner
 * (native CLI runner or provider transport); everything else is owned here:
 *
 *   load session + messages -> format -> related insights -> (chunk + merge when over the
 *   runner's token budget | retrieval when a budget-less runner faces a huge conversation) ->
 *   jsonrepair/parse -> persist (insights, facets, steps, title) -> usage + cost ->
 *   prompt-quality pass; `facets` runs the facet-only backfill.
 *
 * Behavior differences that existed between the two former pipelines are resolved in
 * goals/gepa-optimization-dashboard/pipeline-map.md ("Resolutions").
 *
 * Failures are returned, never thrown: `{ success: false, error_type, ... }`. Callers that
 * want exceptions (the CLI command) convert the result themselves.
 */

import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { jsonrepair } from 'jsonrepair';
import { getDb } from '../db/client.js';
import { loadConfig } from '../utils/config.js';
import { DEFAULT_MAX_INPUT_TOKENS } from '../llm/types.js';
import type { ContentBlock } from '../llm/types.js';
import type { RetrievalConfig } from '../embeddings/retrieval.js';
import type { EmbeddingConfig } from '../embeddings/types.js';
import type { AnalysisResponse, PromptQualityResponse, SessionMetadata, SQLiteMessageRow } from './prompt-types.js';
import type { AnalysisRunner, RunAnalysisResult } from './runner-types.js';
import { formatMessagesForAnalysis, classifyStoredUserMessage, countTurns } from './message-format.js';
import { detectRageLoopHeuristic } from './loop-detector.js';
import {
  SHARED_ANALYST_SYSTEM_PROMPT,
  buildCacheableConversationBlock,
  buildSessionAnalysisInstructions,
  buildPromptQualityInstructions,
  buildFacetOnlyInstructions,
  type RelatedInsight,
} from './prompts.js';
import { extractJsonPayload, parseAnalysisResponse, parsePromptQualityResponse } from './response-parsers.js';
import {
  ANALYSIS_VERSION,
  convertToInsightRows,
  convertPQToInsightRow,
  saveInsightsToDb,
  deleteSessionInsights,
  saveFacetsToDb,
  saveSessionStepsToDb,
  updateSessionTitle,
  type InsightRow,
  type SessionData,
} from './analysis-db.js';
import { saveAnalysisUsage } from './analysis-usage-db.js';
import { calculateAnalysisCost } from './analysis-pricing.js';
import { resolveAnalysisPrompt, type PromptOverride } from '../optimization/resolve-prompt.js';
import { identityForCall, identityFromRunner, identityKey, type StudentIdentity } from '../optimization/identity.js';

// Re-exported so there is exactly one definition of the budget (cli/src/llm/types.ts).
export { DEFAULT_MAX_INPUT_TOKENS };

// ── Constants ─────────────────────────────────────────────────────────────────

const ARCHITECTURE_TIMEOUT_MS = 15_000;
/** ~4k tokens of architecture context is plenty; more crowds out the conversation. */
const ARCHITECTURE_MAX_CHARS = 16_000;

/** Minimum genuine human messages for a prompt-quality analysis to be meaningful. */
const MIN_HUMAN_MESSAGES_FOR_PQ = 2;

/** Chunk calls in flight at once (order of results is still the chunk order). */
const CHUNK_CONCURRENCY = 3;

/** Related-insight candidates fetched per wanted insight, so excluding the session's own rows still fills topK. */
const RELATED_OVERFETCH = 3;

const MERGED_DECISION_CAP = 5;
const MERGED_LEARNING_CAP = 8;

// ── Schemas for native runners (--json-schema) ────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));

function loadSchema(filename: string): object | undefined {
  try {
    return JSON.parse(readFileSync(join(HERE, 'schemas', filename), 'utf-8'));
  } catch {
    // Missing schema: runners fall back to text-only prompts.
    return undefined;
  }
}

const SESSION_ANALYSIS_SCHEMA = loadSchema('session-analysis.json');
const PROMPT_QUALITY_SCHEMA = loadSchema('prompt-quality.json');

// ── Public types ──────────────────────────────────────────────────────────────

/** `facets` = facet-only extraction (the backfill for sessions that already have insights). */
export type AnalysisPass = 'session' | 'prompt_quality' | 'facets';

export interface PipelineProgress {
  phase: 'analyzing' | 'saving';
  currentChunk?: number;
  totalChunks?: number;
}

export interface PipelineInput {
  session: SessionData;
  messages: SQLiteMessageRow[];
}

export interface PipelineOptions {
  runner: AnalysisRunner;
  /** Passes to run. Default: session then prompt_quality (what `insights` does). */
  passes?: AnalysisPass[];
  /**
   * Rows the caller already holds (server routes). Without it the pipeline loads the session
   * and its messages from SQLite by id. Must describe the same session as `sessionId`.
   */
  input?: PipelineInput;
  /**
   * Student identity for prompt resolution and provenance (plan step 8). Absent: prompt resolution
   * uses the runner's own metadata and provenance is derived from what the first call reported.
   */
  identity?: StudentIdentity;
  /** Caller-supplied prompt components (GEPA candidates). Absent: resolveAnalysisPrompt decides. */
  promptOverride?: PromptOverride;
  /**
   * Default true. When false, NOTHING is written: no insights, facets, steps, title, usage rows
   * and no embeddings. The result still carries what would have been saved (dry runs / GEPA).
   */
  persist?: boolean;
  /**
   * 'live' (default) gathers architecture context and related insights; 'none' disables both so
   * the prompt depends only on the session (deterministic scoring).
   */
  contexts?: 'live' | 'none';
  /** Prompt-quality call timeout in ms. Default: runner.timeoutMs; null disables. */
  promptQualityTimeoutMs?: number | null;
  onProgress?: (progress: PipelineProgress) => void;
  signal?: AbortSignal;
  /** Human-readable status lines (CLI prints them; the server passes nothing). */
  log?: (message: string) => void;
}

export interface PipelineUsage {
  inputTokens: number;
  outputTokens: number;
  /** Only present when > 0. */
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface PassReport {
  analysisType: AnalysisPass;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Sum of runner-reported call durations. */
  durationMs: number;
  /** Chunks that parsed successfully (1 for unchunked passes). */
  chunkCount: number;
  /** Chunks attempted. */
  chunksTotal: number;
}

/** One prompt sent to the runner. `hash` = sha256(systemPrompt + "\n---\n" + userPrompt). */
export interface PromptRecord {
  pass: AnalysisPass;
  call: 'session' | 'chunk' | 'facets' | 'prompt_quality';
  hash: string;
  length: number;
}

export interface PipelineSuccess {
  success: true;
  sessionId: string;
  /** Passes that ran to completion. */
  passes: AnalysisPass[];
  /** Requested passes that were skipped, with the reason (prompt-quality gate). */
  skipped: Partial<Record<AnalysisPass, string>>;
  session?: AnalysisResponse;
  promptQuality?: PromptQualityResponse;
  facets?: AnalysisResponse['facets'];
  /** Insight rows produced by the completed passes (persisted unless `persist: false`). */
  insights: InsightRow[];
  reports: Partial<Record<AnalysisPass, PassReport>>;
  /** Summed over all passes. */
  usage: PipelineUsage;
  meta: {
    provider: string;
    model: string;
    durationMs: number;
    inputTokens: number;
    outputTokens: number;
    messageCount: number;
    projectName: string;
  };
  prompts: PromptRecord[];
  identity?: StudentIdentity;
  /** Prompt version that produced this analysis; null = built-in. */
  promptVersionId: string | null;
}

export interface PipelineFailure {
  success: false;
  sessionId: string;
  /** User-facing message. */
  error: string;
  /** e.g. session_not_found, no_messages, insufficient_messages, abort, timeout, api_error, json_parse_error, no_json_found, invalid_structure. */
  error_type: string;
  /** Parser detail (what the CLI used to throw). */
  error_message?: string;
  response_length?: number;
  response_preview?: string;
  failedPass?: AnalysisPass;
  /** Passes that completed (and were persisted) before the failure. */
  completedPasses: AnalysisPass[];
  insights: InsightRow[];
  usage?: PipelineUsage;
}

export type PipelineResult = PipelineSuccess | PipelineFailure;

// ── Shared helpers ────────────────────────────────────────────────────────────

function safeParseJson<T>(value: string | null | undefined, defaultValue: T): T {
  if (!value) return defaultValue;
  try {
    return JSON.parse(value) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Session metadata for prompt builders. Undefined when the session has no compactions or slash
 * commands (pre-V6 rows); the rendered prompt is identical either way.
 */
export function buildSessionMeta(session: SessionData): SessionMetadata | undefined {
  const hasCompacts = !!(session.compact_count || session.auto_compact_count);
  const hasSlashCommands = !!session.slash_commands;
  if (!hasCompacts && !hasSlashCommands) return undefined;
  return {
    compactCount: session.compact_count ?? 0,
    autoCompactCount: session.auto_compact_count ?? 0,
    slashCommands: safeParseJson<string[]>(session.slash_commands, []),
  };
}

const defaultEstimateTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Split messages into chunks of at most 0.8 x budget. Sizes use the formatted text of each
 * message (role header, thinking, tool sections included), so chunk prompts really fit.
 */
export function chunkMessages(
  messages: SQLiteMessageRow[],
  estimateTokens: (text: string) => number,
  maxInputTokens: number,
): SQLiteMessageRow[][] {
  const chunks: SQLiteMessageRow[][] = [];
  let currentChunk: SQLiteMessageRow[] = [];
  let currentTokens = 0;
  const chunkLimit = maxInputTokens * 0.8;

  for (const message of messages) {
    const messageTokens = estimateTokens(formatMessagesForAnalysis([message]));
    if (currentTokens + messageTokens > chunkLimit && currentChunk.length > 0) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }
    currentChunk.push(message);
    currentTokens += messageTokens;
  }

  if (currentChunk.length > 0) chunks.push(currentChunk);
  return chunks;
}

/** Take items round-robin across lists (first of each, then second of each, ...), de-duplicated by title. */
function roundRobinByTitle<T extends { title: string }>(lists: T[][], cap: number): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map(l => l.length));
  for (let i = 0; i < longest && out.length < cap; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      const key = item.title.toLowerCase().trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
      if (out.length >= cap) break;
    }
  }
  return out;
}

/**
 * Merge per-chunk responses (in chunk order): first summary wins; decisions (cap 5) and learnings
 * (cap 8) are taken round-robin so late chunks are represented; step matrices are concatenated.
 */
export function mergeAnalysisResponses(responses: AnalysisResponse[]): AnalysisResponse {
  if (responses.length === 0) {
    return { summary: { title: 'Analysis failed', content: '', bullets: [] }, decisions: [], learnings: [] };
  }
  if (responses.length === 1) return responses[0];

  const steps = responses.flatMap(r => r.step_matrix ?? []);
  return {
    summary: responses[0].summary,
    decisions: roundRobinByTitle(responses.map(r => r.decisions), MERGED_DECISION_CAP),
    learnings: roundRobinByTitle(responses.map(r => r.learnings), MERGED_LEARNING_CAP),
    ...(steps.length > 0 && { step_matrix: steps }),
  };
}

/** Keep the start and end of an over-long conversation; the middle is what gets dropped. */
function truncateHeadTail(text: string, budgetTokens: number, estimate: (t: string) => number): string {
  const tokens = estimate(text);
  if (tokens <= budgetTokens) return text;
  const keep = Math.floor((budgetTokens / tokens) * text.length * 0.8);
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${text.slice(0, head)}\n\n[... middle of conversation truncated for analysis ...]\n\n${text.slice(text.length - tail)}`;
}

// ── DB loading ────────────────────────────────────────────────────────────────

interface SessionRow {
  id: string;
  project_id: string;
  project_name: string;
  project_path: string;
  summary: string | null;
  ended_at: string;
  message_count: number;
  compact_count: number | null;
  auto_compact_count: number | null;
  slash_commands: string | null;
}

function loadSessionRow(sessionId: string): SessionRow | undefined {
  return getDb().prepare(`
    SELECT id, project_id, project_name, project_path, summary, ended_at,
           message_count, compact_count, auto_compact_count, slash_commands
    FROM sessions
    WHERE id = ? AND deleted_at IS NULL
  `).get(sessionId) as SessionRow | undefined;
}

function loadMessageRows(sessionId: string): SQLiteMessageRow[] {
  return getDb().prepare(`
    SELECT id, session_id, type, content, thinking, tool_calls, tool_results, usage, timestamp, parent_id
    FROM messages
    WHERE session_id = ?
    ORDER BY timestamp ASC
  `).all(sessionId) as SQLiteMessageRow[];
}

/** SessionRow uses null for optional columns; SessionData (shared converter contract) uses undefined. */
function toSessionData(row: SessionRow): SessionData {
  return {
    id: row.id,
    project_id: row.project_id,
    project_name: row.project_name,
    project_path: row.project_path,
    summary: row.summary,
    ended_at: row.ended_at,
    compact_count: row.compact_count ?? undefined,
    auto_compact_count: row.auto_compact_count ?? undefined,
    slash_commands: row.slash_commands ?? undefined,
  };
}

// ── Retrieval config ──────────────────────────────────────────────────────────

const DEFAULT_RETRIEVAL_SETTINGS = {
  enabled: true,
  topK: 5,
  similarityThreshold: 0.75,
  sameProjectOnly: true,
};

/** The one retrieval config: dashboard.analysis.retrieval over defaults (topK 5, similarity 0.75). */
function getRetrievalSettings(): typeof DEFAULT_RETRIEVAL_SETTINGS {
  const retrieval = loadConfig()?.dashboard?.analysis?.retrieval;
  return {
    enabled: retrieval?.enabled ?? DEFAULT_RETRIEVAL_SETTINGS.enabled,
    topK: retrieval?.topK ?? DEFAULT_RETRIEVAL_SETTINGS.topK,
    similarityThreshold: retrieval?.similarityThreshold ?? DEFAULT_RETRIEVAL_SETTINGS.similarityThreshold,
    sameProjectOnly: retrieval?.sameProjectOnly ?? DEFAULT_RETRIEVAL_SETTINGS.sameProjectOnly,
  };
}

/** Embedding backend: built-in defaults overridden by dashboard.embedding (model, baseUrl), as `embeddings` does. */
async function resolveEmbeddingConfig(): Promise<EmbeddingConfig> {
  const { DEFAULT_EMBEDDING_CONFIG } = await import('../embeddings/types.js');
  const user = loadConfig()?.dashboard?.embedding;
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    ...(user?.baseUrl ? { baseUrl: user.baseUrl } : {}),
    ...(user?.model ? { model: user.model } : {}),
  };
}

// ── Context gathering (every step is non-fatal) ───────────────────────────────

/**
 * Semantically similar past insights for the same project (AutoRefine), never the session's own
 * rows (a re-analysis would otherwise be shown its previous output). "Configured" means the
 * vec_insights table exists (embeddings were generated) and retrieval is not disabled; any
 * failure (no Ollama, no sqlite-vec) yields no related insights.
 */
async function retrieveRelatedInsights(
  session: { id: string; project_id: string },
  formattedMessages: string,
  embeddingConfig: EmbeddingConfig,
  settings: typeof DEFAULT_RETRIEVAL_SETTINGS,
): Promise<RelatedInsight[]> {
  if (!settings.enabled) return [];

  try {
    const db = getDb();
    const { embedOne } = await import('../embeddings/client.js');
    const { loadVectorExtension, querySimilarFiltered } = await import('../embeddings/store.js');

    loadVectorExtension(db);

    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_insights'"
    ).get() as { name: string } | undefined;
    if (!tableCheck) return [];

    // Truncate to bound embedding cost.
    const maxEmbedChars = 4000;
    const textToEmbed = formattedMessages.length > maxEmbedChars
      ? formattedMessages.slice(0, maxEmbedChars)
      : formattedMessages;
    const embedding = await embedOne(embeddingConfig, `session-${session.id}`, textToEmbed);

    const candidates = querySimilarFiltered(
      db, 'insight', embedding.vector, settings.topK * RELATED_OVERFETCH, session.project_id,
    );
    if (candidates.length === 0) return [];

    const ids = candidates.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, type, title, content, confidence FROM insights WHERE id IN (${placeholders}) AND session_id != ?`
    ).all(...ids, session.id) as Array<{ id: string; type: string; title: string; content: string; confidence: number }>;
    const insightMap = new Map(rows.map(r => [r.id, r]));

    const results: RelatedInsight[] = [];
    for (const candidate of candidates) {
      const insight = insightMap.get(candidate.id);
      if (!insight) continue;
      // cosine similarity ~ 1 - distance for unit vectors
      if (1 - candidate.distance < settings.similarityThreshold) continue;
      results.push({
        type: insight.type,
        title: insight.title,
        content: insight.content.slice(0, 300),
        confidence: insight.confidence,
      });
      if (results.length >= settings.topK) break;
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Retrieved conversation segments for a budget-less runner facing a huge conversation, or ''.
 * Only called above the retrieval threshold; the segments REPLACE the full conversation.
 */
async function buildRetrievedConversation(
  session: SessionData,
  messages: SQLiteMessageRow[],
  formattedMessages: string,
  sessionMeta: SessionMetadata | undefined,
  settings: typeof DEFAULT_RETRIEVAL_SETTINGS,
  embeddingConfig: EmbeddingConfig,
  persist: boolean,
  log: (m: string) => void,
): Promise<string> {
  try {
    const { shouldUseRetrieval, retrieveAnalysisChunks, generateSessionSummary } = await import('../embeddings/retrieval.js');
    // Trigger uses the module default threshold (~102k estimated tokens).
    if (!shouldUseRetrieval(formattedMessages)) return '';

    const { checkEmbeddingReadiness, chunkAndEmbedSession } = await import('../embeddings/analysis-pipeline.js');
    log('Long conversation detected, checking retrieval readiness...');

    const readiness = checkEmbeddingReadiness(getDb(), session.id);
    if (!readiness.ready && persist) {
      // Embedding writes vectors to SQLite, so a dry run (persist: false) never does it.
      log(`Computing embeddings for ${readiness.status.total || messages.length} chunks...`);
      const chunkResult = await chunkAndEmbedSession(session.id, messages, embeddingConfig);
      if (!chunkResult.embedded) {
        log(`Embedding failed: ${chunkResult.error}. Falling back to full conversation.`);
      }
    }

    const config: RetrievalConfig = { ...settings, maxInputTokens: DEFAULT_MAX_INPUT_TOKENS, retrievalThresholdRatio: 0.8 };
    const retrieved = await retrieveAnalysisChunks(
      session.id,
      formattedMessages,
      session.summary || generateSessionSummary(messages),
      session.project_name,
      sessionMeta,
      config,
      embeddingConfig,
    );
    if (!retrieved.usedRetrieval) return '';

    log(`Retrieved ${retrieved.chunkCount} relevant segments (~${retrieved.estimatedTokens} tokens)`);
    return retrieved.augmentedChunks;
  } catch {
    return '';
  }
}

/**
 * Project architecture from codebase-memory-mcp when installed and the project is indexed,
 * capped at ~4k tokens. Async (execFile) because the server runs this inside its event loop.
 */
async function loadArchitectureContext(projectName: string): Promise<string> {
  try {
    const { execFile } = await import('child_process');
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'codebase-memory-mcp',
        ['cli', 'get_architecture'],
        { encoding: 'utf-8', timeout: ARCHITECTURE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
        (err, out) => (err ? reject(err) : resolve(String(out))),
      );
      // Missing binary: spawn fails and stdin emits EPIPE/ENOENT; the callback already rejects.
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ project: projectName }));
    });
    let body = stdout.trim();
    if (!body) return '';
    if (body.length > ARCHITECTURE_MAX_CHARS) body = `${body.slice(0, ARCHITECTURE_MAX_CHARS)}\n[... architecture truncated ...]`;
    return `\n\n<project_architecture>\n${body}\n</project_architecture>\n`;
  } catch {
    // Tool missing, project not indexed, or timeout.
    return '';
  }
}

// ── Prompt assembly + runner calls ────────────────────────────────────────────

interface BuiltPrompt {
  userPrompt: string;
  userContent?: ContentBlock[];
}

/**
 * One prompt text for every runner: `<conversation block><rest>`. When `cache` is set (Anthropic
 * runner and a later pass will reuse the identical conversation block) the prompt is also split
 * into [cached conversation block, rest]; flattening the blocks reproduces `userPrompt` exactly,
 * so the hash does not depend on the transport.
 */
function buildPrompt(conversation: string, rest: string, cache: boolean): BuiltPrompt {
  const block = buildCacheableConversationBlock(conversation);
  const userPrompt = `${block.text}${rest}`;
  if (!cache) return { userPrompt };
  return { userPrompt, userContent: [block, { type: 'text', text: rest }] };
}

function hashPrompt(systemPrompt: string, userPrompt: string): string {
  return createHash('sha256').update(`${systemPrompt}\n---\n${userPrompt}`).digest('hex');
}

class UsageTotals {
  inputTokens = 0;
  outputTokens = 0;
  cacheCreationTokens = 0;
  cacheReadTokens = 0;
  /** Sum of runner-reported call durations (LLM time, excludes retrieval and persistence). */
  durationMs = 0;
  calls = 0;
  costedCalls = 0;
  reportedCostUsd = 0;

  add(r: RunAnalysisResult): void {
    this.calls++;
    this.durationMs += r.durationMs ?? 0;
    this.inputTokens += r.inputTokens ?? 0;
    this.outputTokens += r.outputTokens ?? 0;
    this.cacheCreationTokens += r.cacheCreationTokens ?? 0;
    this.cacheReadTokens += r.cacheReadTokens ?? 0;
    if (r.costUsd !== undefined) {
      this.costedCalls++;
      this.reportedCostUsd += r.costUsd;
    }
  }

  /** Fold another pass's totals into this one (cost bookkeeping stays per pass). */
  merge(o: UsageTotals): void {
    this.inputTokens += o.inputTokens;
    this.outputTokens += o.outputTokens;
    this.cacheCreationTokens += o.cacheCreationTokens;
    this.cacheReadTokens += o.cacheReadTokens;
    this.durationMs += o.durationMs;
  }

  toUsage(): PipelineUsage {
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      ...(this.cacheCreationTokens > 0 && { cacheCreationTokens: this.cacheCreationTokens }),
      ...(this.cacheReadTokens > 0 && { cacheReadTokens: this.cacheReadTokens }),
    };
  }
}

/**
 * Combine the caller's signal with a timeout. Manual (no AbortSignal.any) so it works on every
 * supported Node version; the timeout aborts with a TimeoutError, which the pipeline reports as
 * error_type 'timeout' (distinct from a caller abort).
 */
function withTimeout(signal: AbortSignal | undefined, ms: number | null | undefined): { signal: AbortSignal | undefined; cleanup: () => void } {
  if (!ms) return { signal, cleanup: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${ms}ms`, 'TimeoutError')), ms);
  const onAbort = () => controller.abort(signal!.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function errorName(error: unknown): string | undefined {
  return error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? (error as { name?: string }).name
    : undefined;
}

/** Run `count` jobs with at most `limit` in flight; jobs start in index order. */
async function runPool<T>(count: number, limit: number, job: (index: number) => Promise<T>): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const i = next++;
      results[i] = await job(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, count) }, worker));
  return results;
}

// ── The pipeline ──────────────────────────────────────────────────────────────

export async function analyzeSessionPipeline(
  sessionId: string,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { runner, onProgress, signal } = options;
  const log = options.log ?? (() => {});
  const persist = options.persist ?? true;
  const live = (options.contexts ?? 'live') === 'live';
  const requested = options.passes ?? ['session', 'prompt_quality'];
  const completed: AnalysisPass[] = [];
  const insights: InsightRow[] = [];
  const prompts: PromptRecord[] = [];

  const failure = (f: Omit<PipelineFailure, 'success' | 'sessionId' | 'completedPasses' | 'insights'>): PipelineFailure => ({
    success: false,
    sessionId,
    completedPasses: [...completed],
    insights: [...insights],
    ...f,
  });

  try {
    // 1. Load
    const row = loadSessionRow(sessionId);
    let session: SessionData;
    let messages: SQLiteMessageRow[];
    if (options.input) {
      ({ session, messages } = options.input);
    } else {
      if (!row) return failure({ error: `Session '${sessionId}' not found in local database.`, error_type: 'session_not_found' });
      session = toSessionData(row);
      messages = loadMessageRows(sessionId);
    }
    if (messages.length === 0) {
      return failure({ error: 'No messages found for this session.', error_type: 'no_messages' });
    }
    // sessions.message_count drives resume detection; fall back for caller-supplied rows.
    const messageCount = row?.message_count ?? messages.length;

    // 2. Prompt-quality gate: >= 2 genuine human messages (tool-result rows are type 'user' too).
    const humanMessages = messages.filter(m => m.type === 'user' && classifyStoredUserMessage(m.content) === 'human');
    const wantSession = requested.includes('session');
    const wantFacets = requested.includes('facets');
    let wantPQ = requested.includes('prompt_quality');
    const skipped: PipelineSuccess['skipped'] = {};
    if (wantPQ && humanMessages.length < MIN_HUMAN_MESSAGES_FOR_PQ) {
      const reason = `Not enough user messages to analyze prompt quality (need at least ${MIN_HUMAN_MESSAGES_FOR_PQ}).`;
      if (!wantSession && !wantFacets) return failure({ error: reason, error_type: 'insufficient_messages', failedPass: 'prompt_quality' });
      // Other passes are still useful: skip PQ instead of failing the whole run.
      skipped.prompt_quality = reason;
      wantPQ = false;
    }

    // 3. Shared inputs
    const estimate = runner.estimateTokens ? runner.estimateTokens.bind(runner) : defaultEstimateTokens;
    const budget = runner.maxInputTokens;
    const formatted = formatMessagesForAnalysis(messages);
    const sessionMeta = buildSessionMeta(session);
    const loopSignal = detectRageLoopHeuristic(messages);
    // Resolution happens before any call, so it can only use the caller's identity or the
    // runner's declared metadata. Provenance is recorded later from the actual call result.
    const resolveIdentity = options.identity ?? identityFromRunner(runner);
    const sessionPrompt = options.promptOverride ?? resolveAnalysisPrompt('session-analysis', resolveIdentity);
    const pqPrompt = options.promptOverride ?? resolveAnalysisPrompt('prompt-quality', resolveIdentity);
    const resolveKey = identityKey(resolveIdentity);
    /**
     * Identity that produced a call: the caller's if given, else what the call reported
     * (FallbackNativeRunner reports the primary runner's name even after falling back, so the
     * result's provider/model are the truthful record).
     */
    const identityOf = (result: RunAnalysisResult): StudentIdentity => options.identity ?? identityForCall(runner, result);
    /** Identity for the run summary: the first call's, else the resolve identity. */
    const recordedIdentity = (): StudentIdentity => (state.first ? identityOf(state.first) : resolveIdentity);
    /** Provenance for rows derived from `producer`, the call whose output they hold. */
    const provenanceFor = (prompt: { versionId: string | null }, producer: RunAnalysisResult) => ({
      studentIdentity: identityKey(identityOf(producer)),
      promptVersionId: prompt.versionId,
    });

    const settings = getRetrievalSettings();
    const embeddingConfig = await resolveEmbeddingConfig();
    const related = live && (wantSession || wantFacets)
      ? await retrieveRelatedInsights(session, formatted, embeddingConfig, settings)
      : [];
    // Architecture context is for the single-call session prompt only.
    const architectureContext = live && wantSession ? await loadArchitectureContext(session.project_name) : '';

    const reports: PipelineSuccess['reports'] = {};
    const state: { first?: RunAnalysisResult } = {};
    const allUsage = new UsageTotals();
    /** True once a cache_control block was sent, so the prompt-quality pass can reuse it. */
    let cachedBlockSent = false;

    const callRunner = async (
      pass: AnalysisPass,
      call: PromptRecord['call'],
      prompt: BuiltPrompt,
      jsonSchema: object | undefined,
      callSignal: AbortSignal | undefined,
      resolved: { versionId: string | null },
    ): Promise<RunAnalysisResult> => {
      prompts.push({ pass, call, hash: hashPrompt(SHARED_ANALYST_SYSTEM_PROMPT, prompt.userPrompt), length: prompt.userPrompt.length });
      const result = await runner.runAnalysis({
        systemPrompt: SHARED_ANALYST_SYSTEM_PROMPT,
        userPrompt: prompt.userPrompt,
        jsonSchema,
        ...(prompt.userContent && { userContent: prompt.userContent }),
        ...(callSignal && { signal: callSignal }),
      });
      state.first ??= result;
      // A prompt version is tuned for one identity (found-7). If a fallback runner answered, the
      // version was applied to another student: fail so the queue retries. Built-in prompts
      // (versionId null) are identity-agnostic and may keep falling back.
      if (resolved.versionId !== null) {
        const actualKey = identityKey(identityOf(result));
        if (actualKey !== resolveKey) {
          const err = new Error(
            `Prompt version ${resolved.versionId} is tuned for ${resolveKey} but the call was answered by ${actualKey}; retry later.`,
          );
          err.name = 'IdentityMismatchError';
          throw err;
        }
      }
      return result;
    };

    /** Write the usage row (when persisting) and keep the report. Also used for failed parses: the tokens were spent. */
    const record = (pass: AnalysisPass, usage: UsageTotals, last: RunAnalysisResult, chunksParsed: number, chunksTotal: number): PassReport => {
      const cost = usage.calls > 0 && usage.costedCalls === usage.calls
        ? usage.reportedCostUsd
        : runner.provider
          ? calculateAnalysisCost(last.provider, last.model, {
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              cacheCreationTokens: usage.cacheCreationTokens,
              cacheReadTokens: usage.cacheReadTokens,
            })
          : 0; // native runners report no pricing
      const costUsd = Math.round(cost * 1_000_000) / 1_000_000;
      const report: PassReport = {
        analysisType: pass,
        provider: last.provider,
        model: last.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd,
        durationMs: usage.durationMs,
        chunkCount: chunksParsed,
        chunksTotal,
      };
      if (persist) {
        saveAnalysisUsage({
          session_id: session.id,
          analysis_type: pass === 'facets' ? 'facet' : pass,
          provider: report.provider,
          model: report.model,
          input_tokens: report.inputTokens,
          output_tokens: report.outputTokens,
          cache_creation_tokens: report.cacheCreationTokens,
          cache_read_tokens: report.cacheReadTokens,
          estimated_cost_usd: costUsd,
          duration_ms: report.durationMs,
          chunk_count: chunksParsed,
          session_message_count: messageCount,
        });
      }
      allUsage.merge(usage);
      reports[pass] = report;
      return report;
    };

    /** Facet-only call over the whole conversation (head+tail truncated to the budget). */
    const extractFacets = async (pass: AnalysisPass, usage: UsageTotals): Promise<{ facets?: AnalysisResponse['facets']; result: RunAnalysisResult; parseError?: string }> => {
      const conversation = budget !== undefined ? truncateHeadTail(formatted, budget, estimate) : formatted;
      const prompt = buildPrompt(
        conversation,
        buildFacetOnlyInstructions(session.project_name, session.summary, sessionMeta, loopSignal, related, sessionPrompt.components),
        false,
      );
      // No jsonSchema: session-analysis.json does not describe a facets-only payload.
      const result = await callRunner(pass, 'facets', prompt, undefined, signal, sessionPrompt);
      usage.add(result);
      const payload = extractJsonPayload(result.rawJson);
      if (!payload) return { result };
      try {
        return { facets: JSON.parse(payload), result };
      } catch {
        try {
          return { facets: JSON.parse(jsonrepair(payload)), result };
        } catch (e) {
          return { result, parseError: e instanceof Error ? e.message : 'invalid JSON' };
        }
      }
    };

    // Prompt-quality conversation: full for budget-less (native) runners, head+tail cut otherwise.
    const pqConversation = wantPQ && budget !== undefined ? truncateHeadTail(formatted, budget, estimate) : formatted;

    // ── Pass: session analysis ──────────────────────────────────────────────
    let sessionResponse: AnalysisResponse | undefined;
    if (wantSession) {
      const instructions = (sig?: typeof loopSignal) =>
        buildSessionAnalysisInstructions(session.project_name, session.summary, sessionMeta, sig, related, sessionPrompt.components);

      // Decide chunking BEFORE any retrieval/embedding work.
      const fullPromptText = `${buildCacheableConversationBlock(formatted).text}${architectureContext}\n${instructions(loopSignal)}`;
      const chunked = budget !== undefined && estimate(fullPromptText) > budget;

      // Budget-less runners cannot chunk: above the retrieval threshold, retrieved segments
      // replace the full conversation. Budgeted runners never use retrieval (they chunk instead).
      let conversation = formatted;
      if (budget === undefined) {
        const retrieved = await buildRetrievedConversation(session, messages, formatted, sessionMeta, settings, embeddingConfig, persist, log);
        if (retrieved) conversation = retrieved;
      }

      // Anthropic prompt caching pays off only if the prompt-quality pass sends the identical block.
      const cache = runner.provider === 'anthropic' && wantPQ && !chunked && conversation === formatted && pqConversation === formatted;

      cachedBlockSent = cache;
      const usage = new UsageTotals();
      let last: RunAnalysisResult;
      let chunksParsed = 1;
      let chunksTotal = 1;

      if (!chunked) {
        onProgress?.({ phase: 'analyzing', currentChunk: 1, totalChunks: 1 });
        const prompt = buildPrompt(conversation, `${architectureContext}\n${instructions(loopSignal)}`, cache);
        last = await callRunner('session', 'session', prompt, SESSION_ANALYSIS_SCHEMA, signal, sessionPrompt);
        usage.add(last);
        const parsed = parseAnalysisResponse(last.rawJson);
        if (!parsed.success) {
          record('session', usage, last, 0, 1);
          return failure({
            error: 'Failed to parse LLM response. Please try again.',
            error_type: parsed.error.error_type,
            error_message: parsed.error.error_message,
            response_length: parsed.error.response_length,
            response_preview: parsed.error.response_preview,
            failedPass: 'session',
            usage: usage.toUsage(),
          });
        }
        sessionResponse = parsed.data;
      } else {
        const chunks = chunkMessages(messages, estimate, budget!);
        chunksTotal = chunks.length;

        // Global turn numbering + timestamp continuity, so evidence refs (User#N) never collide across chunks.
        const offsets: Array<{ userStart: number; assistantStart: number; previousTimestamp?: string }> = [];
        let user = 0;
        let assistant = 0;
        chunks.forEach((chunk, i) => {
          offsets.push({ userStart: user, assistantStart: assistant, previousTimestamp: i > 0 ? chunks[i - 1][chunks[i - 1].length - 1].timestamp : undefined });
          const turns = countTurns(chunk);
          user += turns.user;
          assistant += turns.assistant;
        });

        // Chunk prompts carry no retrieval/architecture context: the chunk IS the conversation.
        // The rage-loop turn range is session-global, so they omit it too; the facet pass gets it.
        const results = await runPool(chunks.length, CHUNK_CONCURRENCY, async (i) => {
          onProgress?.({ phase: 'analyzing', currentChunk: i + 1, totalChunks: chunks.length });
          const prompt = buildPrompt(formatMessagesForAnalysis(chunks[i], offsets[i]), `\n${instructions(undefined)}`, false);
          return callRunner('session', 'chunk', prompt, SESSION_ANALYSIS_SCHEMA, signal, sessionPrompt);
        });
        results.forEach(r => usage.add(r));
        last = results[results.length - 1];

        // Parse in chunk order so the merge is order-stable.
        const chunkResponses: AnalysisResponse[] = [];
        for (const r of results) {
          const parsed = parseAnalysisResponse(r.rawJson);
          if (parsed.success) chunkResponses.push(parsed.data);
        }
        chunksParsed = chunkResponses.length;
        if (chunkResponses.length === 0) {
          record('session', usage, last, 0, chunksTotal);
          return failure({
            error: 'All chunks failed to parse LLM response',
            error_type: 'json_parse_error',
            failedPass: 'session',
            usage: usage.toUsage(),
          });
        }
        sessionResponse = mergeAnalysisResponses(chunkResponses);

        // Facets are holistic and cannot be merged across chunks: extract them separately.
        if (!sessionResponse.facets) {
          try {
            const facetOutcome = await extractFacets('session', usage);
            last = facetOutcome.result;
            if (facetOutcome.facets) sessionResponse.facets = facetOutcome.facets;
          } catch (err) {
            // Facets are best-effort on chunked sessions, but cancellation and timeouts must propagate.
            if (errorName(err) === 'AbortError' || errorName(err) === 'TimeoutError' || errorName(err) === 'IdentityMismatchError') throw err;
          }
        }
      }

      onProgress?.({ phase: 'saving' });
      // `last` is the call whose output the rows hold: the single call, or the facet call after a chunk merge.
      const sessionInsights = convertToInsightRows(sessionResponse, session, provenanceFor(sessionPrompt, last));
      if (persist) {
        // Save new rows first, then delete old non-prompt-quality rows: a failed save keeps old data.
        saveInsightsToDb(sessionInsights);
        deleteSessionInsights(session.id, {
          excludeTypes: ['prompt_quality'],
          excludeIds: sessionInsights.map(i => i.id),
        });
        if (sessionResponse.facets) saveFacetsToDb(session.id, sessionResponse.facets, ANALYSIS_VERSION, provenanceFor(sessionPrompt, last));
        if (sessionResponse.step_matrix && sessionResponse.step_matrix.length > 0) {
          saveSessionStepsToDb(session.id, sessionResponse.step_matrix);
        }
        if (sessionResponse.summary?.title) updateSessionTitle(session.id, sessionResponse.summary.title);
      }

      record('session', usage, last, chunksParsed, chunksTotal);
      insights.push(...sessionInsights);
      completed.push('session');
    }

    // ── Pass: prompt quality ────────────────────────────────────────────────
    let pqResponse: PromptQualityResponse | undefined;
    if (wantPQ) {
      // Session shape instead of a raw message count: tool-result rows are type 'user' but
      // are not prompts, so counting them misled the model.
      const assistantCount = messages.filter(m => m.type === 'assistant').length;
      const instructions = buildPromptQualityInstructions(
        session.project_name,
        {
          humanMessageCount: humanMessages.length,
          assistantMessageCount: assistantCount,
          toolExchangeCount: messages.length - humanMessages.length - assistantCount,
        },
        sessionMeta,
        pqPrompt.components,
      );
      // Reuse the session pass's cached block only when it was sent (same conversation text).
      const prompt = buildPrompt(pqConversation, `\n${instructions}`, cachedBlockSent && pqConversation === formatted);

      onProgress?.({ phase: 'analyzing' });
      const usage = new UsageTotals();
      const timeoutMs = options.promptQualityTimeoutMs !== undefined ? options.promptQualityTimeoutMs : runner.timeoutMs;
      const guarded = withTimeout(signal, timeoutMs);
      let result: RunAnalysisResult;
      try {
        result = await callRunner('prompt_quality', 'prompt_quality', prompt, PROMPT_QUALITY_SCHEMA, guarded.signal, pqPrompt);
      } finally {
        guarded.cleanup();
      }
      usage.add(result);

      const parsed = parsePromptQualityResponse(result.rawJson);
      if (!parsed.success) {
        record('prompt_quality', usage, result, 0, 1);
        return failure({
          error: 'Failed to parse prompt quality analysis. Please try again.',
          error_type: parsed.error.error_type,
          error_message: parsed.error.error_message,
          response_length: parsed.error.response_length,
          response_preview: parsed.error.response_preview,
          failedPass: 'prompt_quality',
          usage: usage.toUsage(),
        });
      }
      pqResponse = parsed.data;

      onProgress?.({ phase: 'saving' });
      const pqInsight = convertPQToInsightRow(pqResponse, session, provenanceFor(pqPrompt, result));
      if (persist) {
        saveInsightsToDb([pqInsight]);
        deleteSessionInsights(session.id, { includeOnlyTypes: ['prompt_quality'], excludeIds: [pqInsight.id] });
      }

      record('prompt_quality', usage, result, 1, 1);
      insights.push(pqInsight);
      completed.push('prompt_quality');
    }

    // ── Pass: facets only (backfill) ────────────────────────────────────────
    let facetsOnly: AnalysisResponse['facets'];
    if (wantFacets) {
      onProgress?.({ phase: 'analyzing' });
      const usage = new UsageTotals();
      const outcome = await extractFacets('facets', usage);
      if (!outcome.facets) {
        record('facets', usage, outcome.result, 0, 1);
        return failure({
          error: outcome.parseError ? 'Facet response was not valid JSON.' : 'No JSON in facet response.',
          error_type: outcome.parseError ? 'json_parse_error' : 'no_json_found',
          error_message: outcome.parseError,
          failedPass: 'facets',
          usage: usage.toUsage(),
        });
      }
      facetsOnly = outcome.facets;
      onProgress?.({ phase: 'saving' });
      if (persist) saveFacetsToDb(session.id, facetsOnly, ANALYSIS_VERSION, provenanceFor(sessionPrompt, outcome.result));
      record('facets', usage, outcome.result, 1, 1);
      completed.push('facets');
    }

    return {
      success: true,
      sessionId,
      passes: completed,
      skipped,
      ...(sessionResponse && { session: sessionResponse }),
      ...(pqResponse && { promptQuality: pqResponse }),
      ...(facetsOnly && { facets: facetsOnly }),
      insights,
      reports,
      usage: allUsage.toUsage(),
      meta: {
        provider: state.first?.provider ?? runner.name,
        model: state.first?.model ?? runner.name,
        durationMs: allUsage.durationMs,
        inputTokens: allUsage.inputTokens,
        outputTokens: allUsage.outputTokens,
        messageCount,
        projectName: session.project_name,
      },
      prompts,
      identity: recordedIdentity(),
      promptVersionId: sessionPrompt.versionId,
    };
  } catch (error) {
    const name = errorName(error);
    if (name === 'AbortError') return failure({ error: 'Analysis cancelled', error_type: 'abort' });
    if (name === 'TimeoutError') return failure({ error: 'Analysis timed out', error_type: 'timeout' });
    return failure({
      error: error instanceof Error ? error.message : 'Analysis failed',
      error_type: 'api_error',
    });
  }
}

/**
 * Convert a pipeline failure to the Error the CLI paths throw. Runner/transport errors keep their
 * raw message (the queue worker matches "usage limit reached" in it); parse and structure
 * failures get the pass prefix the `insights` command has always used.
 */
export function pipelineFailureToError(failure: PipelineFailure): Error {
  const raw = ['api_error', 'abort', 'timeout', 'session_not_found', 'no_messages'].includes(failure.error_type);
  if (raw) return new Error(failure.error);
  const pass = failure.failedPass === 'prompt_quality' ? 'Prompt quality analysis' : 'Session analysis';
  return new Error(`${pass} failed: ${failure.error_message ?? failure.error}`);
}
