# CLI Stats Command Suite — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `code-insights stats` command suite with 5 subcommands, a data source abstraction layer (Firestore + local), a `config` command, and modified `init` flow — delivering terminal-based analytics with zero new dependencies.

**Architecture:** Four-layer pipeline (data source → aggregation → render → stdout) with a `StatsDataSource` interface abstracting Firestore and local disk reads. Data source preference stored in config, resolved via 5-level priority chain. All aggregation and rendering is source-agnostic.

**Tech Stack:** TypeScript, Commander.js, chalk, ora, firebase-admin (existing deps only). Unicode sparklines + bar charts. JSON cache for local performance.

**Design Docs:**
- [Design Summary](./2026-02-25-cli-stats-design.md)
- [Architecture](./2026-02-25-cli-stats-architecture.md)
- [UX Design](./2026-02-25-cli-stats-ux-design.md)

**Working Branch:** `feature/cli-stats-command` in CLI repo at `/home/srikanth/Workspace/code-insights/code-insights/`

---

## Overview

10 phases, 18 new files (~2,090 lines) + 9 modified files (~170 lines). Sequential execution.

| Phase | What | Key Files |
|-------|------|-----------|
| 1 | Foundation: types + data source interface + factory | `data/types.ts`, `data/source.ts` |
| 2 | Firestore data source | `firebase/client.ts` (export getDb), `data/firestore.ts` |
| 3 | Local data source + cache | `data/cache.ts`, `data/local.ts` |
| 4 | Aggregation (pure functions) | `data/aggregation.ts` |
| 5 | Rendering primitives | `render/colors.ts`, `render/format.ts`, `render/charts.ts`, `render/layout.ts` |
| 6 | Command wiring | `commands/sync.ts` (refactor), `shared.ts`, `index.ts` |
| 7 | Action handlers | `actions/overview.ts`, `cost.ts`, `projects.ts`, `today.ts`, `models.ts` |
| 8 | Wire into CLI entry point | `index.ts` (root), build + smoke test |
| 9 | Data source preference + config command | `types.ts`, `utils/config.ts`, `commands/config.ts`, `commands/init.ts` |
| 10 | Existing command gates | `commands/sync.ts`, `status.ts`, `install-hook.ts`, `reset.ts` |

---

## Phase 1: Foundation — Types + Data Source Interface + Factory

### Task 1.1: Create stats data types file

**Files:**
- Create: `cli/src/commands/stats/data/types.ts`

**Context:** This is the central type definitions file for the entire stats system. It defines the `StatsDataSource` interface, `SessionRow` (the universal data currency), `SessionQueryOptions`, all aggregated output types, and error classes. The architecture doc Section 10 has the full type definitions, and Section 3.2 has the interface.

**Step 1: Create the directory structure**

Run: `mkdir -p cli/src/commands/stats/data cli/src/commands/stats/render cli/src/commands/stats/actions`

**Step 2: Write `data/types.ts`**

This file must contain:

1. **`Period` type**: `'7d' | '30d' | '90d' | 'all'`

2. **`SessionQueryOptions` interface**: Fields: `periodStart?: Date`, `projectId?: string`, `sourceTool?: string`

3. **`SessionRow` interface** (the universal session representation):
   - `id`, `projectId`, `projectName` (required strings)
   - `startedAt`, `endedAt` (required Dates)
   - `messageCount`, `userMessageCount`, `assistantMessageCount`, `toolCallCount` (required numbers)
   - `estimatedCostUsd?`, `totalInputTokens?`, `totalOutputTokens?`, `cacheCreationTokens?`, `cacheReadTokens?` (optional numbers)
   - `primaryModel?`, `modelsUsed?`, `generatedTitle?`, `customTitle?`, `summary?`, `sessionCharacter?`, `sourceTool?`, `usageSource?` (optional strings/string[])

4. **`ProjectResolution` interface**: `projectId: string`, `projectName: string`

5. **`PrepareResult` interface**: `message: string`, `dataChanged: boolean`

6. **`UsageStatsDoc` interface**: `totalInputTokens`, `totalOutputTokens`, `cacheCreationTokens`, `cacheReadTokens`, `estimatedCostUsd`, `sessionsWithUsage` (all numbers), `lastUpdatedAt: Date`

7. **`StatsDataSource` interface** with 5 methods:
   - `readonly name: string`
   - `getSessions(opts: SessionQueryOptions): Promise<SessionRow[]>`
   - `getUsageStats(): Promise<UsageStatsDoc | null>`
   - `resolveProjectId(name: string): Promise<ProjectResolution>`
   - `getLastSession(): Promise<SessionRow | null>`
   - `prepare(flags: StatsFlags): Promise<PrepareResult>`
   - Note: `StatsFlags` is imported from `../shared.js` (will be created in Phase 6). For now, use a forward-declared type: `import type { StatsFlags } from '../shared.js';` — this will cause a compile error until Phase 6, which is fine since we don't build until Phase 8.

8. **Aggregated output types** (from architecture Section 10.1):
   - `TimeSeriesPoint`: `{ date: string; value: number }`
   - `GroupedMetric`: `{ name: string; count: number; cost: number; percent: number }`
   - `DayStats`: `{ sessionCount: number; totalCost: number; totalMinutes: number }`
   - `StatsOverview`: sessionCount, totalCost, totalTimeMinutes, messageCount, totalTokens, projectCount, sessionsWithCostCount, activityByDay (TimeSeriesPoint[]), todayStats/yesterdayStats/weekStats (DayStats), topProjects (GroupedMetric[]), sourceTools (GroupedMetric[])
   - `CostBreakdown`: totalCost, avgPerDay, avgPerSession, sessionCount, sessionsWithCostCount, dailyTrend (TimeSeriesPoint[]), peakDay, byProject/byModel (GroupedMetric[]), tokenBreakdown object
   - `ProjectStatsEntry`: projectId, projectName, sessionCount, totalCost, totalTimeMinutes, messageCount, totalTokens, primaryModel?, lastActive (Date), sourceTool?, activityByDay (TimeSeriesPoint[])
   - `TodaySession`: id, projectName, title, startedAt, endedAt, durationMinutes, cost?, model?, messageCount, sessionCharacter?
   - `TodayStats`: date (Date), sessionCount, totalCost, totalTimeMinutes, messageCount, totalTokens, sessions (TodaySession[])
   - `ModelStatsEntry`: model, displayName, sessionCount, sessionPercent, totalCost, costPercent, avgCostPerSession, totalTokens, inputCost, outputCost, cacheCost, trend (TimeSeriesPoint[])

9. **Error classes** (from architecture Section 11):
   - `StatsError extends Error` (base)
   - `ConfigNotFoundError extends StatsError`
   - `ProjectNotFoundError extends StatsError` (with `projectName`, `availableProjects`, `suggestions` fields)
   - `FirestoreIndexError extends StatsError` (with `indexUrl` field)
   - `InvalidPeriodError extends StatsError`

