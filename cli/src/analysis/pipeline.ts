/**
 * analyzeSessionPipeline — the single implementation of session analysis.
 *
 * CLI (`insights`), the queue worker, the dashboard/server routes and (later) the GEPA
 * adapter all analyze a session through this function, so the same session produces the
 * same prompt text regardless of entry point. The caller supplies only an AnalysisRunner
 * (native CLI runner or provider transport); everything else is owned here:
 *
 *   load session + messages -> format -> related insights -> long-session retrieval ->
 *   architecture context + rage-loop signal -> (chunk + merge when over the runner's token
 *   budget) -> jsonrepair/parse -> persist (insights, facets, steps, title) -> usage + cost ->
 *   prompt-quality pass
 *
 * Behavior differences that existed between the two former pipelines are resolved in
 * goals/gepa-optimization-dashboard/pipeline-map.md ("Resolutions").
 *
 * Failures are returned, never thrown: `{ success: false, error_type, ... }`. Callers that
 * want exceptions (the CLI command) convert the result themselves.
 */

import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { jsonrepair } from 'jsonrepair';
import { getDb } from '../db/client.js';
import { loadConfig } from '../utils/config.js';
import type { ContentBlock } from '../llm/types.js';
import type { RetrievalConfig } from '../embeddings/retrieval.js';
import type { EmbeddingConfig } from '../embeddings/types.js';
import type { AnalysisResponse, PromptQualityResponse, SessionMetadata, SQLiteMessageRow } from './prompt-types.js';
import type { AnalysisRunner, RunAnalysisResult } from './runner-types.js';
import { formatMessagesForAnalysis, classifyStoredUserMessage } from './message-format.js';
import { detectRageLoopHeuristic, type RageLoopSignal } from './loop-detector.js';
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

// ── Constants ─────────────────────────────────────────────────────────────────

/** Budget used for retrieval config and prompt-quality truncation when the runner declares none. */
export const DEFAULT_MAX_INPUT_TOKENS = 80_000;

/** Prompt-quality hard timeout (was server-only; provider transports honor the signal). */
const PROMPT_QUALITY_TIMEOUT_MS = 120_000;

const ARCHITECTURE_TIMEOUT_MS = 15_000;

/** Minimum genuine human messages for a prompt-quality analysis to be meaningful. */
const MIN_HUMAN_MESSAGES_FOR_PQ = 2;

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

export type AnalysisPass = 'session' | 'prompt_quality';

export interface PipelineProgress {
  phase: 'loading_messages' | 'analyzing' | 'saving';
  currentChunk?: number;
  totalChunks?: number;
}

/**
 * Student identity (runner + model + variant). Reserved for plan steps 8-10: accepted and
 * echoed in the result today, not yet written to rows.
 */
export interface PipelineIdentity {
  runner: string;
  model: string | null;
  variant: string | null;
}

/** Reserved for plan step 10 (prompt resolution). Echoed in the result today. */
export interface PromptResolution {
  promptVersionId: string | null;
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
  identity?: PipelineIdentity;
  promptResolution?: PromptResolution;
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
  durationMs: number;
  chunkCount: number;
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
  /** Insight rows persisted by the completed passes. */
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
  identity?: PipelineIdentity;
  promptVersionId?: string | null;
}

export interface PipelineFailure {
  success: false;
  sessionId: string;
  /** User-facing message. */
  error: string;
  /** e.g. session_not_found, no_messages, insufficient_messages, abort, api_error, json_parse_error, no_json_found, invalid_structure. */
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

// ── Shared helpers (also used by the server facet backfill) ───────────────────

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
    let toolResults: Array<{ output?: string }> = [];
    try {
      toolResults = message.tool_results ? JSON.parse(message.tool_results) as Array<{ output?: string }> : [];
    } catch {
      toolResults = [];
    }

