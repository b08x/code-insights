# ADR: Datetime Range Filter for Insights Export

**Date:** 2026-04-11
**Status:** Accepted — design approval for Issue #3
**Deciders:** TA (technical-architect), PM, Dev
**Feature Branch:** `feature/export-insights-datetime-range-filter`

## Context

Users need to export insights scoped to a specific datetime range, for both
"all projects" and "single project" scopes. Today, `POST /api/export/generate`
and `GET /api/export/generate/stream` synthesize ALL scoped insights (capped by
depth). There is no way to focus an export on "last sprint", "Q1", or a release
window. The feature lives under the Export wizard Step 2 ("Configure"), placed
after the Depth selector.

The existing architecture already surfaces a derived `dateRange: {from, to}` in
`ExportPromptContext` — it's computed by `fetchSessionContext()` as MIN/MAX of
`started_at`/`ended_at`. This is passed to the LLM system prompt for labeling
but never used as a filter. We extend this from derived metadata to an optional
user-supplied filter.

## Decision

Add two optional filter parameters — `dateFrom` and `dateTo` — threaded through
the full pipeline:

```
ExportPage (date picker UI)
  -> ExportGenerateRequest { dateFrom?, dateTo? }
  -> GET /export/generate/stream?dateFrom=&dateTo=
  -> fetchScopedInsights(db, scope, projectId, dateFrom, dateTo)
  -> WHERE i.timestamp >= ? AND i.timestamp < ?
  -> ExportPromptContext.dateRange reflects the USER range, not derived MIN/MAX
  -> Metadata echoes dateFrom/dateTo for receipt
```

### Filter Semantics (Locked)

| Aspect | Decision | Rationale |
|---|---|---|
| Column filtered | `insights.timestamp` | Matches user intent ("insights from this period"); already indexed (`idx_insights_timestamp`, `idx_insights_confidence_timestamp`). `sessions.started_at` would confuse sessions-vs-insights mental model. |
| Date format (wire) | ISO-8601 date-only `YYYY-MM-DD` | Consistent with existing `dateRange.from/to` and `fetchDashboardStats` range pattern. No timezone ambiguity for users. |
| Interval | Half-open `[from, to+1day)` | Standard date-range convention; avoids off-by-one on the end day. Server appends `T23:59:59.999Z` OR adds 1 day — pick one and document. **Decision: append `T00:00:00` to from, and compare `< (to + 1 day)` using SQLite `date(?, '+1 day')`.** |
| Optionality | Both optional, independent | `dateFrom` alone = "since X"; `dateTo` alone = "until Y"; both = bounded; neither = current behavior. |
| Validation | `dateFrom <= dateTo`, both parseable as YYYY-MM-DD | Reject 400 on malformed. |
| Empty result | Return 200 with empty content + metadata | Not an error. UI shows "0 insights in range". |

## Options Considered

### Option A: Filter on `insights.timestamp` (CHOSEN)
- **Pros:** Existing index supports it; semantically matches UI copy ("export insights from..."); no JOIN change needed.
- **Cons:** An insight's `timestamp` is the session timestamp at analysis — close enough, no behavioral surprise.
- **Effort:** S

### Option B: Filter on `sessions.started_at` via JOIN
- **Pros:** Intuitive "sessions from this period".
- **Cons:** Semantics drift — an insight from a session that spans two weeks becomes ambiguous. No existing index on `sessions.started_at` for this access pattern.
- **Rejected:** adds a column to the WHERE clause not already indexed in the confidence-ordered path.

### Option C: Client-side filtering (filter the full insight list in useMemo)
- **Pros:** Zero server change.
- **Cons:** Still sends ALL insights to the LLM — depth-cap eats high-confidence OLD insights before newer in-range ones are even considered. Violates the user's ask.
- **Rejected:** defeats the purpose.

**Chosen: Option A.**

## Type Contract (Single Source of Truth)

