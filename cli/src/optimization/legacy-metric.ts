/**
 * Multi-objective metric function for GEPA prompt optimization.
 *
 * Returns a Record<string, number> with scores in [0, 1] for each objective.
 * GEPA uses these to build a Pareto frontier of prompt variants.
 *
 * Objectives:
 *   - coverage:     % of session content captured in generated insights
 *   - precision:    % of generated insights that are non-trivial (not filler)
 *   - actionability: % of insights with concrete, actionable takeaways
 *   - brevity:      inverse of total insight token count (normalized)
 *   - prompt_refinement: quality and presence of suggested prompts for identified deficits
 */

import type { InsightOutput } from './flow.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MetricInput {
  prediction: InsightOutput;
  example: {
    /** The session transcript data that was analyzed. */
    sessionData: string;
    /** Optional human-rated ground truth quality (0-1). When present,
     *  overrides heuristic scoring for the `coverage` objective. */
    humanQuality?: number;
    /** Optional ground-truth insight count for coverage calculation. */
    expectedInsightCount?: number;
    /** Optional set of known session topics/phrases that should appear in insights. */
    sessionTopics?: string[];
  };
}

/**
 * Phrases that indicate filler / trivial findings.
 * Insights matching these patterns are penalized on the precision objective.
 */
const FILLER_PATTERNS = [
  /^good (use|usage|practice|job|work)/i,
  /^effective (use|usage|approach)/i,
  /^successful /i,
  /^helpful /i,
  /^nice /i,
  /^(the )?(user|assistant|session) (did|was|had|made|used)/i,
  /^everything went well/i,
  /^no (issues?|problems?|concerns?)/i,
  /^smooth /i,
  /^standard /i,
  /^typical /i,
  /^basic /i,
];

/**
 * Phrases that indicate concrete, actionable content.
 */
const ACTIONABLE_PATTERNS = [
  /should (use|consider|avoid|prefer|refactor|extract|split|merge)/i,
  /recommend/i,
  /best practice/i,
  /tradeoff/i,
  /trade-off/i,
  /consider using/i,
  /instead of/i,
  /replace /i,
  /migrate /i,
  /refactor /i,
  /extract (into|to)/i,
  /wrap (in|with)/i,
  /add (a |an |the )?(test|check|validation|guard|type)/i,
  /use (a |an )?(singleton|factory|hook|utility|helper)/i,
  /avoid /i,
  /prefer /i,
  /ensure /i,
  /make sure/i,
  /always /i,
  /never /i,
  // Descriptive-but-valuable patterns that imply action without explicit imperatives
  /pattern: /i,
  /key (takeaway|insight|finding)/i,
  /lesson( learned)?/i,
  /bottleneck/i,
  /risk (of|when|if)/i,
  /memory leak/i,
  /race condition/i,
  /single (point of failure|responsibility)/i,
  /separation of concerns/i,
  /tightly coupled/i,
  /circular dependency/i,
  /anti[- ]pattern/i,
  /code smell|design smell|architecture smell/i,
  /technical debt/i,
  /workaround/i,
  /scal(e|ing) (issue|problem|concern|limit)/i,
  /performance (impact|issue|concern|penalty)/i,
  /security (risk|concern|vulnerability|issue)/i,
  /error[- ]handling/i,
  /edge case/i,
  /null(able)? (check|guard|reference)/i,
  /missing (test|validation|error|type|check)/i,
  /unnecessary (coupling|abstraction|complexity|dependency)/i,
  /can (lead to|result in|cause)/i,
  /leads? to/i,
  /causes?/i,
  /results? in/i,
];

/**
 * Phrases that indicate specific evidence (file paths, line numbers, etc.).
 */
