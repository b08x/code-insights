// Prompt template strings and generator functions for LLM session analysis.
// Types → prompt-types.ts, constants → prompt-constants.ts,
// formatting → message-format.ts, parsers → response-parsers.ts.

import type { SessionMetadata, ContentBlock } from './prompt-types.js';
import type { RageLoopSignal } from './loop-detector.js';
import {
  FRICTION_CLASSIFICATION_GUIDANCE,
  CANONICAL_FRICTION_CATEGORIES,
  CANONICAL_PATTERN_CATEGORIES,
  CANONICAL_PQ_DEFICIT_CATEGORIES,
  CANONICAL_PQ_STRENGTH_CATEGORIES,
  PROMPT_QUALITY_CLASSIFICATION_GUIDANCE,
  EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE,
} from './prompt-constants.js';
import { formatSessionMetaLine } from './message-format.js';

// =============================================================================
// SHARED SYSTEM PROMPT
// A minimal (~100 token) system prompt shared by all analysis calls.
// The full classification guidance and schema examples live in the instruction
// suffix (user[1]), keeping the system prompt cacheable across calls.
// =============================================================================

/**
 * Shared system prompt for all LLM analysis calls.
 * Paired with buildCacheableConversationBlock() + an analysis-specific instruction block.
 */
export const SHARED_ANALYST_SYSTEM_PROMPT = `You are a senior staff engineer analyzing an AI coding session. You will receive the conversation transcript followed by specific extraction instructions.

JSON SAFETY RULES:
1. Respond with valid JSON only, wrapped in <json>...</json> tags.
2. Escape all double quotes within string values using \\".
3. Do not include newlines inside string values; use \\n if necessary.
4. Ensure all property names are enclosed in double quotes.
5. Check for trailing commas in arrays and objects and remove them.`;

// =============================================================================
// CACHEABLE CONVERSATION BLOCK
// Wraps the formatted conversation in an Anthropic ephemeral cache block.
// CRITICAL: Must contain ONLY the formatted messages — no project name, no session
// metadata, no per-session variables. This ensures cache hits across sessions.
// =============================================================================

/**
 * Wrap formatted conversation messages in a cacheable content block.
 * The cache_control field instructs Anthropic to cache everything up to
 * and including this block (ephemeral, 5-minute TTL).
 *
 * Non-Anthropic providers receive this as a ContentBlock[] and use
 * flattenContent() to convert it to a plain string.
 *
 * @param formattedMessages - Output of formatMessagesForAnalysis()
 */
export function buildCacheableConversationBlock(formattedMessages: string): ContentBlock {
  return {
    type: 'text',
    // Trailing double newline ensures the instruction block (user[1]) reads as a
    // distinct section when providers flatten content blocks to a single string.
    text: `--- CONVERSATION ---\n${formattedMessages}\n--- END CONVERSATION ---\n\n`,
    cache_control: { type: 'ephemeral' },
  };
}

// =============================================================================
// SESSION ANALYSIS INSTRUCTIONS
// The instruction suffix for session analysis calls (user[1]).
// Contains the full analyst persona, schema, and quality guidance.
// Per-session variables (project name, summary, meta) go here — NOT in the
// cached conversation block.
// =============================================================================

/**
 * Build the instruction suffix for session analysis.
 * Used as the second content block in the user message, after the cached conversation.
 */
export interface RelatedInsight {
  type: string;
  title: string;
  content: string;
  confidence: number;
}

