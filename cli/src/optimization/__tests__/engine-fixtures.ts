/**
 * Shared fixtures for the engine and gate tests: an in-memory database with labeled sessions on
 * explicit splits, a fake student (runner + pipeline) whose analysis quality depends on whether
 * the candidate guidance contains GOOD, a fake judge and a mock teacher. Nothing calls a model.
 *
 * The fake pipeline replaces analyzeSessionPipeline (the adapter's `pipeline` seam) but still
 * calls `options.runner.runAnalysis`, so usage accounting, per-call retry, the batch collector
 * and replay all run for real.
 */
import Database from 'better-sqlite3';
import { AxMockAIService } from '@ax-llm/ax';
import type { PipelineResult } from '../../analysis/pipeline.js';
import type { AnalysisRunner, RunAnalysisParams, RunAnalysisResult } from '../../analysis/runner-types.js';
import { runMigrations } from '../../db/migrate.js';
import type { BatchBackend, BatchRequest, BatchRow } from '../../llm-batch/index.js';
import { createJudge, type Judge, type JudgeCache } from '../judge.js';
import { providerIdentity, type StudentIdentity } from '../identity.js';
import { componentId } from '../program.js';
import type { Split } from '../splits.js';

export const S = 'session-analysis' as const;
export const FRICTION = componentId(S, 'frictionGuidance');
export const PATTERN = componentId(S, 'patternGuidance');

export const MODEL = 'mistral-small-latest';
export const student: StudentIdentity = providerIdentity('mistral', MODEL);
export const nativeStudent: StudentIdentity = { runner: 'claude-code-native', model: 'claude-native', variant: null };

export const noSleep = async () => {};

export function memoryDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

/** Inserts a session and a label on an explicit split (upsertLabel would assign splits itself). */
export function addLabel(db: Database.Database, sessionId: string, split: Split): void {
  if (!db.prepare('SELECT 1 FROM projects WHERE id = ?').get('p1')) {
    db.prepare(`INSERT INTO projects (id, name, path, last_activity) VALUES ('p1', 'P', '/p', '2026-01-01')`).run();
  }
  db.prepare(
    `INSERT INTO sessions (id, project_id, project_name, project_path, started_at, ended_at, message_count, source_tool)
     VALUES (?, 'p1', 'P', '/p', '2026-01-01', '2026-01-01', 10, 'claude-code')`
  ).run(sessionId);
  db.prepare(
    `INSERT INTO session_labels (session_id, outcome, friction_categories_json, pattern_categories_json, key_points_json, forbidden_claims_json, split)
     VALUES (?, 'high', '["wrong-approach"]', '["verification-workflow"]', '["Fixed the bug"]', '["Rewrote auth"]', ?)`
  ).run(sessionId, split);
}

export interface Splits { train: string[]; validation: string[]; test: string[] }

export function seedLabels(db: Database.Database, counts = { train: 4, validation: 3, test: 3 }): Splits {
  const out: Splits = { train: [], validation: [], test: [] };
  for (const split of ['train', 'validation', 'test'] as const) {
    for (let i = 0; i < counts[split]; i++) {
      const id = `${{ train: "tr", validation: "va", test: "te" }[split]}${i}`;
      addLabel(db, id, split);
      out[split].push(id);
    }
  }
  return out;
}

/**
 * The marker a candidate must contain for the fake student to analyze well. Quality is graded so a
 * run has several accepted rounds: GOOD fixes the friction categories, and a guidance revision
 * number of 3 or more (see mockTeacher) also fixes the pattern categories.
 */
export const GOOD = 'GOOD';

const answerFor = (userPrompt: string): string => {
  const revisions = [...userPrompt.matchAll(/revision (\d+)/g)].map(m => Number(m[1]));
  return JSON.stringify({ friction: userPrompt.includes(GOOD), pattern: userPrompt.includes(GOOD) && Math.max(0, ...revisions) >= 3 });
};

export interface FakeStudent {
  runner: AnalysisRunner;
  /** Every runAnalysis call, in order. */
  calls: RunAnalysisParams[];
  /** Session ids the pipeline was asked to analyze, in order. */
  analyzed: string[];
  pipeline: (sessionId: string, options: { runner: AnalysisRunner; promptOverride?: Record<string, { components: Record<string, string | undefined> } | undefined> }) => Promise<PipelineResult>;
}

export interface FakeStudentOptions {
  identity?: StudentIdentity;
  /** Throw this instead of answering on the n-th (0-based) call. */
  failCall?: (n: number) => Error | null;
  /** Called after each analyzed session (cancel tests abort from here). */
  onAnalyze?: (count: number) => void;
  inputTokens?: number;
  outputTokens?: number;
}

