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

## Canonical FCA Taxonomy (10 Attributes)

Formal Concept Analysis extracts a formal context $(G, M, I)$ where:
- $G$ is the set of **Objects** (the 4–10 semantic episode steps in the session).
- $M$ is the set of **Attributes** (10 canonical binary dimensions across 3 facets).
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

#### A. JSON Response (`format=json` or default)
- **Content-Type**: `application/json`
```json
{
  "session_id": "sess-1234",
  "objects": [
    "Configure build pipeline",
    "Implement FCA router endpoints"
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
    "State_Blocked"
  ],
  "incidence": [
    [false, true, false, true, false, false, false, true, false, false],
    [true, false, false, false, true, false, false, true, false, false]
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
        "State_Blocked": false
      }
    }
  ]
}
```

#### B. CSV Response (`format=csv` or `Accept: text/csv`)
- **Content-Type**: `text/csv; charset=utf-8`
- **Content-Disposition**: `attachment; filename="session-sess-1234-fca.csv"`
```csv
Step,Turn,LLM_Decide,User_Decide,Collab_Decide,Target_Config,Target_SrcCode,Target_Test,Target_Docs,State_Success,State_Error,State_Blocked
"Configure build pipeline","User#1",0,1,0,1,0,0,0,1,0,0
"Implement FCA router endpoints","Assistant#3",1,0,0,0,1,0,0,1,0,0
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
