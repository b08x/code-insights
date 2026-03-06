# Insights Generation: Claude Code `/insights` vs Code Insights

> **Date:** 2026-03-05
> **Purpose:** Deep comparison of insight generation approaches to identify gaps and strategic priorities.

---

## How Claude Code `/insights` Works

Claude Code's `/insights` is a **cross-session workflow analyzer** that:

1. Reads the **last 30 days** of session transcripts from `~/.claude/`
2. Runs a **multi-stage LLM pipeline**:
   - **Stage 1 — Facet Extraction**: Extracts structured "facets" per session (satisfaction signals, friction points, goal categories) and saves JSON to `~/.claude/usage-data/facets/`
   - **Stage 2 — Friction Analysis**: Aggregates facets across sessions, identifies recurring pain points in 3 categories with concrete examples
   - **Stage 3 — Cross-Session Pattern Synthesis**: Detects repeating workflows, tool clusters, systemic friction
   - **Stage 4 — Report Generation**: Synthesizes everything into a 4-section interactive HTML report
3. Opens `~/.claude/usage-data/report.html` in the browser automatically

### The 4 Report Sections

| Section | Purpose |
|---------|---------|
| **What's Working** | Your strengths, successful workflow patterns |
| **What's Hindering You** | Friction points, behavioral anti-patterns, tool misuse |
| **Quick Wins** | Low-effort improvements with copy-paste-ready snippets |
| **Ambitious Workflows** | Strategic, longer-term workflow improvements |

### The Killer Feature: Actionable Output

The report generates **copy-paste-ready artifacts**:
- CLAUDE.md rules tailored to your friction patterns
- Custom `/skill` templates for repetitive tasks
- Hook configurations for automation
- Agent configuration suggestions

---

## Side-by-Side Comparison

| Dimension | Claude Code `/insights` | Code Insights |
|-----------|------------------------|---------------|
| **Scope** | Cross-session (30 days, up to 50 sessions) | Per-session (one at a time) |
| **Trigger** | Single command: `/insights` | Manual click per session in dashboard |
| **Analysis Pipeline** | 4-stage (facets → friction → patterns → report) | 1-stage (session → insights JSON) |
| **Insight Types** | Working patterns, friction, quick wins, ambitious workflows | summary, decision, learning, technique, prompt_quality |
| **Output Format** | Interactive HTML report | Stored in SQLite, viewed in dashboard |
| **Actionable Artifacts** | CLAUDE.md rules, skill templates, hook configs | None — insights are read-only |
| **Cross-Session Patterns** | Core feature (friction analysis, pattern synthesis) | `findRecurringInsights()` exists but is secondary |
| **User Workflow Focus** | "How do YOU work?" (meta-analysis of your habits) | "What happened in THIS session?" (session recap) |
| **Friction Detection** | Dedicated stage with categories + examples | Not present |
| **Prompt Quality** | Implicit in friction analysis | Dedicated feature (efficiency score, anti-patterns, wasted turns) |
| **Privacy** | Local only, HTML file | Local only, SQLite |
| **Multi-Tool Support** | Claude Code only | Claude Code, Cursor, Codex CLI, Copilot CLI |

---

## What Code Insights is Missing

### 1. Cross-Session Synthesis (The Big Gap)

Claude Code analyzes **30 days of sessions together** to find patterns. Our app analyzes sessions **one at a time**. We have `findRecurringInsights()` but it's a lightweight post-hoc linking step, not a dedicated synthesis pipeline.

**What we lack:**
- No "facet extraction" stage that creates structured per-session metadata for aggregation
- No friction analysis across sessions (identifying systemic pain points)
- No cross-session narrative synthesis ("your working style is...")
- No aggregate behavior profiling

### 2. Actionable Output / CLAUDE.md Integration

This is Claude Code's killer differentiation. Their insights produce **artifacts you can immediately use**:
- Copy-paste CLAUDE.md rules
- Custom skill definitions
- Hook configurations
- Agent setup suggestions

Our insights are **informational only** — the user reads them but has no path to action. There's no "Add to CLAUDE.md" button, no generated rules, no workflow automation suggestions.

### 3. Workflow/Habit Analysis

Claude Code asks "How do YOU work?" — it's a **meta-analysis of the developer**, not the session. It identifies:
- What tools you gravitate toward
- Where you get stuck repeatedly
- What behavioral patterns slow you down

