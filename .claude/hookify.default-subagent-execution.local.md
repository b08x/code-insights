---
name: default-subagent-execution
enabled: true
event: prompt
conditions:
  - field: user_prompt
    operator: regex_match
    pattern: (which approach|execution option|subagent.driven.*parallel|parallel.*subagent)
action: warn
---

**Auto-answer: Subagent-Driven execution.**

The user has explicitly configured this preference: always choose **Subagent-Driven (this session)** over Parallel Session execution. Do NOT ask the user which execution approach they prefer — default to subagent-driven in the current session unless the user explicitly requests a parallel session.
