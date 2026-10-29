# Code Insights Safe SQL Recipes Reference

Battle-tested, production-ready SQL queries for analyzing AI coding session intelligence from `~/.code-insights/data.db`.

---

## Read-Only Safety Protocol

To guarantee database integrity and prevent deadlocks or write-locks during active session logging:

1. **CLI Invocations**:
   Always execute using the `-readonly` flag:
   ```bash
   sqlite3 -readonly ~/.code-insights/data.db "SELECT ..."
   ```

2. **In-Query Pragmas**:
   Always prepend queries with query-only enforcement and busy timeouts:
   ```sql
   PRAGMA query_only = ON;
   PRAGMA busy_timeout = 5000;
   ```

3. **Zero Mutation Rule**:
   Never execute `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, or `REPLACE` queries.

---

## 1. High-Level Database Overview

### Global Metrics Summary
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT 
  (SELECT COUNT(*) FROM projects) AS total_projects,
  (SELECT COUNT(*) FROM sessions WHERE deleted_at IS NULL) AS total_sessions,
  (SELECT COUNT(*) FROM messages) AS total_messages,
  (SELECT COUNT(*) FROM insights) AS total_insights,
  (SELECT COUNT(*) FROM session_steps) AS total_steps,
  (SELECT MIN(started_at) FROM sessions WHERE deleted_at IS NULL) AS earliest_session,
  (SELECT MAX(ended_at) FROM sessions WHERE deleted_at IS NULL) AS latest_session,
  (SELECT SUM(total_input_tokens) FROM sessions WHERE deleted_at IS NULL) AS total_input_tokens,
  (SELECT SUM(total_output_tokens) FROM sessions WHERE deleted_at IS NULL) AS total_output_tokens,
  (SELECT SUM(cache_read_tokens) FROM sessions WHERE deleted_at IS NULL) AS total_cache_read_tokens,
  (SELECT ROUND(SUM(estimated_cost_usd), 2) FROM sessions WHERE deleted_at IS NULL) AS total_cost_usd;
```