**Step 3: Verify file compiles in isolation**

Run: `cd /home/srikanth/Workspace/code-insights/code-insights && npx tsc --noEmit cli/src/commands/stats/data/types.ts --skipLibCheck --moduleResolution node16 --module node16 --target es2022 2>&1 | head -20`

Note: This may show import errors for `StatsFlags` since `shared.ts` doesn't exist yet. That's expected — just verify no syntax errors in the type definitions themselves.

**Step 4: Commit**

```bash
git add cli/src/commands/stats/data/types.ts
git commit -m "feat(stats): add core type definitions and StatsDataSource interface"
```

---

### Task 1.2: Create data source factory

**Files:**
- Create: `cli/src/commands/stats/data/source.ts`

**Context:** This is the factory function that resolves which data source to use. It follows a 5-level priority chain (architecture Section 3.3). It imports `LocalDataSource` and `FirestoreDataSource` which don't exist yet — that's fine, we'll create them in Phases 2-3.

**Step 1: Write `data/source.ts`**

Contents:
```typescript
import type { StatsDataSource } from './types.js';
import type { StatsFlags } from '../shared.js';
import { loadConfig } from '../../../utils/config.js';
import { ConfigNotFoundError } from './types.js';

/**
 * Resolve which data source to use based on flags and config.
 *
 * Priority (highest to lowest):
 * 1. --local flag           -> always LocalDataSource
 * 2. --remote flag          -> always FirestoreDataSource (error if not configured)
 * 3. config.dataSource === 'local'    -> LocalDataSource
 * 4. config.dataSource === 'firebase' -> FirestoreDataSource
 * 5. No config, Firebase creds present -> FirestoreDataSource (backward compat)
 * 6. No config at all       -> LocalDataSource (zero-config first run)
 */
export function resolveDataSource(flags: StatsFlags): StatsDataSource {
  // Lazy imports to avoid loading firebase-admin when not needed
  if (flags.local) {
    const { LocalDataSource } = require('./local.js');
    return new LocalDataSource();
  }

  if (flags.remote) {
    const config = loadConfig();
    if (!config?.firebase) {
      throw new ConfigNotFoundError(
        'Firebase not configured. Run `code-insights init` first, or use `stats --local` for local-only stats.'
      );
    }
    const { FirestoreDataSource } = require('./firestore.js');
    return new FirestoreDataSource(config);
  }

  // Use config preference (with backward-compatible inference)
  const config = loadConfig();

  if (!config) {
    const { LocalDataSource } = require('./local.js');
    return new LocalDataSource();
  }

  // Explicit dataSource preference
  if (config.dataSource === 'firebase' || (!config.dataSource && config.firebase?.projectId)) {
    const { FirestoreDataSource } = require('./firestore.js');
    return new FirestoreDataSource(config);
  }

  const { LocalDataSource } = require('./local.js');
  return new LocalDataSource();
}
```