Types are co-located in `server/src/routes/export.ts` and mirrored in
`server/src/llm/export-prompts.ts` + `dashboard/src/lib/api.ts`. This follows
the existing export convention — LLM export types are NOT in `cli/src/types.ts`
(they're server/dashboard-only; SQLite schema is untouched).

### Changes

**`server/src/llm/export-prompts.ts`**
```ts
// ExportPromptContext.dateRange stays the same shape; semantics change:
// - if user supplied dateFrom/dateTo: dateRange reflects user-supplied values
// - else: derived MIN/MAX as today
// Add optional flag so prompt can say "User-selected range" vs "Full history":
dateRange: { from: string; to: string; userSelected?: boolean };
```

**`server/src/routes/export.ts`**
```ts
interface ExportGenerateBody {
  scope: ExportScope;
  projectId?: string;
  format: ExportFormat;
  depth?: ExportDepth;
  dateFrom?: string;  // YYYY-MM-DD, inclusive
  dateTo?: string;    // YYYY-MM-DD, inclusive
}

interface ExportGenerateMetadata {
  // existing fields...
  dateFrom?: string;
  dateTo?: string;
  userSelectedDateRange: boolean;
}
```

**`dashboard/src/lib/api.ts`**
```ts
export interface ExportGenerateRequest {
  scope: ExportGenerateScope;
  projectId?: string;
  format: ExportGenerateFormat;
  depth?: ExportGenerateDepth;
  dateFrom?: string;  // YYYY-MM-DD
  dateTo?: string;    // YYYY-MM-DD
}
```

`exportGenerateStream()` appends `dateFrom`/`dateTo` to the URLSearchParams only when defined. No breaking change to existing callers.

## SQL Changes

`fetchScopedInsights()` gains two optional parameters. Use parameterized
prepared statements — NEVER string-interpolate dates.

```ts
function fetchScopedInsights(
  db, scope, projectId,
  dateFrom?: string, dateTo?: string
): ExportInsightRow[] {
  const conditions: string[] = [`i.type != 'summary'`];
  const params: unknown[] = [];

  if (scope === 'project') {
    if (!projectId) return [];
    conditions.push(`i.project_id = ?`);
    params.push(projectId);
  }
  if (dateFrom) {
    conditions.push(`i.timestamp >= ?`);
    params.push(dateFrom); // lexicographic compare works for ISO-8601
  }
  if (dateTo) {
    conditions.push(`i.timestamp < date(?, '+1 day')`);
    params.push(dateTo);
  }

  const sql = `
    SELECT i.id, i.type, i.title, i.content, i.summary, i.confidence,
           i.project_name, i.timestamp
    FROM insights i
    JOIN sessions s ON i.session_id = s.id AND s.deleted_at IS NULL
    WHERE ${conditions.join(' AND ')}
    ORDER BY i.confidence DESC, i.timestamp DESC
  `;
  return db.prepare(sql).all(...params) as ExportInsightRow[];
}
```

**Dynamic SQL caveat:** `better-sqlite3` prepared statement cache benefits from
a small number of shapes. With 4 optional dimensions (projectId x dateFrom x
dateTo) we get 8 permutations — acceptable. Do NOT concatenate user input into
the SQL string beyond the conditions array (all values are parameterized).

**Index coverage:** `idx_insights_confidence_timestamp (confidence DESC,
timestamp DESC)` remains the leading index for the ORDER BY. SQLite will likely
use `idx_insights_timestamp` for the range predicate when scope=all, or fall
back to `idx_insights_project_id` + filter when scope=project. **No new index
required for Phase 1** — we already have 1000s of insights per user at most.
Revisit if queries exceed 50ms on real data.

`fetchSessionContext()` ALSO gains `dateFrom`/`dateTo` so `sessionCount`,
`projectCount`, and displayed `dateRange` reflect the user's filter, not the
full dataset. Apply the same WHERE conditions against `sessions.started_at`
using the same half-open interval. When user-supplied values are present,
`dateRange` in the prompt uses THEM verbatim (not derived MIN/MAX).

## Frontend State & UX

**ExportPage.tsx** — add to wizard Step 2, AFTER the Depth block:

```ts
const [dateFrom, setDateFrom] = useState<string>('');  // empty = unset
const [dateTo, setDateTo] = useState<string>('');
```

Use shadcn/ui `Calendar` + `Popover` (already in the UI kit via `cn`/shadcn)
OR plain HTML `<input type="date">` wrapped in an Input component. **Recommend
shadcn Calendar + Popover** for consistency with the rest of the dashboard —
confirm with ux-engineer in Step 5.

**Stat bar recomputation:** extend the `useMemo` to filter `scopedInsights` by
`i.timestamp` when dateFrom/dateTo are set, so the count preview matches what
the server will actually fetch. This is the second source of truth — keep the
predicate identical (half-open interval) and add a comment cross-referencing
the server function.

**Pass-through:**
```ts
await generate({
  scope, projectId: scope === 'project' ? projectId : undefined,
  format: format_, depth,
  dateFrom: dateFrom || undefined,
  dateTo: dateTo || undefined,
});
```

**Validation:** client-side check `dateFrom <= dateTo` before enabling "Generate"; surface toast on violation. Server still re-validates.

**Filename:** extend `getFilename()` to append `-YYYY-MM-DD_to_YYYY-MM-DD` when the range is user-selected.

## Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| Client-side stat bar count drifts from server-side result | Medium | Extract the range predicate into a small shared util (dashboard-only) OR document that the client counts insights only (ignores session JOIN `deleted_at`, which is a fine approximation). |
| Lexicographic string compare on ISO dates | Low | ISO-8601 `YYYY-MM-DD...` sorts correctly as text. `date(?, '+1 day')` handles month/year rollover. |
| Empty range yields 0 insights | Low | Server returns 200 with empty metadata; UI shows "No insights in this range. Adjust dates or depth." |
| Timezone confusion (user in UTC-8 picks "today") | Low | `insights.timestamp` is stored as ISO-8601 UTC from the CLI. Document in tooltip: "Dates are evaluated in UTC." Acceptable for Phase 1. |
| LLM prompt includes wrong range when user filter is active | Medium | `fetchSessionContext` MUST return the user-supplied range (not MIN/MAX) when both are defined. Verified in test. |

## Test Coverage (Required)

**FIX NOW before merge** — TDD domain: `server/src/routes/export.test.ts`

1. `fetchScopedInsights` with dateFrom only returns insights >= dateFrom
2. `fetchScopedInsights` with dateTo only returns insights < dateTo+1day (inclusive end-day)
3. `fetchScopedInsights` with both bounds, scope='project', filters correctly
4. `fetchScopedInsights` with both bounds, scope='all', filters correctly
5. Empty range returns empty array, not error
6. Malformed dateFrom returns 400 from route handler
7. `dateFrom > dateTo` returns 400
8. `fetchSessionContext` reflects user range in returned `dateFrom`/`dateTo`
9. Metadata includes `userSelectedDateRange: true` when filter applied
10. SSE stream endpoint parses `dateFrom`/`dateTo` from query params correctly

Dashboard test (`ExportPage.test.tsx` if it exists) — SKIP domain, mark N/A.

## Implementation Order (Required)

1. Server types + `fetchScopedInsights` + `fetchSessionContext` (with tests)
2. Route handlers — POST and GET/SSE — parse + validate + pass-through (with tests)
3. `export-prompts.ts` — `userSelected` flag in context
4. Dashboard `api.ts` types + `exportGenerateStream` query param append
5. `ExportPage.tsx` — date picker UI + state + stat bar predicate
6. Manual verification in dashboard against a real DB

Each step stands alone and is testable — dev can commit per step.

## Out of Scope (Explicitly)

- Presets ("Last 7 days", "Last month", "This quarter") — valid follow-up, NOT this PR
- Datetime precision (hours/minutes) — day precision only
- Timezone selection — UTC only
- Filtering the non-LLM `POST /export/markdown` endpoint — not requested in #3
- SQLite schema migration — none required; filter uses existing indexed column

## Consequences

**Good:** Users can focus exports on meaningful time windows; depth cap no longer eats in-range insights in favor of old high-confidence ones; richer metadata receipt.

**Bad:** Two sources of truth for range predicate (client stat bar + server SQL) — mitigated by documentation and test coverage.

**Neutral:** `ExportPromptContext.dateRange` semantics now overloaded (derived OR user-selected). Added `userSelected` flag disambiguates.

## Layer Impact

- **CLI:** None. Schema unchanged.
- **Server:** 2 functions modified, 2 route handlers updated, types extended, tests added.
- **Dashboard:** 1 page modified, api.ts types extended, new UI component.
- **SQLite:** No migration. Existing indexes sufficient.

---

## TA Approval

**TA Approval: Approach is aligned with architecture. Proceed.**

Proceed to Step 6 (Dev Consensus Checkpoint) with this ADR as the binding
spec. Dev agent: follow the implementation order, write tests first per TDD
for the server-side changes (insider-verified domain), and ping me on Step 5
if the shadcn Calendar component choice conflicts with ux-engineer guidance.
