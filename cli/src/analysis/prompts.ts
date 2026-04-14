// Prompt template strings and generator functions for LLM session analysis.
// Types → prompt-types.ts, constants → prompt-constants.ts,
// formatting → message-format.ts, parsers → response-parsers.ts.

import type { SessionMetadata, ContentBlock } from './prompt-types.js';
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
export function buildSessionAnalysisInstructions(
  projectName: string,
  sessionSummary: string | null,
  meta?: SessionMetadata
): string {
  return `<task>
Extract analytical session facets, decisions, and learnings from the provided session transcript into structured JSON.
</task>

<context>
  <project_name>${projectName}</project_name>
${sessionSummary ? `  <session_summary>${sessionSummary}</session_summary>\n` : ''}  <system_metadata>${formatSessionMetaLine(meta)}</system_metadata>
</context>

<rules>
  1. Enforce strict JSON output schema.
  2. Extract insights containing ONLY concrete references (file paths, endpoints, variables, errors). Filter out generic findings automatically.
  3. Include 1-3 literal quote citations per insight referencing turn labels (e.g., "User#5").
  4. Require a minimum confidence score of 70 for any decision or learning. Drop insights below this threshold.
  5. Return empty arrays for categories yielding no valid findings.
  6. Fill every field in the schema. Use null for unavailable data where permitted.
</rules>

<definitions>
  <facet name="outcome_satisfaction">high | medium | low | abandoned</facet>
  <facet name="workflow_pattern">plan-then-implement | iterative-refinement | debug-fix-verify | explore-then-build | direct-execution | null</facet>
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
      "title": "Technical choice (max 80 chars)",
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
  ]
}
</output_schema>

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
Extract structural inefficiencies and effective prompt patterns from the preceding conversation. Assess ONLY the user's input messages.
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
  4. Use the assistant's responses ONLY as evidence of interpretation, not intent.
  5. Output neutral, factual assessments. Avoid prescriptive or lecturing tones.
  6. Extract both deficit and strength patterns based ONLY on explicit evidence.
  7. If the session had context compactions, classify repetition immediately following compaction as environmental restatement, NOT a prompting deficit.
  8. When generating a 'better_prompt', actively apply Systemic Functional Linguistics (SFL) and explain the structural enhancements in the 'sfl_breakdown' block.
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
      "better_prompt": "A concrete standalone prompt rewrite handling the missing constraints",
      "sfl_breakdown": {
        "ideational": "How the rewrite defines concrete task boundaries, explicit entities, and context inputs (Field)",
        "interpersonal": "How the rewrite removes conversational filler/politeness and enforces rigid operational constraints (Tenor)",
        "textual": "How the rewrite isolates dynamic variables and enforces data packaging/formatting (Mode)"
      },
      "why": "One exact reason the original caused friction"
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
  meta?: SessionMetadata
): string {
  return `<task>
Extract session facets for cross-session pattern analysis. Focus on holistic session execution, friction points, and effective workflow patterns.
</task>

<context>
  <project_name>${projectName}</project_name>
${sessionSummary ? `  <session_summary>${sessionSummary}</session_summary>\n` : ''}${formatSessionMetaLine(meta)}</context>

<rules>
  1. Evaluate the session boundaries and overall progress explicitly.
  2. Map friction and effective patterns onto specific user workflows or AI capability gaps.
  3. Respond with neutral analysis and strictly adhere to provided categorization rules.
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
Friction MUST use: \${CANONICAL_FRICTION_CATEGORIES.join(', ')}
Patterns MUST use: \${CANONICAL_PATTERN_CATEGORIES.join(', ')}
Create a custom kebab-case category ONLY if the behavior strictly diverges from canonical bounds.
</category_enforcement>

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}
