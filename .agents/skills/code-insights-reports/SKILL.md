---
name: code-insights-reports
description: Safely queries, analyzes, and reports on AI coding session intelligence, token economics, prompt quality, friction loops, cross-tool benchmarks, and chronological ADR timelines from the local Code Insights SQLite database (~/.code-insights/data.db).
triggers:
  - "code insights report"
  - "session report"
  - "ai token cost"
  - "prompt quality score"
  - "friction analysis"
  - "tool benchmarks"
  - "adr timeline"
  - "architectural decisions"
  - "coding session history"
---

# Code Insights DB Reporting Agent Skill

The `code-insights-reports` skill equips AI coding agents with safe, read-only analytical access to the local `code-insights` SQLite database at `~/.code-insights/data.db` (5,400+ sessions, 33,000+ insights, 399,000+ messages).

It enables agents to inspect developer history, quantify token spending across models, evaluate prompt quality via Systemic Functional Linguistics (SFL), diagnose friction loops and course corrections, benchmark AI coding CLIs (Claude Code, Antigravity, OpenCode, Mistral Vibe, Hermes Agent, Crush, Codex), and trace chronological Architectural Decision Records (ADRs) with causal graph links.

---

## 1. Safety & Architecture Invariants

- **Strict Read-Only Access**: All queries are executed in read-only mode (`DatabaseSync({ readOnly: true })` or `sqlite3 -readonly`).
- **Zero Mutation Guarantee**: Writing or modifying tables is strictly forbidden. The runner enforces `PRAGMA query_only = ON;` and rejects any non-SELECT statements.
- **Concurrency Safe**: Configured with a `5000ms` busy timeout (`PRAGMA busy_timeout = 5000;`) to safely interoperate with active background sync workers without lock contention.
- **Zero-Dependency CLI**: Powered by `scripts/ci-report.js` using Node.js v22+ built-in `node:sqlite`. No external `npm` installs required.

---

## 2. CLI Runner (`scripts/ci-report.js`)

The skill bundles an executable CLI runner at `scripts/ci-report.js` (also available in the project repo at `.agents/skills/code-insights-reports/scripts/ci-report.js`).

### Quick Command Reference

```bash
# Global database volume, date windows, and economics
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js summary

# Cross-session reflections and developer learnings for a project
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js reflection --project code-insights --limit 10

# Token economics, prompt cache hit ratios, and USD cost by tool/model
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js cost --days 30

# Quantify friction taxonomy, course correction rate, and failure points
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js friction --days 14

# Prompt quality scoring, SFL metafunctions, and actionable improvements
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js prompt-quality --limit 10

# Cross-tool benchmark comparison (Claude Code, Antigravity, OpenCode, etc.)
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js benchmarks

# Chronological ADR timeline graph tracing with causal milestones
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js timeline --project code-insights --mermaid

# Safe read-only ad-hoc SQL query
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js query "SELECT id, name, session_count FROM projects LIMIT 5"

# Run self-test verification suite
node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js verify
```

### Global Options

| Option | Description |
|---|---|
| `--project <name>` | Filter by project name (substring match) |
| `--days <number>` | Filter sessions to the last N days (e.g. 7, 30) |
| `--limit <number>` | Limit the number of records returned (default 10 or 15) |
| `--json` | Output raw JSON instead of formatted Markdown |
| `--output, -o <path>` | Write the resulting Markdown or JSON report to a file |
| `--mermaid` | Output Mermaid causal diagram in timeline analysis |
| `--db <path>` | Custom SQLite database path (default: `~/.code-insights/data.db`) |

---

## 3. Analytical Workflows & Use Cases

### A. Tracking Token Spend & Budget
When asked: *"How much did we spend on LLM coding this month?"* or *"What's our cache efficiency?"*
1. Run `ci-report.js cost --days 30`.
2. Inspect the **Economics by AI Coding Tool** table and **Cache %** column.
3. Note differences between pay-as-you-go API services (Claude, Gemini) vs flat-rate subscriptions or local/free runners (Antigravity, OpenCode free models).

### B. Diagnosing Agent Stalls & Course Corrections
When asked: *"Why are sessions failing or requiring so many corrections?"*
1. Run `ci-report.js friction --days 14`.
2. Review the **Course Correction Rate** and **Friction Taxonomy Breakdown** (e.g., `knowledge-gap`, `tooling-limitation`, `incomplete-requirements`).
3. Check the concrete friction incident narratives to identify recurring bottlenecks.

### C. Improving Developer Prompting Habits (SFL)
When asked: *"How can I improve my prompts?"* or *"Analyze prompt quality scores."*
1. Run `ci-report.js prompt-quality --limit 10`.
2. Review the 5 SFL dimensions:
   - **Context Provision** (Ideational): Providing background files and architectural constraints upfront.
   - **Information Timing** (Ideational): Giving tool parameters proactively rather than reactively.
   - **Correction Quality** (Interpersonal): Decisive guidance when directing agent adjustments.
   - **Request Specificity** (Textual): Clear acceptance criteria and unambiguous tasks.
   - **Scope Management** (Textual): Preventing task creep and keeping focus sharp.
3. Review the **Top Prompt Deficit Categories** and adopt the concrete recommended improvements.

### D. Architectural Decision Records (ADR) Timeline
When asked: *"What architectural choices were made on this project?"* or *"Reconstruct our development timeline."*
1. Run `ci-report.js timeline --project <name> --limit 15 --mermaid`.
2. Present the ADRs including:
   - **Situation**: The technical challenge or bug prompting the decision.
   - **Choice**: The exact solution implemented.
   - **Trade-offs**: Accepted downsides and maintenance considerations.
   - **Reasoning**: Why alternatives were rejected.
   - **Milestones**: Formal Concept Analysis (FCA) execution steps linked to the decision.
3. Include the generated ASCII trajectory or Mermaid diagram in reports.

---

## 4. Fallback Direct `sqlite3` CLI Access

In environments where Node is not available or when executing targeted ad-hoc analytics:

```bash
# Always use -readonly flag
sqlite3 -readonly ~/.code-insights/data.db "
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT 
  source_tool, 
  count(*) as sessions, 
  round(sum(estimated_cost_usd), 2) as cost_usd 
FROM sessions 
WHERE deleted_at IS NULL 
GROUP BY source_tool 
ORDER BY sessions DESC;
"
```

For advanced queries and complete column documentation, refer to:
- [references/schema-v18.md](file:///home/b08x/.gemini/skills/code-insights-reports/references/schema-v18.md)
- [references/sql-recipes.md](file:///home/b08x/.gemini/skills/code-insights-reports/references/sql-recipes.md)