**Important note on `require()` vs `import()`:** We use dynamic `require()` here to avoid top-level imports of `firebase-admin` when only local mode is needed. When Firebase is eventually removed, these `require()` calls are the only import sites that need deleting. Alternatively, use `await import()` with async factory — but `resolveDataSource` is currently sync. The `require()` approach keeps it sync and simple. Change to dynamic `import()` if the team prefers.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/data/source.ts
git commit -m "feat(stats): add data source factory with 5-level resolution"
```

---

## Phase 2: Firestore Data Source

### Task 2.1: Export `getDb()` from firebase/client.ts

**Files:**
- Modify: `cli/src/firebase/client.ts:30` — change `function getDb()` to `export function getDb()`

**Step 1: Make the one-line change**

In `cli/src/firebase/client.ts`, line 30, change:
```typescript
function getDb(): admin.firestore.Firestore {
```
to:
```typescript
export function getDb(): admin.firestore.Firestore {
```

**Step 2: Commit**

```bash
git add cli/src/firebase/client.ts
git commit -m "feat(stats): export getDb() from firebase client for stats queries"
```

---

### Task 2.2: Create FirestoreDataSource

**Files:**
- Create: `cli/src/commands/stats/data/firestore.ts`

**Context:** This implements `StatsDataSource` by querying the user's Firestore. Architecture doc Section 4 has the full specification. It uses the now-exported `getDb()` and reuses `getProjects()` from `firebase/client.ts`. It also needs `initializeFirebase()` and access to the `runSync()` function (which doesn't exist yet — will be created in Phase 6). For now, implement `prepare()` with a TODO for `runSync()`.

**Step 1: Write `data/firestore.ts`**

Must contain:

1. **`docToSessionRow(doc)` function** — maps a Firestore document to `SessionRow`. Reference architecture Section 4.6. Handle `.toDate()` conversion for `startedAt`/`endedAt`, use `??` for optional fields.

2. **`getSessionsInPeriod(opts: SessionQueryOptions)` function** — builds a Firestore query with conditional `.where()` chaining for `projectId`, `sourceTool`, `periodStart`. Always `.orderBy('startedAt', 'desc')`. Returns `SessionRow[]`. Reference architecture Section 4.3.1.

3. **`getUsageStatsDoc()` function** — reads `stats/usage` aggregate doc. Returns `UsageStatsDoc | null`. Reference architecture Section 4.3.2.

4. **`resolveProjectByName(name: string)` function** — uses `getProjects()` from `firebase/client.ts` for exact match (case-insensitive), then substring match. On no match, throws `ProjectNotFoundError` with Levenshtein suggestions. Reference architecture Section 4.3.3.

5. **`getLastSessionRow()` function** — queries `sessions` collection ordered by `startedAt DESC` limit 1. Reference architecture Section 4.3.4.

6. **`levenshtein(a, b)` helper** — standard dynamic programming (used for fuzzy project name matching).

7. **`findSimilarNames(input, candidates, maxDistance?)` helper** — returns candidate names within maxDistance.

8. **`isFirestoreIndexError(error)` helper** — checks if error is `FAILED_PRECONDITION` from Firestore.

9. **`extractIndexUrl(error)` helper** — extracts the index creation URL from the error message.

10. **`FirestoreDataSource` class** implementing `StatsDataSource`:
    - Constructor takes `ClaudeInsightConfig`
    - `prepare()`: calls `initializeFirebase(this.config)`, then attempts `runSync({ quiet: true })` (wrap in try/catch). If `flags.noSync`, skip sync. Return appropriate `PrepareResult`.
    - `getSessions()`: delegates to `getSessionsInPeriod()`
    - `getUsageStats()`: delegates to `getUsageStatsDoc()`
    - `resolveProjectId()`: delegates to `resolveProjectByName()`
    - `getLastSession()`: delegates to `getLastSessionRow()`

**Important:** For `prepare()`, since `runSync()` doesn't exist yet (created in Phase 6), write the full `prepare()` method but comment out the `runSync()` call with a `// TODO: uncomment when Phase 6 is complete` marker. The rest of the method should be functional.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/data/firestore.ts
git commit -m "feat(stats): add FirestoreDataSource with query functions"
```

---

## Phase 3: Local Data Source + Cache

### Task 3.1: Create local stats cache

**Files:**
- Create: `cli/src/commands/stats/data/cache.ts`

**Context:** The cache stores pre-parsed `SessionRow[]` keyed by source file path. Cache invalidation is by file modification time. Architecture doc Section 6 has the full specification.

**Step 1: Write `data/cache.ts`**

Must contain:

1. **Constants**: `CACHE_PATH = path.join(os.homedir(), '.code-insights', 'stats-cache.json')`

2. **`StatsCacheFile` interface**: `version: number`, `lastRefresh: string`, `entries: Record<string, StatsCacheEntry>`

3. **`StatsCacheEntry` interface**: `lastModified: string`, `provider: string`, `rows: SessionRow[]`

4. **`splitVirtualPath(filePath)` function** — same logic as in `sync.ts` lines 204-213. Splits `"/path/to/db#composerId"` into `{ realPath, sessionFragment }`. Export this since `local.ts` needs it too.

5. **`StatsCache` class**:
   - Private `data: StatsCacheFile` and `dirty: boolean`
   - Constructor: calls `this.load()`
   - `async refresh()`: Iterates all providers via `getAllProviders()`, calls `discover()` on each, checks mtime against cached entry, parses only new/modified files via `provider.parse()`, transforms via `parsedSessionToRow()` (imported from `local.ts` — forward reference, will exist after Task 3.2). Prunes deleted files. Saves if dirty. Returns `{ newSessions, totalSessions }`.
   - `getAllRows(): SessionRow[]`: flattens all entries, deserializes Dates from JSON strings.
   - `private load()`: reads CACHE_PATH, checks version, returns empty on error.
   - `private save()`: writes to CACHE_PATH with `JSON.stringify(data, null, 2)`.
   - `private empty()`: returns `{ version: 1, lastRefresh: '', entries: {} }`

**Note on circular dependency:** `cache.ts` needs `parsedSessionToRow()` from `local.ts`, and `local.ts` needs `StatsCache` from `cache.ts`. Break the cycle by putting `parsedSessionToRow()` in `cache.ts` (it's a pure function that transforms `ParsedSession` → `SessionRow`, so it logically belongs with the cache transformation logic). Import `generateStableProjectId` from `utils/device.ts`.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/data/cache.ts
git commit -m "feat(stats): add local stats cache with mtime invalidation"
```

---

### Task 3.2: Create LocalDataSource

**Files:**
- Create: `cli/src/commands/stats/data/local.ts`

**Context:** Implements `StatsDataSource` by reading from the local cache. Architecture doc Section 5 has the full specification.

**Step 1: Write `data/local.ts`**

Must contain:

1. **`LocalDataSource` class** implementing `StatsDataSource`:
   - `readonly name = 'local'`
   - Private `cache: StatsCache`
   - Constructor: `this.cache = new StatsCache()`
   - `async prepare(flags)`: If `flags.noSync`, skip refresh and return cached count. Otherwise call `this.cache.refresh()`. Return `PrepareResult` with message like "Parsed 3 new sessions (47 total)" or "47 sessions cached".
   - `async getSessions(opts)`: Get all rows from cache, filter in-memory by `periodStart`, `projectId`, `sourceTool`. Sort by `startedAt` descending.
   - `async getUsageStats()`: Return `null` (local source has no pre-computed aggregate).
   - `async resolveProjectId(name)`: Build unique project list from cached rows, exact match (case-insensitive), substring match, throw `ProjectNotFoundError` with `findSimilarNames()` suggestions on no match.
   - `async getLastSession()`: Get all rows, find the one with the latest `startedAt`.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/data/local.ts
git commit -m "feat(stats): add LocalDataSource with disk-based session reads"
```

---

## Phase 4: Aggregation Layer

### Task 4.1: Create aggregation functions

**Files:**
- Create: `cli/src/commands/stats/data/aggregation.ts`

**Context:** Pure functions over `SessionRow[]`. These are completely data-source-agnostic. Architecture doc Section 7 has the full specification.

**Step 1: Write `data/aggregation.ts`**

Must contain these exported functions:

1. **Utility functions** (private/internal):
   - `sum<T>(items: T[], fn: (item: T) => number): number`
   - `diffMinutes(start: Date, end: Date): number` — `(end - start) / 60000`
   - `groupBy<T, K extends string>(items: T[], keyFn: (item: T) => K): Map<K, T[]>`
   - `findMostFrequent<T>(items: T[]): T | undefined`
   - `today(): Date` — midnight of today, local time
   - `yesterday(): Date` — midnight of yesterday
   - `startOfWeek(): Date` — Monday of current ISO week
   - `periodStartDate(period: Period): Date | undefined` — maps '7d' → 7 days ago, '30d' → 30 days ago, '90d' → 90 days ago, 'all' → undefined
   - `shortenModelName(model: string): string` — e.g., 'claude-sonnet-4-5-20250929' → 'Sonnet 4.5'

2. **`createBuckets(period: Period): Map<string, TimeSeriesPoint>`** — creates empty buckets for the full date range. 7d → 7 daily, 30d → 30 daily, 90d → 12-13 weekly, 'all' → monthly.

3. **`groupByDay(sessions: SessionRow[], period: Period, metric?: 'sessions' | 'cost' | 'tokens'): TimeSeriesPoint[]`** — reference architecture Section 7.3. Gap-filling is critical.

4. **`computeDayStats(sessions: SessionRow[], dayStart: Date): DayStats`** — filters to sessions on that day, sums count/cost/time.

5. **`computeRangeStats(sessions: SessionRow[], from: Date, to: Date): DayStats`** — filters to sessions in range.

6. **`computeTopProjects(sessions: SessionRow[], limit: number): GroupedMetric[]`** — groups by `projectName`, sums sessions/cost, sorts by session count, truncates to limit.

7. **`computeOverview(sessions: SessionRow[], period: Period): StatsOverview`** — reference architecture Section 7.2.1.

8. **`computeCostBreakdown(sessions: SessionRow[], period: Period): CostBreakdown`** — reference architecture Section 7.2.2. For token cost breakdown, use `getModelPricing()` from `utils/pricing.ts`.

9. **`computeProjectStats(sessions: SessionRow[], period: Period): ProjectStatsEntry[]`** — reference architecture Section 7.2.3.

10. **`computeTodayStats(sessions: SessionRow[]): TodayStats`** — filters to today, builds `TodaySession[]` with resolved titles.

11. **`computeModelStats(sessions: SessionRow[], period: Period): ModelStatsEntry[]`** — reference architecture Section 7.2.4.

12. **`resolveTitle(session: SessionRow): string`** — `customTitle ?? generatedTitle ?? summary ?? 'Untitled Session'`

**Step 2: Commit**

```bash
git add cli/src/commands/stats/data/aggregation.ts
git commit -m "feat(stats): add source-agnostic aggregation functions"
```

---

## Phase 5: Rendering Primitives

### Task 5.1: Create semantic color helpers

**Files:**
- Create: `cli/src/commands/stats/render/colors.ts`

**Context:** Reference architecture Section 9.2 and UX design Section 1.1.

**Step 1: Write `render/colors.ts`**

Export a `colors` object with semantic chalk wrappers:
- `header`, `label`, `value`, `divider`, `hint` (structural)
- `money(amount)` (green/yellow/red based on threshold), `moneyNeutral` (always green)
- `project`, `model`, `source`, `timestamp` (data types)
- `success`, `warning`, `error` (states)
- `sparkChar`, `barFilled`, `barEmpty` (charts)
- `character(char)` (session character color map)

**Step 2: Commit**

```bash
git add cli/src/commands/stats/render/colors.ts
git commit -m "feat(stats): add semantic terminal color system"
```

---

### Task 5.2: Create number/duration/date formatting

**Files:**
- Create: `cli/src/commands/stats/render/format.ts`

**Context:** Reference architecture Section 9.3 and UX design Section 1.4.

**Step 1: Write `render/format.ts`**

Export these functions:
- `formatMoney(amount: number): string` — `$0.47`, `$12.30`, `$1,234.56`
- `formatTokens(count: number): string` — `1.2M`, `450K`, `1,234`
- `formatDuration(minutes: number): string` — `23m`, `1h 42m`, `142h 30m`
- `formatRelativeDate(date: Date): string` — `2h ago`, `yesterday`, `3d ago`, `Feb 18`
- `formatTime(date: Date): string` — `10:32 AM`
- `formatPercent(value: number): string` — `67%`, `3.2%`
- `formatCount(count: number): string` — `47`, `1,284`
- `formatPeriodLabel(period: Period): string` — `Last 7 days`, `Last 30 days`, `Last 90 days`, `All time`

**Step 2: Commit**

```bash
git add cli/src/commands/stats/render/format.ts
git commit -m "feat(stats): add number, duration, and date formatters"
```

---

### Task 5.3: Create sparkline and bar chart renderers

**Files:**
- Create: `cli/src/commands/stats/render/charts.ts`

**Context:** Reference architecture Section 9.4 and UX design Section 1.5.

**Step 1: Write `render/charts.ts`**

Export:
- `SPARK_CHARS = ['▁', '▂', '▃', '▅', '▇']`
- `sparkline(values: number[]): string` — maps values to spark chars, colors with `colors.sparkChar`.
- `sparklineLabels(period: Period): string` — `'M T W T F S S'` for 7d, etc.
- `barChart(items: { label: string; value: number; suffix: string }[], barWidth: number): string[]` — renders horizontal bars with `█` and `░` characters. Handles narrow terminals (barWidth=0 → simple list).

**Step 2: Commit**

```bash
git add cli/src/commands/stats/render/charts.ts
git commit -m "feat(stats): add Unicode sparkline and bar chart renderers"
```

---

### Task 5.4: Create terminal layout utilities

**Files:**
- Create: `cli/src/commands/stats/render/layout.ts`

**Context:** Reference architecture Section 9.5.

**Step 1: Write `render/layout.ts`**

Export:
- `getTerminalWidth(): number` — `process.stdout.columns || 80`
- `getBarWidth(): number` — 20/16/12/0 based on width
- `getGridColumns(): number` — 3/2/1 based on width
- `sectionHeader(title: string, rightText?: string): string` — cyan bold uppercase + divider
- `metricGrid(metrics: { label: string; value: string }[]): string` — responsive grid layout
- `projectCardHeader(name: string): string` — `─ project-name ───...`

**Step 2: Commit**

```bash
git add cli/src/commands/stats/render/layout.ts
git commit -m "feat(stats): add responsive terminal layout utilities"
```

---

## Phase 6: Command Wiring

### Task 6.1: Extract `runSync()` from sync.ts

**Files:**
- Modify: `cli/src/commands/sync.ts`

**Context:** The stats `prepare()` needs to call sync programmatically. Currently `syncCommand()` calls `process.exit(1)` on errors, which would kill the stats process. Extract the core logic into a `runSync()` function that throws instead of exiting. Reference architecture Section 8.1.

**Step 1: Add `SyncResult` interface and `runSync()` function**

At the top of `cli/src/commands/sync.ts` (after the existing `SyncOptions` interface), add:

```typescript
export interface SyncResult {
  syncedCount: number;
  messageCount: number;
  errorCount: number;
}
```

**Step 2: Extract `runSync()` from `syncCommand()`**

Create `export async function runSync(options: SyncOptions = {}): Promise<SyncResult>` that contains the core sync logic from `syncCommand()` but:
1. Does NOT call `process.exit()` — throws errors instead
2. Does NOT print the summary banner — returns `SyncResult` instead
3. Uses `options.quiet = true` by default when called from stats

Then refactor `syncCommand()` to be a thin wrapper:
```typescript
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
    const result = await runSync(options);
    // Print summary (existing logic)
  } catch (error) {
    // Print error and process.exit(1) (existing logic)
  }
}
```

**Key changes to the extracted `runSync()`:**
- Lines 39-43 (config check): `throw new Error(...)` instead of `process.exit(1)`
- Lines 46-56 (Firebase init): `throw new Error(...)` instead of `process.exit(1)`
- Lines 65-71 (provider check): `throw new Error(...)` instead of `process.exit(1)`
- Return `{ syncedCount: totalSyncedCount, messageCount: totalMessageCount, errorCount: totalErrorCount }`

The `filterFilesToSync()`, `updateSyncState()`, and `splitVirtualPath()` helper functions remain as private functions in the same file. Export `splitVirtualPath` since `cache.ts` also needs it — or better, since `cache.ts` already has its own copy from the architecture, keep them separate to avoid coupling.

**Step 3: Verify existing `sync` command still works**

Run: `cd /home/srikanth/Workspace/code-insights/code-insights && pnpm build`

The build must pass. The `syncCommand()` wrapper should produce identical behavior to before.

**Step 4: Commit**

```bash
git add cli/src/commands/sync.ts
git commit -m "refactor(sync): extract runSync() for programmatic invocation"
```

---

### Task 6.2: Create shared flags

**Files:**
- Create: `cli/src/commands/stats/shared.ts`

**Context:** Reference architecture Section 1.2 and 3.4.

**Step 1: Write `shared.ts`**

Must contain:

1. **`StatsFlags` interface**: `period: Period`, `project?: string`, `source?: string`, `noSync: boolean`, `local: boolean`, `remote: boolean`

2. **`applySharedFlags(cmd: Command): Command`** function — applies 6 `.option()` calls to a Command:
   - `-p, --period <period>` (default '7d')
   - `--project <name>`
   - `--source <tool>`
   - `--no-sync`
   - `--local`
   - `--remote`

3. **`validatePeriod(period: string): Period`** function — validates period string, throws `InvalidPeriodError` for invalid values.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/shared.ts
git commit -m "feat(stats): add shared command flags and validation"
```

