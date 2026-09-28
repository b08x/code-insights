# Export Module

> Transformation contract, schemas, and endpoint specifications for session-level and cross-session export pipelines. Linked from [Architecture](../ARCHITECTURE.md).

## Transformation Contract

**Input**: SQLite `sessions`, `insights` (types: `decision`, `summary`), and cross-session aggregated facets
**Process**: 
- Relational attribute extraction from SQLite `insights.metadata`
- Formal Concept Analysis (FCA) incidence matrix derivation
- Multi-format serialization (Rails ActiveRecord JSON, FCA CSV/JSON, Markdown, LLM synthesis)
**Output**: Normalized data structures for downstream consumer systems (Rails/Postgres, Concept Lattice analyzers, Obsidian/Notion)

---

## Overview

The Export module bridges Code Insights' local SQLite persistence with external tooling, relational database migrations (Rails/Postgres/pgvector), and mathematical analysis pipelines (Formal Concept Analysis concept lattice derivation).

Key responsibilities:
1. **ActiveRecord Rails Export**: Unpacks JSON metadata into explicit, typed columns for `decisions` and `step_matrix`.
2. **Formal Concept Analysis (FCA) Context**: Transforms 4–10 semantic steps into formal binary contexts $(G, M, I)$ over 10 canonical attributes.
3. **Cross-Session Markdown / LLM Synthesis**: Generates Markdown summaries and agent rule configurations across date ranges.

---

## Canonical FCA Taxonomy (13 Attributes)

Formal Concept Analysis extracts a formal context $(G, M, I)$ where:
- $G$ is the set of **Objects** (the 4–10 semantic episode steps in the session).
- $M$ is the set of **Attributes** (13 canonical binary dimensions across 4 facets).
- $I \subseteq G \times M$ is the **Incidence Relation** ($gIm$ indicates step $g$ possesses attribute $m$).

| Facet | Attribute Key | Description | Criteria |
|---|---|---|---|
| **Decision Drivers** (3) | `LLM_Decide` | Autonomous Agent Decision | AI proposed and executed the design choice autonomously (`Assistant#N` citations). |
| | `User_Decide` | User-Directed Decision | Human explicitly instructed or commanded the decision (`User#N` citations). |
| | `Collab_Decide` | Collaborative Decision | Co-designed exploration with mutual convergence between human and agent. |
| **Target Scope** (4) | `Target_Config` | Configuration & Environment | Infrastructure, project settings, dependencies, environment variables, build scripts. |
| | `Target_SrcCode` | Source Code | Application logic, algorithms, UI components, backend routes, bug fixes. |
| | `Target_Test` | Verification & Tests | Unit tests, integration tests, mock fixtures, test runner configuration. |
| | `Target_Docs` | Documentation & Specs | Markdown documentation, READMEs, architectural specs, design records. |
| **Outcome State** (3) | `State_Success` | Completed Successfully | Episode executed to completion without fatal errors or blocking failures. |
| | `State_Error` | Error Encountered | Step failed, threw an unhandled exception, syntax error, or test failure. |
| | `State_Blocked` | Blocked / Suspended | Step could not proceed due to missing dependencies, user input required, or tool stasis. |
| **Action & Dynamics** (3) | `HasCourseCorrection` | Course Correction | Step adjusted plan, repaired a previous failure, or recovered from error/stasis. |
| | `RanTests` | Test Execution | Step executed automated test suites, type-checkers, or linters. |
| | `UsedTools` | Tool Usage | Step invoked agent or CLI tools (e.g. bash commands, file edits, git). |

---

## REST Endpoints

Mounted under `/api/export` in `server/src/routes/export.ts`.

### 1. `GET /api/export/session/:id/rails`

Exports the session, its decision insights, and its semantic step matrix in a relational structure designed for ActiveRecord / PostgreSQL ingestion.

