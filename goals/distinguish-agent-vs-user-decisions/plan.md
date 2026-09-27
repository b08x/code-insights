# Implementation Plan: Distinguish Agent vs User Decisions & FCA Step Matrix

## Solution Approach
Enhance Code Insights' session extraction pipeline to distinguish between coding agent decisions, user decisions, and collaborative decisions, while extracting a compact semantic step matrix for Formal Concept Analysis (FCA). 

This plan addresses:
1. **Schema & Prompting:** Extending [`buildSessionAnalysisInstructions`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/prompts.ts#L84) to extract `decided_by` (`'user' | 'agent' | 'collaborative'`), `intent`, `branch_point`, and a 4–10 step semantic incidence matrix (`LLM_Decide`, `User_Decide`, `Target_Config`, `Target_SrcCode`, `State_Success`, `State_Error`) with low-token turn-grounded reasoning.
2. **Types & Storage:** Updating core types in [`cli/src/types.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/types.ts#L183) and [`dashboard/src/lib/types.ts`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/lib/types.ts#L181), validating payloads in [`response-parsers.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/response-parsers.ts#L283), and persisting clean relational JSON into `insights.metadata` via [`analysis-db.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/analysis-db.ts#L54).
3. **Dashboard Visualization:** Rendering distinct driver badges (`User`, `Agent`, `Collaborative`), intent, and branch points in [`DecisionContent`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/components/insights/insight-metadata.tsx#L88), and adding an FCA Incidence Matrix table to [`SessionDetailPage.tsx`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/pages/SessionDetailPage.tsx).
4. **Rails & FCA Export:** Adding Rails-compatible JSON and FCA formal context export endpoints in [`server/src/routes/export.ts`](file:///home/b08x/WorkspaceV3/code-insights/server/src/routes/export.ts).

---

## Ordered Implementation Steps

### Step 1: Type Definitions & Schema Expansion
Update TypeScript interfaces across CLI and dashboard to include `decided_by`, `intent`, `branch_point`, and `step_matrix`.
- **Files Touched:**
  - [`cli/src/analysis/prompt-types.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/prompt-types.ts)
  - [`cli/src/types.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/types.ts)
  - [`dashboard/src/lib/types.ts`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/lib/types.ts)
- **Verification:**
  - Run `pnpm build` to verify type checking compiles cleanly across packages.

### Step 2: Analysis Prompt & Grounding Rules
Update [`buildSessionAnalysisInstructions`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/prompts.ts) to instruct the LLM on decision attribution and the semantic step matrix.
- **Files Touched:**
  - [`cli/src/analysis/prompts.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/prompts.ts)
- **Changes:**
  - Add `decided_by: 'user' | 'agent' | 'collaborative'`, `intent`, `branch_point`, and `_reasoning` to the `decisions` output schema.
  - Define rules for `decided_by` requiring evidence turn citations (`User#N` for user, `Assistant#N` for agent, both for collaborative).
  - Add `step_matrix` schema (array of 4–10 semantic steps with `driver`, `target`, `state`).
- **Verification:**
  - Run `pnpm --filter @code-insights/cli test src/analysis/__tests__/prompts.test.ts` (or equivalent test suite).

### Step 3: Response Parser & DB Conversion Layer
Update response parsing and database serialization to validate new fields, strip transient `_reasoning`, and persist structured metadata.
- **Files Touched:**
  - [`cli/src/analysis/response-parsers.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/response-parsers.ts)
  - [`cli/src/analysis/analysis-db.ts`](file:///home/b08x/WorkspaceV3/code-insights/cli/src/analysis/analysis-db.ts)
  - [`server/src/llm/analysis.ts`](file:///home/b08x/WorkspaceV3/code-insights/server/src/llm/analysis.ts)
- **Changes:**
  - In `parseAnalysisResponse`: ensure defaults for `decided_by` (fallback to `'collaborative'`), parse and validate `step_matrix`.
  - In `convertToInsightRows`: persist `decided_by`, `intent`, `branch_point` in decision `metadata`; attach `step_matrix` to session summary metadata.
- **Verification:**
  - Run unit tests in `cli/src/analysis/__tests__/response-parsers.test.ts` and `cli/src/analysis/__tests__/analysis-db.test.ts`.

### Step 4: Rails & FCA Export Endpoints
Provide endpoints to export the session's decisions and step incidence matrix in Rails-ready JSON and standard FCA matrix format.
- **Files Touched:**
  - [`server/src/routes/export.ts`](file:///home/b08x/WorkspaceV3/code-insights/server/src/routes/export.ts)
  - [`dashboard/src/lib/api.ts`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/lib/api.ts)
- **Changes:**
  - Add `GET /api/export/session/:id/rails` returning structured records `{ session, decisions, step_matrix }` ready for ActiveRecord ingestion.
  - Add `GET /api/export/session/:id/fca` returning the binary context $(G, M, I)$ as JSON/CSV.
- **Verification:**
  - Run `pnpm --filter @code-insights/server test src/routes/__tests__/export.test.ts` or `curl` test on export routes.

### Step 5: Dashboard Decision Cards & Badges
Update the decision card display to highlight decision maker, intent, and branch points.
- **Files Touched:**
  - [`dashboard/src/components/insights/insight-metadata.tsx`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/components/insights/insight-metadata.tsx)
  - [`dashboard/src/components/insights/InsightCard.tsx`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/components/insights/InsightCard.tsx)
- **Changes:**
  - Add `Decided By` badge with distinct styles: User (blue), Agent (purple/indigo), Collaborative (emerald).
  - Add sections for `Intent` and `Branch Point` when present.
- **Verification:**
  - Run dashboard test suite / `pnpm --filter @code-insights/dashboard build`.

### Step 6: Dashboard FCA Incidence Matrix Table
Implement an interactive FCA Incidence Matrix view in the session detail page.
- **Files Touched:**
  - [`dashboard/src/components/insights/FcaMatrixCard.tsx`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/components/insights/FcaMatrixCard.tsx) (new component)
  - [`dashboard/src/pages/SessionDetailPage.tsx`](file:///home/b08x/WorkspaceV3/code-insights/dashboard/src/pages/SessionDetailPage.tsx)
- **Changes:**
  - Render an incidence matrix table: Rows = Steps, Columns = Binary Attributes (`LLM_Decide`, `User_Decide`, `Collab_Decide`, `Target_Config`, `Target_SrcCode`, `Target_Test`, `Target_Docs`, `State_Success`, `State_Error`).
  - Include an Export button for Rails JSON and FCA CSV.
- **Verification:**
  - Run `pnpm --filter @code-insights/dashboard test` and `pnpm build`.

---

## Risks & Open Questions

- **LLM Consistency on Binary Attributes:** LLMs occasionally vary attribute naming. We enforce strict enum guidance in `<output_schema>` and canonicalize attributes during response parsing (`response-parsers.ts`).
- **Token Overhead:** Kept to ~100–150 tokens by restricting `step_matrix` to 4–10 major episodes and using compact single-token attribute keys.
- **Legacy Sessions:** Existing sessions in SQLite lack `decided_by` and `step_matrix`. All rendering logic will gracefully check for field presence without throwing errors.
