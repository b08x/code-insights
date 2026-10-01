/**
 * GEPA prompt optimization module.
 *
 * Exports the full optimization pipeline:
 * - flow.ts:     AxFlow definition for insight generation
 * - metric.ts:   Multi-objective metric (coverage, precision, actionability, brevity)
 * - runner.ts:   GEPA optimization orchestration
 * - prompts.ts:  Save/load/version tracking for optimized prompts
 */

export {
  createInsightProgram,
  INSIGHT_INSTRUCTION,
  INSIGHT_OUTPUT_FORMAT,
  type InsightOutput,
} from './flow.js';

export {
  multiObjectiveMetric,
  scalarizeScores,
  type MetricInput,
} from './legacy-metric.js';

export {
  createGEPARunner,
  runGEPAOptimization,
  GEPARunner,
  type GEPARunnerConfig,
  type TrainingExample,
  type GEPARunnerResult,
  type OptimizationLogEntry,
  type OptimizationStep,
  type OptimizationLogger,
} from './runner.js';

export {
  ensureOptimizationDir,
  loadManifest,
  saveManifest,
  registerVersion,
  activateVersion,
  getActiveVersion,
  deleteVersion,
  getVersionDir,
  saveArtifact,
  loadArtifact,
  saveScores,
  loadScores,
  saveMetadata,
  loadMetadata,
  compareVersions,
  listVersions,
  hasOptimizedPrompt,
  type OptimizationVersion,
  type OptimizationManifest,
  type ParetoPoint,
  type OptimizationScores,
  type OptimizationMetadata,
} from './prompts.js';

// ── Template exports ─────────────────────────────────────────────────────────

export {
  DEFAULT_TEMPLATE_CONFIG,
  TEACHER_SYSTEM_PROMPT,
  TEACHER_EVALUATION_PROMPT,
  STUDENT_SYSTEM_PROMPT,
  STUDENT_MUTATION_PROMPT,
  INSTRUCTION_INVARIANTS,
  fillTemplate,
  validateInstruction,
  buildTeacherPrompt,
  buildStudentPrompt,
  type TemplateConfig,
  type TeacherFeedbackSchema,
  type ObjectiveFeedback,
} from './templates.js';
