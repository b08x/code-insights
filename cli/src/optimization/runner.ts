/**
 * GEPA optimization orchestration for insight generation prompts.
 *
 * Orchestrates the full optimization lifecycle:
 * 1. Prepare training/validation data from session transcripts
 * 2. Create student (fast/cheap) and teacher (strong) AI services
 * 3. Run GEPA optimization with multi-objective metric
 * 4. Save optimized prompt artifacts with version tracking
 * 5. Return AxParetoResult for downstream consumption
 */

import { ai, AxGEPA, axSerializeOptimizedProgram } from '@ax-llm/ax';
import type { AxParetoResult, AxOptimizationProgress } from '@ax-llm/ax';
import { createInsightProgram, INSIGHT_INSTRUCTION, INSIGHT_OUTPUT_FORMAT } from './flow.js';
import { multiObjectiveMetric, scalarizeScores, type MetricInput } from './legacy-metric.js';
import {
  registerVersion,
  saveArtifact,
  saveScores,
  saveMetadata,
  type OptimizationScores,
  type OptimizationMetadata,
  type ParetoPoint,
} from './prompts.js';
import {
  DEFAULT_TEMPLATE_CONFIG,
  validateInstruction,
  type TemplateConfig,
  type TeacherFeedbackSchema,
} from './templates.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Structured log entry emitted during optimization. */
export interface OptimizationLogEntry {
  /** Timestamp in ISO 8601. */
  timestamp: string;
  /** Logical step that produced this entry. */
  step: OptimizationStep;
  /** Human-readable message. */
  message: string;
  /** Optional structured data attached to the step. */
  data?: Record<string, unknown>;
}

/** Steps in the optimization lifecycle. */
export type OptimizationStep =
  | 'init'
  | 'create-student'
  | 'create-teacher'
  | 'compile-start'
  | 'compile-progress'
  | 'compile-end'
  | 'select-best-point'
  | 'register-version'
  | 'save-artifact'
  | 'save-scores'
  | 'save-metadata'
  | 'complete'
  | 'error'
  | 'retry';

/** Logger function that receives structured log entries during optimization. */
export type OptimizationLogger = (entry: OptimizationLogEntry) => void;

/** Default logger: writes to stderr with [GEPA] prefix when verbose is true. */
function defaultLogger(verbose: boolean): OptimizationLogger {
  return (entry) => {
    if (verbose) {
      process.stderr.write(
        `[GEPA] ${entry.timestamp} [${entry.step}] ${entry.message}` +
        (entry.data ? ` ${JSON.stringify(entry.data)}` : '') +
        '\n'
      );
    }
  };
}

export interface GEPARunnerConfig {
  /** Student AI provider (valid Ax provider name). */
  studentProvider: 'openai' | 'anthropic' | 'mistral' | 'deepseek' | 'cohere' | 'google-gemini';
  studentApiKey: string;
  studentModel: string;
  /** Custom API URL (e.g., OpenRouter endpoint: https://openrouter.ai/api/v1). */
  studentApiUrl?: string;

  /** Teacher AI provider (valid Ax provider name). */
  teacherProvider?: 'openai' | 'anthropic' | 'mistral' | 'deepseek' | 'cohere' | 'google-gemini';
  teacherApiKey?: string;
  teacherModel?: string;
  /** Custom API URL for the teacher provider. */
  teacherApiUrl?: string;

  /** Number of optimization trials (default: 25). */
  numTrials?: number;

  /** Random seed for reproducibility. */
  seed?: number;

  /** Enable verbose logging. */
  verbose?: boolean;

  /** Max metric calls to bound evaluation cost. */
  maxMetricCalls?: number;

  /** Early stopping: stop after N trials without improvement. */
  earlyStoppingTrials?: number;

  /** Minibatch size for evaluation. */
  minibatchSize?: number;

  /** Custom logger for structured optimization step logging.
   *  If not provided, a default stderr logger is used when verbose=true. */
  logger?: OptimizationLogger;

  /** Max retries for transient LLM API errors (rate limit, timeout).
   *  Default: 3. Each retry uses exponential backoff starting at 1s. */
  maxRetries?: number;

  /** Timeout in milliseconds for the entire optimization run.
   *  0 means no timeout. Default: 0. */
  timeoutMs?: number;

