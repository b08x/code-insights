/**
 * Bulk pre-analysis (plan step 17, logic only; the route lives elsewhere).
 *
 * provider:mistral / provider:openrouter identity -> batch API at a 50% discount.
 * Any other identity                               -> enqueue to analysis_queue (the worker runs it).
 *
 * Batch mode runs the unified pipeline twice per session, with no change to the pipeline itself:
 *   1. collect: the pipeline runs with persist:false against a CollectingRunner that records every
 *      prompt it is asked to send and returns an empty answer (so the pass fails to parse and stops).
 *      Session and prompt-quality passes are collected separately because the second call only
 *      happens after the first parses.
 *   2. submit:  all unique prompts go through submitAndAwait (failed rows re-run synchronously).
 *   3. replay:  the pipeline runs for real against a ReplayRunner that answers each call from the
 *      batch results, matched by sha256(system + user prompt). Parsing, normalization,
 *      persistence and usage rows all go through the pipeline's own code.
 *
 * Calls the collect phase could not foresee (the facet call after a chunked merge, or a prompt that
 * changed because earlier sessions' new insights altered retrieval) miss the result table and fall
 * back to the synchronous transport. Correct, just full price; such calls are priced at list price.
 * Costs: every call reports `costUsd` (batch rows discounted), so the pipeline records the sum.
 */

import { createHash } from 'node:crypto';
import { analyzeSessionPipeline, type PipelineResult } from '../analysis/pipeline.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../analysis/runner-types.js';
import { loadLLMConfig, resolveApiKey } from '../llm/client.js';
import { DEFAULT_TEMPERATURE } from '../llm/types.js';
import {
  BatchJobError,
  BatchTimeoutError,
  listPrice,
  createMistralBatchBackend,
  createOpenRouterBatchBackend,
  submitAndAwait,
  type BatchBackend,
  type BatchRequest,
  type BatchRow,
  type BatchRowSuccess,
  type SubmitSummary,
} from '../llm-batch/index.js';
import type { StudentIdentity } from './identity.js';

export type PreanalyzeMode = 'batch' | 'queue';

export interface PreanalyzeSessionResult {
  sessionId: string;
  /** analyzed: rows persisted. enqueued: handed to analysis_queue. failed: pipeline failure (see error). */
  status: 'analyzed' | 'enqueued' | 'failed';
  error?: string;
  errorType?: string;
  costUsd?: number;
}

export interface PreanalyzeResult {
  mode: PreanalyzeMode;
  sessions: PreanalyzeSessionResult[];
  /** Batch mode only. */
  batch?: SubmitSummary & {
    costUsd: number;
    /** Calls the collect phase did not foresee (e.g. the facet call after a chunked merge) or whose prompt changed; they ran synchronously. */
    replayMisses: number;
    /** Rows resolved synchronously after a failed job's partial output was merged. */
    jobFailureResyncs: number;
    fellBackToQueue?: string;
  };
}

