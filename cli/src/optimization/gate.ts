/**
 * Test gate, promotion and adoption (plan step 25; engine-20..24).
 *
 * `runGate` scores a candidate version AND its baseline on the TEST split, the split the optimizer
 * never reads, through the same adapter (real pipeline + cached judge) the engine uses. The
 * baseline is the identity's active version, or the built-in prompt when none is active (or when
 * the candidate itself is the active one, which would compare it with itself). Use a batch
 * backend in `deps` and the two evaluations run through the provider's batch API (engine-20).
 * Results are a complete snapshot: per-session rows in `gate_session_scores` (replaced on every
 * gate run) and a summary in `prompt_versions.test_scores_json`.
 *
 * `promoteVersion` writes `active_prompt_versions` only if the stored gate says the candidate's
 * weighted score beats the baseline's (engine-21). A promotion is blocked, not merely warned, for:
 *   not_gated          the version has no gate result
 *   not_better         candidate score <= baseline score          (override allowed)
 *   stale_gate         the active version or the test labels changed since the gate (override allowed)
 *   unstable_identity  the identity's model is a `*-native` / `*-default` label (never allowed:
 *                      the CLI's default model can change under the label; plan carry-forward 2)
 * `override: true` bypasses only the ones marked allowed. Rolling back is promoting an earlier
 * version, which usually needs `override` (it rarely beats the version that replaced it) (engine-22).
 * Promotion never re-analyzes anything (engine-24); re-analysis is a separate action.
 *
 * `adoptForIdentity` carries a version to another student: it creates a child version for the new
 * identity (same text, parent = the source) and gates it there (engine-23). The child is then
 * promoted like any other version. With no GEPA run involved, the child's `sourceRunId` is null.
 *
 * The gate's test split is small (a handful of sessions at first), so every summary says
 * `indicative` when it has fewer than GATE_CONFIDENT_SESSIONS sessions.
 */

import type Database from 'better-sqlite3';
import type { analyzeSessionPipeline } from '../analysis/pipeline.js';
import type { AnalysisRunner } from '../analysis/runner-types.js';
import { listLabels } from '../db/labels.js';
import {
  createVersion, getActivePromptVersion, getVersion, labelsHash, listGateScores, listVersions, replaceGateScores,
  setActiveVersion, setVersionTestScores, type GateSessionScore, type PromptVersion,
} from '../db/optimization.js';
import type { BatchBackend } from '../llm-batch/index.js';
import type { GuidanceComponents } from '../analysis/prompts.js';
import {
  createAdapter, labelToExample, type AdapterCaps, type AdapterUsage, type EvalMode, type EvaluatedExample,
} from './adapter.js';
import { identityFromRunner, identityKey, isPromotableIdentity, parseIdentityKey, type StudentIdentity } from './identity.js';
import type { Judge } from './judge.js';
import { DEFAULT_WEIGHTS, OBJECTIVES, scalarize, type ObjectiveScores, type Weights } from './metric.js';
import { componentId, OptimizableProgram, validateComponentMap } from './program.js';
import type { RetryOptions } from './retry.js';
import { TARGETS, type AnalysisTarget, type TargetRegistry } from './targets.js';

/** A gate over fewer test sessions than this is labeled indicative. */
export const GATE_CONFIDENT_SESSIONS = 10;

export type GateErrorCode =
  | 'not_found'
  | 'invalid_version'
  | 'no_test_labels'
  | 'identity_mismatch'
  | 'same_identity'
  | 'aborted'
  | 'incomplete'
  | 'not_gated'
  | 'not_better'
  | 'stale_gate'
  | 'unstable_identity';

export class GateError extends Error {
  constructor(readonly code: GateErrorCode, message: string) {
    super(message);
    this.name = 'GateError';
  }
}