---

### Task 6.3: Create command registration (stats/index.ts)

**Files:**
- Create: `cli/src/commands/stats/index.ts`

**Context:** Reference architecture Section 1.1. This is the command tree that registers the parent `stats` command and all 5 subcommands.

**Step 1: Write `stats/index.ts`**

```typescript
import { Command } from 'commander';
import { applySharedFlags } from './shared.js';
import { overviewAction } from './actions/overview.js';
import { costAction } from './actions/cost.js';
import { projectsAction } from './actions/projects.js';
import { todayAction } from './actions/today.js';
import { modelsAction } from './actions/models.js';

const costCommand = applySharedFlags(
  new Command('cost').description('Cost breakdown by project, model, and time period')
).action(costAction);

const projectsCommand = applySharedFlags(
  new Command('projects').description('Per-project detail — sessions, time, cost, models')
).action(projectsAction);

const todayCommand = applySharedFlags(
  new Command('today').description("Today's sessions with titles, duration, cost")
).action(todayAction);

const modelsCommand = applySharedFlags(
  new Command('models').description('Model usage distribution, cost per model, trends')
).action(modelsAction);

export const statsCommand = applySharedFlags(
  new Command('stats')
    .description('View usage statistics and analytics')
    .addCommand(costCommand)
    .addCommand(projectsCommand)
    .addCommand(todayCommand)
    .addCommand(modelsCommand)
).action(overviewAction);
```

