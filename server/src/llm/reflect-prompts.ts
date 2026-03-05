// Synthesis prompts for the Reflect/Patterns feature.
// These prompts receive pre-aggregated facet data and produce cross-session narratives.
// LLMs synthesize — they don't count. All counting is done in code before calling these.

// --- Friction & Wins ---

export const FRICTION_WINS_SYSTEM_PROMPT = `You are analyzing cross-session patterns from a developer's AI coding sessions. You will receive pre-aggregated friction categories and effective patterns with counts and severity scores.

Your job is to synthesize a narrative analysis of the 3-5 most significant patterns. For each pattern:
1. State what the pattern is
2. Explain why it matters (impact on productivity)
3. Identify the likely root cause
4. Note if it's trending (getting better or worse)

RULES:
- Every claim must trace to the statistics provided. Do not invent patterns.
- Patterns require 2+ occurrences to be mentioned.
- Do not give advice — that's for the Rules & Skills section.
- Be specific: "wrong-approach appeared 7 times with high severity" not "there were some issues"
- Keep the narrative under 500 words.

Respond with valid JSON only, wrapped in <json>...</json> tags.`;

export function generateFrictionWinsPrompt(data: {
  frictionCategories: Array<{ category: string; count: number; avg_severity: number; examples: string[] }>;
  effectivePatterns: Array<{ description: string; frequency: number; avg_confidence: number }>;
  totalSessions: number;
  period: string;
}): string {
  return `Analyze these cross-session patterns from ${data.totalSessions} sessions over ${data.period}.

FRICTION CATEGORIES (ranked by frequency × severity):
${JSON.stringify(data.frictionCategories.slice(0, 15), null, 2)}

EFFECTIVE PATTERNS (ranked by frequency):
${JSON.stringify(data.effectivePatterns.slice(0, 10), null, 2)}

Respond with this JSON format:
{
  "narrative": "Your 300-500 word analysis of the most significant patterns",
  "topFriction": [
    {
      "category": "category-name",
      "significance": "Why this matters",
      "rootCause": "Likely underlying cause",
      "trend": "increasing | stable | decreasing | new"
    }
  ],
  "topWins": [
    {
      "pattern": "Description of what works",
      "significance": "Why this is effective"
    }
  ]
}

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}

// --- Rules & Skills ---

export const RULES_SKILLS_SYSTEM_PROMPT = `You are generating actionable artifacts from cross-session analysis of a developer's AI coding sessions. You will receive recurring friction patterns and effective practices.

Your job is to produce concrete, copy-paste-ready artifacts:
1. CLAUDE.md rules — specific instructions to add to the AI assistant's config
2. Skill templates — reusable workflows for repetitive tasks
3. Hook configurations — automation triggers

RULES:
- Only generate artifacts for patterns with 3+ occurrences (friction) or 2+ occurrences (effective patterns)
- Rules must be specific enough to be actionable: "Always run tests before creating PRs" not "Be careful with code"
- Skill templates must include step-by-step instructions
- Hook configs must include the event trigger and command
- Max 5 rules, 3 skills, 3 hooks
- Each artifact must reference the friction pattern or effective practice it addresses

Respond with valid JSON only, wrapped in <json>...</json> tags.`;

export function generateRulesSkillsPrompt(data: {
  recurringFriction: Array<{ category: string; count: number; avg_severity: number; examples: string[] }>;
  effectivePatterns: Array<{ description: string; frequency: number; avg_confidence: number }>;
  antiPatterns?: Array<{ name: string; count: number; examples: string[] }>;
  targetTool: string;
}): string {
  return `Generate actionable artifacts from these recurring patterns.

TARGET TOOL: ${data.targetTool} (generate artifacts compatible with this tool's ecosystem)

RECURRING FRICTION (3+ occurrences):
${JSON.stringify(data.recurringFriction, null, 2)}

EFFECTIVE PATTERNS (2+ occurrences):
${JSON.stringify(data.effectivePatterns, null, 2)}

${data.antiPatterns ? `PROMPT ANTI-PATTERNS:\n${JSON.stringify(data.antiPatterns, null, 2)}` : ''}

Respond with this JSON format:
{
  "claudeMdRules": [
    {
      "rule": "The exact text to add to CLAUDE.md",
      "rationale": "Why this rule helps (reference the friction pattern)",
      "frictionSource": "category-name (N occurrences)"
    }
  ],
  "skillTemplates": [
    {
      "name": "skill-name",
      "description": "What this skill automates",
      "content": "Full skill template content with steps"
    }
  ],
  "hookConfigs": [
    {
      "event": "pre-commit | post-file-edit | etc.",
      "command": "The shell command to run",
      "rationale": "Why this automation helps"
    }
  ]
}

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}

// --- Working Style ---

export const WORKING_STYLE_SYSTEM_PROMPT = `You are writing a brief working style profile based on aggregated statistics from a developer's AI coding sessions. You will receive distributions of workflow patterns, outcomes, session types, and friction frequency.

Your job is to describe WHAT you see, not what they should change. Write in second person ("You tend to...").

RULES:
- Base every statement on the statistics provided
- Keep the narrative to 3-5 sentences
- Be descriptive, not prescriptive (no advice)
- Mention the dominant workflow pattern, outcome distribution, and any notable characteristics
- If the data is too sparse (< 5 sessions), say so and keep it brief

Respond with valid JSON only, wrapped in <json>...</json> tags.`;

export function generateWorkingStylePrompt(data: {
  workflowDistribution: Record<string, number>;
  outcomeDistribution: Record<string, number>;
  characterDistribution: Record<string, number>;
  totalSessions: number;
  period: string;
  frictionFrequency: number;
}): string {
  return `Write a working style profile based on ${data.totalSessions} sessions over ${data.period}.

WORKFLOW PATTERNS:
${JSON.stringify(data.workflowDistribution, null, 2)}

OUTCOME SATISFACTION:
${JSON.stringify(data.outcomeDistribution, null, 2)}

SESSION TYPES:
${JSON.stringify(data.characterDistribution, null, 2)}

FRICTION FREQUENCY: ${data.frictionFrequency} total friction points across all sessions

Respond with this JSON format:
{
  "narrative": "3-5 sentence working style description"
}

Respond with valid JSON only, wrapped in <json>...</json> tags.`;
}
