// Canonical category arrays and classification guidance strings for LLM analysis.
// Extracted from prompts.ts — imported by normalizers and prompt generators.

// Shared guidance for friction category and attribution classification.
// Actor-neutral category definitions describe the gap, not the actor.
// Attribution field captures who contributed to the friction for actionability.
export const FRICTION_CLASSIFICATION_GUIDANCE = `
FRICTION CLASSIFICATION GUIDANCE:

Each friction point captures WHAT went wrong (category + description), WHO contributed (attribution), and WHY you classified it that way (_reasoning).

CATEGORIES — classify the TYPE of gap or obstacle:
- "wrong-approach": A strategy was pursued that didn't fit the task — wrong architecture, wrong tool, wrong pattern. Includes choosing a suboptimal tool when a better one was available.
- "knowledge-gap": Incorrect knowledge was applied about a library, API, framework, or language feature. The capability existed but was used wrong.
- "stale-assumptions": Work proceeded from assumptions about current state that were incorrect (stale files, changed config, different environment, tool behavior changed between versions).
- "incomplete-requirements": Instructions were missing critical context, constraints, or acceptance criteria needed to proceed correctly.
- "context-loss": Prior decisions or constraints established earlier in the session were lost or forgotten.
- "scope-creep": Work expanded beyond the boundaries of the stated task.
- "repeated-mistakes": The same or similar error occurred multiple times despite earlier correction.
- "documentation-gap": Relevant docs existed but were inaccessible or unfindable during the session.
- "tooling-limitation": The AI coding tool or its underlying model genuinely could not perform a needed action — missing file system access, unsupported language feature, context window overflow, inability to run a specific command type. Diagnostic: Could a reasonable user prompt or approach have achieved the same result? If the only workaround is unreasonably complex or loses significant fidelity, this IS a tooling-limitation. If a straightforward alternative existed → it is NOT tooling-limitation.
  RECLASSIFY if any of these apply:
  - Rate-limited or throttled → create "rate-limit-hit" instead
  - Agent crashed or lost state → use "wrong-approach" or create "agent-orchestration-failure"
  - Wrong tool chosen when a better one existed → "wrong-approach"
  - User didn't know the tool could do something → "knowledge-gap"
  - Tool worked differently than expected → "stale-assumptions"

DISAMBIGUATION — use these to break ties when two categories seem to fit:
- tooling-limitation vs wrong-approach: Limitation = the tool CANNOT do it (no workaround exists). Wrong-approach = the tool CAN do it but a suboptimal method was chosen.
- tooling-limitation vs knowledge-gap: Limitation = the capability genuinely does not exist. Knowledge-gap = the capability exists but was applied incorrectly.
- tooling-limitation vs stale-assumptions: Limitation = permanent gap in the tool. Stale-assumptions = the tool USED TO work differently or the assumption about current behavior was wrong.
- wrong-approach vs knowledge-gap: Wrong-approach = strategic choice (chose library X over Y). Knowledge-gap = factual error (used library X's API incorrectly).
- incomplete-requirements vs context-loss: Incomplete = the information was NEVER provided. Context-loss = it WAS provided earlier but was forgotten or dropped.

When no category fits, create a specific kebab-case category. A precise novel category is better than a vague canonical one.

ATTRIBUTION — 3-step decision tree (follow IN ORDER):
Step 1: Is the cause external to the user-AI interaction? (missing docs, broken tooling, infra outage) → "environmental"
Step 2: Could the USER have prevented this with better input? Evidence: vague prompt, missing context, no constraints, late requirements, ambiguous correction → "user-actionable"
Step 3: User input was clear and the AI still failed → "ai-capability"
When causality is ambiguous between user-actionable and ai-capability, classify as "user-actionable" to maintain analytical focus on prompt constraints.

DESCRIPTION RULES:
- One neutral sentence describing the GAP, not the actor
- Include specific details (file names, APIs, error messages)
- Frame as "Missing X caused Y" NOT "The AI failed to X" or "The user forgot to X"
- Let the attribution field carry the who`;

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

export const EFFECTIVE_PATTERN_CLASSIFICATION_GUIDANCE = `
EFFECTIVE PATTERN CLASSIFICATION GUIDANCE:

Each effective pattern captures a technique or approach that contributed to a productive session outcome.

BASELINE EXCLUSION — do NOT classify these as patterns:
- Routine file reads at session start (Read/Glob/Grep on <5 files before editing)
- Following explicit user instructions (user said "run tests" → running tests is not a pattern)
- Basic tool usage (single file edits, standard CLI commands)
- Trivial self-corrections (typo fixes, minor syntax errors caught immediately)
Only classify behavior that is NOTABLY thorough, strategic, or beyond baseline expectations.

CATEGORIES — classify the TYPE of effective pattern:
- "structured-planning": Decomposed the task into explicit steps, defined scope boundaries, or established a plan BEFORE writing code. Signal: plan/task-list/scope-definition appears before implementation.
- "incremental-implementation": Work progressed in small, verifiable steps with validation between them. Signal: multiple small edits with checks between, not one large batch.
- "verification-workflow": Proactive correctness checks (builds, tests, linters, types) BEFORE considering work complete. Signal: test/build/lint commands when nothing was known broken.
- "systematic-debugging": Methodical investigation using structured techniques (binary search, log insertion, reproduction isolation). Signal: multiple targeted diagnostic steps, not random guessing.
- "self-correction": Recognized a wrong path and pivoted WITHOUT user correction. Signal: explicit acknowledgment of mistake + approach change. NOT this if the user pointed out the error.
- "context-gathering": NOTABLY thorough investigation before changes — reading 5+ files, cross-module exploration, schema/type/config review. Signal: substantial Read/Grep/Glob usage spanning multiple directories before any Edit/Write.
- "domain-expertise": Applied specific framework/API/language knowledge correctly on first attempt without searching. Signal: correct non-obvious API usage with no preceding search and no subsequent error. NOT this if files were read first — that is context-gathering.
- "effective-tooling": Leveraged advanced tool capabilities that multiplied productivity — agent delegation, parallel work, multi-file coordination, strategic mode selection. Signal: use of tool features beyond basic read/write/edit.

CONTRASTIVE PAIRS:
- structured-planning vs incremental-implementation: Planning = DECIDING what to do (before). Incremental = HOW you execute (during). Can have one without the other.
- context-gathering vs domain-expertise: Gathering = ACTIVE INVESTIGATION (reading files). Expertise = APPLYING EXISTING KNOWLEDGE without investigation. If files were read first → context-gathering.
- verification-workflow vs systematic-debugging: Verification = PROACTIVE (checking working code). Debugging = REACTIVE (investigating a failure).
- self-correction vs user-directed: Self-correction = AI caught own mistake unprompted. User said "that's wrong" → NOT self-correction.

DRIVER — 4-step decision tree (follow IN ORDER):
Step 1: Did user infrastructure enable this? (CLAUDE.md rules, agent configs, hookify hooks, custom commands, system prompts) → "user-driven"
Step 2: Did the user explicitly request this behavior? (asked for plan, requested tests, directed investigation) → "user-driven"
Step 3: Did the AI exhibit this without any user prompting or infrastructure? → "ai-driven"
Step 4: Both made distinct, identifiable contributions → "collaborative"
Use "collaborative" ONLY when you can name what EACH party contributed. If uncertain, prefer the more specific label.

When no canonical category fits, create a specific kebab-case category (a precise novel category is better than forcing a poor fit).`;