Our app asks "What happened HERE?" — it's a **session recap**. Good for knowledge capture, but doesn't help the developer improve their workflow.

### 4. Proactive Friction Detection

Claude Code has a dedicated friction analysis stage that produces structured output:
```json
{
  "intro": "You frequently struggle with...",
  "categories": [
    { "name": "Configuration Drift", "examples": ["..."] },
    { "name": "Test Suite Flakiness", "examples": ["..."] }
  ]
}
```

We have nothing equivalent. Our `prompt_quality` analysis is the closest, but it's per-session and focused on prompt efficiency, not workflow friction.

### 5. One-Click Generation

Claude Code: type `/insights`, wait, get a full report. Our app: navigate to session → click Analyze → repeat for each session → manually browse insights page → no synthesized view.

---

## What Code Insights Does Better

| Area | Why We're Ahead |
|------|-----------------|
| **Granular Insight Types** | 5 typed insights (summary, decision, learning, technique, prompt_quality) with rich structured metadata vs Claude Code's narrative-only output |
| **Decision Tracking** | Full decision records: situation → choice → reasoning → alternatives → trade-offs → revisit conditions. Claude Code doesn't track decisions. |
| **Learning Capture** | Structured: symptom → root cause → takeaway → applies_when. This is knowledge management, not just reporting. |
| **Multi-Tool Support** | We analyze Cursor, Codex CLI, Copilot CLI sessions too. Claude Code only analyzes itself. |
| **Prompt Quality Analysis** | Dedicated analysis with efficiency score, wasted turns, anti-patterns, rewrite suggestions. More granular than Claude Code's friction analysis. |
| **Persistent Storage** | SQLite with full CRUD, search, filtering, grouping. Claude Code writes a static HTML file. |
| **Export Formats** | agent-rules, knowledge-brief, obsidian, notion exports. Claude Code: HTML only. |
| **Confidence Scoring** | Every insight has a confidence score with a 70+ threshold. Claude Code has no confidence model. |

---

## Strategic Recommendations (Ranked by Impact)

### Priority 1: Cross-Session Insight Synthesis

Add a "Generate Project Insights" or "Generate Weekly Report" action that:
- Aggregates all sessions in a time range (7d/30d)
- Runs a multi-stage pipeline similar to Claude Code's facets → friction → synthesis
- Produces a unified report with patterns, friction points, and behavioral insights
- Stores the result as `scope: 'project'` or `scope: 'overall'` insights

### Priority 2: Actionable Artifacts

For each insight, generate actionable output:
- **Decisions** → "Add to CLAUDE.md" button that generates a rule
- **Learnings** → "Create snippet" that adds to a personal knowledge base
- **Friction patterns** → "Create hook" or "Add rule" suggestions
- **Prompt quality** → "Add to CLAUDE.md" with specific prompt improvement rules

### Priority 3: One-Command Analysis

Add a CLI command like `code-insights insights` that:
- Auto-analyzes all un-analyzed sessions
- Runs cross-session synthesis
- Opens the dashboard to the results (or generates an HTML report)

### Priority 4: Developer Behavior Profiling

Add a "Your Working Style" section that synthesizes:
- Tool preferences across sessions
- Time-of-day patterns
- Session character distribution over time
- Recurring friction categories
- Improvement trends (prompt quality scores over time)

---

## Key Takeaway

**Code Insights is stronger on structured knowledge capture** (decisions, learnings, techniques) while **Claude Code is stronger on actionable workflow improvement**. The ideal system combines both — deep insight extraction AND actionable output with cross-session synthesis.

### Our Current Architecture

```
Session Files → Provider → SQLite → Per-Session LLM Analysis → Insights (read-only)
```

### Target Architecture

```
Session Files → Provider → SQLite → Per-Session Analysis → Insights (structured) + Facets
                                   → Cross-Session Synthesis → Friction/Patterns/Behavior Profile
                                   → Actionable Artifacts → CLAUDE.md rules, skills, hooks
                                   → CLI command (one-click) → Report + Dashboard
```

---

## Design Decisions (Finalized 2026-03-05, revised after expert review)

### Feature Name & Information Architecture