- **Method**: `GET`
- **Path Parameter**: `:id` — Session ID
- **Response Status**: `200 OK` (or `404 Not Found` if session missing/deleted)
- **Response Format (`rails-v1`)**:
```json
{
  "exported_at": "2026-09-26T20:00:00.000Z",
  "format": "rails-v1",
  "session": {
    "id": "sess-1234",
    "project_id": "proj-5678",
    "project_name": "code-insights",
    "generated_title": "Implement FCA matrix export",
    "custom_title": null,
    "started_at": "2026-09-26T18:30:00.000Z",
    "ended_at": "2026-09-26T19:15:00.000Z",
    "message_count": 28,
    "estimated_cost_usd": 0.0421,
    "session_character": "feature_build",
    "source_tool": "claude-code"
  },
  "decisions": [
    {
      "id": "ins-9012",
      "session_id": "sess-1234",
      "project_id": "proj-5678",
      "title": "Use formal context (G, M, I) representation",
      "decided_by": "collaborative",
      "intent": "Support downstream mathematical concept lattice tools",
      "branch_point": "Ad-hoc JSON vs Formal Concept Analysis standard matrix",
      "situation": "Need a compact representation for Rails and lattice visualizers",
      "choice": "Adopt 10 canonical binary attributes across Drivers, Targets, and States",
      "reasoning": "Fits standard NextClosure and Ganter algorithm inputs while remaining human-readable",
      "alternatives": [
        { "option": "Arbitrary tag strings", "rejected_because": "Prevents formal concept analysis" }
      ],
      "trade_offs": "Requires fixed taxonomy normalization in response parser",
      "revisit_when": "When new tool modalities are introduced",
      "confidence": 0.95,
      "created_at": "2026-09-26T18:45:00.000Z"
    }
  ],
  "step_matrix": [
    {
      "step": "Configure build pipeline",
      "turn_ref": "User#1",
      "driver": "User_Decide",
      "target": "Target_Config",
      "state": "State_Success"
    },
    {
      "step": "Implement FCA router endpoints",
      "turn_ref": "Assistant#3",
      "driver": "LLM_Decide",
      "target": "Target_SrcCode",
      "state": "State_Success"
    }
  ]
}
```

---

### 2. `GET /api/export/session/:id/fca`

Exports the Formal Concept Analysis incidence matrix for the session.

- **Method**: `GET`
- **Path Parameter**: `:id` — Session ID
- **Query Parameter**: `format` (optional: `'json'` | `'csv'`, default: `'json'`)
- **Headers**: Supports HTTP Content Negotiation via `Accept: text/csv`
- **Response Status**: `200 OK` (or `404 Not Found`)

> **Object Key Uniqueness:** Objects are formatted as `${turn_ref} [step ${idx + 1}]` (e.g. `"User#1 [step 1]"`, `"Assistant#3 [step 2]"`). This ensures steps with identical descriptions (e.g. repeated `"Run tests"`) remain uniquely identifiable objects in formal concept derivations.

#### A. JSON Response (`format=json` or default)
- **Content-Type**: `application/json`
```json
{
  "session_id": "sess-1234",
  "objects": [
    "User#1 [step 1]",
    "Assistant#3 [step 2]"
  ],
  "attributes": [
    "LLM_Decide",
    "User_Decide",
    "Collab_Decide",
    "Target_Config",
    "Target_SrcCode",
    "Target_Test",
    "Target_Docs",
    "State_Success",
    "State_Error",
    "State_Blocked",
    "HasCourseCorrection",
    "RanTests",
    "UsedTools"
  ],
  "incidence": [
    [false, true, false, true, false, false, false, true, false, false, false, false, false],
    [true, false, false, false, true, false, false, true, false, false, false, true, true]
  ],
  "context": [
    {
      "step": "Configure build pipeline",
      "turn_ref": "User#1",
      "attributes": {
        "LLM_Decide": false,
        "User_Decide": true,
        "Collab_Decide": false,
        "Target_Config": true,
        "Target_SrcCode": false,
        "Target_Test": false,
        "Target_Docs": false,
        "State_Success": true,
        "State_Error": false,
        "State_Blocked": false,
        "HasCourseCorrection": false,
        "RanTests": false,
        "UsedTools": false
      }
    }
  ]
}
```

#### B. CSV Response (`format=csv` or `Accept: text/csv`)
- **Content-Type**: `text/csv; charset=utf-8`
- **Content-Disposition**: `attachment; filename="session-sess-1234-fca.csv"`
```csv
Step,Turn,LLM_Decide,User_Decide,Collab_Decide,Target_Config,Target_SrcCode,Target_Test,Target_Docs,State_Success,State_Error,State_Blocked,HasCourseCorrection,RanTests,UsedTools
"Configure build pipeline","User#1",0,1,0,1,0,0,0,1,0,0,0,0,0
"Implement FCA router endpoints","Assistant#3",1,0,0,0,1,0,0,1,0,0,0,1,1
```

---

### 3. `GET /api/export/fca`

Exports a **cross-session pooled Formal Concept Analysis formal context $(G, M, I)$** across sessions matching filter criteria.

- **Method**: `GET`
- **Query Parameters**:
  - `project` (optional): Filter steps by project name or project ID.
  - `since` (optional): Filter sessions started on or after ISO datetime / date.
  - `until` (optional): Filter sessions started on or before ISO datetime / date.
  - `driver` (optional): Filter steps by canonical decision driver (`LLM_Decide`, `User_Decide`, `Collab_Decide`).
  - `state` (optional): Filter steps by outcome state (`State_Success`, `State_Error`, `State_Blocked`).
  - `format` (optional: `'json'` | `'csv'`, default: `'json'`)
