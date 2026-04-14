// Canonical category arrays and classification guidance strings for LLM analysis.
// Extracted from prompts.ts — imported by normalizers and prompt generators.

// Shared guidance for friction category and attribution classification.
// Actor-neutral category definitions describe the gap, not the actor.
// Attribution field captures who contributed to the friction for actionability.
export const FRICTION_CLASSIFICATION_GUIDANCE = `<classification_guidance name="friction_points">
<rules>
  1. Capture WHAT went wrong (category + description).
  2. Capture WHO contributed (attribution).
  3. Explain WHY you classified it that way (_reasoning).
</rules>

<categories>
- "wrong-approach": Suboptimal tool, architecture, or pattern chosen when a better one existed.
- "knowledge-gap": Incorrect API/library usage due to factual error.
- "stale-assumptions": Actions based on false state (stale files, changed config).
- "incomplete-requirements": Missing critical constraints or acceptance criteria.
- "context-loss": Prior established session constraints forgotton or dropped.
- "scope-creep": Execution expanded beyond stated boundaries.
- "repeated-mistakes": Same error occurred multiple times post-correction.
- "documentation-gap": Unfindable or inaccessible documentation.
- "tooling-limitation": Permanent tool gap (no workaround exists).
</categories>

<disambiguation_rules>
- tooling-limitation vs wrong-approach: Limitation = NO workaround. Wrong-approach = Suboptimal choice.
- tooling-limitation vs knowledge-gap: Limitation = Capability missing. Knowledge-gap = Capability applied wrong.
- tooling-limitation vs stale-assumptions: Limitation = Permanent gap. Stale-assumptions = Tool behavior changed.
- wrong-approach vs knowledge-gap: Wrong-approach = Strategic choice. Knowledge-gap = Factual error.
- incomplete-requirements vs context-loss: Incomplete = Never provided. Context-loss = Provided but forgotten.
</disambiguation_rules>

<attribution_decision_tree>
Evaluate in strict order:
1. "environmental" = Cause external to user-AI interaction (infra outage, missing docs).
2. "user-actionable" = Vague prompt, missing context, no constraints, ambiguous correction.
3. "ai-capability" = User input clear, AI still failed.
Resolve ambiguity to "user-actionable" to maintain analytical focus.
</attribution_decision_tree>

<description_rules>
- Output one neutral sentence describing the GAP, not the actor.
- Inject specific details (file names, APIs, errors).
- Sequence as "Missing X caused Y".
- Transfer actor attribution entirely to the attribution field.
</description_rules>
</classification_guidance>`;

export const CANONICAL_FRICTION_CATEGORIES = [
  'wrong-approach',
  'knowledge-gap',
  'stale-assumptions',
  'incomplete-requirements',
  'context-loss',
  'scope-creep',
  'repeated-mistakes',
  'documentation-gap',
  'tooling-limitation',
] as const;

export const CANONICAL_PATTERN_CATEGORIES = [
  'structured-planning',
  'incremental-implementation',
  'verification-workflow',
  'systematic-debugging',
  'self-correction',
  'context-gathering',
  'domain-expertise',
  'effective-tooling',
] as const;

export const CANONICAL_PQ_DEFICIT_CATEGORIES = [
  'vague-request',
  'missing-context',
  'late-constraint',
  'unclear-correction',
  'scope-drift',
  'missing-acceptance-criteria',
  'assumption-not-surfaced',
] as const;

export const CANONICAL_PQ_STRENGTH_CATEGORIES = [
  'precise-request',
  'effective-context',
  'productive-correction',
] as const;

export const CANONICAL_PQ_CATEGORIES = [
  ...CANONICAL_PQ_DEFICIT_CATEGORIES,
  ...CANONICAL_PQ_STRENGTH_CATEGORIES,
] as const;

export const PROMPT_QUALITY_CLASSIFICATION_GUIDANCE = `<classification_guidance>
Each finding encapsulates precisely one execution pattern (deficit or strength). 

DEFICIT CATEGORIES:
- "vague-request": Prerequisite: The AI lacked required file paths, references, or behavioral boundaries to proceed logically. 
- "missing-context": Prerequisite: Essential architectural facts or codebase dependencies were omitted.
- "late-constraint": Prerequisite: The user provided a requirement AFTER the AI completed partial implementation based on previous constraints.
- "unclear-correction": Prerequisite: The user rejected the AI output without providing a corrective vector or structural reason.
- "scope-drift": Prerequisite: The session's primary objective altered boundaries mid-execution.
- "missing-acceptance-criteria": Prerequisite: The end-state boolean condition for success was left undefined, causing cyclical validation checks.
- "assumption-not-surfaced": Prerequisite: The user harbored an implicit local constraint unsupported by provided text.

STRENGTH CATEGORIES:
- "precise-request": Prerequisite: Initial input contained complete explicit boundaries, file paths, and output targets.
- "effective-context": Prerequisite: User actively supplied systemic context, prior codebase choices, or environment preconditions.
- "productive-correction": Prerequisite: User halted the AI and injected exact missing parameters allowing immediate recovery.

DIMENSION SCORING [0-100]:
- context_provision: Measure of proactive requirement loading. (<30 = blind processing, 90+ = zero requirement loss).
- request_specificity: Measure of explicit path/function bindings in initial tasks.
- scope_management: Maintainability of singular objective.
- information_timing: Measure of early-bound constraints versus late-bound corrections.
- correction_quality: Measure of corrective explicit details. (75 = no corrections required).
</classification_guidance>`;

export const EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE = `<classification_guidance name="effective_patterns">
<exclusion_rules>
Do NOT classify these as patterns:
- Routine file reads at session start (Read/Glob/Grep on <5 files before editing)
- Following explicit user instructions (e.g., user said "run tests")
- Basic tool usage (single file edits, standard CLI commands)
- Trivial self-corrections (typo fixes, minor syntax errors caught immediately)
</exclusion_rules>

<categories>
- "structured-planning": Task decomposed and boundaries defined BEFORE writing code.
- "incremental-implementation": Work progressed in verifiable steps with validation between them.
- "verification-workflow": Proactive correctness checks BEFORE considering work complete.
- "systematic-debugging": Methodical investigation using structured techniques.
- "self-correction": Pivoted from wrong path WITHOUT user correction.
- "context-gathering": Thorough investigation spanning multiple directories BEFORE any writes.
- "domain-expertise": Correct specific tool knowledge applied without searching.
- "effective-tooling": Leveraged advanced tool capabilities for outsized utility.
</categories>

<disambiguation_rules>
- structured-planning vs incremental-implementation: Planning = DECIDING what to do. Incremental = HOW you execute.
- context-gathering vs domain-expertise: Gathering = ACTIVE INVESTIGATION. Expertise = APPLYING EXISTING KNOWLEDGE.
- verification-workflow vs systematic-debugging: Verification = PROACTIVE correctness check. Debugging = REACTIVE investigation.
- self-correction vs user-directed: Self-correction = AI unprompted correction.
</disambiguation_rules>

<driver_decision_tree>
Evaluate in strict order:
1. "user-driven" = User infrastructure enabled this or user explicitly requested it.
2. "ai-driven" = AI exhibited behavior without user prompting or infrastructure.
3. "collaborative" = Both made distinct, identifiable contributions.
</driver_decision_tree>
</classification_guidance>`;
