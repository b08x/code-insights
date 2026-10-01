# Skills and agents for implementation

Invoke with the Skill tool (`skill: "<name>"`) and the Agent tool (`subagent_type`). Every skill and agent listed exists in this environment as of 2026-09-30. Project hookify rules (`.claude/hookify.*.local.md`) are binding and override any conflicting skill step.

## Binding project rules (from hookify)

| Rule | Effect on this goal |
|---|---|
| default-subagent-execution | Execute each phase subagent-driven in the current session; do not offer a parallel session. |
| branch-discipline | Before `engineer` / `ux-engineer` / `technical-architect` write code, confirm the phase feature branch is checked out. |
| agent-parallel-warning | Parallelize only steps with no output dependency (for example views in phase 4). Steps 6a→6b→6c→6d are strictly sequential. |
| review-before-pr (+ mcp) | Every task gets a spec-compliance review and a code-quality review before `gh pr create`. |
| block-pr-merge / block-local-merge-to-main | Agents never merge. The user merges each phase PR in GitHub. |
| tdd-domain-check | Tests before or alongside code for migrations (`cli/src/db/`), normalizers, and shared utilities (`cli/src/utils/`, `server/src/utils.ts`). |
| use-git-rm-for-tracked-files | Legacy deletions (engine-27, old agent, `analysis.ts.bak`) use `git rm`. |
| no-jira | Track follow-ups with GitHub Issues only. |

## Per-phase loop (applies to every phase)

