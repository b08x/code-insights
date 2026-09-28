# Plan: FCA & Decision Attribution Remediation (#8-#14)

## Solution Approach
Remediate the full set of Formal Concept Analysis (FCA) and decision attribution issues by:
1. Hardening validation and traceability: Bumping `ANALYSIS_VERSION` to `3.1.0` (#8) and enforcing `minItems: 4, maxItems: 10` on `step_matrix` in JSON Schema (#9).
2. Enriching step semantics: Adding co-occurring step attributes (multi-target support, tool usage, course corrections) to overcome the degenerate lattice limitation (#14).
3. Normalizing persistence: Migrating the SQLite schema to v15 with a dedicated `session_steps` table and updating `analysis-db.ts` to persist structured steps (#10).
4. Hardening export routes: Fixing `ORDER BY created_at DESC` on summary queries, keying FCA objects uniquely with turn references and indices, and extracting a single-source `attributeVector()` helper keyed off `FCA_ATTRIBUTES` (#11, #12).
5. Enabling pooled analytics: Adding a filtered `GET /api/export/fca` endpoint returning pooled formal context `(G, M, I)` + contingency counts and CSV export (#13).
6. Refreshing data: Providing seamless re-analysis for 3.0.0 sessions to 3.1.0 (#8 acceptance).

---

## Ordered Implementation Steps

### Step 1: Version Bumping and Schema Cardinality Enforcement
- **Files**:
  - `cli/src/analysis/analysis-db.ts`
  - `cli/src/analysis/schemas/session-analysis.json`
  - `cli/src/analysis/schemas/__tests__/schema-sync.test.ts`
  - `cli/src/analysis/__tests__/analysis-db.test.ts`
- **Actions**:
  - Bump `ANALYSIS_VERSION` from `'3.0.0'` to `'3.1.0'`.
  - Add `"minItems": 4, "maxItems": 10` to `step_matrix` in `session-analysis.json`.
  - Add assertions in `schema-sync.test.ts` ensuring `minItems: 4` and `maxItems: 10` are present and enforced.
  - Update analysis DB tests to verify `3.1.0` is written on insight records.
- **Verification**:
  - `pnpm --filter cli test src/analysis/schemas/__tests__/schema-sync.test.ts src/analysis/__tests__/analysis-db.test.ts`

### Step 2: Enriched Step Matrix Attributes & Non-Degenerate Lattice
- **Files**:
  - `cli/src/types.ts`
  - `cli/src/analysis/prompt-types.ts`
  - `cli/src/analysis/schemas/session-analysis.json`
  - `cli/src/analysis/prompts.ts`
  - `cli/src/analysis/response-parsers.ts`
  - `cli/src/analysis/__tests__/prompts.test.ts`
  - `server/src/routes/export.ts`
- **Actions**:
  - Extend `SemanticStep` in `cli/src/types.ts` and `cli/src/analysis/prompt-types.ts` with optional co-occurring attributes:
    - `targets?: FcaTarget[]`
    - `has_course_correction?: boolean`
    - `ran_tests?: boolean`
    - `used_tools?: boolean`
  - Update `session-analysis.json` items properties to accept these fields.
  - Update `buildSessionAnalysisInstructions` in `cli/src/analysis/prompts.ts` with guidance on tagging multi-target milestones and co-occurring action flags.
  - Update `response-parsers.ts` to parse and canonicalize these attributes.
  - Extend `FCA_ATTRIBUTES` in `server/src/routes/export.ts` with `HasCourseCorrection`, `RanTests`, `UsedTools`.
  - Add prompt and parsing test cases for enriched step matrix in `prompts.test.ts`.
- **Verification**:
  - `pnpm --filter cli test src/analysis/__tests__/prompts.test.ts`

### Step 3: SQLite Migration v15: `session_steps` Table
- **Files**:
  - `cli/src/db/schema.ts`
  - `cli/src/db/migrate.ts`
  - `cli/src/db/__tests__/migrate-v15.test.ts`
  - `cli/src/analysis/analysis-db.ts`
  - `cli/src/analysis/__tests__/analysis-db.test.ts`
- **Actions**:
  - Bump `CURRENT_SCHEMA_VERSION` to 15 in `cli/src/db/schema.ts`.
  - Add `CREATE TABLE IF NOT EXISTS session_steps (...)` and indices to `SCHEMA_SQL`.
  - In `cli/src/db/migrate.ts`, implement `applyV15(db)` to create `session_steps` table:
    - `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`
    - `idx INTEGER NOT NULL`
    - `turn_ref TEXT NOT NULL`
    - `label TEXT NOT NULL`
    - `driver TEXT NOT NULL`
    - `target TEXT NOT NULL`
    - `state TEXT NOT NULL`
    - `targets TEXT`
    - `has_course_correction INTEGER NOT NULL DEFAULT 0`
    - `ran_tests INTEGER NOT NULL DEFAULT 0`
    - `used_tools INTEGER NOT NULL DEFAULT 0`
    - `created_at TEXT NOT NULL DEFAULT (datetime('now'))`
    - `PRIMARY KEY (session_id, idx)`
  - In `cli/src/analysis/analysis-db.ts`, implement `saveSessionStepsToDb(sessionId: string, steps: SemanticStep[]): void` and invoke it when persisting analysis results.
  - Add unit test `migrate-v15.test.ts` verifying migration from v14 to v15 and table structure.
- **Verification**:
  - `pnpm --filter cli test src/db/__tests__/migrate-v15.test.ts src/analysis/__tests__/analysis-db.test.ts`

### Step 4: Export Route Hardening: Summary Ordering, Object Keying & Centralized `attributeVector()`
- **Files**:
  - `server/src/routes/export.ts`
  - `server/src/routes/__tests__/export.test.ts`
- **Actions**:
  - In `server/src/routes/export.ts`, fix summary insight lookup to include `ORDER BY created_at DESC LIMIT 1`.
  - Prefer reading step records from `session_steps` table when present, falling back to summary metadata.
  - Implement a centralized `attributeVector(step: StepMatrixEntry): boolean[]` helper keyed off `FCA_ATTRIBUTES`.
  - Replace the 3 duplicated one-hot branches (CSV rows, incidence matrix, and context mapping) with `attributeVector()`.
  - Key single-session FCA objects as `${s.turn_ref || 'turn-?'} [step ${idx + 1}]` so identical step labels do not collapse.
  - Add unit tests verifying:
    - Summary query picks latest `created_at`.
    - Identical step labels generate unique object keys.
    - CSV row columns and headers strictly match `FCA_ATTRIBUTES`.
- **Verification**:
  - `pnpm --filter server test`

### Step 5: Pooled Cross-Session FCA Context Endpoint
- **Files**:
  - `server/src/routes/export.ts`
  - `server/src/routes/__tests__/export.test.ts`
- **Actions**:
  - Implement `GET /api/export/fca` in `server/src/routes/export.ts`:
    - Accept query parameters: `project`, `since`, `until`, `driver`, `state`, `format`.
    - Query `session_steps` joined with `sessions` (filtering out deleted sessions).
    - Format pooled object identifiers as `${session_id}:${turn_ref}#${idx + 1}`.
    - Build `(G, M, I)` matrix using `attributeVector()`.
    - Compute contingency counts: group occurrences by `(driver, target, state)` and calculate driver-specific `State_Blocked` rates.
    - Return JSON or CSV (when `format=csv` or `Accept: text/csv`).
  - Add integration tests covering filter permutations, CSV export, and contingency aggregations.
- **Verification**:
  - `pnpm --filter server test`

### Step 6: Targeted Re-Analysis & Full Verification
- **Files**:
  - `cli/src/commands/insights.ts` (or migration utility/doc)
  - Documentation / postmortem
- **Actions**:
  - Provide documented SQL query and/or CLI option for identifying sessions where `analysis_version = '3.0.0'`.
  - Ensure re-analyzing these sessions generates `3.1.0` insights and populates `session_steps`.
  - Run full test suite and build across all packages (`cli`, `server`, `dashboard`).
- **Verification**:
  - `pnpm build && pnpm test`

---

## Risks and Mitigation
- **Risk: Breaking existing dashboard FCA matrix component**: The dashboard renders single-session FCA matrices based on `/api/export/session/:id/fca`.
  - *Mitigation*: Maintain backward compatibility in the single-session JSON response structure (`session_id`, `objects`, `attributes`, `incidence`, `context`), while adding the enriched attributes and unique object labels.
- **Risk: Backward compatibility for sessions analyzed under 3.0.0 before re-analysis**:
  - *Mitigation*: The export endpoints will check `session_steps` first; if no rows exist for that session, gracefully fall back to parsing `insights.metadata` JSON.