export function buildSessionAnalysisInstructions(
  projectName: string,
  sessionSummary: string | null,
  meta?: SessionMetadata,
  loopSignal?: RageLoopSignal,
  relatedInsights?: RelatedInsight[],
): string {
  const loopInfo = loopSignal?.detected
    ? `  <detected_signals>
    <rage_loop>
      <reasoning>${loopSignal.reasoning}</reasoning>
      <turn_range>${loopSignal.turnRange?.join(' to ')}</turn_range>
      <guidance>Verify if these turns exhibit zero semantic progress despite the static context. If so, classify as a high-severity rage-loop.</guidance>
    </rage_loop>
  </detected_signals>\n`
    : '';

  const relatedBlock = relatedInsights && relatedInsights.length > 0
    ? '\n<related_insights>\n' +
      relatedInsights.map((ri, i) =>
        '  <insight index="' + (i + 1) + '">\n' +
        '    <type>' + ri.type + '</type>\n' +
        '    <title>' + ri.title + '</title>\n' +
        '    <content>' + ri.content + '</content>\n' +
        '    <confidence>' + ri.confidence + '</confidence>\n' +
        '  </insight>'
      ).join('\n') +
      '\n</related_insights>\n\n<related_insights_instructions>\n' +
      'These are insights from similar past sessions in the same project. Do NOT duplicate them. Instead, note if they reinforce or contradict the current session\'s patterns. If a related insight is directly relevant, reference it by index (e.g., "reinforces insight #2").\n' +
      '</related_insights_instructions>\n'
    : '';

  return `<task>
Analyze the provided AI coding session transcript. Extract:
1. Session execution facets: outcome satisfaction (high | medium | low | abandoned), workflow pattern, course corrections, iteration count, friction points using canonical categories (${CANONICAL_FRICTION_CATEGORIES.join(', ')}), and effective workflow patterns using canonical categories (${CANONICAL_PATTERN_CATEGORIES.join(', ')}).
2. Architectural decisions: technical choices with trade-offs, alternatives considered, and turn-based attribution (user | agent | collaborative).
3. Transferable learnings: operational discoveries with observable symptoms, root causes, and applicable conditions.
4. Semantic step matrix: sequential milestones (4-10 steps) mapping workflow progression, driver attribution, target scope, and outcome state.
Output strictly valid JSON matching the schema.
</task>

<context>
  <project_name>${projectName}</project_name>
${sessionSummary ? `  <session_summary>${sessionSummary}</session_summary>\n` : ''}${loopInfo}  <system_metadata>${formatSessionMetaLine(meta)}</system_metadata>
</context>${relatedBlock}

<rules>
  1. Enforce strict JSON output schema.
  2. Output Validation Rules (Acceptance Criteria):
     - For decisions, validate that each entry: (a) contains concrete technical choice and alternatives, (b) grounds decided_by attribution in turn citations (User#N for user, Assistant#N for agent, both for collaborative), (c) includes 1-3 literal quote citations, (d) meets minimum confidence >= 70. Reject decisions failing these criteria.
     - For learnings, validate that each entry: (a) identifies observable symptom, root cause, and transferable takeaway, (b) includes literal quote citations, (c) meets minimum confidence >= 70. Reject generic advice.
     - For friction points, validate that each entry: (a) uses a canonical category (${CANONICAL_FRICTION_CATEGORIES.join(', ')}), (b) sets attribution to user-actionable, ai-capability, or environmental strictly per the decision tree, (c) describes the specific GAP with concrete technical details (file paths, APIs, error messages), not the actor, (d) includes _reasoning scratchpad.
     - For effective patterns, validate that each entry: (a) uses a canonical category (${CANONICAL_PATTERN_CATEGORIES.join(', ')}), (b) sets driver to user-driven, ai-driven, or collaborative per the driver decision tree, (c) satisfies exclusion rules (exclude routine file reads, trivial syntax fixes, standard commands), (d) includes _reasoning scratchpad.
     - For step matrix, validate that it: (a) contains 4-10 discrete chronological milestones, (b) assigns driver (LLM_Decide | User_Decide | Collab_Decide), target (Target_Config | Target_SrcCode | Target_Test | Target_Docs), and state (State_Success | State_Error | State_Blocked).
  3. Summary narrative constraint: Describe HOW the user and AI collaborated, the workflow strategy utilized, and the friction-resolving path. Do NOT mechanically list modified files or commit hashes.
  4. Extract insights containing ONLY concrete references (file paths, endpoints, variables, errors). Filter out generic findings automatically.
  5. Fill every field in the schema. Return empty arrays for categories yielding no valid findings. Use null for unavailable data where permitted.
</rules>

<definitions>
  <facet name="outcome_satisfaction">high | medium | low | abandoned</facet>
  <facet name="workflow_pattern">plan-then-implement | iterative-refinement | debug-fix-verify | explore-then-build | direct-execution | null</facet>
  <decision_attribution name="decided_by">user (user explicitly directed/commanded) | agent (AI proposed and autonomously acted) | collaborative (joint exploration/co-designed)</decision_attribution>
</definitions>

${FRICTION_CLASSIFICATION_GUIDANCE}
${EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE}

<output_schema>
{
  "facets": {
    "outcome_satisfaction": "high | medium | low | abandoned",
    "workflow_pattern": "string | null",
    "had_course_correction": false,
    "course_correction_reason": "string | null",
    "iteration_count": 0,
    "friction_points": [
      {
        "_reasoning": "Reasoning for category + attribution classification",
        "category": "kebab-case-category",
        "attribution": "user-actionable | ai-capability | environmental",
        "description": "One neutral sentence about the gap, with specific details",
        "severity": "high | medium | low",
        "resolution": "resolved | workaround | unresolved"
      }
    ],
    "effective_patterns": [
      {
        "_reasoning": "Reasoning for category + driver classification",
        "category": "kebab-case-category",
        "description": "Specific technique, 1-2 sentences",
        "confidence": 85,
        "driver": "user-driven | ai-driven | collaborative"
      }
    ]
  },
  "summary": {
    "title": "Methodological objective (e.g., 'Iterative test-driven refactor of state management')",
    "content": "2-4 sentence narrative of the collaboration dynamics. Do NOT list file changes or commits. Describe HOW the user and AI interacted, the workflow strategy utilized, and the friction-resolving path.",
    "outcome": "success | partial | abandoned | blocked",
    "bullets": [
      "Workflow execution milestones (e.g., 'Enforced test-boundary isolation', 'Relied on AI-driven conceptual design', 'Diagnosed race condition via log analysis')"
    ]
  },
  "decisions": [
    {
      "_reasoning": "Brief rationale grounding attribution in turn evidence (e.g., 'User#3 specified SQLite')",
      "title": "Technical choice (max 80 chars)",
      "decided_by": "user | agent | collaborative",
      "intent": "Initiating intent or problem triggering the decision",
      "branch_point": "Alternative path or design branched away from",
      "situation": "Problem context",
      "choice": "Chosen implementation",
      "reasoning": "Decision factors",
      "alternatives": [{"option": "Name", "rejected_because": "Reason"}],
      "trade_offs": "Accepted downsides",
      "revisit_when": "Reconsideration conditions",
      "confidence": 85,
      "evidence": ["User#1: Quote", "Assistant#2: Quote"]
    }
  ],
  "learnings": [
    {
      "title": "Discovery or gotcha (max 80 chars)",
      "symptom": "Observable behavior",
      "root_cause": "Underlying reason",
      "takeaway": "Transferable lesson",
      "applies_when": "Relevant conditions",
      "confidence": 80,
      "evidence": ["User#1: Quote", "Assistant#2: Quote"]
    }
  ],
  "step_matrix": [
    {
      "step": "Concise episode name (e.g., 'Configure build pipeline')",
      "turn_ref": "User#1 or Assistant#2",
      "driver": "LLM_Decide | User_Decide | Collab_Decide",
      "target": "Target_Config | Target_SrcCode | Target_Test | Target_Docs",
      "state": "State_Success | State_Error | State_Blocked"
    }
  ]
}
</output_schema>

<category_enforcement>
Friction MUST use: ${CANONICAL_FRICTION_CATEGORIES.join(', ')}
Patterns MUST use: ${CANONICAL_PATTERN_CATEGORIES.join(', ')}
Create a custom kebab-case category ONLY if the behavior strictly diverges from canonical bounds.
</category_enforcement>

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}

// =============================================================================
// PROMPT QUALITY INSTRUCTIONS
// The instruction suffix for prompt quality analysis calls (user[1]).
// =============================================================================

/**
 * Build the instruction suffix for prompt quality analysis.
 * Used as the second content block in the user message, after the cached conversation.
 */
export function buildPromptQualityInstructions(
  projectName: string,
  sessionMeta: {
    humanMessageCount: number;
    assistantMessageCount: number;
    toolExchangeCount: number;
  },
  meta?: SessionMetadata
): string {
  return `<task>
Analyze the user's input messages in the provided conversation transcript. Extract:
1. Structural inefficiencies (prompting deficits) using categories: ${CANONICAL_PQ_DEFICIT_CATEGORIES.join(', ')}.
2. Effective prompt patterns (prompting strengths) using categories: ${CANONICAL_PQ_STRENGTH_CATEGORIES.join(', ')}.
Assess ONLY the user's input messages (labeled User#N). For each finding, include: category, type, description, message_ref, impact, confidence, suggested_improvement, and SFL breakdown (ideational, interpersonal, textual). For each takeaway, generate a concrete before/after pair with a tri-stratal SFL breakdown. Output as valid JSON strictly adhering to the schema.
</task>

<context>
  <project_name>${projectName}</project_name>
  <session_shape>
    <human_messages>${sessionMeta.humanMessageCount}</human_messages>
    <assistant_messages>${sessionMeta.assistantMessageCount}</assistant_messages>
    <tool_exchanges>${sessionMeta.toolExchangeCount}</tool_exchanges>
  </session_shape>
  <system_metadata>${formatSessionMetaLine(meta)}</system_metadata>
</context>

<rules>
  1. Distinguish strictly between user input quality and model capability.
  2. Evaluate the user's prompt quality independently of model outcome.
  3. Assistant hallucination despite a high-quality prompt is an AI capability deficit. Do NOT penalize the user.
  4. Use the assistant's responses ONLY as evidence of interpretation, not user intent.
  5. Output neutral, factual assessments. Avoid prescriptive or lecturing tones.
  6. Output Validation Rules (Acceptance Criteria):
     - For each finding, validate that it: (a) references a specific user message (e.g., 'User#3'), (b) uses one of the predefined canonical categories, (c) includes all required fields (category, type, description, message_ref, impact, confidence, suggested_improvement, sfl_breakdown). Reject findings that violate these criteria.
     - For each takeaway, validate that it: (a) references a specific user message, (b) provides a concrete standalone rewrite ('better_prompt' for improve, 'what_worked' for reinforce), (c) includes an explicit tri-stratal sfl_breakdown analyzing Ideational (Field), Interpersonal (Tenor), and Textual (Mode) structural enhancements. Reject takeaways lacking concrete rewrites or structural rationale.
  7. If the session had context compactions, classify repetition immediately following compaction as environmental restatement, NOT a prompting deficit.
  8. When generating a 'better_prompt', actively apply Systemic Functional Linguistics (SFL):
     - Ideational (Field): Define concrete task boundaries, explicit entities, file paths, endpoints, and input parameters.
     - Interpersonal (Tenor): Remove conversational filler and polite hedging; enforce explicit operational constraints and clear imperatives.
     - Textual (Mode): Isolate dynamic variables, enforce structured formatting (XML tags or markdown delimiters), and specify boolean acceptance criteria.
  9. Anchor dimension scores to explicit SFL criteria [0-100] (0 = catastrophic deficit, 50 = baseline functioning, 100 = flawless systemic execution). Score each dimension strictly based on observed user input behavior, independently of model outcome.
</rules>

${PROMPT_QUALITY_CLASSIFICATION_GUIDANCE}

<output_schema>
{
  "efficiency_score": 75,
  "message_overhead": 3,
  "assessment": "2-3 sentence neutral summary of prompting strategy and efficiency.",
  "takeaways": [
    {
      "type": "improve | reinforce",
      "category": "category-name",
      "label": "Short Actionable Heading",
      "message_ref": "User#N",
      "original": "The user's original message (abbreviated)",
      "better_prompt": "A concrete standalone prompt rewrite handling the missing constraints (for improve)",
      "sfl_breakdown": {
        "ideational": "How the rewrite defines concrete task boundaries, explicit entities, and context inputs (Field)",
        "interpersonal": "How the rewrite removes conversational filler/politeness and enforces rigid operational constraints (Tenor)",
        "textual": "How the rewrite isolates dynamic variables and enforces data packaging/formatting (Mode)"
      },
      "why": "One exact reason the original caused friction (for improve)",
      "what_worked": "Specific prompting technique that drove high-efficiency execution (for reinforce)",
      "why_effective": "Why this approach prevented misunderstandings or reduced iterations (for reinforce)"
    }
  ],
  "findings": [
    {
      "category": "category-name",
      "type": "deficit | strength",
      "description": "One neutral sentence using specific terms",
      "message_ref": "User#N",
      "impact": "high | medium | low",
      "confidence": 90,
      "suggested_improvement": "Concrete text replacement or structure rule",
      "sfl_breakdown": {
        "ideational": "How this pattern affected explicit entities, task boundaries, or context inputs (Field)",
        "interpersonal": "How the user's conversational style, constraints, or tone impacted AI behavior (Tenor)",
        "textual": "How the information was packaged, sequenced, or formatted (Mode)"
      }
    }
  ],
  "dimension_scores": {
    "context_provision": 70,
    "request_specificity": 65,
    "scope_management": 80,
    "information_timing": 55,
    "correction_quality": 75
  }
}
</output_schema>

<category_enforcement>
Deficits MUST use: ${CANONICAL_PQ_DEFICIT_CATEGORIES.join(', ')}
Strengths MUST use: ${CANONICAL_PQ_STRENGTH_CATEGORIES.join(', ')}
Create a custom kebab-case category ONLY if the schema strictly diverges from canonical bounds.
</category_enforcement>

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}

