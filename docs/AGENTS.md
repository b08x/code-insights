# Multi-Agent Orchestration — Code Insights

> Agent coordination, development ceremony, and code review processes. Linked from [CLAUDE.md](../CLAUDE.md).

---

## Agent Suite

| Agent | Model | Domain |
|-------|-------|--------|
| `engineer` | sonnet | Implementation across CLI, dashboard, and server — features, fixes, tests |
| `technical-architect` | opus | Architecture, type alignment, SQLite schema, code review, LLD standards |
| `ux-engineer` | opus | UX design (wireframes, flows, specs) and UI implementation (React/Tailwind/shadcn) |
| `product-manager` | sonnet | Task tracking (GitHub Issues), sprint planning, ceremony coordination |
| `journey-chronicler` | opus | Capture learning moments, breakthroughs, course corrections |
| `devtools-cofounder` | opus | DevTools strategy, DX critique, competitive positioning (on-demand) |
| `llm-expert` | opus | LLM integration review, prompt design, token optimization, model selection, cost analysis |

Agent definitions live in `.claude/agents/`.

---

## Orchestrator Role (Main Claude)

**You CAN:**
- Edit `CLAUDE.md` directly (you own it)
- Delegate implementation to the appropriate agent
- Run agents in parallel IF no dependencies exist
- Make final decisions when agents disagree

**You MUST NOT:**
- Implement code directly when an agent should do it
- Skip the ceremony steps
- Merge PRs (only the founder does this)

### Unresponsive Agent Protocol

1. **Retry once** — attempt one more communication
2. **Terminate if still unresponsive** — do not wait indefinitely
3. **Re-spawn or take over** — either spawn a fresh agent or handle the task directly
4. **Log the failure** — note which agent failed and at what step

**Do NOT** spawn duplicate agents alongside a stale one. Terminate first, then replace.

### Pre-Spawn Dependency Check (MANDATORY)

Before parallelizing agents, verify:

1. List each agent's **inputs** — What does it need?
2. List each agent's **outputs** — What does it produce?
3. Map **dependencies** — Does B need A's output?
4. Decide: **Sequential or Parallel**

**Safe to Parallelize:** Independent domains, read-only research, CLI bug fix + Dashboard UI fix (if no shared state)

**Must Run Sequentially:** TA (type decision) -> Engineer (implement types), TA (schema decision) -> Engineer (implement), any change touching `types.ts`

---

## Development Ceremony (MANDATORY)

All feature work follows this 10-step ceremony:

```
Step 1:  Founder assigns task or identifies work
Step 2:  Orchestrator identifies the right agent(s)
Step 3:  Dev agent reviews context (source files, types, existing patterns)
Step 4:  Dev agent clarifies with TA (if schema impact)
Step 5:  TA reviews approach and gives approval
Step 6:  Consensus checkpoint (TA + dev agent agree on approach)
Step 7:  Dev agent: git prechecks + create feature branch
Step 8:  Dev agent: implement, commit in logical chunks, CI gate
Step 9:  Triple-layer code review (TA insider + outsider + synthesis)
Step 10: Founder merges PR
```

### Step-by-Step Ownership

| Step | Owner | Gate Criteria |
|------|-------|---------------|
| 1-2 | Orchestrator | Correct agent identified |
| 3 | Dev agent | Files reviewed, understanding confirmed |
| 4 | Dev agent -> TA | Questions resolved, no assumptions |
| 5 | TA | Explicit approval or changes requested |
| 6 | TA + Dev agent | Both confirm ready to implement |
| 7 | Dev agent | Clean repo, feature branch created |
| 8 | Dev agent | Code implemented, CI passes locally |
| 9 | TA + Outsider + LLM Expert (if applicable) | All review comments addressed |
| 10 | **Founder only** | PR merged to main |

### When to Engage TA (Steps 4-5)

**Required:** Adding/modifying SQLite columns or tables, changing type definitions in `types.ts`, modifying data contract, changing config format, adding new server API endpoints

**Not required:** New command flags, parser improvements, terminal UI changes, dashboard component styling, LLM provider additions

### When to Engage LLM Expert

**Required:** Adding/modifying prompt templates (`server/src/llm/`), new LLM-powered features, changing model assignments or token budgets, SSE streaming or structured output schema changes, debugging inconsistent LLM output, cost optimization