**"Reflect"** is the umbrella feature name and the CLI command that **generates** cross-session analysis. **"Patterns"** is the dashboard page/tab that **displays** the results. This distinction matters:

- `code-insights reflect` = action (generate/refresh the analysis)
- `code-insights stats patterns` = view (display stored results in terminal)
- Dashboard "Patterns" page = view (display stored results in browser)

#### Dashboard: Separate Page (for now)

"Patterns" lives as a dedicated page in the dashboard navigation, not a tab within Insights. Rationale: this is a flagship differentiator that needs room to breathe. Can be merged into Insights as a tab later if navigation becomes crowded.

#### Section Names (Plain Language)

| Section | Name | Intent | Output |
|---------|------|--------|--------|
| Cross-session pattern synthesis | **Friction & Wins** | "What patterns am I seeing?" — friction detection, what's working, recurring workflows | Structured analysis with categories, examples, trends |
| Actionable artifacts | **Rules & Skills** | "What rules/skills/hooks should I use?" — generates artifacts from patterns | CLAUDE.md rules, skill templates, hook configs, targeted per tool |
| Behavior profiling | **Working Style** | "How do I work?" — working style narrative, tool preferences, trends | Behavioral profile, session character distribution, satisfaction trends |

Each section has its own LLM prompt with its own output format and schema. They all consume the same foundation: **facets** + existing insights + computed session metadata.

#### CLI

```bash
# GENERATION (creates/refreshes the analysis)
code-insights reflect                          # Generate all sections
code-insights reflect --section rules-skills   # Generate specific section
code-insights reflect --period 30d             # Time range (default: 7d)
code-insights reflect --project <name>         # Scope to project

# VIEWING (display stored results in terminal)
code-insights stats patterns                   # Show pattern summary
code-insights stats patterns --section style   # Show specific section
code-insights stats patterns --period 30d      # Inherits shared stats flags
code-insights stats patterns --project <name>  # Inherits shared stats flags
```

---

### Storage: Dedicated `session_facets` Table

Facets are stored in a **dedicated table**, not the insights table. Expert review confirmed this is the right call:

- **7 wasted columns** avoided (title, content, summary, bullets, confidence, linked_insight_ids, scope are meaningless for facets)
- **Primary key = session_id** enforces 1:1 relationship (insights table can't prevent duplicates)
- **Indexable scalar columns** — `outcome_satisfaction` and `workflow_pattern` as real columns means `GROUP BY` queries for Working Style are instant, no JSON parsing
- **Backward compat tracking** is a trivial `LEFT JOIN session_facets`

```sql
CREATE TABLE IF NOT EXISTS session_facets (
  session_id              TEXT PRIMARY KEY REFERENCES sessions(id),
  outcome_satisfaction    TEXT NOT NULL,              -- high/medium/low/abandoned
  workflow_pattern        TEXT,                        -- plan-then-implement, etc.
  had_course_correction   INTEGER NOT NULL DEFAULT 0,  -- boolean
  course_correction_reason TEXT,
  iteration_count         INTEGER NOT NULL DEFAULT 0,
  friction_points         TEXT,                        -- JSON array (max 5 items)
  effective_patterns      TEXT,                        -- JSON array (max 3 items)
  extracted_at            TEXT NOT NULL DEFAULT (datetime('now')),
  analysis_version        TEXT NOT NULL DEFAULT '1.0.0'
);

CREATE INDEX IF NOT EXISTS idx_facets_outcome ON session_facets(outcome_satisfaction);
CREATE INDEX IF NOT EXISTS idx_facets_workflow ON session_facets(workflow_pattern);
```

**Migration:** V3 (new table + indexes). No changes to existing insights table or InsightType enum.

---

### Facet Schema

Facets are structured per-session metadata extracted during analysis. They enable cross-session features to work from small aggregated JSON instead of re-reading raw sessions (~350 extra output tokens per session vs ~80k input tokens for re-reading).

```typescript
interface SessionFacet {
  // === FRICTION ===
  friction_points: Array<{
    category: string;           // kebab-case free-form, e.g., "config-drift", "wrong-approach", "missing-dependency"
    description: string;        // one sentence: what went wrong
    severity: 'high' | 'medium' | 'low';
    resolution: 'resolved' | 'workaround' | 'unresolved';
  }>;                           // max 5

  // === OUTCOME ===
  outcome_satisfaction: 'high' | 'medium' | 'low' | 'abandoned';

  // === WORKFLOW ===
  workflow_pattern: string | null;
  // Recommended values: plan-then-implement, iterative-refinement, debug-fix-verify,
  // explore-then-build, direct-execution

  // === WHAT WORKED ===
  effective_patterns: Array<{
    description: string;        // specific technique worth repeating
    confidence: number;         // 0-100
  }>;                           // max 3

  // === COURSE CORRECTIONS ===
  had_course_correction: boolean;
  course_correction_reason: string | null;

  // === INTERACTION QUALITY ===
  iteration_count: number;      // user correction/clarification cycles
}
```

**Key design decisions:**
- **No `goal_category` field** — reuses existing `session_character` (7 types: deep_focus, bug_hunt, feature_build, exploration, refactor, learning, quick_task) wherever classification is needed
- **Friction categories: two-layer normalization** — prompt provides a canonical list of ~15-20 common categories as PREFERRED vocabulary with free-form kebab-case escape hatch. Post-processing uses Levenshtein distance (existing `fuzzy-match.ts`) to cluster similar categories during aggregation. Future: learn from data and add examples to prompt for consistency.
- **`effective_patterns` has per-item confidence** — supports future feedback mechanisms for refinement
- **Integrated extraction** — facets are extracted as part of the existing per-session analysis prompt (~350 output tokens), not a separate LLM call
- **Facets come FIRST in prompt** — holistic session assessment before local knowledge extraction, reduces instruction interference
- **Stored in dedicated `session_facets` table** with indexed scalar columns

#### Computed Facets (Derived from SQLite, NOT LLM)

Computed on-the-fly at query time from existing session/message data. No materialization needed — 10-50ms for 100 sessions is acceptable:

```typescript
interface ComputedFacets {
  tools_used: string[];
  dominant_tool_pattern: 'read-heavy' | 'edit-heavy' | 'bash-heavy' | 'balanced';
  message_count: number;
  session_duration_minutes: number;
}
```

---

### Prompt Architecture

#### Facet Extraction (Per-Session)

**Normal sessions (<80k tokens):** Integrated into existing `SESSION_ANALYSIS_SYSTEM_PROMPT`. Facet instructions come FIRST (holistic assessment) before insight extraction (local knowledge capture).

```
SYSTEM:
  [Role framing]

  PART 1 — SESSION FACETS (extract these first):
  [Facet schema with field-level instructions]
  [Canonical friction category list + escape hatch]
  [3 worked examples]

  PART 2 — INSIGHTS (then extract these):
  [Existing insight instructions — unchanged]

RESPONSE JSON:
  { "facets": { ... }, "session_character": "...", "insights": [...] }
```

**Chunked sessions (>80k tokens):** Separate lightweight facet-only prompt. Facets cannot be meaningfully merged across chunks (e.g., `outcome_satisfaction` for chunk 2 of 4 is nonsense). Uses session summary + first/last 20 messages (~2.5k input tokens → ~350 output tokens).

#### Friction Category Canonical List (~15-20 categories)

Provided in prompt as PREFERRED vocabulary. LLM uses these when applicable, creates new kebab-case categories when none fit:

```
wrong-approach, missing-dependency, config-drift, test-failure, type-error,
api-misunderstanding, stale-cache, version-mismatch, permission-issue,
incomplete-requirements, circular-dependency, race-condition,
environment-mismatch, documentation-gap, tooling-limitation
```

Post-processing: Levenshtein normalization via existing `fuzzy-match.ts` during aggregation.

#### Synthesis Prompts (Cross-Session)

All synthesis prompts receive **pre-aggregated data** (aggregation done in code, not by LLM). LLMs synthesize narratives; they don't count.

**Friction & Wins:**
- Input: Ranked friction categories with counts/severity/examples + ranked effective patterns with frequency/confidence (~2k tokens)
- Output: Narrative analysis of 3-5 significant patterns, root causes, trends (~800 tokens)
- Hallucination guard: "Every claim must trace to the statistics. Patterns require 2+ occurrences. Do not infer patterns not present in the data."

**Rules & Skills:**
- Input: Recurring friction (count >= 3) + effective patterns (count >= 2) + prompt quality anti-patterns (~1.5k tokens)
- Output: CLAUDE.md rules, skill templates, hook configs (~1.2k tokens)
- Format-prescriptive: exact artifact formats specified in prompt
- Target tool auto-detected from database (dominant source tool), with toggle for multi-tool users

**Working Style:**
- Input: Aggregated stats (workflow distribution, outcome trends, session character breakdown, tool usage, friction frequency) (~500 tokens)
- Output: 3-5 sentence narrative working style profile (~200 tokens)
- Instruction: "Describe what you see, not what they should change."

#### Token Budget (100 sessions, 30 days)

| Step | Input Tokens | Output Tokens | Cost (Sonnet 4) |
|------|-------------|---------------|-----------------|
| Facet extraction (new sessions, integrated) | 0 marginal | 35,000 | ~$0.53 marginal |
| Facet backfill (already analyzed, lightweight prompt) | 250,000 | 35,000 | ~$1.28 |
| Friction & Wins synthesis | 2,500 | 800 | ~$0.02 |
| Rules & Skills generation | 2,100 | 1,200 | ~$0.02 |
| Working Style profile | 800 | 200 | ~$0.01 |
| **Total (new sessions + synthesis)** | **5,400** | **37,200** | **~$0.58** |
| **Total (backfill + synthesis)** | **255,400** | **37,200** | **~$1.33** |

---

### Backward Compatibility

Existing analyzed sessions won't have facets. Strategy:

1. **Facet-only extraction prompt** — lightweight prompt (summary + first/last 20 messages → facet JSON). ~$0.013 per session.
2. **Dashboard alerts** — alert icon on session detail page and Patterns page when sessions are missing facet data.
3. **Progressive on-demand generation** — when user navigates to Patterns page, generate facets for sessions that lack them progressively ("Analyzing session 3 of 12...") with cost estimate shown before starting. User can stop at any time. Cross-session synthesis works with whatever facets are available (graceful degradation as primary mode, not fallback).
4. **Cost transparency** — show estimated token/cost before any generation action. (Note: LLM cost tracking per call is a separate backlog item that applies across the entire app.)

### How Sections Consume Facets

```
Friction & Wins:
  SELECT outcome_satisfaction, workflow_pattern, friction_points, effective_patterns
  FROM session_facets sf
  JOIN sessions s ON sf.session_id = s.id
  WHERE s.project_id = ? AND s.started_at >= ?
  → aggregate friction_points via json_each() by category → rank by frequency × severity
  → aggregate effective_patterns → group by similarity
  → pre-aggregate in code → feed to synthesis LLM call

Rules & Skills:
  Filter friction patterns with count >= 3 (recurring)
  Filter effective patterns with count >= 2
  → feed to artifact generation LLM call
  → auto-detect target tool format from database (dominant source tool)
  → dashboard: toggle for multi-tool users ("Show for: [All] [Claude Code] [Cursor]")
  → CLI: --target flag, defaults to auto-detect

Working Style:
  Mostly aggregation queries, minimal LLM:
  → session_character distribution (from sessions table)
  → workflow_pattern distribution (from session_facets — indexed, no JSON parsing)
  → outcome_satisfaction trends (from session_facets — indexed)
  → tool usage patterns (computed on-the-fly from messages table via json_each(), 10-50ms)
  → friction category frequency (from session_facets.friction_points via json_each())
  → light LLM synthesis for narrative working style description
```

### Multi-Tool Differentiation

Code Insights analyzes sessions from Claude Code, Cursor, Codex CLI, and Copilot CLI. The Patterns feature can surface **cross-tool patterns** that Claude Code's `/insights` never could:

- "You hit dependency issues more in Cursor sessions than Claude Code"
- "Your Codex CLI sessions are mostly quick_task, while Claude Code sessions are feature_build"
- "Your workflow pattern differs by tool: plan-then-implement in Claude Code, iterative-refinement in Cursor"

This is a unique competitive advantage.

---

### Backlog Items (Out of Scope for This Feature)

- **LLM cost tracking per call** — show token usage and estimated cost for every LLM call across the entire app (analysis, export, reflect). Scoped separately.
- **Feedback mechanism** — allow users to rate insight/facet quality to improve confidence scoring over time. Scoped separately.
- **Friction category learning** — analyze accumulated novel categories periodically and add frequent ones to the canonical prompt list.