**Note:** The action imports won't resolve until Phase 7. That's fine — no build until Phase 8.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/index.ts
git commit -m "feat(stats): add command tree registration"
```

---

### Task 6.4: Uncomment runSync() call in FirestoreDataSource

**Files:**
- Modify: `cli/src/commands/stats/data/firestore.ts`

**Context:** Now that `runSync()` exists (Task 6.1), uncomment the call in `FirestoreDataSource.prepare()`.

**Step 1: Update the `prepare()` method**

Import `runSync` at the top:
```typescript
import { runSync } from '../../sync.js';
```

In the `prepare()` method, replace the TODO/commented-out section with:
```typescript
if (!flags.noSync) {
  try {
    const result = await runSync({ quiet: true });
    if (result.syncedCount > 0) {
      return { message: `Synced ${result.syncedCount} new sessions`, dataChanged: true };
    }
    return { message: 'Up to date', dataChanged: false };
  } catch {
    return { message: 'Sync failed (showing cached data)', dataChanged: false };
  }
}
return { message: 'Sync skipped', dataChanged: false };
```

**Step 2: Commit**

```bash
git add cli/src/commands/stats/data/firestore.ts
git commit -m "feat(stats): wire runSync() into FirestoreDataSource.prepare()"
```

---

## Phase 7: Action Handlers

Each action handler follows the same pattern (architecture Section 3.5):
1. Resolve data source via `resolveDataSource(flags)`
2. `source.prepare(flags)` with ora spinner
3. Resolve project filter if `--project` is specified
4. Query sessions via `source.getSessions(opts)`
5. Handle empty state
6. Aggregate via `compute*()` functions
7. Render to stdout

### Task 7.1: Create overview action (stats with no args)

**Files:**
- Create: `cli/src/commands/stats/actions/overview.ts`

**Context:** This is the most complex action. Reference UX design Section 3 for the exact terminal output format:
- Sync status line
- 6-metric grid (Sessions, Cost, Time, Messages, Tokens, Projects)
- Activity sparkline
- Today/Yesterday/This Week quick stats
- Top 5 projects bar chart
- Hint lines

**Step 1: Write `actions/overview.ts`**

Export `async function overviewAction(flags: StatsFlags): Promise<void>`

The function must:
1. Validate period with `validatePeriod(flags.period)`
2. Call `resolveDataSource(flags)` to get the source
3. Show ora spinner, call `source.prepare(flags)`, succeed/warn based on result
4. If `flags.project`, call `source.resolveProjectId(flags.project)`
5. Call `source.getSessions(opts)` with period/project/source filters
6. If sessions empty, call `source.getLastSession()` and render empty state (UX design Section 8)
7. Call `computeOverview(sessions, flags.period)` for aggregation
8. Render using `sectionHeader()`, `metricGrid()`, `sparkline()`, `barChart()`, `colors.*`, `format*()` functions
9. Print hint lines at bottom

Handle errors: wrap in try/catch, check for `ProjectNotFoundError`, `FirestoreIndexError`, `ConfigNotFoundError`.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/actions/overview.ts
git commit -m "feat(stats): add overview action handler"
```

---

### Task 7.2: Create cost action

**Files:**
- Create: `cli/src/commands/stats/actions/cost.ts`

**Context:** Reference UX design Section 4. Shows:
- Summary metrics (total cost, avg/day, avg/session)
- Cost trend sparkline
- Peak spending day
- By-project cost breakdown (bar chart)
- By-model cost breakdown (bar chart)
- Token cost breakdown (input vs output vs cache)

**Step 1: Write `actions/cost.ts`**

Export `async function costAction(flags: StatsFlags): Promise<void>`

Same pattern as overview but uses `computeCostBreakdown()`. Handle the "no cost data" edge case (UX design Section 10 — when all sessions lack cost data, show "Cost data not available" message).

**Step 2: Commit**

```bash
git add cli/src/commands/stats/actions/cost.ts
git commit -m "feat(stats): add cost breakdown action handler"
```

---

### Task 7.3: Create projects action

**Files:**
- Create: `cli/src/commands/stats/actions/projects.ts`

**Context:** Reference UX design Section 5. Shows per-project cards with:
- Project name header
- Metrics: sessions, cost, time, messages
- Primary model, source tool
- Activity sparkline per project

**Step 1: Write `actions/projects.ts`**

Export `async function projectsAction(flags: StatsFlags): Promise<void>`

Uses `computeProjectStats()`. Renders each project as a card using `projectCardHeader()`.

**Step 2: Commit**

```bash
git add cli/src/commands/stats/actions/projects.ts
git commit -m "feat(stats): add per-project stats action handler"
```

