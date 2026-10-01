import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';
import {
  validateLabelInput, upsertLabel, getLabel, listLabels, deleteLabel,
  getLabelQueueInputs, getLabelProgress, LabelError, CANONICAL_OUTCOMES,
} from '@code-insights/cli/db/labels';
import { rankLabelQueue, noActiveLearningSignal } from '@code-insights/cli/optimization/label-queue';
import { SPLITS, type Split } from '@code-insights/cli/optimization/splits';
import { preanalyzeSessions, batchProviderOf, type PreanalyzeResult } from '@code-insights/cli/optimization/preanalyze';
import { providerIdentity } from '@code-insights/cli/optimization/identity';
import { ProviderRunner } from '@code-insights/cli/analysis/provider-runner';
import { enqueue } from '@code-insights/cli/db/queue';
import { loadConfig } from '@code-insights/cli/utils/config';
import { resolveApiKey } from '@code-insights/cli/llm/client';
import { randomUUID } from 'node:crypto';
import { CANONICAL_FRICTION_CATEGORIES, CANONICAL_PATTERN_CATEGORIES } from '@code-insights/cli/analysis/prompt-constants';

const app = new Hono();

const DEFAULT_QUEUE_LIMIT = 20;
const MAX_QUEUE_LIMIT = 200;

// Static paths are declared before /:sessionId so they are never captured as a session id.

// GET /api/labels/categories — canonical lists the labeling UI offers as pickers.
app.get('/categories', (c) => c.json({
  outcomes: CANONICAL_OUTCOMES,
  frictionCategories: CANONICAL_FRICTION_CATEGORIES,
  patternCategories: CANONICAL_PATTERN_CATEGORIES,
}));

// GET /api/labels/queue?limit= — unlabeled sessions ranked for coverage (label-7).
// The active-learning provider returns nothing until optimization runs exist (v20, phase 3);
// swap noActiveLearningSignal for a DB-backed provider then (label-8).
app.get('/queue', (c) => {
  const db = getDb();
  const requested = parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, MAX_QUEUE_LIMIT) : DEFAULT_QUEUE_LIMIT;

  const { candidates, labeled } = getLabelQueueInputs(db);
  const ranked = rankLabelQueue({ candidates, labeled, signal: noActiveLearningSignal, limit });
  if (ranked.length === 0) return c.json({ queue: [], unlabeledCount: candidates.length });

  const info = new Map(
    (db.prepare(
      `SELECT id, project_name, COALESCE(custom_title, generated_title, summary) AS title
       FROM sessions WHERE id IN (${ranked.map(() => '?').join(',')})`
    ).all(...ranked.map(r => r.sessionId)) as Array<{ id: string; project_name: string; title: string | null }>)
      .map(r => [r.id, r]),
  );
  return c.json({
    queue: ranked.map(r => ({
      ...r,
      projectName: info.get(r.sessionId)?.project_name ?? r.projectId,
      title: info.get(r.sessionId)?.title ?? null,
    })),
    unlabeledCount: candidates.length,
  });
});

// GET /api/labels/progress — counts per split, project and length bucket vs coverage targets (label-12).
app.get('/progress', (c) => c.json(getLabelProgress(getDb())));

// ── POST /api/labels/preanalyze ─────────────────────────────────────────────
// Batch runs take minutes, so the request only validates and starts a background job in this
// process; clients poll GET /api/labels/preanalyze/:jobId. Jobs live in memory only: a server
// restart loses them (already-persisted analyses stay in the DB).

const MAX_PREANALYZE_SESSIONS = 500;
const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 50;

interface PreanalyzeJob {
  jobId: string;
  status: 'running' | 'completed' | 'failed';
  mode: 'batch' | 'queue';
  submitted: number;
  enqueued: number;
  analyzed: number;
  failed: number;
  costUsd?: number;
  fellBackToQueue?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

const jobs = new Map<string, PreanalyzeJob>();

function pruneJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) jobs.delete(id);
  }
  // Hard cap: drop the oldest finished jobs first (Map iterates in insertion order).
  for (const [id, job] of jobs) {
    if (jobs.size <= MAX_JOBS) break;
    if (job.finishedAt) jobs.delete(id);
  }
}

function summarize(job: PreanalyzeJob, result: PreanalyzeResult): void {
  job.mode = result.mode;
  job.enqueued = result.sessions.filter(s => s.status === 'enqueued').length;
  job.analyzed = result.sessions.filter(s => s.status === 'analyzed').length;
  job.failed = result.sessions.filter(s => s.status === 'failed').length;
  if (result.batch) {
    job.costUsd = result.batch.costUsd;
    if (result.batch.fellBackToQueue) job.fellBackToQueue = result.batch.fellBackToQueue;
  }
}

