/**
 * Collect / submit / replay: running the real analysis pipeline against a provider batch API
 * without changing the pipeline (plan carry-forward 2; used by preanalyze.ts and the GEPA adapter).
 *
 *   1. collect: the pipeline runs (persist:false) against a collecting runner that records every
 *      prompt it is asked to send and answers empty (or from rows already known, see waves), so the
 *      pass stops where it would have needed the model.
 *   2. submit:  `submitCollected` sends the unique unanswered prompts through submitAndAwait. Failed
 *      rows re-run synchronously; a failed job's delivered rows are kept (they are billed).
 *   3. replay:  the pipeline runs for real against `ReplayTable.runner`, which answers each call
 *      from the batch rows, matched by sha256(system + user prompt). Parsing, normalization and
 *      usage accounting all go through the pipeline's own code.
 *
 * Waves: a pass can need prompts that only exist after earlier answers arrive (the facet call after
 * a chunked merge). Collecting again with the rows so far answers the known prompts and exposes the
 * next ones; repeat until a collection finds nothing new (`collectWaves`). Estimates must count
 * waves, and each wave is a separate batch job.
 *
 * Misses: a replay call whose prompt was never collected, or whose row failed, falls back to the
 * synchronous transport at list price. `replayMisses` counts the never-collected ones and
 * `onSyncFallback` fires for every fallback so callers can count them against a cap.
 *
 * Known limit (carry-forward 2, not done): live contexts (related insights, architecture) are
 * re-gathered at replay time, so a context that changed between collect and replay shows up as a
 * miss. The GEPA adapter avoids this by running with contexts:'none'; preanalyze keeps the old
 * behavior. Injecting captured contexts into the pipeline is future work.
 */

import { createHash } from 'node:crypto';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../analysis/runner-types.js';
import { DEFAULT_TEMPERATURE } from '../llm/types.js';
import {
  BatchJobError,
  BatchTimeoutError,
  listPrice,
  submitAndAwait,
  type BatchBackend,
  type BatchRequest,
  type BatchRow,
  type BatchRowSuccess,
  type SubmitSummary,
} from '../llm-batch/index.js';

export const promptKey = (systemPrompt: string, userPrompt: string): string =>
  createHash('sha256').update(`${systemPrompt}\n---\n${userPrompt}`).digest('hex');