  /** Prompt adaptation template configuration.
   *  Controls the teacher evaluation and student mutation prompts.
   *  If not provided, DEFAULT_TEMPLATE_CONFIG is used. */
  templates?: TemplateConfig;

  /**
   * Callback invoked after each evaluation round.
   *
   * Called at the end of each optimization round with the current state
   * of all optimizable components. Use for progress tracking and
   * component-level diagnostics.
   *
   * @param round The current optimization round (1-based).
   * @param components Current values of all optimizable components.
   * @param advice Optimization suggestions for the next round.
   * @param reward The reward score for this round.
   */
  onEvaluation?: (
    round: number,
    components: Record<string, string>,
    advice: Record<string, string>,
    reward: number
  ) => void;

  /**
   * Callback invoked for each individual prediction evaluation.
   *
   * Called every time the metric function processes a prediction.
   * Receives the raw prediction, the training/validation example it was
   * evaluated against, and the resulting metric scores.
   *
   * Use this to inspect what the LLM actually returned and how it was
   * scored — essential for diagnosing parsing failures at the individual
   * prediction level.
   *
   * @param data.prediction The LLM output as parsed by AxFlow.
   * @param data.example The training/validation example used.
   * @param data.scores The metric scores from multiObjectiveMetric.
   */
  onPredictionEval?: (data: {
    prediction: unknown;
    example: { sessionData: string; humanQuality?: number; expectedInsightCount?: number; sessionTopics?: string[] };
    scores: Record<string, number>;
  }) => void;
}

/** Classification of optimization errors. */
export type OptimizationErrorKind =
  | 'validation'       // Bad input (empty data, missing keys)
  | 'rate-limit'       // LLM API rate limit (429)
  | 'timeout'          // LLM or optimization timeout
  | 'auth'             // API key invalid/expired
  | 'network'          // Connection failure
  | 'persistence'      // Filesystem save failure (non-critical)
  | 'compile';         // AxGEPA.compile failed (generic)

export class OptimizationError extends Error {
  readonly kind: OptimizationErrorKind;
  readonly step: OptimizationStep;
  readonly retryable: boolean;

  constructor(kind: OptimizationErrorKind, step: OptimizationStep, message: string, retryable = false) {
    super(message);
    this.name = 'OptimizationError';
    this.kind = kind;
    this.step = step;
    this.retryable = retryable;
  }
}

/** Classify an unknown error from AxGEPA.compile into an OptimizationError. */
function classifyCompileError(error: unknown): OptimizationError {
  const msg = error instanceof Error ? error.message : String(error);

  if (/rate.?limit|429|too.?many.?requests/i.test(msg)) {
    return new OptimizationError('rate-limit', 'compile-start', msg, true);
  }
  if (/timeout|timed.?out|deadline/i.test(msg)) {
    return new OptimizationError('timeout', 'compile-start', msg, true);
  }
  if (/auth|invalid.?key|unauthorized|401|403/i.test(msg)) {
    return new OptimizationError('auth', 'compile-start', msg, false);
  }
  if (/network|connection|ECONNREFUSED|ENOTFOUND|fetch/i.test(msg)) {
    return new OptimizationError('network', 'compile-start', msg, true);
  }
  return new OptimizationError('compile', 'compile-start', msg, false);
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Execute an async operation with retry + exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  logger: OptimizationLogger,
  label: string
): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (rawError) {
      const classified = classifyCompileError(rawError);
      if (!classified.retryable || attempt > maxRetries) {
        throw classified;
      }
      const delayMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s...
      logger({
        timestamp: new Date().toISOString(),
        step: 'retry',
        message: `${label} attempt ${attempt}/${maxRetries} failed (${classified.kind}), retrying in ${delayMs}ms`,
        data: { attempt, maxRetries, errorKind: classified.kind, delayMs },
      });
      await sleep(delayMs);
    }
  }
  // unreachable, but TypeScript needs it
  throw new OptimizationError('compile', 'compile-start', `${label} exhausted retries`);
}