---

### Task 7.4: Create today action

**Files:**
- Create: `cli/src/commands/stats/actions/today.ts`

**Context:** Reference UX design Section 6. Shows:
- Today's summary (sessions, cost, time)
- Session list with: time, title, duration, character badge, cost, model

**Step 1: Write `actions/today.ts`**

Export `async function todayAction(flags: StatsFlags): Promise<void>`

Uses `computeTodayStats()`. Note: the `--period` flag is ignored for this command (always shows today). Display sessions in chronological order (earliest first).

**Step 2: Commit**

```bash
git add cli/src/commands/stats/actions/today.ts
git commit -m "feat(stats): add today's sessions action handler"
```

---

### Task 7.5: Create models action

**Files:**
- Create: `cli/src/commands/stats/actions/models.ts`

**Context:** Reference UX design Section 7. Shows:
- Model distribution bar chart (by session count)
- Per-model details: sessions, cost, cost%, tokens
- Model cost comparison

**Step 1: Write `actions/models.ts`**

Export `async function modelsAction(flags: StatsFlags): Promise<void>`

Uses `computeModelStats()`. Handle edge case: sessions with no `primaryModel` (group as "Unknown").

**Step 2: Commit**

```bash
git add cli/src/commands/stats/actions/models.ts
git commit -m "feat(stats): add model usage action handler"
```

---

## Phase 8: Wire Into CLI Entry Point

### Task 8.1: Register stats command in root index.ts

**Files:**
- Modify: `cli/src/index.ts`

**Step 1: Add stats import and registration**

Add at the top of `cli/src/index.ts` (after other imports):
```typescript
import { statsCommand } from './commands/stats/index.js';
```

Add before `program.parse()`:
```typescript
program.addCommand(statsCommand);
```

Also update the program description from:
```typescript
.description('Sync your AI coding sessions to Firebase for analysis')
```
to:
```typescript
.description('AI coding session analytics — sync, stats, and insights')
```

**Step 2: Build the project**

Run: `cd /home/srikanth/Workspace/code-insights/code-insights && pnpm build`

Fix any TypeScript compilation errors. Common issues:
- Missing imports
- Type mismatches between `StatsFlags` and Commander's parsed options
- Optional chaining needed on nullable fields

**Step 3: Smoke test**

Run: `cd /home/srikanth/Workspace/code-insights/code-insights && node cli/dist/index.js stats --help`

Expected: Shows stats command help with all 4 subcommands and 6 flags.

Run: `node cli/dist/index.js stats --local`

Expected: Either shows stats from local session files, or shows empty state ("No sessions found").

Run: `node cli/dist/index.js stats --local --period 30d`

Expected: Period filter working.

**Step 4: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(stats): wire stats command into CLI entry point"
```

---

## Phase 9: Data Source Preference + Config Command

### Task 9.1: Update types.ts — make firebase optional, add DataSourcePreference

**Files:**
- Modify: `cli/src/types.ts:187-199`

**Step 1: Add `DataSourcePreference` type**

Before the `ClaudeInsightConfig` interface, add:
```typescript
export type DataSourcePreference = 'local' | 'firebase';
```

**Step 2: Make `firebase` optional and add `dataSource`**

Change the `ClaudeInsightConfig` interface from:
```typescript
export interface ClaudeInsightConfig {
  firebase: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  };
  webConfig?: FirebaseWebConfig;
  sync: {
    claudeDir: string;
    excludeProjects: string[];
  };
  dashboardUrl?: string;
}
```
to:
```typescript
export interface ClaudeInsightConfig {
  firebase?: {
    projectId: string;
    clientEmail: string;
    privateKey: string;
  };
  webConfig?: FirebaseWebConfig;
  sync: {
    claudeDir: string;
    excludeProjects: string[];
  };
  dashboardUrl?: string;
  dataSource?: DataSourcePreference;
}
```

**Step 3: Fix all `config.firebase` access sites**

After making `firebase` optional, these files need null-checks:

1. `cli/src/firebase/client.ts:10-24` — `initializeFirebase()` accesses `config.firebase.projectId`, `config.firebase.clientEmail`, `config.firebase.privateKey`. Add a guard at the top:
   ```typescript
   if (!config.firebase) {
     throw new Error('Firebase credentials not configured. Run `code-insights init` to set up.');
   }
   ```

2. `cli/src/commands/status.ts:18` — `config.firebase.projectId`. Change to `config.firebase?.projectId`.

3. `cli/src/commands/reset.ts:49` — `config.firebase.projectId`, `config.firebase.clientEmail`, `config.firebase.privateKey`. Add a guard:
   ```typescript
   if (!config.firebase) {
     console.error(chalk.red('Firebase not configured. Nothing to reset.'));
     process.exit(1);
   }
   ```

4. `cli/src/commands/sync.ts` — `config` is already null-checked by `loadConfig()`, but the `initializeFirebase(config)` call passes the full config. The guard in `initializeFirebase()` from step (1) above handles this.

**Step 4: Build and verify**

Run: `pnpm build`

All existing commands must still compile.

**Step 5: Commit**

```bash
git add cli/src/types.ts cli/src/firebase/client.ts cli/src/commands/status.ts cli/src/commands/reset.ts
git commit -m "feat(config): make firebase optional, add DataSourcePreference type"
```

---

### Task 9.2: Add preference resolution to utils/config.ts

**Files:**
- Modify: `cli/src/utils/config.ts`

**Step 1: Add two new functions**

Add at the bottom of `cli/src/utils/config.ts`:

```typescript
import type { DataSourcePreference } from '../types.js';

/**
 * Determine the effective data source preference.
 *
 * Resolution order:
 * 1. Explicit config.dataSource field -> use it directly
 * 2. No dataSource field, but Firebase credentials present -> 'firebase' (backward compat)
 * 3. No dataSource field, no Firebase credentials -> 'local' (zero-config)
 */
export function resolveDataSourcePreference(): DataSourcePreference {
  const config = loadConfig();

  if (!config) {
    return 'local';
  }

  if (config.dataSource) {
    return config.dataSource;
  }

  // Backward compatibility: infer from Firebase presence
  if (config.firebase?.projectId) {
    return 'firebase';
  }

  return 'local';
}

/**
 * Check if Firebase is configured (has credentials).
 */
export function isFirebaseConfigured(): boolean {
  const config = loadConfig();
  return config !== null && config.firebase !== undefined && !!config.firebase.projectId;
}
```

**Step 2: Commit**

```bash
git add cli/src/utils/config.ts
git commit -m "feat(config): add resolveDataSourcePreference() and isFirebaseConfigured()"
```

---

### Task 9.3: Create config command

**Files:**
- Create: `cli/src/commands/config.ts`

**Context:** Reference architecture Section 17. Two subcommands: `config` (show) and `config set-source <local|firebase>`.

**Step 1: Write `commands/config.ts`**

```typescript
import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, isConfigured, getConfigDir, isFirebaseConfigured, resolveDataSourcePreference } from '../utils/config.js';