const EVIDENCE_PATTERNS = [
  /\.(ts|js|py|rb|go|rs|java|c|cpp|h|hpp|json|yaml|yml|toml|md)\b/i,
  /line \d+/i,
  /:\d+:\d+/,
  /User#\d+/,
  /Assistant#\d+/,
  /`[^`]+`/,
  /"[^"]{10,}"/,
  /error|exception|traceback|fail|bug|crash/i,
  /function|class|method|module|component|service/i,
];

/**
 * Defensive normalization of `prediction.insights`.
 *
 * AxFlow's parser can return the parsed value in several shapes depending
 * on how the LLM formatted its response:
 *   - Array of insight objects (the contract we want)
 *   - Object with an `insights` array (the whole JSON envelope, when the
 *     LLM returned one combined object — this is the crash case)
 *   - null / undefined (no field extracted at all)
 *   - Anything else (string, number, etc.)
 *
 * This helper is the single chokepoint so every objective function
 * receives a clean array. If AxFlow's parser is ever fixed or the
 * program shape changes, this is the one place to update.
 */
function normalizeInsights(prediction: InsightOutput | undefined | null): NonNullable<InsightOutput['insights']> {
  const raw = prediction?.insights;

  if (Array.isArray(raw)) return raw;

  if (raw && typeof raw === 'object') {
    // The Ax prompt template renders field titles in Title Case
    // (e.g., "Insights" not "insights"). The LLM faithfully returns
    // JSON keyed by the Title Case name it was shown. Both shapes
    // must be handled — this is the enum-drift defense.
    const obj = raw as Record<string, unknown>;
    const arr = obj.insights ?? obj.Insights ?? obj.items ?? obj.Items;
    if (Array.isArray(arr)) return arr as NonNullable<InsightOutput['insights']>;
  }

  return [];
}

// ── Individual objective functions ────────────────────────────────────────────

/**
 * Coverage: how much of the session content is captured in insights.
 *
 * Heuristic: checks if session topics/phrases appear in the generated insights.
 * If humanQuality is provided, uses that as the coverage score instead.
 */
function scoreCoverage(prediction: InsightOutput, example: MetricInput['example']): number {
  // Human-rated ground truth takes priority
  if (example.humanQuality !== undefined) {
    return clamp01(example.humanQuality);
  }

  const insights = normalizeInsights(prediction);
  if (insights.length === 0) return 0;

  // If we have expected topics, check how many appear in the insights
  const topics = example.sessionTopics ?? [];
  if (topics.length > 0) {
    const allText = insights.map(i => `${i.category} ${i.description}`).join(' ').toLowerCase();
    const matched = topics.filter(t => allText.includes(t.toLowerCase())).length;
    return clamp01(matched / topics.length);
  }

  // Fallback: use insight count relative to session length as a proxy
  // Longer sessions should yield more insights
  const sessionLength = example.sessionData.length;
  const expectedCount = example.expectedInsightCount ?? Math.max(3, Math.floor(sessionLength / 2000));
  const countScore = Math.min(insights.length / expectedCount, 1);

  // Also check if insights reference specific turns (evidence quality)
  const evidenceScore = insights.filter(i => i.evidence && i.evidence.length > 0).length / insights.length;

  return clamp01(0.6 * countScore + 0.4 * evidenceScore);
}

/**
 * Precision: % of generated insights that are non-trivial (not filler).
 *
 * Penalizes generic, low-signal findings. Rewards specific, evidence-backed insights.
 */
function scorePrecision(prediction: InsightOutput): number {
  const insights = normalizeInsights(prediction);
  if (insights.length === 0) return 0;

  let nonTrivialCount = 0;

  for (const insight of insights) {
    const text = `${insight.category} ${insight.description}`;

    // Check for filler patterns
    const isFiller = FILLER_PATTERNS.some(p => p.test(text));
    if (isFiller) continue;

    // Check for evidence (specific references)
    const hasEvidence = insight.evidence && insight.evidence.length > 0;
    const hasSpecificRefs = EVIDENCE_PATTERNS.some(p => p.test(text));

    // Check confidence threshold
    const hasConfidence = (insight.confidence ?? 0) >= 60;

    // An insight is non-trivial if it has evidence or specific refs, and meets confidence
    if ((hasEvidence || hasSpecificRefs) && hasConfidence) {
      nonTrivialCount++;
    } else if (hasEvidence && hasSpecificRefs) {
      // Even without confidence threshold, evidence + specificity = non-trivial
      nonTrivialCount++;
    }
  }

  return clamp01(nonTrivialCount / insights.length);
}

/**
 * Actionability: % of insights with concrete, actionable takeaways.
 *
 * Rewards insights that suggest specific actions, patterns, or changes.
 */
function scoreActionability(prediction: InsightOutput): number {
  const insights = normalizeInsights(prediction);
  if (insights.length === 0) return 0;

  let actionableCount = 0;

  for (const insight of insights) {
    const text = `${insight.category} ${insight.description}`;

    // Check for actionable language
    const hasActionableLanguage = ACTIONABLE_PATTERNS.some(p => p.test(text));

    // Check for imperative mood (starts with verb)
    const startsWithVerb = /^(use|avoid|prefer|ensure|consider|add|remove|refactor|extract|replace|update|implement|create|define|set|configure|enable|disable|wrap|handle|check|validate|test|review|document|note|remember|try|make|keep|move|split|merge|consolidate|simplify|optimize|improve|fix|debug|investigate|analyze|monitor|track|log|report)\b/i.test(text);

    if (hasActionableLanguage || startsWithVerb) {
      actionableCount++;
    }
  }

  return clamp01(actionableCount / insights.length);
}

/**
 * Brevity: inverse of total insight token count (normalized).
 *
 * Rewards concise insights. Penalizes verbose, rambling findings.
 *
 * Scoring curve:
 *   - <= 50 tokens total: 1.0 (excellent)
 *   - <= 100 tokens: 0.8
 *   - <= 200 tokens: 0.6
 *   - <= 400 tokens: 0.4
 *   - <= 800 tokens: 0.2
 *   - > 800 tokens: 0.05
 */
function scoreBrevity(prediction: InsightOutput): number {
  const insights = normalizeInsights(prediction);
  if (insights.length === 0) return 0;

  // Estimate token count (rough: 1 token ≈ 4 chars for English text)
  const totalChars = insights.reduce(
    (sum, i) => sum + i.category.length + i.description.length + (i.evidence?.join(' ').length ?? 0),
    0
  );
  const estimatedTokens = totalChars / 4;

  if (estimatedTokens <= 50) return 1.0;
  if (estimatedTokens <= 100) return 0.8;
  if (estimatedTokens <= 200) return 0.6;
  if (estimatedTokens <= 400) return 0.4;
  if (estimatedTokens <= 800) return 0.2;
  return 0.05;
}

/**
 * Prompt Refinement: quality and presence of suggested prompts for identified deficits.
 *
 * Rewards:
 *   - Identifying prompt-deficit categories.
 *   - Providing a non-empty suggested_prompt.
 *   - suggested_prompt being longer and more descriptive than the description.
 */
function scorePromptRefinement(prediction: InsightOutput): number {
  const insights = normalizeInsights(prediction);
  const promptDeficits = insights.filter(i => i.category === 'prompt-deficit' || /prompt/i.test(i.category));

  if (promptDeficits.length === 0) return 0.2; // Small baseline if no deficits found (might be a clean session)

  let score = 0;
  for (const insight of promptDeficits) {
    if (insight.suggested_prompt && insight.suggested_prompt.length > 10) {
      score += 1;
      // Bonus if suggested prompt is significantly detailed
      if (insight.suggested_prompt.length > 50) score += 0.5;
      // Bonus if it contains common "good prompt" markers
      if (/\b(context|example|format|schema|rules|role)\b/i.test(insight.suggested_prompt)) {
        score += 0.5;
      }
    }
  }

  return clamp01(score / (promptDeficits.length * 2));
}

// ── Main metric function ─────────────────────────────────────────────────────

/**
 * Multi-objective metric for GEPA optimization.
 *
 * Returns scores for all four objectives. GEPA uses these to build a Pareto
 * frontier of prompt variants that represent different trade-offs.
 *
 * Usage:
 *   const metric = ({ prediction, example }) => multiObjectiveMetric({ prediction, example });
 *   const optimizer = new AxGEPA({ studentAI, numTrials: 20 });
 *   const result = await optimizer.compile(program, trainData, metric);
 */
export function multiObjectiveMetric({ prediction, example }: MetricInput): Record<string, number> {
  return {
    coverage: scoreCoverage(prediction, example),
    precision: scorePrecision(prediction),
    actionability: scoreActionability(prediction),
    brevity: scoreBrevity(prediction),
    prompt_refinement: scorePromptRefinement(prediction),
  };
}

// ── Utility ──────────────────────────────────────────────────────────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Scalarize multi-objective scores into a single weighted score.
 * Useful for selecting a single "best" prompt from the Pareto frontier.
 *
 * Default weights favor coverage and precision over actionability and brevity.
 */
export function scalarizeScores(
  scores: Record<string, number>,
  weights: Record<string, number> = {
    coverage: 0.25,
    precision: 0.25,
    actionability: 0.20,
    brevity: 0.10,
    prompt_refinement: 0.20
  }
): number {
  let totalWeight = 0;
  let weightedSum = 0;

  for (const [key, weight] of Object.entries(weights)) {
    const score = scores[key] ?? 0;
    weightedSum += weight * score;
    totalWeight += weight;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}