| Step | Skill / agent | Purpose |
|---|---|---|
| 1 | `start-feature` | Create the phase branch from `development`; triggers the TDD domain check. |
| 2 | `superpowers:writing-plans` | Expand the phase section of `plan.md` into task-level steps with exact files and tests. |
| 3 | `codebase-memory` (skill) + `codebase-memory-scout` agent | Trace callers and callees before editing. Required for 6a–6d and the legacy deletions. |
| 4 | `superpowers:subagent-driven-development` | Execute tasks: one implementer subagent per task, followed by spec and quality reviewers. |
| 5 | `superpowers:test-driven-development` | For every `[auto]` fact and every hookify TDD domain. |
| 6 | `superpowers:systematic-debugging` | Any failing test or unexpected behavior, before proposing a fix. |
| 7 | `superpowers:verification-before-completion` | Run `pnpm run test` and `pnpm run build` and check the phase's facts before claiming the phase is done. |
| 8 | `simplify` | Quality pass on the phase diff. |
| 9 | `start-review` (triple-layer) + `llm-expert` agent as 4th reviewer for any LLM/prompt change | Required review before PR. |
| 10 | `git:commit` | Gitmoji conventional commits, matching repo history (`✨ feat:`, `🐛 fix:`, `♻️ refactor:`). |
| 11 | `git:create-pr` | PR into `development` with the phase's fact IDs in the description. |
| 12 | `docs:update-docs` | Update `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, and `.claude/rules/*` (API, models, changelog) for the phase. |

## Phase 5 — Agent replacement

| Plan steps | Skills | Agents |
|---|---|---|
| 1 read functions, 2 conversation store | `superpowers:test-driven-development` (migration = TDD domain), `developer-essentials:sql-optimization-patterns` (snippet search, RRF query) | `technical-architect` (v17 schema review), `engineer` |
| 3 new agent | `ax-agent` (function-calling agent, no RLM), `ax-signature` (typed `pageContext`, draft payload), `ax-agent-observability` (streaming tool-call events for the UI), `security-review` (the `execMcpCli` shell-out behind the codebase toggle) | `engineer`, `llm-expert` (system prompt, tool descriptions) |
| 4 dashboard chat UI | `frontend-design:frontend-design`, `better-ui`, `better-layout`, `design:accessibility-review` (panel focus and keyboard), `design:ux-copy` (per-page suggested prompts) | `ux-engineer` |
| Manual fact walk-through | `run` (launch the dashboard and drive it), Playwright MCP tools for screenshots | none |

## Phase 1 — Foundations (including pipeline consolidation)

| Plan steps | Skills | Agents |
|---|---|---|
| 6a characterization fixtures | `superpowers:test-driven-development`, `codebase-memory` (map every caller of both pipelines) | `codebase-memory-auditor` (bounded audit of `server/src/llm` and `cli/src/analysis`) |
| 6b one transport | `ax-ai` only if the transport is re-based on Ax `ai()` (otherwise plain TS), `code-refactoring-refactor-clean` | `engineer` |
| 6c–6d one pipeline, rewire callers | `refactor`, `kaizen:root-cause-tracing` (each characterization diff), `developer-essentials:error-handling-patterns` (`jsonrepair` fallback, chunk-merge failure) | `technical-architect` (pipeline contract), `engineer` |
| 6–7 runner model/variant, OpenCodeRunner | `superpowers:test-driven-development` (mocked `execFileSync` argv tests) | `engineer` |
| 8–10 identity, provenance columns, target registry, prompt resolution | `superpowers:test-driven-development` (migration), `ax-gepa` (component shape the registry must expose) | `technical-architect` (v17 part B, registry types) |
| 11 Settings picker | `better-ui`, `design:ux-copy` | `ux-engineer` |
| 12 single-path guard | `superpowers:test-driven-development` | `engineer` |

## Phase 2 — Labeling

| Plan steps | Skills | Agents |
|---|---|---|
| 13–15 labels table, splits, queue ranking | `superpowers:test-driven-development` (migration, deterministic split), `data:statistical-analysis` (stratification and coverage targets), `developer-essentials:sql-optimization-patterns` | `technical-architect` (v18), `engineer` |
| 16–17 batch client, bulk pre-analysis | `developer-essentials:error-handling-patterns` (partial failures, `custom_id` reconciliation, expired batches); Context7 / WebSearch for current Mistral and OpenRouter batch docs (repair context-mode first) | `engineer`, `llm-expert` |
| 18–19 label routes, labeling UI, view 7 | `frontend-design:frontend-design`, `better-ui`, `better-interface`, `design:accessibility-review` (keyboard-first keep/reject), `dataviz` (view 7) | `ux-engineer` |

## Phase 3 — Optimization engine

| Plan steps | Skills | Agents |
|---|---|---|
| 20 v19 tables | `superpowers:test-driven-development` (migration) | `technical-architect` |
| 21–23 program, adapter, metric, judge, orchestrator | `ax-gepa` (`gepaAdapter`, `paretoScalarize`, `feedbackFn`, `applyOptimization`, `maxMetricCalls` sizing), `ax-gen` + `ax-signature` (typed judge), `customaize-agent:agent-evaluation` (judge design and calibration), `superpowers:test-driven-development` (fake student and judge backends) | `llm-expert` (judge prompt, objectives, weights), `engineer` |
| 24–26 job runner, gate/promote/adopt, overnight mode, estimates | `developer-essentials:error-handling-patterns` (per-call retry, cancel, crash recovery), `superpowers:test-driven-development` | `engineer`, `technical-architect` (promotion invariants) |
| 27 legacy removal + manifest import | `code-refactoring-refactor-clean`, `codebase-memory` (0-caller confirmation before `git rm`) | `engineer` |
| 28 views 1 and 4 | `dataviz` (read before any chart code), `frontend-design:frontend-design`, `better-ui` | `ux-engineer` |
| 29 agent optimization tools | `ax-agent` | `engineer` |
| Real-run smoke (done condition) | `run`, `superpowers:verification-before-completion` | none |

## Phase 4 — Insight views

| Plan steps | Skills | Agents |
|---|---|---|
| 30 prompt evolution (lineage + jsdiff) | `frontend-design:frontend-design`, `better-typography` (diff readability), `better-ui` | `ux-engineer` |
| 31 judge audit | `customaize-agent:agent-evaluation` (agreement metric), `superpowers:test-driven-development` (agreement rate) | `ux-engineer`, `llm-expert` |
| 32–33 Pareto scatter, version history | `dataviz`, `better-colors` (objective series palette in light and dark) | `ux-engineer` |
| Views 30–33 are independent | `superpowers:dispatching-parallel-agents` (allowed here: no output dependencies) | up to 4 `ux-engineer` in parallel |

## Not recommended for this goal

- `ax-agent-rlm`, `ax-agent-memory-skills`: the new agent drops the RLM runtime and memory-search path (Q1, agent-1).
- `ax-flow`, `ax-refine`: nothing in the plan needs multi-node flows or best-of-N.
- `sdd:*` / `sadd:*` pipelines: they duplicate the superpowers plus hookify workflow the project already enforces.
- `claude-api`: the project is multi-provider, and the transport consolidation is provider-neutral.

## Pre-flight

- Repair context-mode (`/ctx-upgrade`, or `npm rebuild better-sqlite3` in its plugin cache). While broken, its hook blocks WebFetch and `curl`, which phase 2 batch-API research depends on.
- `codemap --diff` and `git status` at the start of each phase (global CLAUDE.md rule).