export interface GateDeps {
  /** Student transport for the version's identity; its identity must equal the version's. */
  runner: AnalysisRunner;
  judge: Judge;
  /** With a batch backend the gate defaults to batch mode (engine-20). Must match the identity. */
  batch?: BatchBackend;
  /** Default: 'batch' with a backend, else 'sync' for provider runners, 'cli' for native runners. */
  mode?: EvalMode;
  /** Default: the weights stored on the version, else DEFAULT_WEIGHTS. */
  weights?: Weights;
  /** Student caps; a gate that stops on a cap is incomplete and stores nothing. */
  caps?: AdapterCaps;
  signal?: AbortSignal;
  log?: (message: string) => void;
  registry?: TargetRegistry;
  // Tuning and test seams, forwarded to the adapter.
  retry?: RetryOptions;
  concurrency?: number;
  pollIntervalMs?: number;
  batchTimeoutMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pipeline?: typeof analyzeSessionPipeline;
}

export interface GateSide {
  /** Mean per-objective scores over the test sessions. */
  scores: ObjectiveScores;
  /** scalarize(scores, weights): the number promotion compares. */
  scalar: number;
  /** Sessions whose pipeline run failed (they score zero). */
  failedSessions: number;
}

/** What is stored in `prompt_versions.test_scores_json`. */
export interface GateSummary {
  gatedAt: string;
  mode: EvalMode;
  judgeModel: string;
  weights: Record<string, number>;
  /** Content hash of the test labels the gate scored against. */
  labelsHash: string;
  sessions: number;
  /** True when `sessions` < GATE_CONFIDENT_SESSIONS: treat the delta as a hint. */
  indicative: boolean;
  candidate: GateSide;
  baseline: GateSide & {
    /** The version compared against; null = the built-in prompt. */
    versionId: string | null;
  };
  /** candidate.scalar - baseline.scalar. */
  delta: number;
  beatsBaseline: boolean;
  usage: { candidate: AdapterUsage; baseline: AdapterUsage };
}

export interface GateSessionResult {
  sessionId: string;
  candidate: { scores: ObjectiveScores; scalar: number; analysis: unknown; error: string | null };
  baseline: { scores: ObjectiveScores; scalar: number; analysis: unknown; error: string | null };
  /** candidate.scalar - baseline.scalar */
  delta: number;
}