export const configCommand = new Command('config')
  .description('View or change CLI configuration')
  .action(showConfigAction);

configCommand
  .command('set-source <source>')
  .description('Set the data source preference (local or firebase)')
  .action(setSourceAction);

async function showConfigAction(): Promise<void> {
  // Print current config summary
  // Reference architecture Section 17.3 for exact output format
  const preference = resolveDataSourcePreference();
  const config = loadConfig();

  console.log('\n  ' + chalk.cyan.bold('CODE INSIGHTS CONFIGURATION'));
  console.log('  ' + chalk.gray('─'.repeat(42)));
  console.log('');
  console.log('  ' + chalk.gray('Data source:') + '    ' + chalk.white.bold(preference));

  if (config?.firebase?.projectId) {
    console.log('  ' + chalk.gray('Firebase:') + '       ' + chalk.white(config.firebase.projectId) + chalk.green(' (configured)'));
  } else {
    console.log('  ' + chalk.gray('Firebase:') + '       ' + chalk.yellow('not configured'));
  }

  // ... web dashboard, claude dir, config file location
  console.log('  ' + chalk.gray('Config file:') + '    ' + chalk.white(getConfigDir() + '/config.json'));
  console.log('');

  if (preference === 'local') {
    console.log('  ' + chalk.gray.italic('To enable cloud sync:'));
    console.log('  ' + chalk.gray('  code-insights config set-source firebase'));
  } else {
    console.log('  ' + chalk.gray.italic('To change data source:'));
    console.log('  ' + chalk.gray('  code-insights config set-source local'));
    console.log('  ' + chalk.gray('  code-insights config set-source firebase'));
  }
  console.log('');
}

async function setSourceAction(source: string): Promise<void> {
  if (source !== 'local' && source !== 'firebase') {
    console.error(chalk.red(`\n  Invalid source "${source}". Expected: local or firebase\n`));
    process.exit(1);
  }

  if (source === 'firebase') {
    if (!isFirebaseConfigured()) {
      console.log(chalk.yellow('\n  Firebase is not configured yet.'));
      console.log(chalk.gray('  Run `code-insights init` to set up Firebase credentials first.\n'));
      return;
    }
  }

  const config = loadConfig();
  if (!config) {
    // No config exists yet — create minimal
    saveConfig({
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
      dataSource: source,
    });
  } else {
    config.dataSource = source;
    saveConfig(config);
  }

  console.log(chalk.green(`\n  ✓ Data source set to ${source}.`));

  if (source === 'local') {
    console.log('');
    console.log(chalk.gray('  What this means:'));
    console.log(chalk.gray('  • Stats will read from local session files (no network required)'));
    console.log(chalk.gray('  • Auto-sync to Firestore is disabled'));
    console.log(chalk.gray("  • Your Firebase config is preserved (switch back anytime)"));
  } else {
    const config = loadConfig();
    if (config?.firebase?.projectId) {
      console.log(chalk.gray(`  Firebase project: ${config.firebase.projectId}`));
    }
    console.log('');
    console.log(chalk.gray("  Run 'code-insights sync' to sync now."));
  }
  console.log('');
}
```

**Step 2: Register in index.ts**

Add to `cli/src/index.ts`:
```typescript
import { configCommand } from './commands/config.js';
```

Add before `program.parse()`:
```typescript
program.addCommand(configCommand);
```

**Step 3: Build and verify**

Run: `pnpm build`

Run: `node cli/dist/index.js config`
Expected: Shows current configuration.

Run: `node cli/dist/index.js config set-source local`
Expected: Shows success message.

**Step 4: Commit**

```bash
git add cli/src/commands/config.ts cli/src/index.ts
git commit -m "feat(config): add config show and set-source commands"
```

---

### Task 9.4: Modify init.ts — add data source prompt

**Files:**
- Modify: `cli/src/commands/init.ts`

**Context:** Reference architecture Section 16. The init flow now starts with a data source choice. "Local only" is the recommended default.

**Step 1: Restructure `initCommand()`**

The new flow:
1. If config exists, show re-init menu (Keep / Switch to local / Switch to Firebase / Reconfigure Firebase) instead of simple "Overwrite?" prompt
2. If `--from-json` or `--web-config` flags provided, auto-set `dataSource: 'firebase'` and proceed with existing Firebase flow
3. Otherwise, prompt for data source choice (local recommended)
4. If local: save minimal config and show local-specific next steps
5. If firebase: proceed with existing Steps 1 & 2, save with `dataSource: 'firebase'`

**Key changes:**

Replace lines 28-42 (the `isConfigured()` / overwrite check) with a re-init menu using `inquirer.prompt()` with `type: 'list'`.

Add data source prompt before Step 1:
```typescript
const { dataSource } = await inquirer.prompt([{
  type: 'list',
  name: 'dataSource',
  message: 'How would you like to store your sessions?',
  choices: [
    { name: 'Local only (recommended) — Zero config. Stats computed on your machine.', value: 'local' },
    { name: 'Firebase (cloud sync) — Web dashboard + cross-device access.', value: 'firebase' },
  ],
  default: 'local',
}]);
```

If `dataSource === 'local'`:
```typescript
const config: ClaudeInsightConfig = {
  sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
  dataSource: 'local',
};
saveConfig(config);
// Print local success + next steps
```

If `dataSource === 'firebase'`: run existing Steps 1 & 2, then save with `dataSource: 'firebase'` in config.

For non-interactive mode (`options.fromJson || options.webConfig`): add `dataSource: 'firebase'` to the saved config object (line 192).

**Step 2: Build and verify**

Run: `pnpm build`

Test with: `node cli/dist/index.js init` (cancel before making changes if you don't want to overwrite config)

**Step 3: Commit**

```bash
git add cli/src/commands/init.ts
git commit -m "feat(init): add data source prompt with local-first default"
```

---

## Phase 10: Existing Command Gates

### Task 10.1: Gate sync command by data source

**Files:**
- Modify: `cli/src/commands/sync.ts`

**Step 1: Add data source check at the top of `syncCommand()`**

After the existing imports, add:
```typescript
import { resolveDataSourcePreference } from '../utils/config.js';
```

At the top of `syncCommand()` (before config loading), add:
```typescript
const preference = resolveDataSourcePreference();
if (preference === 'local' && !options.forceRemote) {
  log(chalk.yellow('\n  ⚠ Data source is set to local. Sync is only used with Firebase.\n'));
  log(chalk.gray('  To switch to Firebase: code-insights config set-source firebase'));
  log(chalk.gray('  To sync anyway (one-time): code-insights sync --force-remote\n'));
  return;
}
```

Also add `forceRemote` to the `SyncOptions` interface:
```typescript
forceRemote?: boolean;
```

And add the flag to the sync command registration in `index.ts`:
```typescript
.option('--force-remote', 'Force sync even when data source is local')
```

**Step 2: Commit**

```bash
git add cli/src/commands/sync.ts cli/src/index.ts
git commit -m "feat(sync): add data source gate and --force-remote flag"
```

---

### Task 10.2: Update status command

**Files:**
- Modify: `cli/src/commands/status.ts`

**Step 1: Add data source preference to output**

Import `resolveDataSourcePreference` from `utils/config.ts`.

After the "Configuration" section (line 19), add:
```typescript
const preference = resolveDataSourcePreference();
console.log(chalk.gray(`    Data source: ${preference}`));
```

When `preference === 'local'`, skip the Firebase connection check and synced projects display. Show local cache info instead (check if `~/.code-insights/stats-cache.json` exists, show file size and last modified time).

When `preference === 'firebase'`, keep existing Firebase/sync sections.

Fix the `config.firebase.projectId` access (line 18) to use optional chaining: `config.firebase?.projectId`.

**Step 2: Commit**

```bash
git add cli/src/commands/status.ts
git commit -m "feat(status): show data source preference, conditional Firebase display"
```

---

### Task 10.3: Update install-hook command

**Files:**
- Modify: `cli/src/commands/install-hook.ts`

**Step 1: Add data source check**

Import `resolveDataSourcePreference` from `utils/config.ts`.

After the `isConfigured()` check (line 36-39), add:
```typescript
const preference = resolveDataSourcePreference();
if (preference === 'local') {
  console.log(chalk.yellow('\n  ⚠ Your data source is set to local. The auto-sync hook is only useful with Firebase.\n'));
  console.log(chalk.gray('  Your stats refresh automatically when you run `code-insights stats`.'));
  console.log(chalk.gray('  To install the hook anyway: code-insights install-hook --force'));
  console.log(chalk.gray('  To switch to Firebase: code-insights config set-source firebase\n'));
  if (!options.force) return;
}
```

Add `--force` option to the command registration in `index.ts`:
```typescript
.option('--force', 'Install hook even in local mode')
```

**Step 2: Commit**

```bash
git add cli/src/commands/install-hook.ts cli/src/index.ts
git commit -m "feat(install-hook): add local mode warning"
```

---

### Task 10.4: Update reset command

**Files:**
- Modify: `cli/src/commands/reset.ts`

**Step 1: Add data source guard**

Import `resolveDataSourcePreference` from `utils/config.ts`.

At the top of the action handler (after the warning message, before confirmation), add:
```typescript
const preference = resolveDataSourcePreference();
if (preference === 'local') {
  console.log(chalk.yellow('\n  ⚠ Your data source is set to local. Nothing to reset in Firestore.\n'));
  console.log(chalk.gray('  To clear the local stats cache:'));
  console.log(chalk.gray('    rm ~/.code-insights/stats-cache.json\n'));
  console.log(chalk.gray('  To switch to Firebase and reset: code-insights config set-source firebase'));
  console.log('');
  process.exit(0);
}
```

The existing `config.firebase` null check (added in Task 9.1) handles the case where Firebase is truly not configured.

**Step 2: Commit**

```bash
git add cli/src/commands/reset.ts
git commit -m "feat(reset): add local mode guard"
```

---

### Task 10.5: Final build and comprehensive smoke test

**Step 1: Build**

Run: `cd /home/srikanth/Workspace/code-insights/code-insights && pnpm build`

Must pass with zero errors.

**Step 2: Smoke tests**

Run each command and verify output format matches the UX design:

```bash
# Core stats commands (local mode)
node cli/dist/index.js stats --local
node cli/dist/index.js stats --local --period 30d
node cli/dist/index.js stats --local cost
node cli/dist/index.js stats --local today
node cli/dist/index.js stats --local models
node cli/dist/index.js stats --local projects

