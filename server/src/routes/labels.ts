import { Hono } from 'hono';
import { getDb } from '@code-insights/cli/db/client';
import {
  validateLabelInput, upsertLabel, getLabel, listLabels, deleteLabel,
  getLabelQueueInputs, getLabelProgress, LabelError, CANONICAL_OUTCOMES,
} from '@code-insights/cli/db/labels';
import { rankLabelQueue, noActiveLearningSignal } from '@code-insights/cli/optimization/label-queue';
import { SPLITS, type Split } from '@code-insights/cli/optimization/splits';
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

// HOOK POINT: POST /api/labels/preanalyze { sessionIds } is added by the batch-API work
// (plan steps 16-17). Declare it here, above the /:sessionId routes.

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
  if (!label) return c.json({ error: 'Label not found' }, 404);
  return c.json({ label });
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