### Activity in Recent Time Windows
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  SUM(CASE WHEN datetime(started_at) >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS sessions_last_24h,
  SUM(CASE WHEN datetime(started_at) >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS sessions_last_7d,
  SUM(CASE WHEN datetime(started_at) >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS sessions_last_30d
FROM sessions
WHERE deleted_at IS NULL;
```

---

## 2. Session Reflection & Narrative Digests

### Recent Sessions with Summaries & Characterization
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  s.id,
  s.project_name,
  s.source_tool,
  COALESCE(s.custom_title, s.generated_title, s.summary, 'Untitled') AS title,
  s.session_character,
  s.started_at,
  s.message_count,
  ROUND(s.estimated_cost_usd, 2) AS cost_usd,
  sf.outcome_satisfaction
FROM sessions s
LEFT JOIN session_facets sf ON sf.session_id = s.id
WHERE s.deleted_at IS NULL
ORDER BY s.started_at DESC
LIMIT 15;
```

### Key Learnings & Takeaways for a Project
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  i.project_name,
  i.title,
  i.summary,
  json_extract(i.metadata, '$.symptom') AS symptom,
  json_extract(i.metadata, '$.root_cause') AS root_cause,
  json_extract(i.metadata, '$.takeaway') AS takeaway,
  i.timestamp
FROM insights i
WHERE i.type = 'learning'
  AND (:projectName IS NULL OR i.project_name LIKE '%' || :projectName || '%')
ORDER BY i.timestamp DESC
LIMIT 20;
```

---

## 3. Token Economics, Cache Ratios & Cost Analysis

### Economics by Source Tool
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  source_tool,
  COUNT(*) AS session_count,
  SUM(total_input_tokens) AS input_tokens,
  SUM(total_output_tokens) AS output_tokens,
  SUM(cache_read_tokens) AS cache_read_tokens,
  SUM(cache_creation_tokens) AS cache_creation_tokens,
  ROUND(
    100.0 * SUM(cache_read_tokens) / 
    NULLIF(SUM(cache_read_tokens) + SUM(total_input_tokens), 0), 
    1
  ) AS cache_hit_pct,
  ROUND(SUM(estimated_cost_usd), 2) AS total_cost_usd,
  ROUND(AVG(estimated_cost_usd), 3) AS avg_cost_per_session
FROM sessions
WHERE deleted_at IS NULL
GROUP BY source_tool
ORDER BY total_cost_usd DESC;
```

### Top 10 Most Cost-Intensive Projects
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  project_name,
  COUNT(*) AS session_count,
  SUM(total_input_tokens) AS input_tokens,
  SUM(total_output_tokens) AS output_tokens,
  ROUND(SUM(estimated_cost_usd), 2) AS estimated_cost_usd,
  ROUND(AVG(message_count), 1) AS avg_messages
FROM sessions
WHERE deleted_at IS NULL
GROUP BY project_name
ORDER BY estimated_cost_usd DESC
LIMIT 10;
```

---

## 4. Friction, Failures & Loop Analysis

### Course Correction & Outcome Satisfaction Rates
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  COUNT(*) AS total_faceted_sessions,
  SUM(had_course_correction) AS course_corrected_sessions,
  ROUND(100.0 * SUM(had_course_correction) / COUNT(*), 1) AS course_correction_rate_pct,
  ROUND(100.0 * SUM(CASE WHEN outcome_satisfaction = 'high' THEN 1 ELSE 0 END) / COUNT(*), 1) AS high_satisfaction_pct,
  ROUND(100.0 * SUM(CASE WHEN outcome_satisfaction = 'abandoned' THEN 1 ELSE 0 END) / COUNT(*), 1) AS abandoned_rate_pct
FROM session_facets;
```

### Friction Point Categorization & Severity Distribution
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  json_extract(f.value, '$.category') AS category,
  json_extract(f.value, '$.attribution') AS attribution,
  COUNT(*) AS occurrences,
  SUM(CASE WHEN json_extract(f.value, '$.severity') = 'high' THEN 1 ELSE 0 END) AS high_severity,
  SUM(CASE WHEN json_extract(f.value, '$.severity') = 'medium' THEN 1 ELSE 0 END) AS medium_severity,
  SUM(CASE WHEN json_extract(f.value, '$.severity') = 'low' THEN 1 ELSE 0 END) AS low_severity
FROM session_facets sf,
json_each(sf.friction_points) f
WHERE sf.friction_points IS NOT NULL AND sf.friction_points != '[]'
GROUP BY category, attribution
ORDER BY occurrences DESC
LIMIT 15;
```

---

## 5. Prompt Quality & SFL Breakdown

### Average SFL Dimension Scores
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  COUNT(*) AS total_scored_sessions,
  ROUND(AVG(json_extract(metadata, '$.efficiency_score')), 1) AS avg_efficiency_score,
  -- Ideational Metafunction (Domain, Context, Information Timing)
  ROUND(AVG(json_extract(metadata, '$.dimension_scores.context_provision')), 1) AS avg_context_provision,
  ROUND(AVG(json_extract(metadata, '$.dimension_scores.information_timing')), 1) AS avg_information_timing,
  -- Interpersonal Metafunction (Tenor, Guidance, Correction Quality)
  ROUND(AVG(json_extract(metadata, '$.dimension_scores.correction_quality')), 1) AS avg_correction_quality,
  -- Textual Metafunction (Request Specificity, Scope Boundaries)
  ROUND(AVG(json_extract(metadata, '$.dimension_scores.request_specificity')), 1) AS avg_request_specificity,
  ROUND(AVG(json_extract(metadata, '$.dimension_scores.scope_management')), 1) AS avg_scope_management
FROM insights
WHERE type = 'prompt_quality'
  AND json_extract(metadata, '$.dimension_scores') IS NOT NULL;
```

### Top Prompt Deficit Categories & Recommended Improvements
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  json_extract(finding.value, '$.category') AS deficit_category,
  COUNT(*) AS frequency,
  SUM(CASE WHEN json_extract(finding.value, '$.impact') = 'high' THEN 1 ELSE 0 END) AS high_impact_count,
  MIN(json_extract(finding.value, '$.suggested_improvement')) AS sample_improvement
FROM insights i,
json_each(json_extract(i.metadata, '$.findings')) finding
WHERE i.type = 'prompt_quality'
  AND json_extract(finding.value, '$.type') = 'deficit'
GROUP BY deficit_category
ORDER BY frequency DESC
LIMIT 10;
```

---

## 6. Cross-Tool Benchmarking

### Head-to-Head Comparison Across Coding CLIs & Agents
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  s.source_tool,
  COUNT(DISTINCT s.id) AS sessions,
  COUNT(m.id) AS total_messages,
  ROUND(AVG(s.message_count), 1) AS avg_messages_per_session,
  ROUND(AVG(s.tool_call_count), 1) AS avg_tool_calls_per_session,
  ROUND(AVG(s.total_input_tokens), 0) AS avg_input_tokens,
  ROUND(AVG(s.estimated_cost_usd), 2) AS avg_cost_usd,
  ROUND(100.0 * SUM(CASE WHEN sf.outcome_satisfaction = 'high' THEN 1 ELSE 0 END) / NULLIF(COUNT(sf.session_id), 0), 1) AS high_satisfaction_pct,
  ROUND(100.0 * SUM(CASE WHEN sf.had_course_correction = 1 THEN 1 ELSE 0 END) / NULLIF(COUNT(sf.session_id), 0), 1) AS course_correction_pct
FROM sessions s
LEFT JOIN messages m ON m.session_id = s.id
LEFT JOIN session_facets sf ON sf.session_id = s.id
WHERE s.deleted_at IS NULL
GROUP BY s.source_tool
HAVING sessions >= 5
ORDER BY sessions DESC;
```

---

## 7. Chronological ADR Graph & Timeline Tracing

### Chronological Architectural Decision Records (ADRs)
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  i.id AS insight_id,
  i.session_id,
  i.project_name,
  i.title,
  i.timestamp,
  json_extract(i.metadata, '$.decided_by') AS decided_by,
  json_extract(i.metadata, '$.situation') AS situation,
  json_extract(i.metadata, '$.choice') AS choice,
  json_extract(i.metadata, '$.trade_offs') AS trade_offs,
  json_extract(i.metadata, '$.reasoning') AS reasoning
FROM insights i
WHERE i.type = 'decision'
  AND (:projectName IS NULL OR i.project_name LIKE '%' || :projectName || '%')
ORDER BY i.timestamp ASC
LIMIT 25;
```

### Reconstructing Session Step Trajectory & Milestones
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  ss.session_id,
  ss.idx,
  ss.turn_ref,
  ss.driver,
  ss.target,
  ss.state,
  ss.label,
  ss.has_course_correction,
  ss.ran_tests,
  ss.used_tools
FROM session_steps ss
WHERE ss.session_id = :targetSessionId
ORDER BY ss.idx ASC;
```

---

## 8. Full-Text Search on Messages (FTS5)

### Querying Messages with BM25 Ranking
```sql
PRAGMA query_only = ON;
PRAGMA busy_timeout = 5000;

SELECT
  m.session_id,
  m.type,
  m.timestamp,
  snippet(messages_fts, 0, '<b>', '</b>', '...', 12) AS content_snippet
FROM messages_fts f
JOIN messages m ON m.rowid = f.rowid
WHERE messages_fts MATCH :searchQuery
ORDER BY bm25(messages_fts)
LIMIT 15;
```