- **Headers**: Supports HTTP Content Negotiation via `Accept: text/csv`
- **Response Status**: `200 OK`

> **Pooled Object Identifiers:** Pooled objects are keyed as `${session_id}:${turn_ref}#${idx + 1}` (e.g. `"sess-1:User#1#1"`), preserving session and turn provenance.

#### A. JSON Response
```json
{
  "objects": [
    "sess-1:User#1#1",
    "sess-1:Assistant#3#2"
  ],
  "attributes": [
    "LLM_Decide",
    "User_Decide",
    "Collab_Decide",
    "Target_Config",
    "Target_SrcCode",
    "Target_Test",
    "Target_Docs",
    "State_Success",
    "State_Error",
    "State_Blocked",
    "HasCourseCorrection",
    "RanTests",
    "UsedTools"
  ],
  "incidence": [
    [false, true, false, true, false, false, false, true, false, false, false, false, false],
    [true, false, false, false, true, false, false, true, false, false, false, true, true]
  ],
  "contingency_counts": {
    "total_steps": 2,
    "by_driver": { "User_Decide": 1, "LLM_Decide": 1 },
    "by_target": { "Target_Config": 1, "Target_SrcCode": 1 },
    "by_state": { "State_Success": 2 },
    "combinations": [
      { "driver": "User_Decide", "target": "Target_Config", "state": "State_Success", "count": 1 },
      { "driver": "LLM_Decide", "target": "Target_SrcCode", "state": "State_Success", "count": 1 }
    ],
    "driver_blocked_rates": {
      "User_Decide": { "total": 1, "blocked": 0, "rate": 0 },
      "LLM_Decide": { "total": 1, "blocked": 0, "rate": 0 }
    }
  }
}
```

#### B. CSV Response (`format=csv` or `Accept: text/csv`)
- **Content-Type**: `text/csv; charset=utf-8`
- **Content-Disposition**: `attachment; filename="fca-context.csv"`
```csv
Session,Step,Turn,LLM_Decide,User_Decide,Collab_Decide,Target_Config,Target_SrcCode,Target_Test,Target_Docs,State_Success,State_Error,State_Blocked,HasCourseCorrection,RanTests,UsedTools
"sess-1","Configure build pipeline","User#1",0,1,0,1,0,0,0,1,0,0,0,0,0
"sess-1","Implement FCA router endpoints","Assistant#3",1,0,0,0,1,0,0,1,0,0,0,1,1
```

---

## Client Integration

Frontend SDK wrappers in `dashboard/src/lib/api.ts`:

```typescript
// Fetch Rails-ready export
const railsData = await fetchSessionRailsExport(sessionId);

// Fetch FCA JSON data
const fcaJson = await fetchSessionFcaExport(sessionId, 'json');

// Download FCA CSV export as a Blob
const csvBlob = await fetchSessionFcaExport(sessionId, 'csv');
```

In the UI, downloads are triggered from:
1. `SessionDetailPanel.tsx` — Download menu options for Rails JSON and FCA CSV.
2. `FcaMatrixCard.tsx` — Quick download buttons embedded above the matrix table.

---

## Targeted Re-Analysis Procedure (v3.0.0 to v3.1.0)

Sessions analyzed under prompt version `3.0.0` lack the enriched multi-target and action attributes (`targets`, `has_course_correction`, `ran_tests`, `used_tools`) and their `session_steps` rows may not be populated.

### Identifying 3.0.0 Sessions
Run the following SQL query against `~/.code-insights/data.db`:
```sql
SELECT DISTINCT s.id, s.project_name, s.started_at, i.analysis_version
FROM sessions s
JOIN insights i ON i.session_id = s.id
WHERE i.analysis_version = '3.0.0'
  AND s.deleted_at IS NULL
ORDER BY s.started_at DESC;
```

### Re-Analyzing Sessions
To upgrade a session to `3.1.0` and populate the `session_steps` table:

```bash
# Single session re-analysis
code-insights insights <session_id> --force

# Batch re-analysis of all 3.0.0 sessions using CLI & sqlite3
sqlite3 ~/.code-insights/data.db \
  "SELECT DISTINCT s.id FROM sessions s JOIN insights i ON i.session_id = s.id WHERE i.analysis_version = '3.0.0' AND s.deleted_at IS NULL;" \
  | xargs -I {} code-insights insights {} --force
```

Upon re-analysis:
1. The LLM runs with schema `minItems: 4, maxItems: 10` and extracts enriched step attributes.
2. Insights records are tagged with `analysis_version = '3.1.0'`.
3. Normalized step rows are automatically inserted into `session_steps`.