export interface PreanalyzeDeps {
  /** Configured student identity; decides batch vs queue. */
  identity: StudentIdentity;
  /** Synchronous transport for this identity: metadata source and the fallback for failed rows. */
  runner: AnalysisRunner;
  enqueue: (sessionId: string, runnerType: string) => void;
  /** Default: backend for identity.runner from the saved LLM config. */
  createBackend?: (identity: StudentIdentity) => BatchBackend | null;
  /** Test seam; default analyzeSessionPipeline. */
  pipeline?: typeof analyzeSessionPipeline;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

const BATCH_PROVIDERS = new Set(['mistral', 'openrouter']);

/** Provider id when the identity is a batch-capable provider student, else null. */
export function batchProviderOf(identity: StudentIdentity): 'mistral' | 'openrouter' | null {
  if (!identity.runner.startsWith('provider:') || !identity.model) return null;
  const id = identity.runner.slice('provider:'.length);
  return BATCH_PROVIDERS.has(id) ? (id as 'mistral' | 'openrouter') : null;
}

export function chooseMode(identity: StudentIdentity): PreanalyzeMode {
  return batchProviderOf(identity) ? 'batch' : 'queue';
}

function defaultCreateBackend(identity: StudentIdentity): BatchBackend | null {
  const provider = batchProviderOf(identity);
  const llm = loadLLMConfig();
  if (!provider || !identity.model || !llm) return null;
  const apiKey = resolveApiKey(provider, llm.provider === provider ? llm.apiKey : undefined);
  if (!apiKey) return null;
  return provider === 'mistral'
    ? createMistralBatchBackend({ apiKey, model: identity.model })
    : createOpenRouterBatchBackend({ apiKey, model: identity.model });
}

const promptKey = (systemPrompt: string, userPrompt: string): string =>
  createHash('sha256').update(`${systemPrompt}\n---\n${userPrompt}`).digest('hex');

/** Same metadata as `base` so the pipeline makes identical budgeting/identity decisions. */
function wrapRunner(base: AnalysisRunner, runAnalysis: AnalysisRunner['runAnalysis']): AnalysisRunner {
  return {
    name: base.name,
    provider: base.provider,
    model: base.model,
    variant: base.variant,
    maxInputTokens: base.maxInputTokens,
    estimateTokens: base.estimateTokens?.bind(base),
    // No PQ timeout: the collecting call is instant and the replay call never waits on the network.
    timeoutMs: undefined,
    runAnalysis,
  };
}

function emptyResult(base: AnalysisRunner): RunAnalysisResult {
  return { rawJson: '', durationMs: 0, inputTokens: 0, outputTokens: 0, model: base.model ?? base.name, provider: base.provider ?? base.name };
}

/**
 * Runner type for analysis_queue (queue-worker.ts: 'native' -> native CLI runner, anything else ->
 * the dashboard's configured provider). A native/CLI identity must never be run by the provider.
 */
export function runnerTypeFor(identity: StudentIdentity): 'native' | 'provider' {
  return identity.runner.startsWith('provider:') ? 'provider' : 'native';
}

export async function preanalyzeSessions(sessionIds: string[], deps: PreanalyzeDeps): Promise<PreanalyzeResult> {
  const unique = [...new Set(sessionIds)];
  const log = deps.log ?? (() => {});
  const mode = chooseMode(deps.identity);

  const enqueueAll = (ids: string[]): PreanalyzeSessionResult[] =>
    ids.map(sessionId => {
      try {
        deps.enqueue(sessionId, runnerTypeFor(deps.identity));
        return { sessionId, status: 'enqueued' as const };
      } catch (err) {
        return { sessionId, status: 'failed' as const, error: err instanceof Error ? err.message : String(err) };
      }
    });

  if (mode === 'queue') return { mode, sessions: enqueueAll(unique) };

  const backend = (deps.createBackend ?? defaultCreateBackend)(deps.identity);
  if (!backend) {
    // No key/config for the batch API: the queue worker reports the real configuration error per item.
    log('No batch-capable LLM configuration found; enqueueing instead.');
    return { mode: 'queue', sessions: enqueueAll(unique) };
  }

  const pipeline = deps.pipeline ?? analyzeSessionPipeline;
  const base = deps.runner;
  // The batch must be run by the same student the prompts are resolved and recorded for.
  const expectedProvider = batchProviderOf(deps.identity);
  if (backend.provider !== expectedProvider || backend.model !== deps.identity.model || base.model !== deps.identity.model) {
    throw new Error(
      `Batch backend (${backend.provider}/${backend.model}) and runner (${base.provider ?? base.name}/${base.model}) ` +
      `do not match the configured identity ${deps.identity.runner}/${deps.identity.model}.`,
    );
  }
  const common = { identity: deps.identity };

  // ── 1. collect ────────────────────────────────────────────────────────────
  const requests = new Map<string, BatchRequest>();
  /** Sessions that asked for each prompt: identical prompts are billed once, so cost is split. */
  const owners = new Map<string, Set<string>>();
  let collecting = '';
  const collector = wrapRunner(base, async (params: RunAnalysisParams) => {
    const key = promptKey(params.systemPrompt, params.userPrompt);
    if (!owners.has(key)) owners.set(key, new Set());
    owners.get(key)!.add(collecting);
    if (!requests.has(key)) {
      requests.set(key, {
        customId: key,
        body: {
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
          ],
          temperature: DEFAULT_TEMPERATURE,
        },
      });
    }
    return emptyResult(base);
  });
  for (const sessionId of unique) {
    collecting = sessionId;
    for (const pass of ['session', 'prompt_quality'] as const) {
      // Failure is expected (empty answer); a pass that cannot even build a prompt just adds nothing.
      await pipeline(sessionId, { ...common, runner: collector, passes: [pass], persist: false, signal: deps.signal });
    }
  }
  log(`Collected ${requests.size} unique prompts for ${unique.length} sessions.`);