    const messageText = [
      message.content,
      message.thinking?.slice(0, 1000) ?? '',
      ...toolResults.map(r => (r.output || '').slice(0, 500)),
    ].join(' ');
    const messageTokens = estimateTokens(messageText);

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

function deduplicateByTitle<T extends { title: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const normalized = item.title.toLowerCase().trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/** Merge per-chunk responses: first summary wins, decisions capped at 3, learnings at 5. */
export function mergeAnalysisResponses(responses: AnalysisResponse[]): AnalysisResponse {
  if (responses.length === 0) {
    return { summary: { title: 'Analysis failed', content: '', bullets: [] }, decisions: [], learnings: [] };
  }
  if (responses.length === 1) return responses[0];

  const merged: AnalysisResponse = { summary: responses[0].summary, decisions: [], learnings: [] };
  for (const response of responses) {
    merged.decisions.push(...response.decisions);
    merged.learnings.push(...response.learnings);
  }
  merged.decisions = deduplicateByTitle(merged.decisions).slice(0, 3);
  merged.learnings = deduplicateByTitle(merged.learnings).slice(0, 5);
  return merged;
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

// ── Context gathering (every step is non-fatal) ───────────────────────────────

/**
 * Semantically similar past insights for the same project (AutoRefine). "Configured" means the
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

    const candidates = querySimilarFiltered(db, 'insight', embedding.vector, settings.topK, session.project_id);
    if (candidates.length === 0) return [];

    const ids = candidates.map(c => c.id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT id, type, title, content, confidence FROM insights WHERE id IN (${placeholders})`
    ).all(...ids) as Array<{ id: string; type: string; title: string; content: string; confidence: number }>;
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

/** Retrieval-augmented context block for very long conversations ('' when not used). */
async function buildRetrievalContext(
  session: SessionData,
  messages: SQLiteMessageRow[],
  formattedMessages: string,
  sessionMeta: SessionMetadata | undefined,
  settings: typeof DEFAULT_RETRIEVAL_SETTINGS,
  maxInputTokens: number,
  embeddingConfig: EmbeddingConfig,
  log: (m: string) => void,
): Promise<string> {
  try {
    const { shouldUseRetrieval, retrieveAnalysisChunks, generateSessionSummary } = await import('../embeddings/retrieval.js');
    // Trigger uses the module default threshold (~102k estimated tokens), as both former paths did.
    if (!shouldUseRetrieval(formattedMessages)) return '';

    const { checkEmbeddingReadiness, chunkAndEmbedSession } = await import('../embeddings/analysis-pipeline.js');
    log('Long conversation detected, checking retrieval readiness...');

    const readiness = checkEmbeddingReadiness(getDb(), session.id);
    if (!readiness.ready) {
      log(`Computing embeddings for ${readiness.status.total || messages.length} chunks...`);
      const chunkResult = await chunkAndEmbedSession(session.id, messages, embeddingConfig);
      if (!chunkResult.embedded) {
        log(`Embedding failed: ${chunkResult.error}. Falling back to full conversation.`);
      }
    }

    const config: RetrievalConfig = { ...settings, maxInputTokens, retrievalThresholdRatio: 0.8 };
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
    return `\n\n${retrieved.augmentedChunks}\n\n`;
  } catch {
    return '';
  }
}

/**
 * Project architecture from codebase-memory-mcp when installed and the project is indexed.
 * Async (execFile) because the server runs this inside its event loop; 15 s cap.
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
    return stdout.trim() ? `\n\n<project_architecture>\n${stdout.trim()}\n</project_architecture>\n` : '';
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
 * One prompt text for every runner: `<conversation block><rest>`. Anthropic-backed runners also
 * get it split into [cached conversation block, rest]; flattening the blocks reproduces
 * `userPrompt` exactly, so the hash does not depend on the transport.
 */
function buildPrompt(runner: AnalysisRunner, conversation: string, rest: string): BuiltPrompt {
  const block = buildCacheableConversationBlock(conversation);
  const userPrompt = `${block.text}${rest}`;
  if (runner.provider !== 'anthropic') return { userPrompt };
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

  add(r: Pick<RunAnalysisResult, 'inputTokens' | 'outputTokens' | 'cacheCreationTokens' | 'cacheReadTokens'>): void {
    this.inputTokens += r.inputTokens ?? 0;
    this.outputTokens += r.outputTokens ?? 0;
    this.cacheCreationTokens += r.cacheCreationTokens ?? 0;
    this.cacheReadTokens += r.cacheReadTokens ?? 0;
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

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : signal;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

// ── The pipeline ──────────────────────────────────────────────────────────────

export async function analyzeSessionPipeline(
  sessionId: string,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const { runner, onProgress, signal } = options;
  const log = options.log ?? (() => {});
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
    let wantPQ = requested.includes('prompt_quality');
    const skipped: PipelineSuccess['skipped'] = {};
    if (wantPQ && humanMessages.length < MIN_HUMAN_MESSAGES_FOR_PQ) {
      const reason = `Not enough user messages to analyze prompt quality (need at least ${MIN_HUMAN_MESSAGES_FOR_PQ}).`;
      if (!wantSession) return failure({ error: reason, error_type: 'insufficient_messages', failedPass: 'prompt_quality' });
      // Session pass is still useful: skip PQ instead of failing the whole run.
      skipped.prompt_quality = reason;
      wantPQ = false;
    }

    // 3. Shared inputs
    const estimate = runner.estimateTokens ? runner.estimateTokens.bind(runner) : defaultEstimateTokens;
    const budget = runner.maxInputTokens;
    const formatted = formatMessagesForAnalysis(messages);
    const sessionMeta = buildSessionMeta(session);
    const architectureContext = await loadArchitectureContext(session.project_name);

    const reports: PipelineSuccess['reports'] = {};
    let sessionResponse: AnalysisResponse | undefined;
    let pqResponse: PromptQualityResponse | undefined;
    const state: { first?: RunAnalysisResult } = {};
    const allUsage = new UsageTotals();
    let totalDuration = 0;

    const callRunner = async (
      pass: AnalysisPass,
      call: PromptRecord['call'],
      prompt: BuiltPrompt,
      jsonSchema: object | undefined,
      callSignal: AbortSignal | undefined,
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
      return result;
    };

    const record = (pass: AnalysisPass, usage: UsageTotals, last: RunAnalysisResult, durationMs: number, chunkCount: number): PassReport => {
      // Cost needs a priced provider; native runners report none and cost 0.
      const costUsd = runner.provider
        ? calculateAnalysisCost(last.provider, last.model, {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheCreationTokens: usage.cacheCreationTokens,
            cacheReadTokens: usage.cacheReadTokens,
          })
        : 0;
      const report: PassReport = {
        analysisType: pass,
        provider: last.provider,
        model: last.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        cacheReadTokens: usage.cacheReadTokens,
        costUsd,
        durationMs,
        chunkCount,
      };
      saveAnalysisUsage({
        session_id: session.id,
        analysis_type: pass,
        provider: report.provider,
        model: report.model,
        input_tokens: report.inputTokens,
        output_tokens: report.outputTokens,
        cache_creation_tokens: report.cacheCreationTokens,
        cache_read_tokens: report.cacheReadTokens,
        estimated_cost_usd: costUsd,
        duration_ms: durationMs,
        chunk_count: chunkCount,
        session_message_count: messageCount,
      });
      allUsage.add(usage);
      totalDuration += durationMs;
      reports[pass] = report;
      return report;
    };

    // ── Pass 1: session analysis ────────────────────────────────────────────
    if (wantSession) {
      const settings = getRetrievalSettings();
      const embeddingConfig = await defaultEmbeddingConfig();
      const related = await retrieveRelatedInsights(session, formatted, embeddingConfig, settings);
      const retrievalContext = await buildRetrievalContext(
        session, messages, formatted, sessionMeta, settings,
        budget ?? DEFAULT_MAX_INPUT_TOKENS, embeddingConfig, log,
      );
      const loopSignal = detectRageLoopHeuristic(messages);
      const extras = `${retrievalContext}${architectureContext}`;
      const sessionInstructions = (signalForPrompt?: RageLoopSignal) =>
        buildSessionAnalysisInstructions(session.project_name, session.summary, sessionMeta, signalForPrompt, related);

      const singlePrompt = buildPrompt(runner, formatted, `${extras}\n${sessionInstructions(loopSignal)}`);
      const chunked = budget !== undefined && estimate(singlePrompt.userPrompt) > budget;

      const usage = new UsageTotals();
      const passStart = Date.now();
      let chunkCount = 1;
      let last!: RunAnalysisResult;

      if (!chunked) {
        onProgress?.({ phase: 'analyzing', currentChunk: 1, totalChunks: 1 });
        last = await callRunner('session', 'session', singlePrompt, SESSION_ANALYSIS_SCHEMA, signal);
        usage.add(last);
        const parsed = parseAnalysisResponse(last.rawJson);
        if (!parsed.success) {
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
        const chunks = chunkMessages(messages, estimate, budget);
        chunkCount = chunks.length;
        const chunkResponses: AnalysisResponse[] = [];
        for (let i = 0; i < chunks.length; i++) {
          onProgress?.({ phase: 'analyzing', currentChunk: i + 1, totalChunks: chunks.length });
          // The rage-loop turn range is session-global, so chunk prompts omit it; the facet pass
          // below sees the whole conversation and receives it.
          const prompt = buildPrompt(runner, formatMessagesForAnalysis(chunks[i]), `${extras}\n${sessionInstructions(undefined)}`);
          last = await callRunner('session', 'chunk', prompt, SESSION_ANALYSIS_SCHEMA, signal);
          usage.add(last);
          const parsed = parseAnalysisResponse(last.rawJson);
          if (parsed.success) chunkResponses.push(parsed.data);
        }
        if (chunkResponses.length === 0) {
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
            let facetMessages = formatted;
            const facetTokens = estimate(facetMessages);
            if (facetTokens > budget) {
              const targetLength = Math.floor((budget / facetTokens) * facetMessages.length * 0.8);
              facetMessages = facetMessages.slice(0, targetLength) + '\n\n[... conversation truncated for analysis ...]';
            }
            const facetPrompt = buildPrompt(
              runner,
              facetMessages,
              buildFacetOnlyInstructions(session.project_name, session.summary, sessionMeta, loopSignal, related),
            );
            // No jsonSchema: session-analysis.json does not describe a facets-only payload.
            const facetResult = await callRunner('session', 'facets', facetPrompt, undefined, signal);
            last = facetResult;
            usage.add(facetResult);
            const facetJson = extractJsonPayload(facetResult.rawJson);
            if (facetJson) {
              try {
                sessionResponse.facets = JSON.parse(facetJson);
              } catch {
                sessionResponse.facets = JSON.parse(jsonrepair(facetJson));
              }
            }
          } catch (err) {
            // Facets are best-effort on chunked sessions, but cancellation must still propagate.
            if (isAbortError(err)) throw err;
          }
        }
      }

      onProgress?.({ phase: 'saving' });
      // Save new rows first, then delete old non-prompt-quality rows: a failed save keeps old data.
      const sessionInsights = convertToInsightRows(sessionResponse, session);
      saveInsightsToDb(sessionInsights);
      deleteSessionInsights(session.id, {
        excludeTypes: ['prompt_quality'],
        excludeIds: sessionInsights.map(i => i.id),
      });
      if (sessionResponse.facets) saveFacetsToDb(session.id, sessionResponse.facets, ANALYSIS_VERSION);
      if (sessionResponse.step_matrix && sessionResponse.step_matrix.length > 0) {
        saveSessionStepsToDb(session.id, sessionResponse.step_matrix);
      }
      if (sessionResponse.summary?.title) updateSessionTitle(session.id, sessionResponse.summary.title);

      record('session', usage, last, Date.now() - passStart, chunkCount);
      insights.push(...sessionInsights);
      completed.push('session');
    }

    // ── Pass 2: prompt quality ──────────────────────────────────────────────
    if (wantPQ) {
      // Truncate to the budget (80k when the runner declares none).
      const pqBudget = budget ?? DEFAULT_MAX_INPUT_TOKENS;
      let conversation = formatted;
      const tokens = estimate(formatted);
      if (tokens > pqBudget) {
        const targetLength = Math.floor((pqBudget / tokens) * formatted.length * 0.8);
        conversation = formatted.slice(0, targetLength) + '\n\n[... conversation truncated for analysis ...]';
      }

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
      );
      const prompt = buildPrompt(runner, conversation, `${architectureContext}\n${instructions}`);

      onProgress?.({ phase: 'analyzing' });
      const usage = new UsageTotals();
      const passStart = Date.now();
      const result = await callRunner('prompt_quality', 'prompt_quality', prompt, PROMPT_QUALITY_SCHEMA, combineSignals(signal, PROMPT_QUALITY_TIMEOUT_MS));
      usage.add(result);

      const parsed = parsePromptQualityResponse(result.rawJson);
      if (!parsed.success) {
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
      const pqInsight = convertPQToInsightRow(pqResponse, session);
      saveInsightsToDb([pqInsight]);
      deleteSessionInsights(session.id, { includeOnlyTypes: ['prompt_quality'], excludeIds: [pqInsight.id] });

      record('prompt_quality', usage, result, Date.now() - passStart, 1);
      insights.push(pqInsight);
      completed.push('prompt_quality');
    }

    return {
      success: true,
      sessionId,
      passes: completed,
      skipped,
      ...(sessionResponse && { session: sessionResponse }),
      ...(pqResponse && { promptQuality: pqResponse }),
      insights,
      reports,
      usage: allUsage.toUsage(),
      meta: {
        provider: state.first?.provider ?? runner.name,
        model: state.first?.model ?? runner.name,
        durationMs: totalDuration,
        inputTokens: allUsage.inputTokens,
        outputTokens: allUsage.outputTokens,
        messageCount,
        projectName: session.project_name,
      },
      prompts,
      ...(options.identity && { identity: options.identity }),
      ...(options.promptResolution && { promptVersionId: options.promptResolution.promptVersionId }),
    };
  } catch (error) {
    if (isAbortError(error)) return failure({ error: 'Analysis cancelled', error_type: 'abort' });
    return failure({
      error: error instanceof Error ? error.message : 'Analysis failed',
      error_type: 'api_error',
    });
  }
}

async function defaultEmbeddingConfig(): Promise<EmbeddingConfig> {
  const { DEFAULT_EMBEDDING_CONFIG } = await import('../embeddings/types.js');
  return { ...DEFAULT_EMBEDDING_CONFIG };
}
