# Facts

- ANALYSIS_VERSION in cli/src/analysis/analysis-db.ts is bumped from '3.0.0' to '3.1.0' so new decision attribution and step matrix insights are identifiable.
- cli/src/analysis/schemas/session-analysis.json explicitly enforces minItems: 4 and maxItems: 10 on the step_matrix array schema.
- step_matrix schema and prompt instructions are enriched to include co-occurring step attributes (e.g. multi-valued targets, tool usage flags, and course corrections), updating FCA_ATTRIBUTES to produce non-degenerate concept lattices.
- Database schema is migrated to v15 with a dedicated session_steps table (keyed by session_id and idx), and the analysis persistence pipeline inserts step records into this table.
- Summary insight query in server/src/routes/export.ts includes ORDER BY created_at DESC so re-analyzed sessions reliably pick the newest summary insight.
- FCA objects are keyed as `${turn_ref} [step ${idx}]` in single-session export and `${session_id}:${turn_ref}#${idx}` in pooled export to guarantee object uniqueness across duplicate step labels.
- A centralized attributeVector(step) helper keyed off FCA_ATTRIBUTES replaces the duplicated one-hot encoding across CSV, incidence array, and context object in server/src/routes/export.ts.
- A pooled cross-session FCA endpoint GET /api/export/fca queries session_steps with optional project, date range, driver, and outcome filters, returning JSON (G, M, I) + contingency counts and supporting CSV export.
- Targeted re-analysis refreshes existing 3.0.0 sessions to 3.1.0, populating session_steps with enriched FCA step matrices.