const publicJob = ({ startedAt: _s, finishedAt: _f, ...rest }: PreanalyzeJob) => rest;

app.post('/preanalyze', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const ids = (raw as { sessionIds?: unknown } | null)?.sessionIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(i => typeof i === 'string' && i.length > 0)) {
    return c.json({ error: 'sessionIds must be a non-empty array of strings' }, 400);
  }
  const sessionIds = [...new Set(ids as string[])];
  if (sessionIds.length > MAX_PREANALYZE_SESSIONS) {
    return c.json({ error: `At most ${MAX_PREANALYZE_SESSIONS} sessions per request` }, 400);
  }

  const db = getDb();
  const placeholders = sessionIds.map(() => '?').join(',');
  const existing = new Set(
    (db.prepare(
      `SELECT id FROM sessions WHERE id IN (${placeholders}) AND id NOT IN (SELECT id FROM deleted_sessions)`
    ).all(...sessionIds) as Array<{ id: string }>).map(r => r.id),
  );
  const unknown = sessionIds.filter(i => !existing.has(i));
  if (unknown.length > 0) {
    return c.json({ error: 'Unknown or deleted sessions', unknownSessionIds: unknown.slice(0, 20) }, 400);
  }

  // Identity is always the configured dashboard LLM on the server path. Only mistral/openrouter
  // with a usable key can use the batch API; anything else goes to the queue worker.
  const llm = loadConfig()?.dashboard?.llm;
  const identity = llm ? providerIdentity(llm.provider, llm.model ?? null) : null;
  const apiKey = llm ? resolveApiKey(llm.provider, llm.apiKey) : undefined;

  if (!llm || !identity || !batchProviderOf(identity) || !apiKey) {
    let enqueued = 0;
    for (const id of sessionIds) {
      try { enqueue(id, 'provider'); enqueued++; } catch { /* counted as not enqueued */ }
    }
    return c.json({ mode: 'queue', submitted: sessionIds.length, enqueued });
  }

  pruneJobs();
  const job: PreanalyzeJob = {
    jobId: randomUUID(), status: 'running', mode: 'batch',
    submitted: sessionIds.length, enqueued: 0, analyzed: 0, failed: 0, startedAt: Date.now(),
  };
  jobs.set(job.jobId, job);

  // Detached on purpose. Every failure path (including a synchronous throw while building the
  // runner) lands in job.error so nothing escapes as an unhandled rejection.
  void (async () => {
    try {
      const runner = new ProviderRunner(llm, apiKey);
      const result = await preanalyzeSessions(sessionIds, { identity, runner, enqueue });
      summarize(job, result);
      job.status = 'completed';
    } catch (err) {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    } finally {
      job.finishedAt = Date.now();
    }
  })();

  return c.json(publicJob(job), 202);
});

// GET /api/labels/preanalyze/:jobId — poll a background batch job.
app.get('/preanalyze/:jobId', (c) => {
  pruneJobs();
  const job = jobs.get(c.req.param('jobId'));
  if (!job) return c.json({ error: 'Job not found (it may have expired)' }, 404);
  return c.json(publicJob(job));
});

// GET /api/labels?split=&project=
app.get('/', (c) => {
  const split = c.req.query('split');
  if (split && !(SPLITS as readonly string[]).includes(split)) {
    return c.json({ error: `split must be one of: ${SPLITS.join(', ')}` }, 400);
  }
  const labels = listLabels(getDb(), { split: split as Split | undefined, projectId: c.req.query('project') });
  return c.json({ labels });
});

// GET /api/labels/:sessionId
app.get('/:sessionId', (c) => {
  const label = getLabel(getDb(), c.req.param('sessionId'));
  // 200 {label: null} for an unlabeled session: "no label yet" is a normal state, not an error,
  // and a 404 shows up as a console error in the browser on every first load.
  return c.json({ label: label ?? null });
});

// PUT /api/labels/:sessionId — create or edit. The split is assigned on first write and is never
// read from the request body, so a client cannot choose or change it.
app.put('/:sessionId', async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = validateLabelInput(raw);
  if (!parsed.ok) return c.json({ error: 'Invalid label', details: parsed.errors }, 400);

  try {
    return c.json({ label: upsertLabel(getDb(), c.req.param('sessionId'), parsed.value) });
  } catch (e) {
    if (e instanceof LabelError) return c.json({ error: e.message }, 404);
    throw e;
  }
});

// DELETE /api/labels/:sessionId
app.delete('/:sessionId', (c) => {
  if (!deleteLabel(getDb(), c.req.param('sessionId'))) return c.json({ error: 'Label not found' }, 404);
  return c.json({ success: true });
});

export default app;
