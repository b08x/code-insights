---
name: agent-parallel-dependency-check
enabled: true
event: all
action: warn
tool_matcher: Task
conditions:
  - field: prompt
    operator: regex_match
    pattern: (parallel|concurrently|simultaneously|at the same time)
---

**Parallel Agent Dependency Check**

Before running agents in parallel, verify NO output dependencies exist:

**Common Sequential Patterns (DO NOT parallelize):**
```
PM (requirements)     → Engineer (needs scope)
TA (type alignment)   → Engineer (needs type decision)
PM (requirements)     → TA (needs scope to design)
```

**Safe to Parallelize:**
- Independent research/exploration tasks
- CLI bug fix + Dashboard UI fix (if no shared types involved)
- Read-only codebase analysis

**Pre-Spawn Checklist:**
- [ ] No agent produces types/schema another agent needs?
- [ ] No shared SQLite schema changes?
- [ ] No cross-package type dependencies (cli/ ↔ server/ ↔ dashboard/)?

If ANY dependency exists → Run sequentially instead.

**Example of DANGEROUS parallelization:**
- CLI engineer adds field to ParsedSession type + Dashboard engineer reads ParsedSession
  → Dashboard will read stale type definition → Runtime mismatch

**Example of SAFE parallelization:**
- CLI engineer adds new stats flag + Dashboard engineer fixes CSS on insights page
  → No shared state, safe to run in parallel
