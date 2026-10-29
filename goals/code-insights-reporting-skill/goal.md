# Goal: Code Insights DB Reporting Agent Skill

## Articulated Goal

Create an agent skill (`code-insights-reports`) installed globally at `~/.gemini/skills/code-insights-reports/` and mirrored in the project at `.agents/skills/code-insights-reports/`. The skill empowers AI agents to safely query, analyze, and report on session intelligence from the local `code-insights` SQLite database (`~/.code-insights/data.db`), featuring a zero-dependency CLI runner (`scripts/ci-report.js`) with dedicated subcommands for reflections, token/cost breakdowns, friction and loop analysis, prompt quality scores, cross-tool benchmarks, and chronological ADR / development timeline graph tracing.

## Shared Understanding

- **Facts**: [facts.md](file:///home/b08x/WorkspaceV3/code-insights/goals/code-insights-reporting-skill/facts.md) defines the agreed-upon capabilities, safety standards, and verification criteria.
- **Facts Metadata**: [facts.meta.json](file:///home/b08x/WorkspaceV3/code-insights/goals/code-insights-reporting-skill/facts.meta.json) contains the machine-readable verification statuses and IDs.

## Execution Plan

- **Plan**: [plan.md](file:///home/b08x/WorkspaceV3/code-insights/goals/code-insights-reporting-skill/plan.md) details the sequential implementation steps, file touched, verification commands, and risks.

## Done Condition

The goal is complete when:
1. `~/.gemini/skills/code-insights-reports/` and `.agents/skills/code-insights-reports/` contain valid `SKILL.md`, `references/`, and executable `scripts/ci-report.js`.
2. All reporting modes (`summary`, `reflection`, `cost`, `friction`, `prompt-quality`, `benchmarks`, `timeline`, `query`) execute cleanly in read-only mode against `~/.code-insights/data.db`.
3. ADR timeline and graph-like causal tracing successfully reconstructs architectural decisions with their situation, choice, and trade-offs.
4. The automated verification suite (`goals/code-insights-reporting-skill/verify.sh` or `ci-report.js verify`) runs and passes with zero errors and no database modifications.