export function fakeStudent(opts: FakeStudentOptions = {}): FakeStudent {
  const identity = opts.identity ?? student;
  const native = !identity.runner.startsWith('provider:');
  const calls: RunAnalysisParams[] = [];
  const analyzed: string[] = [];
  const runner: AnalysisRunner = native
    ? { name: identity.runner, model: identity.model ?? undefined, runAnalysis: respond }
    : { name: 'mistral', provider: 'mistral', model: identity.model ?? undefined, maxInputTokens: 80_000, runAnalysis: respond };
  async function respond(params: RunAnalysisParams): Promise<RunAnalysisResult> {
    const n = calls.length;
    calls.push(params);
    const err = opts.failCall?.(n);
    if (err) throw err;
    return {
      rawJson: answerFor(params.userPrompt),
      durationMs: 1,
      inputTokens: opts.inputTokens ?? 1000,
      outputTokens: opts.outputTokens ?? 200,
      model: runner.model!,
      provider: native ? runner.name : 'mistral',
    };
  }
  const pipeline: FakeStudent['pipeline'] = async (sessionId, options) => {
    const guidance = options.promptOverride?.[S]?.components ?? {};
    // The prompt carries the candidate's guidance, like the real formatter does.
    const result = await options.runner.runAnalysis({
      systemPrompt: 'system',
      userPrompt: `${sessionId}\n${guidance.frictionGuidance ?? 'built-in'}\n${guidance.patternGuidance ?? 'built-in'}`,
    });
    if (result.rawJson === '') {
      return { success: false, sessionId, completedPasses: [], insights: [], error: 'empty answer', error_type: 'parse_error' } as unknown as PipelineResult;
    }
    analyzed.push(sessionId);
    opts.onAnalyze?.(analyzed.length);
    const answer = JSON.parse(result.rawJson) as { friction: boolean; pattern: boolean };
    return {
      success: true,
      sessionId,
      passes: ['session', 'facets'],
      skipped: {},
      session: {
        summary: { title: 't', content: 'c', bullets: [] },
        decisions: [],
        learnings: [],
        facets: {
          outcome_satisfaction: 'high',
          friction_points: answer.friction ? [{ category: 'wrong-approach', description: 'd', resolution: 'r' }] : [],
          effective_patterns: answer.pattern ? [{ category: 'verification-workflow', description: 'd' }] : [],
        },
      },
      insights: [], reports: {}, usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens },
      meta: { provider: result.provider, model: result.model, durationMs: 1, inputTokens: result.inputTokens, outputTokens: result.outputTokens, messageCount: 1, projectName: 'P' },
      prompts: [], promptVersionId: null,
    } as unknown as PipelineResult;
  };
  return { runner, calls, analyzed, pipeline: pipeline as FakeStudent['pipeline'] };
}

/** A provider batch backend answering from the same function as the fake runner. Collect-phase calls get an empty answer from the real collector, which the fake pipeline reports as a failure. */
export function fakeBackend(fail?: () => boolean) {
  const submitted: BatchRequest[] = [];
  const byJob = new Map<string, BatchRequest[]>();
  let jobs = 0;
  const backend: BatchBackend = {
    provider: 'mistral',
    model: MODEL,
    maxRequestsPerJob: 1000,
    submit: async reqs => { const id = `job-${++jobs}`; byJob.set(id, [...reqs]); submitted.push(...reqs); return id; },
    poll: async jobId => {
      if (fail?.()) return { state: 'failed', status: 'failed', message: 'provider outage' };
      const rows: BatchRow[] = (byJob.get(jobId) ?? []).map(req => ({
        customId: req.customId, ok: true, content: answerFor(req.body.messages[1].content), inputTokens: 1000, outputTokens: 200, costUsd: 0.001,
      }));
      return { state: 'done', rows };
    },
  };
  return { backend, submitted, jobs: () => jobs };
}

/** A real createJudge over a fake model, so the engine's cache wiring is exercised. */
export function fakeJudgeFactory() {
  const runs: unknown[] = [];
  const created: Judge[] = [];
  const createJudgeWith = (cache: JudgeCache): Judge => {
    const judge = createJudge({
      model: 'fake-judge',
      cache,
      run: async input => {
        runs.push(input);
        return { covered: input.keyPoints.map(() => true), violated: input.forbiddenClaims.map(() => false), rationale: 'fake rationale' };
      },
    });
    created.push(judge);
    return judge;
  };
  return { createJudge: createJudgeWith, runs, created };
}

/**
 * Mock teacher: every reflection reply carries GOOD plus a counter, so each proposal is a new
 * candidate that the fake student scores higher than the built-in text.
 */
export function mockTeacher(reply: (n: number) => string = n => `${GOOD} guidance revision ${n}`) {
  let n = 0;
  let chats = 0;
  const ai = new AxMockAIService({
    features: { functions: false, streaming: false },
    chatResponse: async () => {
      chats++;
      return {
        results: [{ index: 0, content: `Feedback Summary: be more specific\nNew Value: ${reply(++n)}`, finishReason: 'stop' as const }],
        modelUsage: { ai: 'mock', model: 'mock', tokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } },
      };
    },
  } as never);
  return { ai: ai as never, chats: () => chats };
}

export const TEACHER = { provider: 'openai' as const, model: 'gpt-4o' };