  // ── 2. submit ─────────────────────────────────────────────────────────────
  const syncCall = async (params: RunAnalysisParams): Promise<RunAnalysisResult> => {
    const r = await base.runAnalysis(params);
    if (r.costUsd !== undefined) return r;
    // Full price; undefined (not 0) when the model has no price.
    const cost = listPrice(base.provider ?? r.provider, r.model, r.inputTokens, r.outputTokens);
    return cost === undefined ? r : { ...r, costUsd: cost };
  };

  let rows = new Map<string, BatchRow>();
  let jobFailureResyncs = 0;
  let summary: SubmitSummary = { submitted: 0, jobs: 0, succeeded: 0, failedRows: 0, resynced: 0, resyncFailed: 0, unknownIds: [], unparsed: 0 };
  if (requests.size > 0) {
    try {
      const outcome = await submitAndAwait(backend, [...requests.values()], {
        pollIntervalMs: deps.pollIntervalMs,
        timeoutMs: deps.timeoutMs,
        sleep: deps.sleep,
        signal: deps.signal,
        onProgress: log,
        resync: async (request): Promise<BatchRowSuccess> => {
          const [system, user] = request.body.messages;
          const r = await syncCall({ systemPrompt: system.content, userPrompt: user.content });
          return { customId: request.customId, ok: true, content: r.rawJson, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ...(r.costUsd !== undefined && { costUsd: r.costUsd }) };
        },
      });
      rows = outcome.rows;
      summary = outcome.summary;
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      const salvaged = err instanceof BatchJobError ? err.partialRows.filter(r => r.ok && requests.has(r.customId)) : [];
      if (err instanceof BatchJobError && salvaged.length > 0) {
        // Rows the failed job already produced are billed: keep them and run only the rest synchronously.
        log(`Batch ${err.status} with ${salvaged.length}/${requests.size} rows delivered; running the rest synchronously.`);
        for (const r of salvaged) rows.set(r.customId, r);
        summary = { ...summary, submitted: requests.size, jobs: 1, succeeded: salvaged.length };
        jobFailureResyncs = requests.size - salvaged.length;
      } else if (err instanceof BatchJobError || err instanceof BatchTimeoutError) {
        // Nothing usable: hand the set to the queue worker rather than paying full price inline.
        log(`Batch failed (${err.message}); enqueueing ${unique.length} sessions instead.`);
        return {
          mode,
          sessions: enqueueAll(unique),
          batch: { ...summary, submitted: requests.size, costUsd: 0, replayMisses: 0, jobFailureResyncs: 0, fellBackToQueue: err.message },
        };
      } else {
        throw err;
      }
    }
  }

  // ── 3. replay ─────────────────────────────────────────────────────────────
  let replayMisses = 0;
  const replay = wrapRunner(base, async (params: RunAnalysisParams) => {
    const key = promptKey(params.systemPrompt, params.userPrompt);
    const row = rows.get(key);
    if (row?.ok) {
      // One billed call can feed several sessions (identical prompts): give each its share.
      const share = owners.get(key)?.size || 1;
      return {
        rawJson: row.content,
        durationMs: 0,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        model: base.model ?? base.name,
        provider: base.provider ?? base.name,
        ...(row.costUsd !== undefined && { costUsd: row.costUsd / share }),
      };
    }
    if (!requests.has(key)) replayMisses++;
    return syncCall(params);
  });

  const sessions: PreanalyzeSessionResult[] = [];
  let totalCost = 0;
  for (const sessionId of unique) {
    let result: PipelineResult;
    try {
      result = await pipeline(sessionId, { ...common, runner: replay, signal: deps.signal });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      sessions.push({ sessionId, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (result.success) {
      const costUsd = Object.values(result.reports).reduce((s, r) => s + (r?.costUsd ?? 0), 0);
      totalCost += costUsd;
      sessions.push({ sessionId, status: 'analyzed', costUsd });
    } else {
      sessions.push({ sessionId, status: 'failed', error: result.error, errorType: result.error_type });
    }
  }
  return { mode, sessions, batch: { ...summary, costUsd: Math.round(totalCost * 1_000_000) / 1_000_000, replayMisses, jobFailureResyncs } };
}
