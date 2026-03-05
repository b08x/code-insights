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
Session Files → Provider → SQLite → Per-Session Analysis → Insights (structured)
                                   → Cross-Session Synthesis → Friction/Patterns/Behavior Profile
                                   → Actionable Artifacts → CLAUDE.md rules, skills, hooks
                                   → CLI command (one-click) → Report + Dashboard
```