**Not required:** CLI commands without LLM, dashboard UI (unless LLM rendering logic), source tool providers, SQLite schema (unless for LLM results storage)

**Proactive dispatch:** Auto-invoke `llm-expert` when conversation touches prompt design, token optimization, model selection, or when engineer writes new code in `server/src/llm/`.

### CI Simulation Gate (Step 8 — BLOCKING)

```bash
pnpm build    # Must pass across the workspace
```

**If ANY check fails:** Fix before creating PR. Never rely on CI.

---

## Dynamic Team Workflow

For non-trivial features, use `/start-feature` to spin up a coordinated agent team.

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/start-feature <description>` | Creates worktree, team, and spawns PM to lead ceremony | 3+ files or architectural decisions |
| `/start-review <PR#>` | Triple-layer code review (TA insider + outsider + synthesis) | After dev creates a PR |

### Team Structure

```
/start-feature "add demo mode onboarding"
    |
    +-- Orchestrator: Creates worktree + team, spawns PM
    +-- PM (team lead): Scopes feature, creates task graph, spawns agents
    |     +-- TA: Reviews architecture alignment (skipped for internal changes)
    |     +-- LLM Expert: Reviews prompt architecture (skipped if no LLM impact)
    |     +-- Dev (engineer): Implements in worktree, creates PR
    +-- /start-review (triggered by PM after PR created)
          +-- TA (insider) + Outsider + LLM Expert (conditional) + Wild card (if needed)
          +-- TA synthesis -> Consolidated fix list -> Dev implements fixes
```

### When to Use Teams vs Direct Delegation

| Scenario | Approach |
|----------|----------|
| Multi-file feature, architectural decisions | `/start-feature` (full ceremony) |
| Internal change, clear scope, <3 files | Direct `engineer` dispatch |
| Bug fix with clear root cause | Direct `engineer` dispatch |
| Code review for any PR | `/start-review` |

### Worktree Naming

```bash
../code-insights-<feature-slug>/    # e.g., ../code-insights-add-demo-mode-onboarding/
```

---

## Triple-Layer Code Review (MANDATORY)

### Phase 1: Parallel Independent Reviews (No Cross-Contamination)

| Role | Reviewer | Focus |
|------|----------|-------|
| **INSIDER** | `technical-architect` | Type alignment, schema contract, architecture patterns |
| **OUTSIDER** | `code-review:code-review` skill | Security, best practices, logic bugs, fresh perspective |
| **LLM EXPERT** | `llm-expert` *(conditional)* | Prompt quality, token efficiency, model selection, output consistency |

**LLM Expert invoked when PR touches:** `server/src/llm/`, LLM API calls, structured output schemas, SSE streaming, token budgets, or model selection logic.

**CRITICAL:** Phase 1 reviews run in parallel. No reviewer reads another's comments during initial review.

### Phase 2: TA Synthesis

TA reads outsider comments, does 2nd pass, creates consolidated list:

```markdown
## TA Synthesis: [PR Title]
**Must Fix:** 1. [issue and fix]
**Won't Fix (With Rationale):** 1. [comment] - Reason: [justification]
**Final Verdict:** Ready / Changes Required / Escalate to Founder
```

### Phase 3: Dev Implements Fixes

Dev receives consolidated list, implements fixes, re-runs CI gate, updates PR.

### CRITICAL: Agents NEVER Merge PRs

```
FORBIDDEN: gh pr merge (or any merge command)
CORRECT: Report "PR #XX is ready for merge" and STOP
```

Enforced by hookify rule `block-pr-merge`. **Only the founder merges PRs.**

---

## Document Ownership & Delegation

Orchestrator MUST NOT directly edit documents it doesn't own. Always delegate.

| Document Type | Owner Agent | Action |
|---------------|------------|--------|
| `CLAUDE.md` | **Orchestrator** | Direct edit allowed |
| CLI code (`cli/src/`) | `engineer` | Delegate |
| Dashboard code (`dashboard/src/`) | `engineer` | Delegate |
| Server code (`server/src/`) | `engineer` | Delegate |
| Type alignment decisions | `technical-architect` | Delegate |
| Product docs (`docs/`) | `technical-architect` | Delegate |
| Task tracking, sprints | `product-manager` | Delegate |
| PR creation | Dev agent (whoever implemented) | Agent creates PR |

**Why delegation matters:** Each agent has git hygiene rules — they commit AND push immediately. Orchestrator editing code directly bypasses these safeguards.