/** Wrap an async operation with a timeout. Rejects with OptimizationError on timeout. */
function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  logger: OptimizationLogger
): Promise<T> {
  if (timeoutMs <= 0) {
    return fn();
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      logger({
        timestamp: new Date().toISOString(),
        step: 'error',
        message: `Optimization timed out after ${timeoutMs}ms`,
        data: { timeoutMs },
      });
      reject(new OptimizationError('timeout', 'compile-start', `Optimization timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export interface TrainingExample {
  sessionData: string;
  humanQuality?: number;
  expectedInsightCount?: number;
  sessionTopics?: string[];
}

export interface GEPARunnerResult {
  paretoResult: AxParetoResult;
  versionId: string;
  optimizedProgram: ReturnType<typeof createInsightProgram>;
  serializedArtifact: Record<string, unknown>;
  selectedPoint: ParetoPoint;
  paretoFront: ParetoPoint[];
}

// ── Helper to create AI service ───────────────────────────────────────────────

export function createAIService(
  provider: string,
  apiKey: string,
  model: string,
  apiUrl?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  const config = apiUrl ? { model, apiURL: apiUrl } : { model };

  // ai() uses a discriminated union: the config type depends on `name`.
  // TypeScript can't narrow this through a switch, so we use per-case `as any`.
  switch (provider) {
    case 'openai':
      return ai({ name: 'openai' as const, apiKey, config } as any);
    case 'anthropic':
      return ai({ name: 'anthropic' as const, apiKey, config } as any);
    case 'mistral':
      return ai({ name: 'mistral' as const, apiKey, config } as any);
    case 'deepseek':
      return ai({ name: 'deepseek' as const, apiKey, config } as any);
    case 'cohere':
      return ai({ name: 'cohere' as const, apiKey, config } as any);
    case 'google-gemini':
      return ai({ name: 'google-gemini' as const, apiKey, config } as any);
    default:
      return ai({ name: 'openai' as const, apiKey, config } as any);
  }
}

// ── Runner ────────────────────────────────────────────────────────────────────

export function createGEPARunner(config: GEPARunnerConfig): GEPARunner {
  return new GEPARunner(config);
}

export class GEPARunner {
  private readonly studentProvider: GEPARunnerConfig['studentProvider'];
  private readonly studentApiKey: string;
  private readonly studentModel: string;
  private readonly studentApiUrl?: string;
  private readonly teacherProvider: Exclude<GEPARunnerConfig['teacherProvider'], undefined>;
  private readonly teacherApiKey: string;
  private readonly teacherModel: string;
  private readonly teacherApiUrl?: string;
  private readonly numTrials: number;
  private readonly minibatchSize: number;
  private readonly earlyStoppingTrials: number;
  private readonly seed?: number;
  private readonly verbose: boolean;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly templates: TemplateConfig;
  private readonly logger: OptimizationLogger;
  private readonly maxMetricCalls?: number;
  private onEvaluation?: (
    round: number,
    components: Record<string, string>,
    advice: Record<string, string>,
    reward: number
  ) => void;
  private onPredictionEval?: (data: {
    prediction: unknown;
    example: { sessionData: string; humanQuality?: number; expectedInsightCount?: number; sessionTopics?: string[] };
    scores: Record<string, number>;
  }) => void;
  private program?: any; // Store the program instance for onProgress callback

  constructor(config: GEPARunnerConfig) {
    this.studentProvider = config.studentProvider;
    this.studentApiKey = config.studentApiKey;
    this.studentModel = config.studentModel;
    this.studentApiUrl = config.studentApiUrl;
    this.teacherProvider = config.teacherProvider ?? config.studentProvider;
    this.teacherApiKey = config.teacherApiKey ?? config.studentApiKey;
    this.teacherModel = config.teacherModel ?? config.studentModel;
    this.teacherApiUrl = config.teacherApiUrl ?? config.studentApiUrl;
    this.numTrials = config.numTrials ?? 25;
    this.seed = config.seed ?? 42;
    this.verbose = config.verbose ?? false;
    this.maxMetricCalls = config.maxMetricCalls ?? 200;
    this.earlyStoppingTrials = config.earlyStoppingTrials ?? 8;
    this.minibatchSize = config.minibatchSize ?? 6;
    this.logger = config.logger ?? defaultLogger(this.verbose);
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 0;
    this.templates = config.templates ?? DEFAULT_TEMPLATE_CONFIG;
    this.onEvaluation = config.onEvaluation;
    this.onPredictionEval = config.onPredictionEval;
  }
  
  // Method for testing purposes only
  createOptimizer(): any {
    const studentAI = createAIService(
      this.studentProvider,
      this.studentApiKey,
      this.studentModel,
      this.studentApiUrl
    );
    
    const teacherAI = createAIService(
      this.teacherProvider,
      this.teacherApiKey,
      this.teacherModel,
      this.teacherApiUrl
    );
    
    const optimizer = new AxGEPA({
      studentAI,
      teacherAI,
      numTrials: this.numTrials,
      minibatch: true,
      minibatchSize: this.minibatchSize,
      earlyStoppingTrials: this.earlyStoppingTrials,
      seed: this.seed,
      verbose: this.verbose,
      onProgress: (progress: Readonly<AxOptimizationProgress>) => {
        this.log('compile-progress', `Trial ${progress.round}/${progress.totalRounds}`, {
          round: progress.round,
          currentScore: progress.currentScore,
          bestScore: progress.bestScore,
          tokensUsed: progress.tokensUsed,
          successfulExamples: progress.successfulExamples,
          totalExamples: progress.totalExamples,
        });
        
        // Invoke onEvaluation callback if provided
        if (this.onEvaluation && progress.round > 0) {
          try {
            // Extract current component values from progress
            const components: Record<string, string> = {};
            
            // Get current component values from the program
            const optimizableComponents = this.program.getOptimizableComponents();
            for (const component of optimizableComponents) {
              components[component.key] = component.current;
            }
            
            // Invoke the callback
            this.onEvaluation(
              progress.round,
              components,
              {}, // advice is not available in AxOptimizationProgress
              progress.currentScore
            );
          } catch (error) {
            this.log('error', 'onEvaluation callback failed', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    });
  }

  private log(step: OptimizationStep, message: string, data?: Record<string, unknown>): void {
    this.logger({
      timestamp: new Date().toISOString(),
      step,
      message,
      data,
    });
  }

  async optimize(
    trainData: TrainingExample[],
    validationData: TrainingExample[] = []
  ): Promise<GEPARunnerResult> {
    if (trainData.length === 0) {
      throw new OptimizationError(
        'validation',
        'init',
        'GEPA optimization requires at least one training example'
      );
    }

    this.log('init', 'Starting GEPA optimization', {
      numTrials: this.numTrials,
      seed: this.seed,
      trainCount: trainData.length,
      valCount: validationData.length,
      studentModel: `${this.studentProvider}/${this.studentModel}`,
      teacherModel: `${this.teacherProvider}/${this.teacherModel}`,
      maxRetries: this.maxRetries,
      timeoutMs: this.timeoutMs,
      templateConfig: {
        maxTeacherResponseTokens: this.templates.maxTeacherResponseTokens,
        maxStudentResponseTokens: this.templates.maxStudentResponseTokens,
        teacherExampleCount: this.templates.teacherExampleCount,
      },
    });

    const studentAI = createAIService(
      this.studentProvider,
      this.studentApiKey,
      this.studentModel,
      this.studentApiUrl
    );
    this.log('create-student', `Student AI service created: ${this.studentProvider}/${this.studentModel}`);

    const teacherAI = createAIService(
      this.teacherProvider,
      this.teacherApiKey,
      this.teacherModel,
      this.teacherApiUrl
    );
    this.log('create-teacher', `Teacher AI service created: ${this.teacherProvider}/${this.teacherModel}`);

    const program = createInsightProgram();
    this.program = program; // Store for onProgress callback

    const metricFn = (input: { prediction: unknown; example: unknown }) => {
      const scores = multiObjectiveMetric(input as MetricInput);
      // Fire the prediction-level callback if provided
      if (this.onPredictionEval) {
        try {
          this.onPredictionEval({
            prediction: input.prediction,
            example: input.example as { sessionData: string; humanQuality?: number; expectedInsightCount?: number; sessionTopics?: string[] },
            scores,
          });
        } catch (err) {
          // Callback errors must not crash the optimization loop
          this.log('error', 'onPredictionEval callback failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return scores;
    };

    this.log('compile-start', 'Calling AxGEPA.compile', {
      minibatch: true,
      minibatchSize: this.minibatchSize,
      earlyStoppingTrials: this.earlyStoppingTrials,
      maxMetricCalls: this.maxMetricCalls,
    });

    // Wire onProgress to our structured logger
    const onProgress = (progress: Readonly<AxOptimizationProgress>) => {
      this.log('compile-progress', `Trial ${progress.round}/${progress.totalRounds}`, {
        round: progress.round,
        currentScore: progress.currentScore,
        bestScore: progress.bestScore,
        tokensUsed: progress.tokensUsed,
        successfulExamples: progress.successfulExamples,
        totalExamples: progress.totalExamples,
      });
    };

    const optimizer = new AxGEPA({
      studentAI,
      teacherAI,
      numTrials: this.numTrials,
      minibatch: true,
      minibatchSize: this.minibatchSize,
      earlyStoppingTrials: this.earlyStoppingTrials,
      seed: this.seed,
      verbose: this.verbose,
      onProgress,
    });

    // Run compile with retry + timeout
    const compileFn = () =>
      optimizer.compile(
        program as unknown as Parameters<typeof optimizer.compile>[0],
        trainData as unknown as Parameters<typeof optimizer.compile>[1],
        metricFn as unknown as Parameters<typeof optimizer.compile>[2],
        {
          validationExamples: validationData.length > 0 ? validationData : trainData,
          maxMetricCalls: this.maxMetricCalls,
          verbose: this.verbose,
        } as unknown as Parameters<typeof optimizer.compile>[3]
      ) as unknown as Promise<AxParetoResult>;

    const result = await withTimeout(
      () => withRetry(compileFn, this.maxRetries, this.logger, 'AxGEPA.compile'),
      this.timeoutMs,
      this.logger
    );

    this.log('compile-end', 'Optimization compile finished', {
      bestScore: result.bestScore,
      paretoFrontSize: result.paretoFrontSize,
      hypervolume: result.hypervolume,
      converged: result.optimizedProgram?.stats?.convergenceInfo?.converged ?? false,
    });

    const selectedPoint = this.selectBestPoint(result);
    this.log('select-best-point', 'Selected best point from Pareto front', {
      scores: selectedPoint.scores,
      dominatedSolutions: selectedPoint.dominatedSolutions,
    });

    if (result.optimizedProgram) {
      this.program.applyOptimizedComponents(result.optimizedProgram);
    }

    // Validate the optimized instruction against template invariants
    const optimizedDescription = (program as unknown as { _description?: string })?._description
      ?? (result.optimizedProgram as unknown as { signature?: { description?: string } })?.signature?.description
      ?? '';
    if (optimizedDescription) {
      const validation = validateInstruction(optimizedDescription, this.templates);
      if (!validation.valid) {
        this.log('error', 'Optimized instruction violates template invariants', {
          violations: validation.violations,
        });
        // Non-fatal: log but don't throw. The optimization result is still valid.
      } else {
        this.log('compile-end', 'Optimized instruction passes template validation');
      }
    }

    const serializedArtifact = result.optimizedProgram
      ? axSerializeOptimizedProgram(result.optimizedProgram)
      : {};

    const scores: OptimizationScores = {
      paretoFront: result.paretoFront.map(p => ({
        scores: p.scores,
        configuration: p.configuration,
        dominatedSolutions: p.dominatedSolutions,
      })),
      selectedPoint: {
        scores: selectedPoint.scores,
        configuration: selectedPoint.configuration,
        dominatedSolutions: selectedPoint.dominatedSolutions,
      },
      selectionMethod: 'weighted-sum',
    };

    const metadata: OptimizationMetadata = {
      versionId: '',
      createdAt: new Date().toISOString(),
      studentModel: `${this.studentProvider}/${this.studentModel}`,
      teacherModel: `${this.teacherProvider}/${this.teacherModel}`,
      trainingExampleCount: trainData.length,
      validationExampleCount: validationData.length,
    };

    const version = registerVersion(
      {
        optimizerType: 'GEPA',
        numTrials: this.numTrials,
        objectives: ['coverage', 'precision', 'actionability', 'brevity', 'prompt_refinement'],
        bestScore: result.bestScore,
        converged: result.optimizedProgram?.stats?.convergenceInfo?.converged ?? false,
        totalRounds: result.optimizedProgram?.stats?.totalCalls ?? 0,
        optimizationTimeMs: result.optimizedProgram?.stats?.resourceUsage?.totalTime ?? 0,
        paretoFrontSize: result.paretoFrontSize,
        hypervolume: result.hypervolume,
      },
      true
    );
    this.log('register-version', `Version registered: ${version.id}`, { versionId: version.id });

    metadata.versionId = version.id;

    // Persistence: save artifacts with graceful error handling.
    // These are non-critical — the optimization result is still valid even if
    // saving to disk fails. We log the error but don't throw.
    try {
      saveArtifact(version.id, serializedArtifact as Record<string, unknown>);
      this.log('save-artifact', `Artifact saved for version ${version.id}`);
    } catch (err) {
      this.log('error', `Failed to save artifact for version ${version.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      saveScores(version.id, scores);
      this.log('save-scores', `Scores saved for version ${version.id}`);
    } catch (err) {
      this.log('error', `Failed to save scores for version ${version.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      saveMetadata(version.id, metadata);
      this.log('save-metadata', `Metadata saved for version ${version.id}`, { metadata });
    } catch (err) {
      this.log('error', `Failed to save metadata for version ${version.id}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.log('complete', 'GEPA optimization complete', {
      versionId: version.id,
      bestScore: result.bestScore,
      paretoFrontSize: result.paretoFrontSize,
    });

    return {
      paretoResult: result,
      versionId: version.id,
      optimizedProgram: program,
      serializedArtifact: serializedArtifact as Record<string, unknown>,
      selectedPoint,
      paretoFront: result.paretoFront.map(p => ({
        scores: p.scores,
        configuration: p.configuration,
        dominatedSolutions: p.dominatedSolutions,
      })),
    };
  }

  private selectBestPoint(result: AxParetoResult): ParetoPoint {
    if (result.paretoFront.length === 0) {
      throw new OptimizationError('validation', 'select-best-point', 'Pareto frontier is empty');
    }

    const weights = {
      coverage: 0.25,
      precision: 0.25,
      actionability: 0.20,
      brevity: 0.10,
      prompt_refinement: 0.20
    };

    let bestPoint = result.paretoFront[0];
    let bestScore = -1;

    for (const point of result.paretoFront) {
      const score = scalarizeScores(point.scores, weights);
      if (score > bestScore) {
        bestScore = score;
        bestPoint = point;
      }
    }

    return {
      scores: bestPoint.scores,
      configuration: bestPoint.configuration,
      dominatedSolutions: bestPoint.dominatedSolutions,
    };
  }
}

/**
 * Convenience function: run GEPA optimization with default config.
 */
export async function runGEPAOptimization(
  trainData: TrainingExample[],
  validationData: TrainingExample[] = [],
  config: Partial<GEPARunnerConfig> = {}
): Promise<GEPARunnerResult> {
  const provider = config.studentProvider ?? 'mistral';
  const apiKeyEnvMap: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
    cohere: 'COHERE_API_KEY',
    'google-gemini': 'GEMINI_API_KEY',
  };

  const apiKeyEnv = apiKeyEnvMap[provider];
  const apiKey = config.studentApiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : undefined);

  if (!apiKey) {
    throw new OptimizationError(
      'auth',
      'init',
      `No API key for provider '${provider}'. ` +
      (apiKeyEnv ? `Set ${apiKeyEnv} environment variable.` : '')
    );
  }

  const runner = createGEPARunner({
    studentProvider: provider,
    studentApiKey: apiKey,
    studentModel: config.studentModel ?? 'mistral-small-latest',
    studentApiUrl: config.studentApiUrl,
    teacherProvider: config.teacherProvider ?? provider,
    teacherApiKey: config.teacherApiKey ?? apiKey,
    teacherModel: config.teacherModel ?? 'mistral-medium-latest',
    teacherApiUrl: config.teacherApiUrl,
    numTrials: config.numTrials ?? 25,
    seed: config.seed ?? 42,
    verbose: config.verbose ?? false,
    maxMetricCalls: config.maxMetricCalls ?? 200,
    earlyStoppingTrials: config.earlyStoppingTrials ?? 8,
    minibatchSize: config.minibatchSize ?? 6,
    logger: config.logger,
    maxRetries: config.maxRetries ?? 3,
    timeoutMs: config.timeoutMs ?? 0,
  });

  return runner.optimize(trainData, validationData);
}