# Implementation Plan: Code Insights DB Reporting Agent Skill

## Solution Approach

Create an agent skill package named `code-insights-reports` deployed globally to `~/.gemini/skills/code-insights-reports/` and mirrored locally to `.agents/skills/code-insights-reports/`. 

The skill provides AI coding agents with direct, safe analytical access to the local `code-insights` SQLite database (`~/.code-insights/data.db`, 5,400+ sessions, 33,000+ insights, 399,000+ messages). To guarantee portability and avoid build/dependency issues across agent environments, the skill bundles a zero-dependency CLI helper (`scripts/ci-report.js`) built on Node.js v22+ built-in `node:sqlite` (`DatabaseSync`) configured with strict read-only access (`readOnly: true`) and a 5,000ms busy timeout.

The skill supports 7 specialized analytical dimensions:
1. **Overview / Summary**: High-level database metrics, active date windows, session/message volume, and total investment.
2. **Session Reflection**: Narrative developer digests, key architectural decisions, and key takeaways filtered by project or time period.
3. **Cost & Token Economics**: Input/output/cache tokens, cache hit efficiency ratios, and estimated USD costs by model, project, and tool.
4. **Friction & Failure Loops**: Quantified friction taxonomy (tooling, context, knowledge gaps), course corrections, abandoned sessions, and satisfaction ratings.
5. **Prompt Quality & SFL**: SFL metafunction distributions (Ideational, Interpersonal, Textual), dimension scores (context provision, request specificity, etc.), and optimization suggestions.
6. **Cross-Tool Benchmarks**: Comparative analysis across Claude Code, Antigravity, OpenCode, Mistral Vibe, Hermes Agent, and other tools.
7. **Project Development Timelines & ADR Graph Tracing**: Chronological reconstruction of Architectural Decision Records (ADRs) extracted from `insights` (`type = 'decision'`, unpacking situation, choice, reasoning, and trade-offs) linked to `session_steps` milestones and causal branch points.
8. **Ad-Hoc Safe Querying**: Schema reference (v18) and SQL design guidelines for ad-hoc natural language questions.

Outputs are rendered as formatted Markdown briefs with summary metrics, readable tabular data, or exported standalone Markdown reports/artifacts.

---

## Ordered Implementation Steps

### Step 1: Create Skill Scaffolding and Reference Documentation
- **Files**:
  - `~/.gemini/skills/code-insights-reports/references/schema-v18.md`
  - `~/.gemini/skills/code-insights-reports/references/sql-recipes.md`
- **Actions**:
  - Document the complete v18 SQLite schema with primary keys, indexes, and JSON column structures (`metadata`, `friction_points`, `dimension_scores`, `session_steps`).
  - Document battle-tested, read-only SQL recipes with explicit `PRAGMA query_only = ON;` and `sqlite3 -readonly` patterns.
- **Verification**:
  - Verify markdown files exist and accurately match `cli/src/db/schema.ts` and live table info.

### Step 2: Implement Zero-Dependency CLI Helper (`scripts/ci-report.js`)
- **Files**:
  - `~/.gemini/skills/code-insights-reports/scripts/ci-report.js`
- **Actions**:
  - Implement standalone CLI script using `node:sqlite` `DatabaseSync` with `{ readOnly: true }` and `PRAGMA busy_timeout = 5000;`.
  - Implement subcommands:
    - `summary`: High-level database summary metrics.
    - `reflection`: Cross-session summaries and learnings for a project or time window (`--project`, `--days`).
    - `cost`: Token and cost breakdown by project, model, and source tool.
    - `friction`: Friction points analysis, failure categorization, and course correction rates.
    - `prompt-quality`: Prompt scores, dimension averages, and SFL breakdowns.
    - `benchmarks`: Cross-tool comparison metrics and satisfaction rates.
    - `timeline`: Chronological ADR graph tracing, extracting decision metadata (`situation`, `choice`, `trade_offs`, `branch_point`), linked session steps, and rendering ASCII/Mermaid causal traces.
    - `query`: Safe read-only ad-hoc SQL execution (blocking any non-SELECT statements).
    - `verify`: Automated self-test verifying database connection, schema checks, and running all subcommands.
  - Implement output options: formatted Markdown table output (default), `--json` (raw JSON), and `--output <path>` (saving report to file/artifact).
- **Verification**:
  - Run `node ~/.gemini/skills/code-insights-reports/scripts/ci-report.js verify` and verify clean 0 exit code.

### Step 3: Author the Agent Skill Manifest (`SKILL.md`)
- **Files**:
  - `~/.gemini/skills/code-insights-reports/SKILL.md`
- **Actions**:
  - Include valid YAML frontmatter (`name: code-insights-reports`, description, triggers).
  - Document agent orientation protocol: locating database, checking version, selecting appropriate reporting subcommand.
  - Document direct `sqlite3` CLI recipes as fallback for environments without Node.
  - Document guidelines for synthesizing executive reports, citing session IDs, and outputting actionable recommendations.
- **Verification**:
  - Check YAML frontmatter parsing and test reading the skill instructions.

### Step 4: Mirror Skill to Repository Local Directory
- **Files**:
  - `.agents/skills/code-insights-reports/`
- **Actions**:
  - Mirror the complete skill package (`SKILL.md`, `scripts/`, `references/`) to `.agents/skills/code-insights-reports/`.
- **Verification**:
  - Run `diff -r ~/.gemini/skills/code-insights-reports/ .agents/skills/code-insights-reports/` to verify parity.

### Step 5: End-to-End Automated Verification
- **Files**:
  - `goals/code-insights-reporting-skill/verify.sh`
- **Actions**:
  - Execute a comprehensive verification script that:
    1. Runs each `ci-report.js` subcommand (`summary`, `cost`, `friction`, `prompt-quality`, `benchmarks`, `timeline`, `query`).
    2. Tests `--json` export and `--output` file generation.
    3. Verifies read-only integrity (asserts file modification timestamp of `~/.code-insights/data.db` is unchanged and non-SELECT queries throw errors).
    4. Validates that markdown tables and summaries are generated cleanly without truncation.
- **Verification**:
  - Shell script executes cleanly with exit code 0 and logs all passed checks.

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Database is locked by active sync worker | Low-Medium | `ci-report.js` sets `PRAGMA busy_timeout = 5000;` and opens in read-only mode so it never requests write locks. |
| Missing or varying Node version across environments | Low | `node:sqlite` is standard in Node 22+. Fallback `sqlite3 -readonly` CLI patterns are fully documented in `SKILL.md` and `references/sql-recipes.md`. |
| Unsafe ad-hoc SQL execution | High | Query runner strictly checks that queries start with `SELECT` or `WITH`, prohibits mutative keywords (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `REPLACE`), and enforces SQLite read-only mode at the connection level. |