# Help
node cli/dist/index.js stats --help
node cli/dist/index.js stats cost --help

# Config command
node cli/dist/index.js config
node cli/dist/index.js config set-source local

# Error cases
node cli/dist/index.js stats --remote  # should error if no Firebase
node cli/dist/index.js stats --local --project nonexistent  # should show suggestions

# Existing commands with data source awareness
node cli/dist/index.js sync  # should warn about local mode
node cli/dist/index.js status  # should show data source preference
```

**Step 3: Commit any fixes**

```bash
git add -A
git commit -m "fix(stats): resolve smoke test issues"
```

**Step 4: Push and create PR**

```bash
git push -u origin feature/cli-stats-command
gh pr create --base main --title "feat: add CLI stats command suite with data source abstraction" --body "..."
```

---

## Summary of All Files

### New Files (18)

| File | Phase | Lines (est.) |
|------|-------|-------------|
| `commands/stats/data/types.ts` | 1 | 160 |
| `commands/stats/data/source.ts` | 1 | 50 |
| `commands/stats/data/firestore.ts` | 2 | 180 |
| `commands/stats/data/cache.ts` | 3 | 130 |
| `commands/stats/data/local.ts` | 3 | 150 |
| `commands/stats/data/aggregation.ts` | 4 | 250 |
| `commands/stats/render/colors.ts` | 5 | 60 |
| `commands/stats/render/format.ts` | 5 | 80 |
| `commands/stats/render/charts.ts` | 5 | 80 |
| `commands/stats/render/layout.ts` | 5 | 100 |
| `commands/stats/shared.ts` | 6 | 90 |
| `commands/stats/index.ts` | 6 | 40 |
| `commands/stats/actions/overview.ts` | 7 | 130 |
| `commands/stats/actions/cost.ts` | 7 | 120 |
| `commands/stats/actions/projects.ts` | 7 | 130 |
| `commands/stats/actions/today.ts` | 7 | 110 |
| `commands/stats/actions/models.ts` | 7 | 110 |
| `commands/config.ts` | 9 | 120 |

### Modified Files (9)

| File | Phase | Lines Changed |
|------|-------|--------------|
| `firebase/client.ts` | 2 | 1 (export getDb) + 4 (null guard) |
| `commands/sync.ts` | 6, 10 | ~50 (extract runSync + gate) |
| `index.ts` | 8, 9, 10 | ~8 (imports + addCommand) |
| `types.ts` | 9 | ~5 (DataSourcePreference, firebase optional) |
| `utils/config.ts` | 9 | ~30 (preference resolution) |
| `commands/init.ts` | 9 | ~60 (data source prompt) |
| `commands/status.ts` | 10 | ~15 (data source display) |
| `commands/install-hook.ts` | 10 | ~10 (local warning) |
| `commands/reset.ts` | 10 | ~10 (local guard) |