export interface GateResult {
  versionId: string;
  summary: GateSummary;
  /** Per test session, sorted by session id (the delta table and side-by-side view of engine-29). */
  sessions: GateSessionResult[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Version components -> a complete candidate map (keys the version omits use the built-in text). */
export function componentMapFor(
  target: AnalysisTarget,
  components: GuidanceComponents,
  registry: TargetRegistry = TARGETS,
): Record<string, string> {
  return Object.fromEntries(
    registry[target].mutable.map(c => [componentId(target, c.key), components[c.key] ?? c.builtIn]),
  );
}

function versionIdentity(version: PromptVersion): StudentIdentity {
  const identity = parseIdentityKey(version.identityKey);
  if (!identity) throw new GateError('invalid_version', `Version ${version.id} has an unreadable identity key "${version.identityKey}".`);
  return identity;
}

const round = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

function meanVector(vectors: ReadonlyArray<Readonly<Record<string, number>>>): ObjectiveScores {
  const out = Object.fromEntries(OBJECTIVES.map(o => [o, 0])) as ObjectiveScores;
  for (const o of OBJECTIVES) out[o] = vectors.length ? vectors.reduce((s, v) => s + (v[o] ?? 0), 0) / vectors.length : 0;
  return out;
}

// ── Gate ─────────────────────────────────────────────────────────────────────

/**
 * Score a version and its baseline on the test split and store the result. Throws GateError
 * (nothing stored) when there are no test labels, the version or runner is unusable, or the gate
 * was cancelled / hit a cap / lost its batch job: a partial gate would compare unequal evidence.
 */
export async function runGate(db: Database.Database, versionId: string, deps: GateDeps): Promise<GateResult> {
  const registry = deps.registry ?? TARGETS;
  const version = getVersion(db, versionId);
  if (!version) throw new GateError('not_found', `Prompt version not found: ${versionId}`);
  const target = version.target as AnalysisTarget;
  if (!registry[target]?.enabled) throw new GateError('invalid_version', `Target "${version.target}" is not enabled.`);
  const identity = versionIdentity(version);

  const runnerKey = identityKey(identityFromRunner(deps.runner));
  if (runnerKey !== version.identityKey) {
    throw new GateError('identity_mismatch', `The student runner is ${runnerKey} but version ${version.id} is for ${version.identityKey}.`);
  }
  const candidateMap = componentMapFor(target, version.components, registry);
  const check = validateComponentMap(target, candidateMap, registry);
  if (!check.ok) throw new GateError('invalid_version', `Version ${version.id} cannot be evaluated: ${check.errors.join(' ')}`);

  // The test split only: the optimizer never saw these sessions.
  const examples = listLabels(db, { split: 'test', usableOnly: true }).map(labelToExample);
  if (examples.length === 0) throw new GateError('no_test_labels', 'The test split has no labeled sessions: label more sessions before gating.');

  const active = getActivePromptVersion(db, version.target, version.identityKey);
  const baselineVersion = active && active.id !== version.id ? active : null;
  const baselineMap = baselineVersion
    ? componentMapFor(target, baselineVersion.components, registry)
    : new OptimizableProgram(target, registry).builtInMap();

  const mode: EvalMode = deps.mode ?? (deps.batch ? 'batch' : deps.runner.provider ? 'sync' : 'cli');
  const weights = (deps.weights ?? version.weights ?? DEFAULT_WEIGHTS) as Record<string, number>;

  const evaluate = async (map: Record<string, string>) => {
    const evaluated: EvaluatedExample[] = [];
    const adapter = createAdapter({
      target, mode, identity, runner: deps.runner, judge: deps.judge, batch: deps.batch, weights, caps: deps.caps, registry,
      retry: deps.retry, concurrency: deps.concurrency, pollIntervalMs: deps.pollIntervalMs, batchTimeoutMs: deps.batchTimeoutMs,
      sleep: deps.sleep, signal: deps.signal, pipeline: deps.pipeline, log: deps.log,
      onEvaluated: e => evaluated.push(e),
    });
    const batch = await adapter.evaluate(examples, map);
    return { batch, evaluated, usage: { ...adapter.usage }, stopReason: adapter.stopReason };
  };

  const cand = await evaluate(candidateMap);
  const base = cand.stopReason ? null : await evaluate(baselineMap);
  const stopReason = cand.stopReason ?? base?.stopReason ?? null;
  if (stopReason === 'aborted' || deps.signal?.aborted) throw new GateError('aborted', 'The gate was cancelled; nothing was stored.');
  if (stopReason || !base) {
    throw new GateError('incomplete', `The gate stopped early (${stopReason}); nothing was stored. Raise the cap or check the batch job and run it again.`);
  }

  const side = (r: typeof cand): GateSide => {
    const scores = meanVector(r.batch.scoreVectors ?? r.batch.outputs.map(o => o.scores));
    return { scores, scalar: round(scalarize(scores, weights)), failedSessions: r.usage.failedExamples };
  };
  const candidateSide = side(cand);
  const baselineSide = side(base);
  const delta = round(candidateSide.scalar - baselineSide.scalar);
  const summary: GateSummary = {
    gatedAt: new Date().toISOString(),
    mode,
    judgeModel: deps.judge.model,
    weights,
    labelsHash: labelsHash(db, 'test'),
    sessions: examples.length,
    indicative: examples.length < GATE_CONFIDENT_SESSIONS,
    candidate: candidateSide,
    baseline: { ...baselineSide, versionId: baselineVersion?.id ?? null },
    delta,
    beatsBaseline: candidateSide.scalar > baselineSide.scalar,
    usage: { candidate: cand.usage, baseline: base.usage },
  };

  const rowsFor = (subject: 'candidate' | 'baseline', r: typeof cand) =>
    r.batch.outputs.map(o => {
      const e = r.evaluated.find(x => x.example.sessionId === o.sessionId);
      return {
        subject,
        sessionId: o.sessionId,
        baselineVersionId: baselineVersion?.id ?? null,
        scores: { ...o.scores } as Record<string, number>,
        scalar: round(scalarize(o.scores, weights)),
        analysis: e?.analysis ?? null,
        error: o.errorType ?? null,
      };
    });
  db.transaction(() => {
    replaceGateScores(db, version.id, [...rowsFor('candidate', cand), ...rowsFor('baseline', base)]);
    setVersionTestScores(db, version.id, summary as unknown as Record<string, unknown>);
  })();

  return readGate(db, version.id)!;
}

/** The stored gate of a version (summary + per-session rows), or null when it was never gated. */
export function readGate(db: Database.Database, versionId: string): GateResult | null {
  const version = getVersion(db, versionId);
  const summary = version?.testScores as unknown as GateSummary | null | undefined;
  if (!version || !summary || typeof summary.candidate?.scalar !== 'number') return null;
  const rows = listGateScores(db, versionId);
  const bySubject = (subject: 'candidate' | 'baseline') => new Map(rows.filter(r => r.subject === subject).map(r => [r.sessionId, r]));
  const cand = bySubject('candidate');
  const base = bySubject('baseline');
  const part = (r: GateSessionScore | undefined) => ({
    scores: (r?.scores ?? {}) as ObjectiveScores, scalar: r?.scalar ?? 0, analysis: r?.analysis ?? null, error: r?.error ?? null,
  });
  const ids = [...new Set([...cand.keys(), ...base.keys()])].sort();
  return {
    versionId,
    summary,
    sessions: ids.map(sessionId => ({
      sessionId,
      candidate: part(cand.get(sessionId)),
      baseline: part(base.get(sessionId)),
      delta: round((cand.get(sessionId)?.scalar ?? 0) - (base.get(sessionId)?.scalar ?? 0)),
    })),
  };
}

// ── Promotion ────────────────────────────────────────────────────────────────

export interface PromotionBlocker {
  code: Extract<GateErrorCode, 'not_gated' | 'not_better' | 'stale_gate' | 'unstable_identity'>;
  message: string;
  /** `override: true` can bypass it. */
  overridable: boolean;
}

export interface PromotionCheck {
  /** True when promoteVersion would succeed without `override`. */
  ok: boolean;
  /** True when promoteVersion would succeed with `override: true`. */
  overridable: boolean;
  blockers: PromotionBlocker[];
  /** The active version a promotion would replace; null when the built-in prompt is active. */
  activeVersionId: string | null;
}

/** What blocks promoting this version right now (the UI disables Promote when `ok` is false). */
export function checkPromotion(db: Database.Database, versionId: string): PromotionCheck {
  const version = getVersion(db, versionId);
  if (!version) throw new GateError('not_found', `Prompt version not found: ${versionId}`);
  const blockers: PromotionBlocker[] = [];
  const identity = versionIdentity(version);
  const active = getActivePromptVersion(db, version.target, version.identityKey);

  if (!isPromotableIdentity(identity)) {
    blockers.push({
      code: 'unstable_identity',
      message: `${identity.runner} reports "${identity.model ?? 'no model'}", a label for the CLI's own default model, which can change without notice. Choose an explicit model in Settings and optimize for that.`,
      overridable: false,
    });
  }
  const gate = readGate(db, versionId);
  if (!gate) {
    blockers.push({ code: 'not_gated', message: 'Run the test gate before promoting this version.', overridable: false });
  } else {
    const { summary } = gate;
    if (!summary.beatsBaseline) {
      blockers.push({
        code: 'not_better',
        message: `Test score ${summary.candidate.scalar.toFixed(3)} does not beat the baseline's ${summary.baseline.scalar.toFixed(3)}.`,
        overridable: true,
      });
    }
    const staleReasons: string[] = [];
    if (active?.id !== version.id && (active?.id ?? null) !== summary.baseline.versionId) staleReasons.push('the active version changed after the gate ran');
    if (summary.labelsHash !== labelsHash(db, 'test')) staleReasons.push('the test labels changed after the gate ran');
    if (staleReasons.length > 0) {
      blockers.push({ code: 'stale_gate', message: `The gate is out of date: ${staleReasons.join(' and ')}. Run it again.`, overridable: true });
    }
  }
  return {
    ok: blockers.length === 0,
    overridable: blockers.every(b => b.overridable),
    blockers,
    activeVersionId: active?.id ?? null,
  };
}

export interface PromoteResult {
  versionId: string;
  target: string;
  identityKey: string;
  /** The version this one replaced; null when the built-in prompt was active. */
  previousVersionId: string | null;
  /** True when `override` bypassed at least one blocker. */
  overridden: boolean;
  /** Messages of the blockers that were overridden. */
  overriddenReasons: string[];
}

/**
 * Make the version the active prompt for its (target, identity). Throws GateError with the first
 * blocker's code when blocked (see the header); `override: true` bypasses overridable blockers.
 */
export function promoteVersion(db: Database.Database, versionId: string, opts: { override?: boolean } = {}): PromoteResult {
  const check = checkPromotion(db, versionId);
  const blocked = opts.override ? check.blockers.filter(b => !b.overridable) : check.blockers;
  if (blocked.length > 0) throw new GateError(blocked[0].code, blocked.map(b => b.message).join(' '));
  const version = getVersion(db, versionId)!;
  setActiveVersion(db, version.target, version.identityKey, version.id);
  return {
    versionId: version.id,
    target: version.target,
    identityKey: version.identityKey,
    previousVersionId: check.activeVersionId === version.id ? null : check.activeVersionId,
    overridden: check.blockers.length > 0,
    overriddenReasons: check.blockers.map(b => b.message),
  };
}

// ── Adoption ─────────────────────────────────────────────────────────────────

export interface AdoptResult {
  /** The child version for the new identity (with its gate summary stored). */
  version: PromptVersion;
  gate: GateResult;
  /** False when an earlier adoption of the same source for this identity was reused and re-gated. */
  created: boolean;
}

const sameComponents = (a: GuidanceComponents, b: GuidanceComponents): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Carry `versionId` to `newIdentity` without a GEPA run: create (or reuse) a child version for the
 * identity and gate it with `deps` (whose runner must be the new identity's student). The child
 * stays if the gate throws (cancelled, capped); call runGate on it again. Promotion is a separate step.
 */
export async function adoptForIdentity(
  db: Database.Database,
  versionId: string,
  newIdentity: StudentIdentity,
  deps: GateDeps,
): Promise<AdoptResult> {
  const source = getVersion(db, versionId);
  if (!source) throw new GateError('not_found', `Prompt version not found: ${versionId}`);
  const newKey = identityKey(newIdentity);
  if (newKey === source.identityKey) throw new GateError('same_identity', 'The version already belongs to this identity.');
  if (!isPromotableIdentity(newIdentity)) {
    throw new GateError('unstable_identity', `${newIdentity.runner} uses "${newIdentity.model ?? 'no model'}", a label for the CLI's own default model: a version adopted for it could never be promoted.`);
  }
  const runnerKey = identityKey(identityFromRunner(deps.runner));
  if (runnerKey !== newKey) throw new GateError('identity_mismatch', `The student runner is ${runnerKey} but the adoption is for ${newKey}.`);

  const existing = listVersions(db, { target: source.target, identityKey: newKey })
    .find(v => v.parentVersionId === source.id && sameComponents(v.components, source.components));
  const child = existing ?? createVersion(db, {
    target: source.target,
    identityKey: newKey,
    components: source.components,
    parentVersionId: source.id,
    sourceRunId: null,
    judgeModel: null,
    weights: null,
  });
  const gate = await runGate(db, child.id, deps);
  return { version: getVersion(db, child.id)!, gate, created: !existing };
}