/** Same metadata as `base` so the pipeline makes identical budgeting/identity decisions. */
export function wrapRunner(base: AnalysisRunner, runAnalysis: AnalysisRunner['runAnalysis']): AnalysisRunner {
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

export function emptyResult(base: AnalysisRunner): RunAnalysisResult {
  return { rawJson: '', durationMs: 0, inputTokens: 0, outputTokens: 0, model: base.model ?? base.name, provider: base.provider ?? base.name };
}

/** One billed call on the synchronous transport; priced at list price (undefined, not 0, when unpriced). */
export function makeSyncCall(base: AnalysisRunner): (params: RunAnalysisParams) => Promise<RunAnalysisResult> {
  return async params => {
    const r = await base.runAnalysis(params);
    if (r.costUsd !== undefined) return r;
    const cost = listPrice(base.provider ?? r.provider, r.model, r.inputTokens, r.outputTokens);
    return cost === undefined ? r : { ...r, costUsd: cost };
  };
}

// ── 1. collect ───────────────────────────────────────────────────────────────

export class PromptCollector {
  readonly requests = new Map<string, BatchRequest>();
  /** Owners (sessions) that asked for each prompt: identical prompts are billed once, so cost is split. */
  readonly owners = new Map<string, Set<string>>();
  /** Who is asking right now; set before each pipeline run. */
  owner = '';

  /** `known`: rows from earlier waves; their prompts are answered for real so the pass advances. */
  constructor(private readonly base: AnalysisRunner, private readonly known?: ReplayTable) {}

  runner(): AnalysisRunner {
    return wrapRunner(this.base, async (params: RunAnalysisParams) => {
      const key = promptKey(params.systemPrompt, params.userPrompt);
      if (!this.owners.has(key)) this.owners.set(key, new Set());
      this.owners.get(key)!.add(this.owner);
      if (!this.requests.has(key)) {
        this.requests.set(key, {
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
      const row = this.known?.rows.get(key);
      return row?.ok ? rowResult(this.base, row, 1) : emptyResult(this.base);
    });
  }

  /** Collected prompts the table has no successful row for yet. */
  unanswered(table?: ReplayTable): BatchRequest[] {
    const t = table ?? this.known;
    return [...this.requests.values()].filter(r => !t?.rows.get(r.customId)?.ok);
  }
}

function rowResult(base: AnalysisRunner, row: BatchRowSuccess, share: number): RunAnalysisResult {
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

// ── 2. submit ────────────────────────────────────────────────────────────────

export interface SubmitCollectedOptions {
  backend: BatchBackend;
  requests: BatchRequest[];
  /** Synchronous transport for failed rows (see makeSyncCall). */
  syncCall: (params: RunAnalysisParams) => Promise<RunAnalysisResult>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

export interface SubmitCollectedResult {
  rows: Map<string, BatchRow>;
  summary: SubmitSummary;
  /** Rows resolved synchronously after a failed job's partial output was merged. */
  jobFailureResyncs: number;
}

export const EMPTY_SUMMARY: SubmitSummary = { submitted: 0, jobs: 0, succeeded: 0, failedRows: 0, resynced: 0, resyncFailed: 0, unknownIds: [], unparsed: 0 };

/** The job produced nothing usable; the caller decides the fallback (preanalyze: the queue; the adapter: stop). */
export class BatchUnusableError extends Error {
  constructor(readonly cause: BatchJobError | BatchTimeoutError, readonly submitted: number) {
    super(cause.message);
    this.name = 'BatchUnusableError';
  }
}

export async function submitCollected(opts: SubmitCollectedOptions): Promise<SubmitCollectedResult> {
  const { requests, backend, syncCall, signal } = opts;
  const ids = new Set(requests.map(r => r.customId));
  if (requests.length === 0) return { rows: new Map(), summary: EMPTY_SUMMARY, jobFailureResyncs: 0 };
  try {
    const outcome = await submitAndAwait(backend, requests, {
      pollIntervalMs: opts.pollIntervalMs,
      timeoutMs: opts.timeoutMs,
      sleep: opts.sleep,
      signal,
      onProgress: opts.log,
      resync: async (request): Promise<BatchRowSuccess> => {
        const [system, user] = request.body.messages;
        const r = await syncCall({ systemPrompt: system.content, userPrompt: user.content });
        return { customId: request.customId, ok: true, content: r.rawJson, inputTokens: r.inputTokens, outputTokens: r.outputTokens, ...(r.costUsd !== undefined && { costUsd: r.costUsd }) };
      },
    });
    return { rows: outcome.rows, summary: outcome.summary, jobFailureResyncs: 0 };
  } catch (err) {
    if (signal?.aborted) throw err;
    const salvaged = err instanceof BatchJobError ? err.partialRows.filter(r => r.ok && ids.has(r.customId)) : [];
    if (err instanceof BatchJobError && salvaged.length > 0) {
      // Rows the failed job already produced are billed: keep them and run only the rest synchronously.
      opts.log?.(`Batch ${err.status} with ${salvaged.length}/${requests.length} rows delivered; running the rest synchronously.`);
      return {
        rows: new Map(salvaged.map(r => [r.customId, r])),
        summary: { ...EMPTY_SUMMARY, submitted: requests.length, jobs: 1, succeeded: salvaged.length },
        jobFailureResyncs: requests.length - salvaged.length,
      };
    }
    if (err instanceof BatchJobError || err instanceof BatchTimeoutError) throw new BatchUnusableError(err, requests.length);
    throw err;
  }
}

// ── 3. replay ────────────────────────────────────────────────────────────────

export class ReplayTable {
  readonly rows = new Map<string, BatchRow>();
  /** Replay calls whose prompt was never collected (the collect phase could not foresee them). */
  replayMisses = 0;
  /** Every replay call answered by the synchronous transport (misses and failed rows). */
  syncFallbacks = 0;

  add(rows: Iterable<BatchRow>): void {
    for (const r of rows) this.rows.set(r.customId, r);
  }

  runner(
    base: AnalysisRunner,
    opts: {
      collected: PromptCollector;
      syncCall: (params: RunAnalysisParams) => Promise<RunAnalysisResult>;
      /** Fires before each synchronous fallback; may throw to refuse it (cap reached). */
      onSyncFallback?: () => void;
    },
  ): AnalysisRunner {
    return wrapRunner(base, async (params: RunAnalysisParams) => {
      const key = promptKey(params.systemPrompt, params.userPrompt);
      const row = this.rows.get(key);
      if (row?.ok) {
        // One billed call can feed several owners (identical prompts): give each its share.
        return rowResult(base, row, opts.collected.owners.get(key)?.size || 1);
      }
      if (!opts.collected.requests.has(key)) this.replayMisses++;
      opts.onSyncFallback?.();
      this.syncFallbacks++;
      return opts.syncCall(params);
    });
  }
}

// ── waves ────────────────────────────────────────────────────────────────────

export interface CollectWavesOptions {
  base: AnalysisRunner;
  /** Run the pipeline once per owner against `runner` (persist:false); failure is expected and ignored. */
  collectPass: (runner: AnalysisRunner, setOwner: (owner: string) => void) => Promise<void>;
  /** Submit one wave of prompts; its rows are added to the table by this function's caller-visible return. */
  submit: (requests: BatchRequest[], wave: number) => Promise<Iterable<BatchRow>>;
  table: ReplayTable;
  /** Safety bound. Default 4 (chunk wave, facet wave, and slack). */
  maxWaves?: number;
}

export interface CollectWavesResult {
  /** Union of every wave's collector, for owners/requests lookups in the replay. */
  collected: PromptCollector;
  waves: number;
  submitted: number;
}

/**
 * Collect -> submit repeatedly until a collection finds no unanswered prompt. Returns the last
 * collector (its `requests`/`owners` cover every prompt the final, fully answered collection saw).
 */
export async function collectWaves(opts: CollectWavesOptions): Promise<CollectWavesResult> {
  const maxWaves = opts.maxWaves ?? 4;
  let waves = 0;
  let submitted = 0;
  for (;;) {
    const collector = new PromptCollector(opts.base, opts.table);
    await opts.collectPass(collector.runner(), owner => { collector.owner = owner; });
    const pending = collector.unanswered(opts.table).filter(r => !opts.table.rows.has(r.customId));
    if (pending.length === 0 || waves >= maxWaves) return { collected: collector, waves, submitted };
    waves++;
    submitted += pending.length;
    opts.table.add(await opts.submit(pending, waves));
  }
}