// =============================================================================
// FACET-ONLY INSTRUCTIONS
// The instruction suffix for facet-only extraction calls (user[1]).
// =============================================================================

/**
 * Build the instruction suffix for facet-only extraction (backfill path).
 * Used as the second content block in the user message, after the cached conversation.
 */
export function buildFacetOnlyInstructions(
  projectName: string,
  sessionSummary: string | null,
  meta?: SessionMetadata,
  loopSignal?: RageLoopSignal,
  relatedInsights?: RelatedInsight[],
): string {
  const loopInfo = loopSignal?.detected
    ? `  <detected_signals>
    <rage_loop>
      <reasoning>${loopSignal.reasoning}</reasoning>
      <turn_range>${loopSignal.turnRange?.join(' to ')}</turn_range>
      <guidance>Verify if these turns exhibit zero semantic progress despite the static context. If so, classify as a high-severity rage-loop.</guidance>
    </rage_loop>
  </detected_signals>\n`
    : '';

  const relatedBlock = relatedInsights && relatedInsights.length > 0
    ? '\n<related_insights>\n' +
      relatedInsights.map((ri, i) =>
        '  <insight index="' + (i + 1) + '">\n' +
        '    <type>' + ri.type + '</type>\n' +
        '    <title>' + ri.title + '</title>\n' +
        '    <content>' + ri.content + '</content>\n' +
        '    <confidence>' + ri.confidence + '</confidence>\n' +
        '  </insight>'
      ).join('\n') +
      '\n</related_insights>\n\n<related_insights_instructions>\n' +
      'These are insights from similar past sessions in the same project. Do NOT duplicate them. Instead, note if the current session\'s facets reinforce or contradict these patterns.\n' +
      '</related_insights_instructions>\n'
    : '';

  return `<task>
Analyze the provided AI coding session transcript for cross-session facet aggregation. Extract:
1. Execution dynamics: outcome satisfaction (high | medium | low | abandoned), primary workflow pattern, course corrections, and iteration count.
2. Friction points using canonical categories: ${CANONICAL_FRICTION_CATEGORIES.join(', ')}.
3. Effective workflow patterns using canonical categories: ${CANONICAL_PATTERN_CATEGORIES.join(', ')}.
For each friction point and effective pattern, include the _reasoning scratchpad, canonical category, attribution/driver classification, and concrete technical description. Output strictly valid JSON matching the schema.
</task>

<context>
  <project_name>${projectName}</project_name>
${sessionSummary ? `  <session_summary>${sessionSummary}</session_summary>\n` : ''}${loopInfo}  <system_metadata>${formatSessionMetaLine(meta)}</system_metadata>
</context>${relatedBlock}

<rules>
  1. Enforce strict JSON output schema.
  2. Output Validation Rules (Acceptance Criteria):
     - For friction points, validate that each entry: (a) uses a canonical category (${CANONICAL_FRICTION_CATEGORIES.join(', ')}), (b) sets attribution to user-actionable, ai-capability, or environmental strictly following the attribution decision tree, (c) describes the specific GAP with concrete details (file paths, APIs, error messages), not the actor, (d) includes _reasoning scratchpad. Reject vague or ungrounded entries.
     - For effective patterns, validate that each entry: (a) uses a canonical category (${CANONICAL_PATTERN_CATEGORIES.join(', ')}), (b) sets driver to user-driven, ai-driven, or collaborative, (c) satisfies exclusion rules (exclude routine file reads, trivial syntax fixes, standard commands), (d) includes _reasoning scratchpad. Reject trivial behaviors.
     - For execution facets, validate that: (a) outcome_satisfaction is one of: high, medium, low, abandoned; (b) workflow_pattern is one of the defined patterns or null; (c) had_course_correction is a boolean with course_correction_reason populated if true; (d) iteration_count is a non-negative integer.
  3. Map friction and effective patterns onto specific user workflows or AI capability gaps with neutral, factual descriptions.
  4. Fill every field in the schema. Return empty arrays for categories yielding no valid findings.
</rules>

${FRICTION_CLASSIFICATION_GUIDANCE}

${EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE}

<output_schema>
{
  "outcome_satisfaction": "high | medium | low | abandoned",
  "workflow_pattern": "plan-then-implement | iterative-refinement | debug-fix-verify | explore-then-build | direct-execution | null",
  "had_course_correction": false,
  "course_correction_reason": null,
  "iteration_count": 0,
  "friction_points": [
    {
      "_reasoning": "Reasoning for category + attribution classification",
      "category": "kebab-case-category",
      "attribution": "user-actionable | ai-capability | environmental",
      "description": "One neutral sentence about the gap, with specific details",
      "severity": "high | medium | low",
      "resolution": "resolved | workaround | unresolved"
    }
  ],
  "effective_patterns": [
    {
      "_reasoning": "Reasoning for category + driver classification, including baseline check",
      "category": "kebab-case-category",
      "description": "technique",
      "confidence": 85,
      "driver": "user-driven | ai-driven | collaborative"
    }
  ]
}
</output_schema>

<category_enforcement>
Friction MUST use: ${CANONICAL_FRICTION_CATEGORIES.join(', ')}
Patterns MUST use: ${CANONICAL_PATTERN_CATEGORIES.join(', ')}
Create a custom kebab-case category ONLY if the behavior strictly diverges from canonical bounds.
</category_enforcement>

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}
