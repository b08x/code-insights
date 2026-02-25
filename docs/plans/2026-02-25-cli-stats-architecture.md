# `code-insights stats` -- Technical Architecture

> **Author:** Technical Architect
> **Date:** 2026-02-25
> **Status:** Design -- Ready for Implementation
> **Companion doc:** `docs/stats-ux-design.md` (terminal output specification)

---

## Table of Contents

1. [Command Registration Architecture](#1-command-registration-architecture)
2. [File Structure](#2-file-structure)
3. [Data Source Abstraction Layer](#3-data-source-abstraction-layer)
4. [Firestore Data Source](#4-firestore-data-source)
5. [Local Data Source](#5-local-data-source)
6. [Local Cache Strategy](#6-local-cache-strategy)
7. [Data Aggregation Layer](#7-data-aggregation-layer)
8. [Auto-Sync Integration](#8-auto-sync-integration)
9. [Terminal Rendering Layer](#9-terminal-rendering-layer)
10. [Type Definitions](#10-type-definitions)
11. [Error Handling](#11-error-handling)
12. [Dependencies](#12-dependencies)
13. [Cross-Repo Impact Assessment](#13-cross-repo-impact-assessment)
14. [Implementation Plan](#14-implementation-plan)
15. [Data Source Preference and Config Schema](#15-data-source-preference-and-config-schema)
16. [Modified `init` Flow](#16-modified-init-flow)
17. [The `config` Command](#17-the-config-command)
18. [Impact on Existing Commands](#18-impact-on-existing-commands)
19. [Backward Compatibility for Existing Users](#19-backward-compatibility-for-existing-users)
20. [Future Extensibility](#20-future-extensibility)

---

## 1. Command Registration Architecture

### 1.1 Commander.js Subcommand Pattern

The `stats` command is registered as a parent `Command` object via `program.addCommand()` -- the same pattern used by the existing `reset` command. This approach lets the parent command have its own action handler (for `stats` with no subcommand) while also supporting named subcommands.

```typescript
// In index.ts
import { statsCommand } from './commands/stats/index.js';

program.addCommand(statsCommand);
```

```typescript
// In commands/stats/index.ts
import { Command } from 'commander';

export const statsCommand = new Command('stats')
  .description('View usage statistics and analytics')
  .addCommand(costCommand)
  .addCommand(projectsCommand)
  .addCommand(todayCommand)
  .addCommand(modelsCommand)
  .action(overviewAction);   // runs when `stats` is invoked with no subcommand
```

### 1.2 Shared Flags (DRY)

All five entry points (overview + 4 subcommands) share the same four flags. Rather than duplicating `.option()` calls, a helper function applies them to any `Command`:

```typescript
// In commands/stats/shared.ts

export interface StatsFlags {
  period: '7d' | '30d' | '90d' | 'all';
  project?: string;
  source?: string;
  noSync: boolean;
}

export function applySharedFlags(cmd: Command): Command {
  return cmd
    .option('-p, --period <period>', 'Time range: 7d, 30d, 90d, all', '7d')
    .option('--project <name>', 'Scope to a single project')
    .option('--source <tool>', 'Filter by source tool (claude-code, cursor, etc.)')
    .option('--no-sync', 'Skip auto-sync before displaying stats');
}
```

Each subcommand is wrapped:

```typescript
export const costCommand = applySharedFlags(
  new Command('cost')
    .description('Cost breakdown by project, model, and time period')
).action(costAction);
```

The parent `stats` command itself also gets the shared flags via the same helper before `.addCommand()` calls are chained.

### 1.3 Command Tree Diagram

```
code-insights
  |
  +-- stats              (overview action + shared flags)
  |     +-- cost         (cost action + shared flags)
  |     +-- projects     (projects action + shared flags)
  |     +-- today        (today action + shared flags)
  |     +-- models       (models action + shared flags)
  |
  +-- sync
  +-- status
  +-- init
  +-- connect
  +-- install-hook
  +-- uninstall-hook
  +-- reset
```

---

## 2. File Structure

Stats is complex enough to warrant its own directory under `commands/`. Each subcommand gets its own action file. Shared data fetching, aggregation logic, and rendering utilities are factored out. The data layer uses a **data source abstraction** that allows transparent switching between Firestore and local (disk-based) data sources.

```
cli/src/
  commands/
    stats/
      index.ts            # Command registration (statsCommand, subcommands, flag wiring)
      shared.ts           # StatsFlags type, applySharedFlags(), shared option parsing
      actions/
        overview.ts       # stats (no args) handler
        cost.ts           # stats cost handler
        projects.ts       # stats projects handler
        today.ts          # stats today handler
        models.ts         # stats models handler
      data/
        source.ts         # StatsDataSource interface + factory (resolveDataSource())
        firestore.ts      # FirestoreDataSource — Firestore implementation of StatsDataSource
        local.ts          # LocalDataSource — disk-based implementation of StatsDataSource
        cache.ts          # Local stats cache (read/write/invalidate ~/.code-insights/stats-cache.json)
        aggregation.ts    # Client-side computation (sparklines, rollups, model distributions)
        types.ts          # SessionRow, aggregated data types, StatsDataSource interface
      render/
        format.ts         # Number/duration/date formatting utilities
        charts.ts         # Sparkline and bar chart rendering
        layout.ts         # Terminal width detection, grid layout, section headers
        colors.ts         # Semantic color helpers (money, label, value, hint, etc.)
  firebase/
    client.ts             # EXISTING -- gains exported getDb()
  utils/
    pricing.ts            # EXISTING -- no changes needed
```

**Rationale for the split:**

- **`actions/`**: One file per subcommand keeps each action handler focused (100-150 lines each). Action handlers call `resolveDataSource()` to get a `StatsDataSource` and then pass `SessionRow[]` to aggregation. They never know which data source is active.
- **`data/source.ts`**: Defines the `StatsDataSource` interface and the factory function that selects the correct implementation based on config + flags. This is the key architectural seam.
- **`data/firestore.ts`**: Firestore implementation (was `queries.ts` in the original design). All Firestore-specific code is isolated here.
- **`data/local.ts`**: Local disk implementation. Uses the existing provider `discover()` + `parse()` pipeline with a local cache for performance.
- **`data/cache.ts`**: Manages the local stats cache (`~/.code-insights/stats-cache.json`). Handles cache reads, writes, invalidation by file modification time, and cache warming.
- **`data/aggregation.ts`**: All aggregation and in-memory computation. Pure functions over `SessionRow[]` -- completely data-source-agnostic.
- **`render/`**: All terminal output logic is isolated. A future `--json` flag could swap renderers without touching data logic.

---

## 3. Data Source Abstraction Layer

### 3.1 Motivation

The stats command's three-layer architecture (data -> aggregation -> render) already ensures the aggregation and rendering layers only see `SessionRow[]`. This section formalizes that boundary by defining a `StatsDataSource` interface that both Firestore and local implementations satisfy.

**Why now, not later:**
- The founder is actively considering removing Firebase from the CLI entirely, making it a local-only tool. Users don't understand Firebase's advantages, and the cost factor is a barrier to adoption.
- By abstracting the data source now, we avoid a costly retrofit later. The aggregation and rendering layers will NEVER need to change when switching data sources.
- The local data source enables `stats` to work immediately after install, with zero configuration. This dramatically improves the first-run experience.

### 3.2 `StatsDataSource` Interface

```typescript
// In commands/stats/data/types.ts

export interface StatsDataSource {
  /** Human-readable name for diagnostics: 'firestore' | 'local' */
  readonly name: string;

  /**
   * Fetch sessions matching the given filters.
   * Returns SessionRow[] — the universal currency of the stats pipeline.
   * Both implementations must produce identical SessionRow shapes.
   */
  getSessions(opts: SessionQueryOptions): Promise<SessionRow[]>;

  /**
   * Fetch all-time aggregate usage stats.
   * Returns null if aggregate data is unavailable (e.g., local source computes on the fly).
   * The caller (aggregation layer) handles null by falling back to computing from SessionRow[].
   */
  getUsageStats(): Promise<UsageStatsDoc | null>;

  /**
   * Resolve a project name (from --project flag) to a project ID.
   * Returns the matching project, or throws ProjectNotFoundError with suggestions.
   */
  resolveProjectId(name: string): Promise<ProjectResolution>;

  /**
   * Fetch the most recent session (for empty-state messages).
   */
  getLastSession(): Promise<SessionRow | null>;

  /**
   * Perform pre-query setup (e.g., auto-sync for Firestore, cache refresh for local).
   * Called once before any queries. Returns metadata about what happened.
   */
  prepare(flags: StatsFlags): Promise<PrepareResult>;
}

export interface PrepareResult {
  /** Message to display (e.g., "Synced 3 new sessions", "Parsed 12 new files") */
  message: string;
  /** Whether anything changed since last invocation */
  dataChanged: boolean;
}
```

### 3.3 Data Source Factory

```typescript
// In commands/stats/data/source.ts

import { StatsDataSource, StatsFlags } from './types.js';
import { FirestoreDataSource } from './firestore.js';
import { LocalDataSource } from './local.js';
import { loadConfig } from '../../../utils/config.js';
import { resolveDataSourcePreference } from '../../../utils/config.js';

/**
 * Resolve which data source to use based on config, dataSource preference, and flags.
 *
 * Priority (highest to lowest):
 * 1. --local flag           -> always LocalDataSource (even if Firebase is configured)
 * 2. --remote flag          -> always FirestoreDataSource (error if not configured)
 * 3. config.dataSource === 'local'    -> LocalDataSource
 * 4. config.dataSource === 'firebase' -> FirestoreDataSource
 * 5. No config at all       -> LocalDataSource (zero-config first run)
 *
 * See Section 15 for the dataSource config field and backward compatibility rules.
 */
export function resolveDataSource(flags: StatsFlags): StatsDataSource {
  if (flags.local) {
    return new LocalDataSource();
  }

  if (flags.remote) {
    const config = loadConfig();
    if (!config) {
      throw new ConfigNotFoundError(
        'Firebase not configured. Run `code-insights init` first, or use `stats --local` for local-only stats.'
      );
    }
    return new FirestoreDataSource(config);
  }

  // Use the dataSource preference from config (with backward-compatible inference)
  const preference = resolveDataSourcePreference();

  if (preference === 'firebase') {
    const config = loadConfig();
    if (config) {
      return new FirestoreDataSource(config);
    }
    // Config was expected but missing (shouldn't happen if resolveDataSourcePreference is correct)
    return new LocalDataSource();
  }

  return new LocalDataSource();
}
```

### 3.4 Updated Shared Flags

The `StatsFlags` type gains two new flags:

```typescript
export interface StatsFlags {
  period: '7d' | '30d' | '90d' | 'all';
  project?: string;
  source?: string;
  noSync: boolean;
  local: boolean;      // NEW: --local flag
  remote: boolean;     // NEW: --remote flag
}

export function applySharedFlags(cmd: Command): Command {
  return cmd
    .option('-p, --period <period>', 'Time range: 7d, 30d, 90d, all', '7d')
    .option('--project <name>', 'Scope to a single project')
    .option('--source <tool>', 'Filter by source tool (claude-code, cursor, etc.)')
    .option('--no-sync', 'Skip auto-sync before displaying stats')
    .option('--local', 'Use local session files (no Firebase required)')
    .option('--remote', 'Force Firestore data source (requires Firebase config)');
}
```

### 3.5 Action Handler Pattern (Updated)

Every action handler now uses the data source abstraction instead of calling Firestore directly:

```typescript
// In actions/overview.ts (and all other action handlers)

export async function overviewAction(flags: StatsFlags): Promise<void> {
  // Step 1: Resolve data source (Firestore or local — handler doesn't care which)
  const source = resolveDataSource(flags);

  // Step 2: Prepare (auto-sync for Firestore, cache refresh for local)
  const spinner = ora('').start();
  const prepResult = await source.prepare(flags);
  spinner.succeed(prepResult.message);

  // Step 3: Resolve project filter if specified
  let projectId: string | undefined;
  if (flags.project) {
    const resolved = await source.resolveProjectId(flags.project);
    projectId = resolved.projectId;
  }

  // Step 4: Query data (identical call regardless of source)
  const sessions = await source.getSessions({
    periodStart: periodStartDate(flags.period),
    projectId,
    sourceTool: flags.source,
  });

  // Step 5: Aggregate (pure functions, source-agnostic)
  const overview = computeOverview(sessions, projects, flags.period);

  // Step 6: Render (pure functions, source-agnostic)
  renderOverview(overview, flags.period);
}
```

**The critical invariant:** Steps 5 and 6 are IDENTICAL regardless of data source. The `computeOverview()` and `renderOverview()` functions never change when switching between Firestore and local.

### 3.6 Architecture Diagram (Updated)

```
User runs: code-insights stats cost --period 30d

  |
  v
shared.ts :: resolveDataSource(flags)
  |
  |-- --local flag?                    ──yes──> LocalDataSource
  |-- --remote flag?                   ──yes──> FirestoreDataSource (error if no config)
  |-- config.dataSource === 'local'?   ──yes──> LocalDataSource
  |-- config.dataSource === 'firebase'?──yes──> FirestoreDataSource
  |-- No config at all?                ──────> LocalDataSource (zero-config)
  |
  v
StatsDataSource.prepare()          // auto-sync or cache refresh
  |
  v
StatsDataSource.getSessions()      // returns SessionRow[] (same shape from both)
  |
  v
aggregation.ts                     // UNCHANGED — pure functions over SessionRow[]
  |
  v
render/*.ts                        // UNCHANGED — pure functions over aggregated types
  |
  v
stdout
```

---

## 4. Firestore Data Source

### 4.1 Data Flow

The `FirestoreDataSource` implements the `StatsDataSource` interface by querying the user's Firestore database. This is the data source used when Firebase is configured (the current default behavior).

```
                                 +-- firestore.ts ---+
                                 |                    |
  StatsDataSource.getSessions -> | Firestore queries  | --> raw docs --> SessionRow[]
                                 +--------------------+
                                          |
                                          v
                                 +-- aggregation.ts --+
                                 |                    |
                                 | Client-side math   | --> typed aggregates
                                 +--------------------+
                                          |
                                          v
                                 +-- render/*.ts -----+
                                 |                    |
                                 | Terminal output     | --> stdout
                                 +--------------------+
```

### 4.2 Existing Reusable Functions

| Function | File | What it does | Reuse plan |
|---|---|---|---|
| `initializeFirebase(config)` | `firebase/client.ts` | Initializes Admin SDK | Reuse directly -- called in auto-sync and query phase |
| `getProjects()` | `firebase/client.ts` | `projects` ordered by `lastActivity DESC` | Reuse for project list + name-to-ID resolution |
| `getRecentSessions(limit)` | `firebase/client.ts` | Sessions ordered by `endedAt DESC` | NOT reused -- it returns `ParsedSession` with empty messages array, but lacks filter support. We need a new function. |
| `recalculateUsageStats()` | `firebase/client.ts` | Reads all sessions with usage data | NOT reused directly -- but its pattern (iterating all sessions, per-project aggregation) is the template for the stats aggregation layer |

### 4.3 New Query Functions (in `commands/stats/data/firestore.ts`)

All query functions live in `firestore.ts` (renamed from `queries.ts` to clarify it is one implementation of the `StatsDataSource` interface). They are NOT added to `firebase/client.ts` because they serve a different purpose (read-only analytics vs sync operations). However, since `getDb()` is private to `firebase/client.ts`, we need to either:

**Option A (Recommended):** Export `getDb()` from `firebase/client.ts`.

This is a one-line change (`export function getDb()`) and avoids duplicating Firebase initialization logic. The function already throws if Firebase is not initialized, which is the correct behavior for stats queries.

**Option B:** Pass the `Firestore` instance from the action handler down to query functions.

This is cleaner from a dependency injection perspective but adds plumbing. Since the CLI is not a library, Option A is pragmatic.

#### 4.3.1 `getSessionsInPeriod()`

The workhorse query. Used by every subcommand.

```typescript
export interface SessionQueryOptions {
  periodStart?: Date;          // null = all time
  projectId?: string;          // from resolveProjectId()
  sourceTool?: string;         // 'claude-code', 'cursor', etc.
}

export interface SessionRow {
  id: string;
  projectId: string;
  projectName: string;
  startedAt: Date;
  endedAt: Date;
  messageCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  estimatedCostUsd?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  primaryModel?: string;
  modelsUsed?: string[];
  generatedTitle?: string;
  customTitle?: string;
  summary?: string;
  sessionCharacter?: string;
  sourceTool?: string;
  usageSource?: string;
}
```

**Firestore queries by filter combination:**

| Filters applied | Firestore query | Index required |
|---|---|---|
| Period only | `.where('startedAt', '>=', periodStart).orderBy('startedAt', 'desc')` | `startedAt DESC` (single-field, auto-created) |
| Period + project | `.where('projectId', '==', pid).where('startedAt', '>=', periodStart).orderBy('startedAt', 'desc')` | **Composite: `(projectId ASC, startedAt DESC)`** |
| Period + source | `.where('sourceTool', '==', tool).where('startedAt', '>=', periodStart).orderBy('startedAt', 'desc')` | **Composite: `(sourceTool ASC, startedAt DESC)`** |
| Period + project + source | `.where('projectId', '==', pid).where('sourceTool', '==', tool).where('startedAt', '>=', periodStart).orderBy('startedAt', 'desc')` | **Composite: `(projectId ASC, sourceTool ASC, startedAt DESC)`** |
| All time (no period) | `.orderBy('startedAt', 'desc')` | Single-field auto-index |
| All time + project | `.where('projectId', '==', pid).orderBy('startedAt', 'desc')` | Composite: `(projectId ASC, startedAt DESC)` (same as above) |

**Implementation strategy for filter combinations:**

Rather than building a complex conditional query builder, use a straightforward approach: start with a base query on the `sessions` collection, then conditionally chain `.where()` calls. Firestore Admin SDK supports this fluent pattern.

```typescript
export async function getSessionsInPeriod(opts: SessionQueryOptions): Promise<SessionRow[]> {
  const firestore = getDb();
  let query: admin.firestore.Query = firestore.collection('sessions');

  if (opts.projectId) {
    query = query.where('projectId', '==', opts.projectId);
  }
  if (opts.sourceTool) {
    query = query.where('sourceTool', '==', opts.sourceTool);
  }
  if (opts.periodStart) {
    query = query.where('startedAt', '>=', admin.firestore.Timestamp.fromDate(opts.periodStart));
  }

  query = query.orderBy('startedAt', 'desc');

  const snapshot = await query.get();
  return snapshot.docs.map(docToSessionRow);
}
```

#### 4.3.2 `getUsageStats()`

Reads the `stats/usage` aggregate document. This is a single document read (1 Firestore read operation).

```typescript
export interface UsageStatsDoc {
  totalInputTokens: number;
  totalOutputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  sessionsWithUsage: number;
  lastUpdatedAt: Date;
}

export async function getUsageStats(): Promise<UsageStatsDoc | null> {
  const firestore = getDb();
  const doc = await firestore.collection('stats').doc('usage').get();
  if (!doc.exists) return null;
  const data = doc.data()!;
  return {
    totalInputTokens: data.totalInputTokens ?? 0,
    totalOutputTokens: data.totalOutputTokens ?? 0,
    cacheCreationTokens: data.cacheCreationTokens ?? 0,
    cacheReadTokens: data.cacheReadTokens ?? 0,
    estimatedCostUsd: data.estimatedCostUsd ?? 0,
    sessionsWithUsage: data.sessionsWithUsage ?? 0,
    lastUpdatedAt: data.lastUpdatedAt?.toDate() ?? new Date(),
  };
}
```

**When to use `stats/usage` vs querying sessions:**

| Scenario | Data source | Why |
|---|---|---|
| `stats` overview, period=`all` | `stats/usage` doc for totals, then sessions query for sparkline/recent activity | 1 read for totals vs scanning all sessions |
| `stats` overview, period=`7d/30d/90d` | Sessions query only | Cannot use aggregate doc (it has no time partitioning) |
| `stats cost`, any period | Sessions query | Need per-session breakdown for model/project grouping |
| `stats projects`, any period | Sessions query + `getProjects()` | Need per-project grouping from session data |
| `stats today` | Sessions query (today only) | Small result set, need full session details |
| `stats models`, any period | Sessions query | Need per-model aggregation from session-level data |

**Design decision:** The `stats/usage` aggregate doc is only useful for the all-time overview hero numbers. For any filtered or grouped view, we must query the sessions collection directly. This is acceptable because:
- Most users will have < 1,000 sessions (< 1,000 reads)
- Firestore pricing is $0.06 per 100K reads
- Even 5,000 sessions = $0.003 per `stats` invocation

#### 4.3.3 `resolveProjectId()`

Converts a `--project <name>` flag value to a Firestore project ID. Uses the existing `getProjects()` function.

```typescript
export interface ProjectResolution {
  projectId: string;
  projectName: string;
}

export async function resolveProjectId(name: string): Promise<ProjectResolution> {
  const projects = await getProjects();

  // Exact match (case-insensitive)
  const exact = projects.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (exact) {
    return { projectId: exact.id, projectName: exact.name };
  }

  // Substring match
  const substring = projects.filter(p =>
    p.name.toLowerCase().includes(name.toLowerCase())
  );
  if (substring.length === 1) {
    return { projectId: substring[0].id, projectName: substring[0].name };
  }

  // No match -- throw with suggestions
  const suggestions = findSimilarNames(name, projects.map(p => p.name));
  throw new ProjectNotFoundError(name, projects, suggestions);
}
```

This function does NOT add a new Firestore query -- it reuses the existing `getProjects()` (which fetches all projects ordered by lastActivity). Since project count is typically < 20, this is efficient.

#### 4.3.4 `getLastSession()`

Used for empty-state messages ("Last session: Feb 18 in code-insights").

```typescript
export async function getLastSession(): Promise<SessionRow | null> {
  const firestore = getDb();
  const snapshot = await firestore
    .collection('sessions')
    .orderBy('startedAt', 'desc')
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  return docToSessionRow(snapshot.docs[0]);
}
```

Cost: 1 Firestore read.

### 4.4 Composite Index Requirements

The following composite indexes are needed. These must be created in the user's Firebase project.

| Collection | Fields | Order | Status |
|---|---|---|---|
| `sessions` | `projectId`, `startedAt` | ASC, DESC | **NEW -- required** |
| `sessions` | `sourceTool`, `startedAt` | ASC, DESC | **NEW -- required** |
| `sessions` | `projectId`, `sourceTool`, `startedAt` | ASC, ASC, DESC | **NEW -- required only for triple filter** |

**Index creation strategy:**

Firestore returns a URL for index creation when a query requires a missing index. The implementation must catch `FAILED_PRECONDITION` errors and extract the index creation URL. This is the same pattern already established in the web dashboard (see `src/lib/hooks/useFirestore.ts` in the web repo).

```typescript
try {
  const sessions = await getSessionsInPeriod(opts);
} catch (error: unknown) {
  if (isFirestoreIndexError(error)) {
    const url = extractIndexUrl(error);
    console.error(chalk.red('\n  Missing Firestore index.'));
    console.error(chalk.yellow(`  Create it here: ${url}\n`));
    process.exit(1);
  }
  throw error;
}
```

**Practical note on the triple-filter index:** The combination of `--project` and `--source` together is an edge case. If we want to avoid requiring a third composite index, we can apply `sourceTool` filtering client-side when `--project` is also specified. The dataset per-project is small enough that this adds negligible overhead. This is the recommended approach.

**Revised index requirements (practical minimum):**

| Collection | Fields | Order | Required for |
|---|---|---|---|
| `sessions` | `projectId`, `startedAt` | ASC, DESC | `--project` flag |
| `sessions` | `sourceTool`, `startedAt` | ASC, DESC | `--source` flag |

The triple-filter case (`--project` + `--source`) uses the `projectId + startedAt` index and filters `sourceTool` client-side.

### 4.5 Query Cost Estimation

| Subcommand | Typical reads | Breakdown |
|---|---|---|
| `stats` (7d) | ~50-100 | sessions in 7d + getProjects() |
| `stats` (all) | 1 + ~20 + ~50 | stats/usage doc + projects + last 50 sessions for sparkline |
| `stats cost` | ~50-200 | sessions in period |
| `stats projects` | ~50-200 + ~20 | sessions in period + projects |
| `stats today` | ~5-20 | today's sessions only |
| `stats models` | ~50-200 | sessions in period |

At Firestore's pricing ($0.06 / 100K reads), running `stats` 100 times/day with 200 sessions each = 20K reads/day = $0.012/day. Negligible.

### 4.6 Document-to-Row Mapping

```typescript
function docToSessionRow(doc: admin.firestore.DocumentSnapshot): SessionRow {
  const data = doc.data()!;
  return {
    id: doc.id,
    projectId: data.projectId,
    projectName: data.projectName,
    startedAt: data.startedAt?.toDate() ?? new Date(),
    endedAt: data.endedAt?.toDate() ?? new Date(),
    messageCount: data.messageCount ?? 0,
    userMessageCount: data.userMessageCount ?? 0,
    assistantMessageCount: data.assistantMessageCount ?? 0,
    toolCallCount: data.toolCallCount ?? 0,
    estimatedCostUsd: data.estimatedCostUsd,       // intentionally undefined if absent
    totalInputTokens: data.totalInputTokens,
    totalOutputTokens: data.totalOutputTokens,
    cacheCreationTokens: data.cacheCreationTokens,
    cacheReadTokens: data.cacheReadTokens,
    primaryModel: data.primaryModel,
    modelsUsed: data.modelsUsed,
    generatedTitle: data.generatedTitle,
    customTitle: data.customTitle,
    summary: data.summary,
    sessionCharacter: data.sessionCharacter,
    sourceTool: data.sourceTool,
    usageSource: data.usageSource,
  };
}
```

### 4.7 `FirestoreDataSource` Class

The `FirestoreDataSource` wraps all the query functions above behind the `StatsDataSource` interface:

```typescript
// In commands/stats/data/firestore.ts

export class FirestoreDataSource implements StatsDataSource {
  readonly name = 'firestore';

  constructor(private config: ClaudeInsightConfig) {}

  async prepare(flags: StatsFlags): Promise<PrepareResult> {
    // 1. Initialize Firebase
    initializeFirebase(this.config);

    // 2. Auto-sync (unless --no-sync)
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
  }

  async getSessions(opts: SessionQueryOptions): Promise<SessionRow[]> {
    return getSessionsInPeriod(opts);   // existing query function
  }

  async getUsageStats(): Promise<UsageStatsDoc | null> {
    return getUsageStatsDoc();          // existing query function
  }

  async resolveProjectId(name: string): Promise<ProjectResolution> {
    return resolveProjectByName(name);  // existing resolution function
  }

  async getLastSession(): Promise<SessionRow | null> {
    return getLastSessionRow();         // existing query function
  }
}
```

The internal query functions (`getSessionsInPeriod`, `getUsageStatsDoc`, etc.) remain as private module functions within `firestore.ts`. The class is a thin adapter that satisfies the interface contract.

---

## 5. Local Data Source

### 5.1 Overview

The `LocalDataSource` reads sessions directly from disk using the existing provider infrastructure (`providers/registry.ts`, `providers/claude-code.ts`, etc.). It transforms `ParsedSession` objects into `SessionRow[]` -- the same shape produced by `FirestoreDataSource` -- so the aggregation and rendering layers are completely unaffected.

### 5.2 Data Flow

```
LocalDataSource.getSessions()
  |
  |-- 1. Check local cache (~/.code-insights/stats-cache.json)
  |       |-- Cache hit (file not modified) -> return cached SessionRow
  |       |-- Cache miss (new/modified file) -> parse file
  |
  |-- 2. For cache misses: provider.discover() + provider.parse()
  |       |-- ClaudeCodeProvider.discover() -> JSONL file paths
  |       |-- CursorProvider.discover()     -> SQLite virtual paths
  |       |-- CodexProvider.discover()      -> JSONL file paths
  |       |-- CopilotCliProvider.discover() -> JSONL file paths
  |
  |-- 3. Transform ParsedSession -> SessionRow (+ generate projectId)
  |
  |-- 4. Update cache with newly parsed sessions
  |
  |-- 5. Apply filters (period, project, source) in-memory
  |
  +-- Return SessionRow[]
```

### 5.3 `ParsedSession` to `SessionRow` Transformation

The key challenge: `SessionRow` expects a `projectId` field (a hash), but `ParsedSession` only has `projectPath` and `projectName`. The local data source must compute `projectId` using the same algorithm that `sync.ts` uses: `generateStableProjectId()` from `utils/device.ts`.

```typescript
// In commands/stats/data/local.ts

import { generateStableProjectId } from '../../../utils/device.js';

function parsedSessionToRow(session: ParsedSession): SessionRow {
  const { projectId } = generateStableProjectId(session.projectPath);

  return {
    id: session.id,
    projectId,
    projectName: session.projectName,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    messageCount: session.messageCount,
    userMessageCount: session.userMessageCount,
    assistantMessageCount: session.assistantMessageCount,
    toolCallCount: session.toolCallCount,
    // Cost/token data — available from Claude Code and Codex, absent from Cursor/Copilot
    estimatedCostUsd: session.usage?.estimatedCostUsd,
    totalInputTokens: session.usage?.totalInputTokens,
    totalOutputTokens: session.usage?.totalOutputTokens,
    cacheCreationTokens: session.usage?.cacheCreationTokens,
    cacheReadTokens: session.usage?.cacheReadTokens,
    primaryModel: session.usage?.primaryModel,
    modelsUsed: session.usage?.modelsUsed,
    generatedTitle: session.generatedTitle ?? undefined,
    customTitle: session.customTitle,
    summary: session.summary ?? undefined,
    sessionCharacter: session.sessionCharacter ?? undefined,
    sourceTool: session.sourceTool,
    usageSource: session.usage?.usageSource,
  };
}
```

**Important:** `generateStableProjectId()` calls `git remote get-url origin` which spawns a child process. For performance, the local data source should compute this once per unique `projectPath` and cache the result in-memory during a single `stats` invocation.

### 5.4 `LocalDataSource` Class

```typescript
// In commands/stats/data/local.ts

export class LocalDataSource implements StatsDataSource {
  readonly name = 'local';

  private cache: StatsCache;
  private projectIdCache = new Map<string, string>();  // projectPath -> projectId

  constructor() {
    this.cache = new StatsCache();
  }

  async prepare(flags: StatsFlags): Promise<PrepareResult> {
    const result = await this.cache.refresh();
    if (result.newSessions > 0) {
      return {
        message: `Parsed ${result.newSessions} new sessions (${result.totalSessions} total)`,
        dataChanged: true,
      };
    }
    return {
      message: `${result.totalSessions} sessions cached`,
      dataChanged: false,
    };
  }

  async getSessions(opts: SessionQueryOptions): Promise<SessionRow[]> {
    let rows = this.cache.getAllRows();

    // Apply filters in-memory
    if (opts.periodStart) {
      rows = rows.filter(r => r.startedAt >= opts.periodStart!);
    }
    if (opts.projectId) {
      rows = rows.filter(r => r.projectId === opts.projectId);
    }
    if (opts.sourceTool) {
      rows = rows.filter(r => r.sourceTool === opts.sourceTool);
    }

    // Sort by startedAt descending (same order as Firestore query)
    rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

    return rows;
  }

  async getUsageStats(): Promise<UsageStatsDoc | null> {
    // Local source has no pre-computed aggregate doc.
    // Return null — the aggregation layer will compute totals from SessionRow[].
    return null;
  }

  async resolveProjectId(name: string): Promise<ProjectResolution> {
    const rows = this.cache.getAllRows();

    // Build unique project list from cached rows
    const projects = new Map<string, { id: string; name: string }>();
    for (const row of rows) {
      if (!projects.has(row.projectId)) {
        projects.set(row.projectId, { id: row.projectId, name: row.projectName });
      }
    }

    const projectList = [...projects.values()];

    // Exact match (case-insensitive)
    const exact = projectList.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (exact) return { projectId: exact.id, projectName: exact.name };

    // Substring match
    const substring = projectList.filter(p =>
      p.name.toLowerCase().includes(name.toLowerCase())
    );
    if (substring.length === 1) {
      return { projectId: substring[0].id, projectName: substring[0].name };
    }

    // No match
    const suggestions = findSimilarNames(name, projectList.map(p => p.name));
    throw new ProjectNotFoundError(name, projectList, suggestions);
  }

  async getLastSession(): Promise<SessionRow | null> {
    const rows = this.cache.getAllRows();
    if (rows.length === 0) return null;
    return rows.reduce((latest, row) =>
      row.startedAt > latest.startedAt ? row : latest
    );
  }
}
```

### 5.5 Provider Coverage and Data Availability

| Provider | Token data | Cost data | Session character | Title generation |
|---|---|---|---|---|
| Claude Code | Full (from JSONL `usage` blocks) | Full (via `pricing.ts`) | Yes | Yes |
| Codex CLI | Partial (input/output tokens, cached tokens) | No (pricing not public) | Yes | Yes |
| Cursor | None (SQLite has no token data) | None | Yes | Yes |
| Copilot CLI | None (events.jsonl has no usage data) | None | Yes | Yes |

**Implication for `stats cost`:** When using the local data source, cost data is only available for Claude Code sessions (and partially for Codex). The rendering layer already handles `estimatedCostUsd: undefined` gracefully by showing "N/A" or excluding from cost totals. No changes needed.

### 5.6 Project ID Consistency

A critical invariant: the local data source must generate the **same `projectId`** that `sync.ts` would produce for the same session. This is guaranteed because both use `generateStableProjectId()` from `utils/device.ts`.

This means:
- If a user switches from Firestore to local mode, `--project my-app` still resolves to the same project.
- If a user has both Firebase and local data, project IDs are consistent.

The only exception: Firestore stores projects that were synced from **other devices**. The local data source only sees sessions from the current device. This is a known and acceptable limitation -- `--local` is explicitly "this machine only."

---

## 6. Local Cache Strategy

### 6.1 Problem Statement

Parsing all session files from disk on every `stats` invocation is too slow. A typical user might have 100+ Claude Code JSONL files, plus Cursor SQLite databases, each requiring full file reads and JSON parsing. Without caching, a single `stats` command could take 10-30 seconds.

### 6.2 Cache Location and Format

```
~/.code-insights/stats-cache.json
```

**Why JSON, not SQLite:**
- The cache stores `SessionRow[]` -- a flat array of objects. No relational queries needed.
- JSON is human-readable and debuggable (users can inspect `stats-cache.json` to verify data).
- No additional dependency (better-sqlite3 is already used by the Cursor provider, but adding it as a required dependency for cache would be heavy).
- The cache file is expected to be < 1MB even for power users (1,000 sessions at ~500 bytes each = ~500KB).
- Read/write is a single `fs.readFileSync()` / `fs.writeFileSync()` -- no connection management.

**Why not the existing `sync-state.json`:**
- `sync-state.json` tracks which files have been synced to Firestore. It does not store parsed session data.
- The stats cache is a separate concern: it stores pre-computed `SessionRow[]` for fast stats rendering.
- Using separate files avoids coupling the sync and stats features.

### 6.3 Cache Schema

```typescript
// In commands/stats/data/cache.ts

interface StatsCacheFile {
  /** Cache format version — bump to invalidate all caches */
  version: 1;

  /** ISO timestamp of last cache refresh */
  lastRefresh: string;

  /** Map from source file path to cached data */
  entries: Record<string, StatsCacheEntry>;
}

interface StatsCacheEntry {
  /** File modification time (ISO string) — used for invalidation */
  lastModified: string;

  /** Provider that produced this entry */
  provider: string;

  /** Pre-computed SessionRow(s) from this file */
  rows: SessionRow[];
}
```

**Key design choices:**
- Keyed by **source file path** (the same key used in `sync-state.json`). This means the cache tracks the same files that `discover()` returns.
- For multi-session files (Cursor SQLite), a single cache entry may contain multiple `SessionRow` objects.
- `lastModified` is compared against `fs.statSync(path).mtime` for cache invalidation.

### 6.4 Cache Invalidation Strategy

```typescript
// In commands/stats/data/cache.ts

export class StatsCache {
  private data: StatsCacheFile;
  private dirty = false;

  constructor() {
    this.data = this.load();
  }

  /**
   * Refresh the cache by scanning all providers.
   * Only re-parses files that are new or modified since last cache.
   */
  async refresh(): Promise<{ newSessions: number; totalSessions: number }> {
    const providers = getAllProviders();
    let newSessions = 0;

    // Track which file paths are still valid (for pruning deleted files)
    const currentPaths = new Set<string>();

    for (const provider of providers) {
      const files = await provider.discover();

      for (const filePath of files) {
        const { realPath } = splitVirtualPath(filePath);
        currentPaths.add(filePath);

        // Check if cached entry is still valid
        const cached = this.data.entries[filePath];
        if (cached) {
          try {
            const stat = fs.statSync(realPath);
            if (stat.mtime.toISOString() === cached.lastModified) {
              continue;  // Cache hit — skip parsing
            }
          } catch {
            // File no longer accessible — will be pruned below
            continue;
          }
        }

        // Cache miss — parse the file
        const session = await provider.parse(filePath);
        if (!session) continue;

        const row = parsedSessionToRow(session);
        const stat = fs.statSync(realPath);

        this.data.entries[filePath] = {
          lastModified: stat.mtime.toISOString(),
          provider: provider.getProviderName(),
          rows: [row],
        };

        newSessions++;
        this.dirty = true;
      }
    }

    // Prune entries for files that no longer exist
    for (const path of Object.keys(this.data.entries)) {
      if (!currentPaths.has(path)) {
        delete this.data.entries[path];
        this.dirty = true;
      }
    }

    // Persist if anything changed
    if (this.dirty) {
      this.save();
    }

    const totalSessions = this.getAllRows().length;
    return { newSessions, totalSessions };
  }

  /**
   * Get all cached SessionRows.
   */
  getAllRows(): SessionRow[] {
    const rows: SessionRow[] = [];
    for (const entry of Object.values(this.data.entries)) {
      // Deserialize Date objects (JSON stringifies Dates)
      for (const row of entry.rows) {
        rows.push({
          ...row,
          startedAt: new Date(row.startedAt),
          endedAt: new Date(row.endedAt),
        });
      }
    }
    return rows;
  }

  private load(): StatsCacheFile {
    try {
      const content = fs.readFileSync(CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(content) as StatsCacheFile;
      if (parsed.version !== 1) {
        return this.empty();  // Version mismatch — start fresh
      }
      return parsed;
    } catch {
      return this.empty();
    }
  }

  private save(): void {
    ensureConfigDir();
    this.data.lastRefresh = new Date().toISOString();
    fs.writeFileSync(CACHE_PATH, JSON.stringify(this.data, null, 2));
    this.dirty = false;
  }

  private empty(): StatsCacheFile {
    return { version: 1, lastRefresh: '', entries: {} };
  }
}

const CACHE_PATH = path.join(os.homedir(), '.code-insights', 'stats-cache.json');
```

### 6.5 Cache Performance Characteristics

| Scenario | Time (est.) | I/O operations |
|---|---|---|
| Cold cache (first run, 100 files) | 5-15s | 100 file reads + 1 cache write |
| Warm cache (nothing changed) | < 200ms | 100 `stat()` calls + 1 cache read |
| Warm cache (3 new files) | 0.5-2s | 100 `stat()` calls + 3 file reads + 1 cache write |
| Cache pruning (5 files deleted) | < 300ms | 100 `stat()` calls + 1 cache write |

The warm-cache case is the common path. 100 `stat()` calls complete in < 50ms on modern SSDs. The cache read itself is a single `fs.readFileSync()` of a < 1MB JSON file.

### 6.6 Cache Correctness Guarantees

1. **Deterministic:** The same set of files always produces the same `SessionRow[]`, regardless of cache state.
2. **Invalidation by mtime:** If a file is modified (e.g., an active Claude Code session appends to a JSONL file), the cache entry is invalidated and re-parsed.
3. **Pruning:** Deleted files are removed from the cache on the next refresh.
4. **Version migration:** Bumping `StatsCacheFile.version` forces a full re-parse. Use this when `SessionRow` shape changes.
5. **Atomic writes:** The cache is written as a single `fs.writeFileSync()` — no partial writes.

### 6.7 `--no-sync` Behavior with Local Source

When the local data source is active, `--no-sync` skips the `prepare()` step entirely (no discovery, no parsing, no cache refresh). It reads whatever is in the cache file from the last invocation. This is useful for rapid re-runs:

```bash
code-insights stats              # Full cache refresh + display
code-insights stats --no-sync    # Instant display from cached data
```

---

## 7. Data Aggregation Layer

> **This section is UNCHANGED from the original design.** The aggregation layer operates on `SessionRow[]` and never knows which data source produced them. This is the architectural payoff of the data source abstraction.

### 7.1 Architecture

All aggregation happens client-side after the data source query completes. This is a deliberate choice:
- Neither Firestore nor local files support server-side aggregation with sums/grouping.
- Session count per user is manageable (hundreds to low thousands).
- Aggregation logic is pure functions: easy to test, no side effects.

### 7.2 Aggregation Functions

Each function takes `SessionRow[]` (and optionally `Project[]`) and returns a typed aggregate.

#### 7.2.1 `computeOverview()`

```typescript
export function computeOverview(
  sessions: SessionRow[],
  projects: Project[],
  period: string,
): StatsOverview {
  const sessionsWithCost = sessions.filter(s => s.estimatedCostUsd !== undefined);

  return {
    sessionCount: sessions.length,
    totalCost: sum(sessionsWithCost, s => s.estimatedCostUsd!),
    totalTime: sum(sessions, s => diffMinutes(s.startedAt, s.endedAt)),
    messageCount: sum(sessions, s => s.messageCount),
    totalTokens: sum(sessionsWithCost, s =>
      (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0) +
      (s.cacheCreationTokens ?? 0) + (s.cacheReadTokens ?? 0)
    ),
    projectCount: projects.length,
    sessionsWithCostCount: sessionsWithCost.length,

    // Sparkline data
    activityByDay: groupByDay(sessions, period),

    // Quick stats
    todayStats: computeDayStats(sessions, today()),
    yesterdayStats: computeDayStats(sessions, yesterday()),
    weekStats: computeRangeStats(sessions, startOfWeek(), now()),

    // Top projects
    topProjects: computeTopProjects(sessions, 5),
  };
}
```

#### 7.2.2 `computeCostBreakdown()`

```typescript
export function computeCostBreakdown(
  sessions: SessionRow[],
  period: string,
): CostBreakdown {
  const withCost = sessions.filter(s => s.estimatedCostUsd !== undefined);

  return {
    totalCost: sum(withCost, s => s.estimatedCostUsd!),
    avgPerDay: /* totalCost / days in period */,
    avgPerSession: /* totalCost / withCost.length */,
    sessionCount: sessions.length,
    sessionsWithCostCount: withCost.length,

    dailyTrend: groupCostByDay(withCost, period),
    peakDay: findPeakDay(withCost),

    byProject: groupCostBy(withCost, s => s.projectName),
    byModel: groupCostBy(withCost, s => s.primaryModel ?? 'unknown'),

    tokenBreakdown: {
      inputTokens: sum(withCost, s => s.totalInputTokens ?? 0),
      outputTokens: sum(withCost, s => s.totalOutputTokens ?? 0),
      cacheCreation: sum(withCost, s => s.cacheCreationTokens ?? 0),
      cacheReads: sum(withCost, s => s.cacheReadTokens ?? 0),
      inputCost: /* computed from tokens * pricing */,
      outputCost: /* computed from tokens * pricing */,
      cacheCreationCost: /* computed */,
      cacheReadCost: /* computed */,
      cacheHitRate: /* cacheReads / (totalInput + cacheReads) */,
    },
  };
}
```

#### 7.2.3 `computeProjectStats()`

```typescript
export function computeProjectStats(
  sessions: SessionRow[],
  projects: Project[],
  period: string,
): ProjectStats[] {
  const byProject = groupBy(sessions, s => s.projectId);

  return projects
    .map(project => {
      const projectSessions = byProject.get(project.id) ?? [];
      const withCost = projectSessions.filter(s => s.estimatedCostUsd !== undefined);

      return {
        projectId: project.id,
        projectName: project.name,
        sessionCount: projectSessions.length,
        totalCost: sum(withCost, s => s.estimatedCostUsd!),
        totalTime: sum(projectSessions, s => diffMinutes(s.startedAt, s.endedAt)),
        messageCount: sum(projectSessions, s => s.messageCount),
        totalTokens: sum(withCost, s =>
          (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0)
        ),
        primaryModel: findMostFrequent(projectSessions.map(s => s.primaryModel).filter(Boolean)),
        lastActive: project.lastActivity,
        sourceTool: findMostFrequent(projectSessions.map(s => s.sourceTool).filter(Boolean)),
        activityByDay: groupByDay(projectSessions, period),
      };
    })
    .filter(p => p.sessionCount > 0)
    .sort((a, b) => b.sessionCount - a.sessionCount);
}
```

#### 7.2.4 `computeModelStats()`

```typescript
export function computeModelStats(
  sessions: SessionRow[],
  period: string,
): ModelStats[] {
  // Group by primaryModel
  const byModel = groupBy(
    sessions.filter(s => s.primaryModel),
    s => s.primaryModel!,
  );

  return [...byModel.entries()]
    .map(([model, modelSessions]) => {
      const withCost = modelSessions.filter(s => s.estimatedCostUsd !== undefined);
      return {
        model,
        displayName: shortenModelName(model),
        sessionCount: modelSessions.length,
        sessionPercent: modelSessions.length / sessions.length * 100,
        totalCost: sum(withCost, s => s.estimatedCostUsd!),
        costPercent: /* totalCost / globalTotalCost * 100 */,
        avgCostPerSession: /* totalCost / withCost.length */,
        totalTokens: sum(withCost, s =>
          (s.totalInputTokens ?? 0) + (s.totalOutputTokens ?? 0)
        ),
        inputCost: /* computed */,
        outputCost: /* computed */,
        cacheCost: /* computed */,
        trend: groupByDay(modelSessions, period),
      };
    })
    .sort((a, b) => b.totalCost - a.totalCost);
}
```

### 7.3 Sparkline Data Computation

Sparkline data is produced by `groupByDay()` which returns an array of `{ date: string, value: number }` objects.

```typescript
export interface TimeSeriesPoint {
  date: string;      // 'YYYY-MM-DD' for days, 'YYYY-Www' for weeks, 'YYYY-MM' for months
  value: number;     // session count (default), or cost, or tokens
}

export function groupByDay(
  sessions: SessionRow[],
  period: string,
  metric: 'sessions' | 'cost' | 'tokens' = 'sessions',
): TimeSeriesPoint[] {
  // 1. Determine bucket size and count from period
  //    7d  -> 7 daily buckets
  //    30d -> 4 weekly buckets (or 30 daily)
  //    90d -> 12 weekly buckets
  //    all -> 12 monthly buckets
  //
  // 2. Create empty buckets array for the full range
  //    This ensures days with zero sessions still appear as 0
  //
  // 3. Iterate sessions, place each into appropriate bucket
  //
  // 4. Return array (oldest first)

  const buckets = createBuckets(period);
  for (const session of sessions) {
    const key = bucketKey(session.startedAt, period);
    const bucket = buckets.get(key);
    if (bucket !== undefined) {
      if (metric === 'sessions') bucket.value++;
      else if (metric === 'cost') bucket.value += session.estimatedCostUsd ?? 0;
      else bucket.value += (session.totalInputTokens ?? 0) + (session.totalOutputTokens ?? 0);
    }
  }
  return [...buckets.values()];
}
```

**Gap-filling is critical.** Days with zero sessions must appear as `{ value: 0 }` in the array, otherwise sparklines misrepresent activity. The `createBuckets()` function pre-populates every bucket in the range.

### 7.4 Shared Utility Functions

```typescript
// Pure math helpers -- no Firestore dependency

function sum<T>(items: T[], fn: (item: T) => number): number;
function diffMinutes(start: Date, end: Date): number;
function groupBy<T, K>(items: T[], keyFn: (item: T) => K): Map<K, T[]>;
function findMostFrequent<T>(items: T[]): T | undefined;
function today(): Date;        // start of today (midnight local)
function yesterday(): Date;    // start of yesterday
function startOfWeek(): Date;  // start of current ISO week (Monday)
function periodStartDate(period: string): Date | undefined;  // undefined = all time
```

---

## 8. Auto-Sync Integration

> **Note:** Auto-sync only applies when the `FirestoreDataSource` is active. When using the `LocalDataSource`, the `prepare()` step handles cache refresh instead of syncing. The action handlers do not distinguish between these -- they call `source.prepare(flags)` uniformly.

### 8.1 Programmatic Sync Invocation

The auto-sync feature reuses the existing `syncCommand()` function from `commands/sync.ts`, invoked programmatically with the `quiet` flag to suppress its output:

```typescript
// In commands/stats/shared.ts

export async function autoSync(): Promise<{ synced: number; error: string | null }> {
  // The sync command already handles:
  // - Loading config (exits if not configured)
  // - Initializing Firebase
  // - Discovering and uploading new sessions
  // - Saving sync state
  //
  // We call it with quiet=true and capture results.

  try {
    await syncCommand({ quiet: true });
    return { synced: 0, error: null };  // sync output is suppressed
  } catch (error) {
    return { synced: 0, error: error instanceof Error ? error.message : 'Unknown sync error' };
  }
}
```

**Problem with this approach:** `syncCommand()` calls `process.exit(1)` on config errors, which would kill the stats process.

**Solution:** Extract the sync logic into a reusable function that does NOT call `process.exit()`. This requires a small refactor:

```typescript
// In commands/sync.ts -- new exported function

export async function runSync(options: SyncOptions = {}): Promise<SyncResult> {
  // Same logic as syncCommand() but:
  // 1. Returns SyncResult instead of void
  // 2. Throws on config errors instead of process.exit()
  // 3. Does NOT print summary (caller handles output)
}

export interface SyncResult {
  syncedCount: number;
  messageCount: number;
  errorCount: number;
}

// syncCommand() becomes a thin wrapper:
export async function syncCommand(options: SyncOptions = {}): Promise<void> {
  try {
    const result = await runSync(options);
    // print summary
  } catch (error) {
    // handle + process.exit
  }
}
```

**This refactor of `sync.ts` is the ONLY modification to an existing file** (besides the one-line `getDb()` export in `firebase/client.ts` and the import + registration in `index.ts`).

### 8.2 Auto-Sync Flow in Stats

```typescript
// In each action handler (data-source-agnostic):

export async function overviewAction(flags: StatsFlags): Promise<void> {
  // Step 1: Resolve data source (handles config detection, flag overrides)
  const source = resolveDataSource(flags);

  // Step 2: Prepare (auto-sync for Firestore, cache refresh for local)
  //         This replaces the old manual sync + Firebase init.
  if (!flags.noSync) {
    const spinner = ora('').start();
    try {
      const result = await source.prepare(flags);
      spinner.succeed(result.message);
    } catch {
      spinner.warn('Preparation failed (showing cached data)');
    }
  }

  // Step 3: Query data (same call for both Firestore and local)
  // Step 4: Aggregate (pure functions)
  // Step 5: Render (pure functions)
}
```

**Note:** The `FirestoreDataSource.prepare()` encapsulates `ensureConfig()`, `initializeFirebase()`, and `runSync()`. The `LocalDataSource.prepare()` encapsulates the cache refresh. Action handlers never call these directly.

### 8.3 Sync Failure Handling

| Failure mode | Behavior |
|---|---|
| Config not found | Exit with error: "Not configured. Run `code-insights init` first." |
| Firebase init fails | Exit with error: "Failed to connect to Firebase" |
| Sync finds no new files | `spinner.succeed('Up to date')` -- proceed to query |
| Sync encounters upload errors | `spinner.warn('Sync failed (showing cached data)')` -- proceed to query with stale data |
| `--no-sync` flag | Skip sync entirely, proceed directly to query |

### 8.4 Performance Considerations

Auto-sync adds 1-3 seconds of latency (filesystem scan + Firestore writes for new sessions). Mitigation:

1. **`--no-sync` flag** for repeat invocations within a session.
2. **Sync is incremental** -- only processes files modified since last sync (tracked in `sync-state.json`). If nothing changed, sync completes in < 500ms.
3. **Consider future optimization:** Run sync and Firestore reads in parallel. This is possible because sync writes to `sessions/messages` collections while stats reads from `sessions`. However, this optimization adds complexity and is NOT worth implementing in v1 -- serial execution is simpler and the latency is acceptable.

---

## 9. Terminal Rendering Layer

### 9.1 Architecture

The rendering layer is a set of pure functions that take aggregated data and return strings (or print directly to stdout). No Firestore or business logic.

```
render/
  colors.ts    # Semantic color functions
  format.ts    # Number/duration/date formatting
  charts.ts    # Sparkline + bar chart generators
  layout.ts    # Terminal width, grids, section headers, dividers
```

### 9.2 `render/colors.ts` -- Semantic Color Abstraction

```typescript
import chalk from 'chalk';

// Semantic wrappers -- change colors in one place
export const colors = {
  // Structural
  header:     (text: string) => chalk.cyan.bold(text),
  label:      (text: string) => chalk.gray(text),
  value:      (text: string) => chalk.white.bold(text),
  divider:    (width: number) => chalk.gray('─'.repeat(width)),
  hint:       (text: string) => chalk.gray.italic(`  → ${text}`),

  // Money
  money:      (amount: number) => {
    const formatted = `$${amount.toFixed(2)}`;
    if (amount >= 20) return chalk.red.bold(formatted);    // daily threshold
    if (amount >= 5) return chalk.yellow.bold(formatted);
    return chalk.green.bold(formatted);
  },
  moneyNeutral: (amount: number) => chalk.green.bold(`$${amount.toFixed(2)}`),

  // Data types
  project:    (name: string) => chalk.white(name),
  model:      (name: string) => chalk.magenta(name),
  source:     (name: string) => chalk.blue(name),
  timestamp:  (text: string) => chalk.gray(text),

  // States
  success:    (text: string) => chalk.green(text),
  warning:    (text: string) => chalk.yellow(text),
  error:      (text: string) => chalk.red(text),

  // Charts
  sparkChar:  (char: string) => chalk.cyan(char),
  barFilled:  (chars: string) => chalk.cyan(chars),
  barEmpty:   (chars: string) => chalk.gray(chars),

  // Session characters
  character: (char: string): string => {
    const map: Record<string, (s: string) => string> = {
      deep_focus:    chalk.blue,
      bug_hunt:      chalk.red,
      feature_build: chalk.green,
      exploration:   chalk.yellow,
      refactor:      chalk.magenta,
      learning:      chalk.cyan,
      quick_task:    chalk.gray,
    };
    const display = char.replace('_', ' ');
    return (map[char] ?? chalk.gray)(`[${display}]`);
  },
};
```

### 9.3 `render/format.ts` -- Numeric Formatting

```typescript
/** Format dollar amounts: $0.47, $12.30, $1,234.56 */
export function formatMoney(amount: number): string {
  if (amount >= 1000) {
    return '$' + amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return '$' + amount.toFixed(2);
}

/** Format token counts: 1.2M, 450K, 89K, 1,234 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return (count / 1_000_000).toFixed(1) + 'M';
  if (count >= 1_000) return Math.round(count / 1_000) + 'K';
  return count.toLocaleString();
}

/** Format duration from minutes: 23m, 1h 42m, 142h 30m */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/** Format relative date: 2h ago, yesterday, 3d ago, Feb 18 */
export function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffHours < 1) return `${Math.round(diffMs / 60000)}m ago`;
  if (diffHours < 24) return `${Math.round(diffHours)}h ago`;
  if (diffDays < 2) return 'yesterday';
  if (diffDays < 7) return `${Math.round(diffDays)}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Format time of day: 10:32 AM */
export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Format percentage: 67%, 12%, 3.2% */
export function formatPercent(value: number): string {
  if (value >= 10) return `${Math.round(value)}%`;
  return `${value.toFixed(1)}%`;
}

/** Format session count with commas: 47, 1,284 */
export function formatCount(count: number): string {
  return count.toLocaleString();
}
```

### 9.4 `render/charts.ts` -- Sparklines and Bar Charts

#### Sparkline Algorithm

```typescript
const SPARK_CHARS = ['▁', '▂', '▃', '▅', '▇'];

/**
 * Generate a sparkline string from a series of values.
 * Returns colored Unicode characters.
 *
 * Algorithm:
 * 1. Find max of series. If max === 0, all values map to SPARK_CHARS[0].
 * 2. For each value: index = Math.round((value / max) * 4)
 * 3. Zero values always map to SPARK_CHARS[0] (lowest bar, not blank).
 */
export function sparkline(values: number[]): string {
  const max = Math.max(...values);
  return values
    .map(v => {
      if (max === 0) return SPARK_CHARS[0];
      const idx = Math.round((v / max) * 4);
      return SPARK_CHARS[idx];
    })
    .map(char => colors.sparkChar(char))
    .join('');
}

/**
 * Generate day labels for sparklines.
 * Returns the label string matching the sparkline width.
 */
export function sparklineLabels(period: string): string {
  if (period === '7d') return 'M T W T F S S';
  if (period === '30d') return 'W1 W2 W3 W4';
  // 90d and all: abbreviated labels
  return ''; // computed dynamically
}
```

#### Bar Chart Algorithm

```typescript
/**
 * Render a horizontal bar chart for a set of labeled values.
 *
 * Algorithm:
 * 1. Find max value across all items.
 * 2. For each item: filledCount = Math.round((value / max) * barWidth)
 * 3. Remaining chars filled with empty block character.
 * 4. Labels right-aligned to longest label, truncated at 20 chars.
 *
 * Returns array of formatted lines (caller prints them).
 */
export function barChart(
  items: { label: string; value: number; suffix: string }[],
  barWidth: number,
): string[] {
  if (barWidth === 0 || items.length === 0) {
    // Narrow terminal: return simple list format
    return items.map(item =>
      `  ${colors.project(padEnd(item.label, 20))}  ${item.suffix}`
    );
  }

  const maxValue = Math.max(...items.map(i => i.value));
  const maxLabelLen = Math.min(20, Math.max(...items.map(i => i.label.length)));

  return items.map(item => {
    const label = item.label.length > 20
      ? item.label.slice(0, 17) + '...'
      : item.label;
    const paddedLabel = label.padEnd(maxLabelLen);

    const filled = maxValue === 0 ? 0 : Math.round((item.value / maxValue) * barWidth);
    const empty = barWidth - filled;

    const bar = colors.barFilled('\u2588'.repeat(filled))
              + colors.barEmpty('\u2591'.repeat(empty));

    return `  ${colors.project(paddedLabel)}  ${bar}  ${item.suffix}`;
  });
}
```

### 9.5 `render/layout.ts` -- Terminal Layout

```typescript
/**
 * Get terminal width, defaulting to 80.
 */
export function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

/**
 * Get bar chart width based on terminal size.
 */
export function getBarWidth(): number {
  const width = getTerminalWidth();
  if (width >= 100) return 20;
  if (width >= 80) return 16;
  if (width >= 60) return 12;
  return 0;
}

/**
 * Get metric grid column count.
 */
export function getGridColumns(): number {
  const width = getTerminalWidth();
  if (width >= 80) return 3;
  if (width >= 60) return 2;
  return 1;
}

/**
 * Render a section header: "  SECTION TITLE" with full-width divider.
 */
export function sectionHeader(title: string, rightText?: string): string {
  const width = getTerminalWidth() - 4;  // 2-char margin each side
  const header = colors.header(title.toUpperCase());
  const right = rightText ? colors.label(rightText) : '';

  // Right-align the optional text
  // Note: chalk strings have ANSI codes, so we pad using the raw text lengths
  const gap = width - title.length - (rightText?.length ?? 0);
  return `  ${header}${' '.repeat(Math.max(1, gap))}${right}\n  ${colors.divider(width)}`;
}

/**
 * Render a metric grid (3x2, 2x3, or 1x6 depending on terminal width).
 *
 * Each metric is { label: string, value: string }.
 */
export function metricGrid(metrics: { label: string; value: string }[]): string {
  const cols = getGridColumns();
  const colWidth = cols === 3 ? 22 : cols === 2 ? 30 : 40;
  const lines: string[] = [];

  for (let i = 0; i < metrics.length; i += cols) {
    const row = metrics.slice(i, i + cols);
    const formatted = row.map(m =>
      `${colors.label(m.label.padEnd(10))} ${m.value.padStart(colWidth - 12)}`
    );
    lines.push('  ' + formatted.join('  '));
  }

  return lines.join('\n');
}

/**
 * Render a project card header: "  -- project-name -------..."
 */
export function projectCardHeader(name: string): string {
  const width = getTerminalWidth() - 4;
  const nameSection = `${chalk.gray('\u2500 ')}${chalk.white.bold(name)} `;
  const remaining = width - name.length - 3;
  return `  ${nameSection}${chalk.gray('\u2500'.repeat(Math.max(0, remaining)))}`;
}
```

---

## 10. Type Definitions

### 10.1 New Types (in `commands/stats/data/types.ts`)

These types are internal to the stats command and do NOT go in the top-level `types.ts` (they are not part of the Firestore schema contract).

```typescript
// ============================================================
// Period computation
// ============================================================

export type Period = '7d' | '30d' | '90d' | 'all';

// ============================================================
// Aggregated data types (output of aggregation layer)
// ============================================================

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface GroupedMetric {
  name: string;
  count: number;
  cost: number;
  percent: number;
}

export interface DayStats {
  sessionCount: number;
  totalCost: number;
  totalMinutes: number;
}

export interface StatsOverview {
  sessionCount: number;
  totalCost: number;
  totalTimeMinutes: number;
  messageCount: number;
  totalTokens: number;
  projectCount: number;
  sessionsWithCostCount: number;

  activityByDay: TimeSeriesPoint[];

  todayStats: DayStats;
  yesterdayStats: DayStats;
  weekStats: DayStats;

  topProjects: GroupedMetric[];
  sourceTools: GroupedMetric[];         // only populated if 2+ sources exist
}

export interface CostBreakdown {
  totalCost: number;
  avgPerDay: number;
  avgPerSession: number;
  sessionCount: number;
  sessionsWithCostCount: number;

  dailyTrend: TimeSeriesPoint[];
  peakDay: { date: string; cost: number; sessions: number } | null;

  byProject: GroupedMetric[];
  byModel: GroupedMetric[];

  tokenBreakdown: {
    inputTokens: number;
    outputTokens: number;
    cacheCreation: number;
    cacheReads: number;
    inputCost: number;
    outputCost: number;
    cacheCreationCost: number;
    cacheReadCost: number;
    cacheHitRate: number;
  };
}

export interface ProjectStatsEntry {
  projectId: string;
  projectName: string;
  sessionCount: number;
  totalCost: number;
  totalTimeMinutes: number;
  messageCount: number;
  totalTokens: number;
  primaryModel: string | undefined;
  lastActive: Date;
  sourceTool: string | undefined;
  activityByDay: TimeSeriesPoint[];
}

export interface TodaySession {
  id: string;
  projectName: string;
  title: string;             // resolved: customTitle > generatedTitle > summary > 'Untitled Session'
  startedAt: Date;
  endedAt: Date;
  durationMinutes: number;
  cost: number | undefined;  // undefined = no cost data
  model: string | undefined;
  messageCount: number;
  sessionCharacter: string | undefined;
}

export interface TodayStats {
  date: Date;
  sessionCount: number;
  totalCost: number;
  totalTimeMinutes: number;
  messageCount: number;
  totalTokens: number;
  sessions: TodaySession[];
}

export interface ModelStatsEntry {
  model: string;
  displayName: string;
  sessionCount: number;
  sessionPercent: number;
  totalCost: number;
  costPercent: number;
  avgCostPerSession: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheCost: number;
  trend: TimeSeriesPoint[];
}
```

### 10.2 Modifications to Existing `types.ts`

The following changes are required for the data source preference feature (Section 15):

```typescript
// NEW type
export type DataSourcePreference = 'local' | 'firebase';

// MODIFIED interface — firebase becomes optional
export interface ClaudeInsightConfig {
  firebase?: {                            // CHANGED: was required, now optional
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
  dataSource?: DataSourcePreference;      // NEW
}
```

These changes are backward-compatible: existing configs missing `dataSource` are handled by `resolveDataSourcePreference()`, and existing configs with `firebase` still satisfy the new optional type.

**No new Firestore fields are written.** The `dataSource` preference is local to `~/.code-insights/config.json` and never touches Firestore.

### 10.3 Cross-Repo Type Impact

**None.** The web dashboard (`code-insights-web`) is not affected. The `DataSourcePreference` type and `dataSource` config field are CLI-internal concepts. Stats types are internal to the CLI.

The only cross-repo observation: the web hooks (`useFirestore.ts`) and the stats queries read the same Firestore fields. If the web ever adds fields that stats should display, the stats `SessionRow` type would need updating -- but that is a future concern, not a current one.

---

## 11. Error Handling

### 11.1 Error Hierarchy

```
StatsError (base)
  +-- ConfigNotFoundError      -> "Not configured. Run `code-insights init` first." (Firestore only)
  +-- FirebaseConnectionError  -> "Failed to connect to Firebase" + diagnostic hints (Firestore only)
  +-- ProjectNotFoundError     -> "Project not found" + suggestions (both sources)
  +-- FirestoreIndexError      -> "Missing index" + creation URL (Firestore only)
  +-- InvalidPeriodError       -> "Invalid period" + valid options (both sources)
  +-- CacheCorruptError        -> "Stats cache corrupted, rebuilding..." (local only, auto-recovers)
  +-- EmptyDataError           -> Not a thrown error; handled as a render state (both sources)
```

### 11.2 Error Handling by Layer

| Layer | Error source | Handling |
|---|---|---|
| Data source resolution | `resolveDataSource()` with `--remote` but no config | Print error + suggest `--local`, exit 1 |
| Firestore: Config loading | `loadConfig()` returns null | Print error, exit 1 |
| Firestore: Firebase init | `initializeFirebase()` throws | Print error + "check `code-insights status`", exit 1 |
| Firestore: Auto-sync | `runSync()` throws | Warn "Sync failed (showing cached data)", continue |
| Firestore: Query | `FAILED_PRECONDITION` (missing index) | Print index URL, exit 1 |
| Firestore: Query | `PERMISSION_DENIED` | Print "check service account permissions", exit 1 |
| Firestore: Query | Network error / timeout | Print "network error", exit 1 |
| Local: Cache read | Corrupt JSON or version mismatch | Warn "Rebuilding cache...", delete and re-parse |
| Local: File parse | Provider `parse()` returns null | Skip file silently (same as sync behavior) |
| Local: Discovery | Provider `discover()` finds no files | Render empty state |
| Aggregation | Empty session list | Render empty state (section 11.3) |
| `--project` flag | No matching project | Print suggestions (Levenshtein), exit 1 |
| `--period` flag | Invalid value | Commander.js validation via `.choices()` |

### 11.3 Empty State Handling

Empty states are NOT errors. They are valid render states with helpful guidance:

```typescript
// In each action handler, after querying:
if (sessions.length === 0) {
  const lastSession = await getLastSession();
  if (!lastSession) {
    renderFreshInstallEmpty();  // no sessions at all
  } else {
    renderNoPeriodData(period, lastSession);  // sessions exist but not in period
  }
  return;
}
```

### 11.4 `--period` Validation

Use Commander.js built-in `.choices()` for period validation:

```typescript
.option('-p, --period <period>', 'Time range', '7d')
// Validate in the action handler:
const validPeriods = ['7d', '30d', '90d', 'all'];
if (!validPeriods.includes(flags.period)) {
  console.error(chalk.red(`Invalid period "${flags.period}". Expected: ${validPeriods.join(', ')}`));
  process.exit(1);
}
```

Commander `.choices()` works on arguments but not on option values in older versions. Manual validation is more portable.

### 11.5 Project Name Fuzzy Matching

For the "Did you mean?" suggestion, implement a simple Levenshtein distance:

```typescript
// In commands/stats/data/firestore.ts (also used by local.ts — extract to shared utility)

function levenshtein(a: string, b: string): number {
  // Standard dynamic programming implementation
  // ~15 lines, no dependencies
}

function findSimilarNames(input: string, candidates: string[], maxDistance = 3): string[] {
  return candidates
    .map(c => ({ name: c, distance: levenshtein(input.toLowerCase(), c.toLowerCase()) }))
    .filter(c => c.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .map(c => c.name);
}
```

---

## 12. Dependencies

### 12.1 New npm Dependencies

**Zero.** All functionality is implemented with:

| Need | Solution | Already available |
|---|---|---|
| Terminal colors | `chalk` (^5.4.1) | Yes |
| Spinners | `ora` (^8.2.0) | Yes |
| CLI framework | `commander` (^12.1.0) | Yes |
| Firestore | `firebase-admin` (^13.4.0) | Yes |
| Unicode chars | String literals | Built-in |
| Terminal width | `process.stdout.columns` | Built-in |
| Date math | Manual (no date-fns) | Built-in |

**Note on date-fns:** The CLI CLAUDE.md mentions `date-fns` in the tech stack, but it is NOT in `package.json` dependencies. The stats date arithmetic (start of day, start of week, date formatting) is simple enough to implement without it. Adding date-fns would be the only justifiable dependency addition, but it is not necessary for v1.

### 12.2 Justification for Zero Dependencies

- **Sparklines and bar charts:** Pure string manipulation with Unicode characters. Libraries like `cli-sparkline` add overhead for trivial logic.
- **Table formatting:** The output is hand-crafted grids, not generic tables. Libraries like `cli-table3` would constrain the layout.
- **Date formatting:** `toLocaleDateString()`, `toLocaleTimeString()`, and simple arithmetic handle all formatting needs.

---

## 13. Cross-Repo Impact Assessment

### 13.1 Summary

| Aspect | Impact |
|---|---|
| Web dashboard code | **None** |
| Web types (`src/lib/types.ts`) | **None** |
| Firestore schema | **None** (read-only) |
| Firestore indexes | **2 new composite indexes** (user must create in their Firebase console) |
| CLI types (`cli/src/types.ts`) | **Minor** — add `DataSourcePreference` type, make `firebase` field optional on `ClaudeInsightConfig` |
| CLI `utils/config.ts` | **Add** `resolveDataSourcePreference()`, `isFirebaseConfigured()` (~30 lines) |
| CLI `commands/init.ts` | **Refactor** — add data source prompt, restructure flow (~60 lines changed) |
| CLI `commands/config.ts` | **New file** — `config` show + `config set-source` (~120 lines) |
| CLI `commands/sync.ts` | **Minor refactor** — extract `runSync()`, add dataSource gate |
| CLI `commands/status.ts` | **Minor** — show data source, conditional Firebase section |
| CLI `commands/install-hook.ts` | **Minor** — warn when local mode |
| CLI `commands/reset.ts` | **Minor** — guard against local mode |
| CLI `firebase/client.ts` | **One-line change** (export `getDb()`) |
| CLI `index.ts` | **Three-line addition** (imports + `addCommand` for stats + config) |

### 13.2 Firestore Index Documentation

The 2 new composite indexes should be documented in the CLI README and surfaced automatically when missing (via error message with creation URL). No changes to the web dashboard are needed because:

1. The web already uses `projectId + startedAt` in its `useSessions()` hook (this index may already exist for web users).
2. The `sourceTool + startedAt` index is CLI-specific (web does not filter by source tool currently).

### 13.3 TA Verdict on Cross-Repo Alignment

This feature does NOT require `@technical-architect` engagement for type alignment because:
- No new Firestore fields are written
- No changes to the type contract (`types.ts` in either repo)
- No changes to the sync protocol
- The `stats/usage` aggregate document (written during sync) is already in the schema; stats only reads it

---

## 14. Implementation Plan

### 14.1 Files to Create

| # | File | Lines (est.) | Description |
|---|---|---|---|
| 1 | `commands/stats/index.ts` | 40 | Command tree registration |
| 2 | `commands/stats/shared.ts` | 90 | Shared flags (incl. `--local`, `--remote`) |
| 3 | `commands/stats/data/types.ts` | 160 | `StatsDataSource` interface, `SessionRow`, aggregated types |
| 4 | `commands/stats/data/source.ts` | 50 | Data source factory (`resolveDataSource()`) |
| 5 | `commands/stats/data/firestore.ts` | 180 | `FirestoreDataSource` class + Firestore queries |
| 6 | `commands/stats/data/local.ts` | 150 | `LocalDataSource` class + `ParsedSession` -> `SessionRow` transform |
| 7 | `commands/stats/data/cache.ts` | 130 | `StatsCache` class (read/write/invalidate local cache) |
| 8 | `commands/stats/data/aggregation.ts` | 250 | All `compute*()` functions, `groupByDay()`, utilities |
| 9 | `commands/stats/render/colors.ts` | 60 | Semantic color abstraction |
| 10 | `commands/stats/render/format.ts` | 80 | Number/duration/date formatting |
| 11 | `commands/stats/render/charts.ts` | 80 | Sparkline and bar chart generators |
| 12 | `commands/stats/render/layout.ts` | 100 | Terminal width, grids, section headers |
| 13 | `commands/stats/actions/overview.ts` | 130 | `stats` overview handler |
| 14 | `commands/stats/actions/cost.ts` | 120 | `stats cost` handler |
| 15 | `commands/stats/actions/projects.ts` | 130 | `stats projects` handler |
| 16 | `commands/stats/actions/today.ts` | 110 | `stats today` handler |
| 17 | `commands/stats/actions/models.ts` | 110 | `stats models` handler |

**Total new code: ~1,970 lines across 17 files.** (+410 lines / +3 files vs original design, for the data source abstraction layer.)

### 14.2 Files to Create (Data Source Preference + Config Command)

| # | File | Lines (est.) | Description |
|---|---|---|---|
| 18 | `commands/config.ts` | 120 | `config` show + `config set-source` subcommand |

### 14.3 Files to Modify

| # | File | Change | Lines changed |
|---|---|---|---|
| 1 | `index.ts` | Add imports + `program.addCommand(statsCommand)` + `program.addCommand(configCommand)` | 4 |
| 2 | `firebase/client.ts` | Export `getDb()` function (add `export` keyword) | 1 |
| 3 | `commands/sync.ts` | Extract `runSync()` from `syncCommand()` + add dataSource gate | ~40 (refactor, not new logic) |
| 4 | `types.ts` | Add `DataSourcePreference` type, make `firebase` field optional | ~5 |
| 5 | `utils/config.ts` | Add `resolveDataSourcePreference()`, `isFirebaseConfigured()` | ~30 |
| 6 | `commands/init.ts` | Add data source prompt at start, restructure flow | ~60 (refactor + new prompts) |
| 7 | `commands/status.ts` | Show data source preference, conditional Firebase section | ~15 |
| 8 | `commands/install-hook.ts` | Warn when dataSource is local | ~10 |
| 9 | `commands/reset.ts` | Guard against local-only mode | ~10 |

### 14.4 Implementation Order

The implementation should proceed in this order, with each step building on the previous:

```
Phase 1: Foundation — types + data source abstraction
  1. commands/stats/data/types.ts           -- StatsDataSource interface + all type definitions
  2. commands/stats/data/source.ts          -- resolveDataSource() factory

Phase 2: Firestore data source
  3. firebase/client.ts                     -- export getDb()
  4. commands/stats/data/firestore.ts       -- FirestoreDataSource class + Firestore queries

Phase 3: Local data source + cache
  5. commands/stats/data/cache.ts           -- StatsCache class
  6. commands/stats/data/local.ts           -- LocalDataSource class

Phase 4: Aggregation (pure functions, source-agnostic)
  7. commands/stats/data/aggregation.ts     -- computation functions

Phase 5: Rendering primitives
  8. commands/stats/render/colors.ts        -- semantic colors
  9. commands/stats/render/format.ts        -- number formatting
  10. commands/stats/render/charts.ts       -- sparklines + bar charts
  11. commands/stats/render/layout.ts       -- terminal layout

Phase 6: Command wiring
  12. commands/sync.ts                      -- extract runSync()
  13. commands/stats/shared.ts              -- shared flags (incl. --local, --remote)
  14. commands/stats/index.ts               -- command registration

Phase 7: Action handlers (each is independently testable)
  15. commands/stats/actions/overview.ts     -- most complex, do first
  16. commands/stats/actions/cost.ts
  17. commands/stats/actions/projects.ts
  18. commands/stats/actions/today.ts
  19. commands/stats/actions/models.ts

Phase 8: Wire into CLI
  20. index.ts                              -- import + addCommand (stats + config)
  21. Build + manual testing

Phase 9: Data source preference + config command (can be parallelized with Phases 2-7)
  22. types.ts                              -- DataSourcePreference type, firebase optional
  23. utils/config.ts                       -- resolveDataSourcePreference(), isFirebaseConfigured()
  24. commands/config.ts                    -- config show + config set-source
  25. commands/init.ts                      -- data source prompt at start of flow
  26. commands/sync.ts                      -- dataSource gate check
  27. commands/status.ts                    -- show data source preference
  28. commands/install-hook.ts              -- local mode warning
  29. commands/reset.ts                     -- local mode guard
  30. index.ts                              -- register configCommand
```

### 14.5 Build Verification

After implementation, verify:

```bash
cd cli && pnpm build                        # TypeScript compilation

# Firestore mode (default when Firebase configured)
code-insights stats                          # Basic smoke test
code-insights stats --period 30d             # Period filtering
code-insights stats cost                     # Subcommand
code-insights stats today                    # Today's sessions
code-insights stats models                   # Model breakdown
code-insights stats projects                 # Project details
code-insights stats --no-sync                # Skip sync
code-insights stats --project nonexistent    # Error handling

# Local mode
code-insights stats --local                  # Force local data source
code-insights stats --local --period 30d     # Local + period filter
code-insights stats --local --no-sync        # Local + skip cache refresh
code-insights stats --local cost             # Local + cost subcommand
code-insights stats --remote                 # Force Firestore (error if not configured)

# Config command
code-insights config                         # Show current config + data source
code-insights config set-source local        # Switch to local
code-insights config set-source firebase     # Switch to Firebase

# Init with data source prompt
code-insights init                           # Interactive: prompts for data source first
code-insights init --from-json ~/sa.json --web-config ~/web.json   # Non-interactive: auto-sets firebase

# Data source gating
code-insights sync                           # Warning if dataSource is local
code-insights sync --force-remote            # Force sync even if local
code-insights install-hook                   # Warning if dataSource is local
code-insights reset                          # Warning if dataSource is local
```

---

## 15. Data Source Preference and Config Schema

### 15.1 Motivation

The current CLI architecture assumes Firebase is the only way to store and access session data. Every command (`init`, `sync`, `connect`, `status`, `install-hook`) requires Firebase to be configured before it is useful. This creates a high barrier to entry: users must create a Firebase project, download credentials, and run a multi-step setup just to see their stats.

With the `LocalDataSource` from Section 5, the CLI can deliver value with zero configuration. But the user needs a way to **choose** their preferred data source and **switch** between them. This section formalizes that choice as a first-class config preference.

### 15.2 Config Schema Update

Add a `dataSource` field to `ClaudeInsightConfig` in `cli/src/types.ts`:

```typescript
export type DataSourcePreference = 'local' | 'firebase';

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
  dataSource?: DataSourcePreference;   // NEW — default behavior depends on context (see 15.3)
}
```

**Why `dataSource` is optional (`?`):** Backward compatibility. Existing config files do not have this field. The resolution logic (Section 15.3) infers the correct default based on what is present in the config.

#### 15.2.1 Minimal Local-Only Config

When a user selects "Local only" during `init`, the config file is minimal:

```json
{
  "sync": {
    "claudeDir": "~/.claude/projects",
    "excludeProjects": []
  },
  "dataSource": "local"
}
```

No `firebase` field, no `webConfig`, no `dashboardUrl`. The `firebase` field is no longer structurally required for a valid config -- it is only required when `dataSource` is `'firebase'`.

**Type change required:** The `firebase` field in `ClaudeInsightConfig` must become optional:

```typescript
export interface ClaudeInsightConfig {
  firebase?: {                            // CHANGED: was required, now optional
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

All existing code that accesses `config.firebase` must null-check it. This is a manageable change since Firebase access is already gated behind `isConfigured()` / `loadConfig()` checks throughout the codebase.

### 15.3 Data Source Preference Resolution (`resolveDataSourcePreference`)

This function is the single source of truth for determining the active data source. It is used by `resolveDataSource()` (Section 3.3), `status`, `install-hook`, and any other command that needs to know the user's preference.

```typescript
// In utils/config.ts

import type { DataSourcePreference } from '../types.js';

/**
 * Determine the effective data source preference.
 *
 * Resolution order:
 * 1. Explicit config.dataSource field -> use it directly
 * 2. No dataSource field, but Firebase credentials present -> 'firebase'
 *    (backward compat: existing users who set up Firebase before this feature)
 * 3. No dataSource field, no Firebase credentials -> 'local'
 *    (new users who haven't run init yet — zero-config local mode)
 */
export function resolveDataSourcePreference(): DataSourcePreference {
  const config = loadConfig();

  if (!config) {
    return 'local';   // No config at all -> zero-config local mode
  }

  if (config.dataSource) {
    return config.dataSource;   // Explicit preference takes priority
  }

  // Backward compatibility: infer from Firebase presence
  if (config.firebase?.projectId) {
    return 'firebase';
  }

  return 'local';
}
```

**Decision table:**

| Config state | `dataSource` field | Resolved preference | Rationale |
|---|---|---|---|
| No config file at all | N/A | `local` | First run, zero-config |
| Config exists, `dataSource: 'local'` | `'local'` | `local` | Explicit local preference |
| Config exists, `dataSource: 'firebase'` | `'firebase'` | `firebase` | Explicit Firebase preference |
| Config exists, no `dataSource`, Firebase creds present | absent | `firebase` | Backward compat for existing users |
| Config exists, no `dataSource`, no Firebase creds | absent | `local` | Should not happen in practice (implies a corrupt config) |

### 15.4 `isConfigured()` Update

The current `isConfigured()` checks for the existence of `config.json`. This remains correct -- a local-only config file still means the CLI is "configured." However, commands that specifically require Firebase (like `sync`, `connect`, `reset`) should use a new helper:

```typescript
// In utils/config.ts

/**
 * Check if Firebase is configured (has credentials).
 * Use this for commands that require Firebase: sync, connect, reset.
 */
export function isFirebaseConfigured(): boolean {
  const config = loadConfig();
  return config !== null && config.firebase !== undefined && config.firebase.projectId !== undefined;
}
```

### 15.5 File Structure Changes

```
cli/src/
  types.ts                    # MODIFIED: add DataSourcePreference type, make firebase optional
  utils/
    config.ts                 # MODIFIED: add resolveDataSourcePreference(), isFirebaseConfigured()
  commands/
    init.ts                   # MODIFIED: add data source prompt at start of flow
    config.ts                 # NEW: config show / config set-source subcommands
```

---

## 16. Modified `init` Flow

### 16.1 Overview

The `init` command is redesigned to start with a data source choice. The Firebase setup flow is preserved but is now conditional -- it only runs when the user selects Firebase.

### 16.2 Interactive Flow

```
$ code-insights init

  Code Insights Setup

? How would you like to store your sessions?
  > Local only (recommended)     Sessions stay on your machine. Stats computed locally. Zero config.
    Firebase (cloud sync)         Sync to Firestore for web dashboard + cross-device access.
```

**If Local:**

```
  ✓ Data source set to local.

  Configuration saved!
  Config location: ~/.code-insights/config.json

  Setup complete! Next steps:

  1. View your stats:
     code-insights stats

  2. Auto-refresh stats on session end:
     code-insights install-hook
```

**If Firebase:**

```
  (proceed with current Firebase setup flow — Steps 1 and 2 unchanged)

  ✓ Data source set to firebase.

  Configuration saved!
  Config location: ~/.code-insights/config.json

  Setup complete! Next steps:

  1. Sync your sessions:
     code-insights sync

  2. Connect the dashboard:
     code-insights connect
```

### 16.3 Non-Interactive Mode (`--from-json`, `--web-config`)

When either `--from-json` or `--web-config` flags are passed, the user has explicitly chosen Firebase. The data source is auto-set to `'firebase'` without prompting:

```typescript
if (options.fromJson || options.webConfig) {
  // Non-interactive: user is providing Firebase credentials, so dataSource is 'firebase'
  // (proceed with current Firebase flow, set dataSource: 'firebase' in saved config)
}
```

### 16.4 Re-Running `init`

When `init` is re-run and a config already exists, the behavior depends on the current data source:

```
$ code-insights init

  Code Insights Setup

  Configuration already exists.
  Current data source: firebase (Project: my-firebase-project)

? What would you like to do?
  > Keep current settings
    Switch to local only
    Reconfigure Firebase
    Switch to Firebase (and configure)    # only shown if currently local
```

The "Overwrite?" yes/no prompt is replaced with this more informative menu. This prevents users from accidentally losing their Firebase config.

### 16.5 Config Saved After `init`

**Local choice:**
```json
{
  "sync": {
    "claudeDir": "~/.claude/projects",
    "excludeProjects": []
  },
  "dataSource": "local"
}
```

**Firebase choice:**
```json
{
  "firebase": {
    "projectId": "my-project",
    "clientEmail": "...",
    "privateKey": "..."
  },
  "webConfig": { ... },
  "sync": {
    "claudeDir": "~/.claude/projects",
    "excludeProjects": []
  },
  "dashboardUrl": "https://code-insights.app",
  "dataSource": "firebase"
}
```

### 16.6 Implementation Changes to `init.ts`

```typescript
// Pseudocode for the modified init flow

export async function initCommand(options: InitOptions): Promise<void> {
  console.log(chalk.cyan('\n  Code Insights Setup\n'));

  // --- Handle re-init ---
  if (isConfigured()) {
    const currentPref = resolveDataSourcePreference();
    const config = loadConfig();
    // Show current state and offer menu (see Section 16.4)
    // Return early if user chooses "Keep current settings"
  }

  // --- Non-interactive: --from-json or --web-config implies Firebase ---
  if (options.fromJson || options.webConfig) {
    // Proceed with current Firebase flow
    // Set dataSource: 'firebase' in saved config
    return;
  }

  // --- Interactive: prompt for data source ---
  const { dataSource } = await inquirer.prompt([{
    type: 'list',
    name: 'dataSource',
    message: 'How would you like to store your sessions?',
    choices: [
      {
        name: 'Local only (recommended) — Zero config. Stats computed on your machine.',
        value: 'local',
      },
      {
        name: 'Firebase (cloud sync) — Web dashboard + cross-device access. Requires Firebase project.',
        value: 'firebase',
      },
    ],
    default: 'local',
  }]);

  if (dataSource === 'local') {
    const config: ClaudeInsightConfig = {
      sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
      dataSource: 'local',
    };
    saveConfig(config);
    // Print success + local next steps
    return;
  }

  // dataSource === 'firebase': proceed with current Firebase setup flow
  // (Steps 1 and 2 from current init.ts, then save with dataSource: 'firebase')
}
```

---

## 17. The `config` Command

### 17.1 Command Design

A new `config` command provides a way to view and change the data source preference without re-running the full `init` flow.

**Command name rationale:** `config` is better than `migrate` because:
- "Migrate" implies data movement, which does not happen here (switching data source does not move data)
- "Config" accurately describes what is changing (a configuration preference)
- It is extensible for future settings (e.g., `config set-default-period 30d`)

### 17.2 Subcommands

```
code-insights config                    # Show current configuration summary
code-insights config set-source local   # Switch to local data source
code-insights config set-source firebase # Switch to Firebase data source
```

### 17.3 `config` (No Arguments) -- Show Current Config

```
$ code-insights config

  CODE INSIGHTS CONFIGURATION
  ──────────────────────────────────────────

  Data source:    firebase
  Firebase:       my-project-id (configured)
  Web dashboard:  configured
  Claude dir:     ~/.claude/projects
  Config file:    ~/.code-insights/config.json

  To change data source:
    code-insights config set-source local
    code-insights config set-source firebase
```

Or for a local-only user:

```
$ code-insights config

  CODE INSIGHTS CONFIGURATION
  ──────────────────────────────────────────

  Data source:    local
  Firebase:       not configured
  Web dashboard:  not configured
  Claude dir:     ~/.claude/projects
  Config file:    ~/.code-insights/config.json

  To enable cloud sync:
    code-insights config set-source firebase
```

### 17.4 `config set-source local`

```
$ code-insights config set-source local

  ✓ Data source set to local.

  What this means:
  • Stats will read from local session files (no network required)
  • Auto-sync to Firestore is disabled
  • Your Firebase config is preserved (switch back anytime with 'config set-source firebase')

  Note: Your existing Firestore data is untouched. The web dashboard will continue to
  show previously synced sessions, but new sessions will not sync until you switch back.
```

**Implementation:**

```typescript
// Read current config, update dataSource field, write back
const config = loadConfig();
if (!config) {
  // No config exists yet -- create a minimal local config
  saveConfig({
    sync: { claudeDir: '~/.claude/projects', excludeProjects: [] },
    dataSource: 'local',
  });
} else {
  config.dataSource = 'local';
  saveConfig(config);
}
```

**Key behavior:** The Firebase credentials are NOT removed from the config. The user can switch back to Firebase without re-entering credentials. This is intentional -- `dataSource` is a preference toggle, not a destructive operation.

### 17.5 `config set-source firebase`

**Case A: Firebase already configured in config**

```
$ code-insights config set-source firebase

  ✓ Data source set to firebase.
  Firebase project: my-project-id

  Your sessions will sync to Firestore. Run 'code-insights sync' to sync now.
```

**Case B: Firebase NOT configured**

```
$ code-insights config set-source firebase

  Firebase is not configured yet.
  Run 'code-insights init' to set up Firebase credentials first.
```

The command does NOT prompt for Firebase credentials. It simply validates that credentials exist. If they do not, it directs the user to `init`.

### 17.6 Command Registration

```typescript
// In commands/config.ts

import { Command } from 'commander';

export const configCommand = new Command('config')
  .description('View or change CLI configuration')
  .action(showConfigAction);           // config (no args) -> show current config

configCommand
  .command('set-source <source>')
  .description('Set the data source preference (local or firebase)')
  .action(setSourceAction);
```

```typescript
// In index.ts
import { configCommand } from './commands/config.js';

program.addCommand(configCommand);
```

### 17.7 Updated Command Tree

```
code-insights
  |
  +-- init                 (MODIFIED: data source prompt at start)
  +-- config               (NEW: show config)
  |     +-- set-source     (NEW: switch data source)
  +-- stats                (EXISTING: uses resolveDataSourcePreference)
  |     +-- cost
  |     +-- projects
  |     +-- today
  |     +-- models
  +-- sync                 (EXISTING: respects dataSource preference)
  +-- status               (EXISTING: shows dataSource in output)
  +-- connect              (EXISTING: only relevant for firebase)
  +-- install-hook         (MODIFIED: adapts command based on dataSource)
  +-- uninstall-hook
  +-- reset                (EXISTING: only relevant for firebase)
```

---

## 18. Impact on Existing Commands

### 18.1 `stats` -- Uses Configured Data Source

No changes to the `stats` command itself. The `resolveDataSource()` factory (Section 3.3) already handles the new `dataSource` preference. The resolution priority is:

```
1. --local flag           -> LocalDataSource
2. --remote flag          -> FirestoreDataSource
3. config.dataSource      -> as configured
4. No config              -> LocalDataSource (zero-config)
```

Users can always override their configured preference with `--local` or `--remote` flags.

### 18.2 `sync` -- Gated by Data Source Preference

The `sync` command only makes sense when `dataSource` is `'firebase'`. Behavior when run in local mode:

```
$ code-insights sync

  ⚠ Data source is set to local. Sync is only used with Firebase.

  To switch to Firebase: code-insights config set-source firebase
  To sync anyway (one-time): code-insights sync --force-remote
```

**Implementation:** Add a check at the top of `syncCommand()`:

```typescript
export async function syncCommand(options: SyncOptions): Promise<void> {
  const preference = resolveDataSourcePreference();

  if (preference === 'local' && !options.forceRemote) {
    console.log(chalk.yellow('\n  Data source is set to local. Sync is only used with Firebase.\n'));
    console.log(chalk.gray('  To switch to Firebase: code-insights config set-source firebase'));
    console.log(chalk.gray('  To sync anyway (one-time): code-insights sync --force-remote\n'));
    return;
  }

  // ... existing sync logic ...
}
```

A new `--force-remote` flag allows one-off syncs even when the preference is local. This is useful for users who primarily work locally but occasionally want to push data to Firebase.

### 18.3 `connect` -- Firebase Only

The `connect` command generates a dashboard URL. It is only meaningful when Firebase is configured.

**Current behavior:** Already checks `isConfigured()` and `hasWebConfig()`. No changes needed. The existing error messages ("Run `code-insights init` first") are appropriate.

**Optional enhancement:** If `dataSource` is `'local'`, add a hint:

```
  Your data source is set to local. The web dashboard requires Firebase.
  To enable: code-insights config set-source firebase
```

### 18.4 `install-hook` -- Adapts Based on Data Source

The hook command currently installs `code-insights sync -q` as the Stop hook. When the data source is local, syncing is not useful. Instead, the hook should refresh the local stats cache:

| Data source | Hook command installed |
|---|---|
| `firebase` | `node <cli-path> sync -q` (current behavior) |
| `local` | `node <cli-path> stats --no-sync -q 2>/dev/null` or no hook at all |

**Recommended approach:** When `dataSource` is `'local'`, the hook runs `code-insights stats --no-sync` to warm the cache after each session. This ensures the next `code-insights stats` invocation is instant (warm cache hit).

However, the stats cache refresh already happens automatically via `prepare()` when `stats` is run. So the hook's value in local mode is marginal -- it only saves 1-5 seconds on the next `stats` invocation. For simplicity, the v1 implementation can skip the hook in local mode:

```
$ code-insights install-hook

  ⚠ Your data source is set to local. The auto-sync hook is only useful with Firebase.

  Your stats are computed from local files and refresh automatically when you run 'code-insights stats'.

  To install the hook anyway (for future Firebase use): code-insights install-hook --force
  To switch to Firebase: code-insights config set-source firebase
```

**Future enhancement (v2):** Install a local cache warming hook that runs `stats --no-sync --quiet` in the background. This is a nice optimization but not essential for v1.

### 18.5 `status` -- Shows Data Source Preference

The `status` command should include the current data source in its output:

```
$ code-insights status

  Code Insights Status

  Configuration:
    ✓ Configured at ~/.code-insights
    Data source: local                          # NEW LINE

  Claude Code:
    ✓ Found at ~/.claude/projects
    5 projects, 47 sessions

  Local Stats Cache:                            # NEW SECTION (when local)
    ✓ 47 sessions cached
    Last refreshed: 2 minutes ago

  Firebase:                                     # Only shown when dataSource is 'firebase' or was 'firebase'
    ...
```

When the data source is `'local'`, the Firebase section can either be hidden entirely or show "Not active (data source is local)".

### 18.6 `reset` -- Firebase Only

The `reset` command deletes Firestore data and local sync state. It is only meaningful in Firebase mode.

**When `dataSource` is `'local'`:**

```
$ code-insights reset

  ⚠ Your data source is set to local. Nothing to reset in Firestore.

  To clear the local stats cache:
    rm ~/.code-insights/stats-cache.json

  To switch to Firebase and reset: code-insights config set-source firebase
```

**Optional:** Add a `reset --cache` flag that clears `stats-cache.json` (the local stats cache). This is useful for debugging cache issues.

### 18.7 Impact Summary Table

| Command | dataSource: local | dataSource: firebase |
|---|---|---|
| `init` | Prompt with "Local (recommended)" default | Prompt, then Firebase setup flow |
| `config` | Show "Data source: local" | Show "Data source: firebase" + project ID |
| `config set-source` | Switch preference | Switch preference |
| `stats` | LocalDataSource (default) | FirestoreDataSource (default) |
| `stats --local` | LocalDataSource (explicit) | LocalDataSource (override) |
| `stats --remote` | FirestoreDataSource (override, error if no creds) | FirestoreDataSource (explicit) |
| `sync` | Warn + suggest `config set-source firebase` | Normal sync behavior |
| `sync --force-remote` | Force sync (one-time) | Normal sync behavior |
| `connect` | Hint: "requires Firebase" | Normal behavior |
| `install-hook` | Warn: "hook is for Firebase sync" | Install `sync -q` hook |
| `status` | Show local cache info, hide/dim Firebase section | Show Firebase + sync info |
| `reset` | Warn: "nothing to reset" + offer cache clear | Delete Firestore data + sync state |

---

## 19. Backward Compatibility for Existing Users

### 19.1 The Critical Guarantee

**Existing users who have Firebase configured and are actively using `sync` + the web dashboard MUST NOT be disrupted.** Their CLI must continue working exactly as before, with no action required on their part.

### 19.2 How It Works

An existing user's config file looks like this:

```json
{
  "firebase": {
    "projectId": "my-project",
    "clientEmail": "firebase-admin@my-project.iam.gserviceaccount.com",
    "privateKey": "-----BEGIN PRIVATE KEY-----\n..."
  },
  "webConfig": { ... },
  "sync": {
    "claudeDir": "~/.claude/projects",
    "excludeProjects": []
  },
  "dashboardUrl": "https://code-insights.app"
}
```

**Note:** No `dataSource` field.

When the CLI upgrades and any command runs `resolveDataSourcePreference()`:

1. `config.dataSource` is `undefined` (field does not exist)
2. `config.firebase.projectId` is present
3. Resolution: `'firebase'`

**Result:** Everything behaves identically to the pre-upgrade behavior:
- `stats` defaults to Firestore
- `sync` works normally
- `connect` works normally
- `install-hook` installs the sync hook
- `status` shows Firebase info

The user only encounters the new data source prompt if they re-run `code-insights init`.

### 19.3 Lazy Migration

The config file is NOT automatically rewritten to add `dataSource: 'firebase'`. This avoids:
- Unexpected file modifications
- Potential permission issues
- Confusing diffs if the config is version-controlled

The `dataSource` field is only written when:
- The user runs `code-insights init` (new or re-init)
- The user runs `code-insights config set-source <value>`

Over time, as users re-init or change settings, their configs will gain the explicit `dataSource` field. Until then, the inference logic handles backward compatibility.

### 19.4 Edge Cases

| Scenario | Behavior |
|---|---|
| User upgrades CLI, runs `stats` | Works as before: Firestore (inferred from Firebase creds) |
| User upgrades CLI, runs `sync` | Works as before: no data source check needed |
| User upgrades CLI, runs `init` | Sees data source prompt. "Firebase" is pre-selected if Firebase creds exist. |
| User has config with Firebase creds, runs `config set-source local` | Switches to local. Firebase creds preserved. Can switch back. |
| User has local config, runs `sync` | Warning: "Data source is set to local." |
| User has corrupt config (no firebase, no dataSource) | Defaults to local. `init` guides them through setup. |

### 19.5 Type Safety During Migration

Since `firebase` becomes optional on `ClaudeInsightConfig`, all code paths that access `config.firebase` must add null checks. This is a surgical change -- the affected locations are:

| File | Access pattern | Fix |
|---|---|---|
| `commands/sync.ts` | `config.firebase` | Already gated by `loadConfig()` which fails if no config |
| `commands/status.ts` | `config.firebase.projectId` | Add `config.firebase?.projectId` |
| `commands/reset.ts` | `config.firebase` | Add null check, exit with error if no Firebase |
| `commands/connect.ts` | Does not access `config.firebase` directly | No change needed |
| `commands/init.ts` | Creates `config.firebase` during setup | No change (writes, doesn't read) |
| `firebase/client.ts` | `initializeFirebase(config)` reads `config.firebase` | Already passed full config; add guard |
| `commands/stats/data/firestore.ts` | Receives config in constructor | Already validated by `resolveDataSource()` |

Total: ~10 lines of null-check additions across 4 files.

---

## 20. Future Extensibility

### 20.1 Scenario: Removing Firebase from the CLI Entirely

The founder is actively considering making the CLI a fully offline, local-only tool. The data source abstraction designed in Section 3 makes this a clean, low-effort operation. Here is the complete impact analysis.

#### 20.1.1 What the CLI Looks Like Without Firebase

```
Commands that remain (unchanged):
  code-insights stats              # Uses LocalDataSource exclusively
  code-insights stats cost         # Same
  code-insights stats projects     # Same
  code-insights stats today        # Same
  code-insights stats models       # Same
  code-insights install-hook       # Still useful for auto-stats on session end
  code-insights uninstall-hook     # Pair with install-hook

Commands that are removed:
  code-insights init               # No Firebase to configure
  code-insights sync               # No remote to sync to
  code-insights connect            # No web dashboard to connect to
  code-insights status             # No Firebase status to check
  code-insights reset              # No sync state to reset

Commands that are repurposed:
  code-insights init               # Could be repurposed for LLM API key config (for local insights)
```

#### 20.1.2 Code Removal Inventory

| File/Directory | Action | Reason |
|---|---|---|
| `firebase/client.ts` | **Delete** | No Firestore dependency |
| `commands/sync.ts` | **Delete** | No remote to sync to |
| `commands/init.ts` | **Repurpose or delete** | Could configure LLM keys for local insights |
| `commands/connect.ts` | **Delete** | No web dashboard connection |
| `commands/status.ts` | **Delete or simplify** | Could show local cache stats instead |
| `commands/reset.ts` | **Simplify** | Only reset local cache, not sync state |
| `commands/stats/data/firestore.ts` | **Delete** | No Firestore data source |
| `commands/stats/data/source.ts` | **Simplify** | Always returns `LocalDataSource` (or remove factory entirely) |
| `utils/config.ts` | **Simplify** | Remove `loadConfig()`/`saveConfig()` for Firebase config, keep `ensureConfigDir()` |
| `utils/device.ts` | **Keep** | `generateStableProjectId()` still needed for local project IDs |
| `types.ts` | **Simplify** | Remove `ClaudeInsightConfig`, `FirebaseServiceAccountJson`, `FirebaseWebConfig`, `SyncState` |
| `package.json` | **Remove `firebase-admin`** | Significant dependency reduction (~30MB) |

**Estimated removal: ~800 lines of code, ~30MB of node_modules.**

#### 20.1.3 What Does NOT Change

| Component | Why it survives |
|---|---|
| `providers/*` (all 4 providers) | Still needed for local session discovery and parsing |
| `parser/jsonl.ts` | Still needed for Claude Code JSONL parsing |
| `utils/pricing.ts` | Still needed for cost calculation |
| `commands/stats/data/local.ts` | Becomes the only data source |
| `commands/stats/data/cache.ts` | Local cache is critical for performance |
| `commands/stats/data/aggregation.ts` | Pure functions -- unchanged |
| `commands/stats/render/*` | Terminal rendering -- unchanged |
| `commands/stats/actions/*` | Action handlers -- unchanged (they only call `StatsDataSource`) |

**The key insight: the aggregation layer, rendering layer, and action handlers require ZERO changes when Firebase is removed.** Only the data source selection logic changes (from "auto-detect" to "always local").

#### 20.1.4 The `--local` / `--remote` Flags in a Post-Firebase World

In a Firebase-less CLI:
- `--local` flag becomes a no-op (always local). Can be deprecated silently.
- `--remote` flag returns an error: "Remote data sources are not supported in this version. See code-insights-web for cloud-based analytics."
- The `resolveDataSource()` factory simplifies to `return new LocalDataSource()`.

#### 20.1.5 Migration Path

The removal can happen in stages:

```
Stage 1 (current design):
  Firebase configured   -> FirestoreDataSource (default)
  Firebase unconfigured -> LocalDataSource (auto-fallback)
  --local flag          -> force local

Stage 2 (deprecation warning):
  Firebase configured   -> FirestoreDataSource + warn "Firebase support will be removed in v3.0"
  Firebase unconfigured -> LocalDataSource

Stage 3 (removal):
  Always                -> LocalDataSource
  Delete firebase-admin dependency
  Delete Firestore-related code
```

Each stage is backward-compatible with the previous one. Users who have Firebase configured see a deprecation warning in Stage 2, giving them time to migrate to local-only or to the web dashboard for cloud features.

#### 20.1.6 What About Insights?

Insights (summaries, learnings, decisions, techniques, prompt quality analysis) are currently generated by the web dashboard and stored in Firestore. In a local-only world:

**This is a SEPARATE concern documented here for strategic planning, NOT part of the stats implementation.**

- **Option A: CLI generates insights locally.** Add LLM integration to the CLI (OpenAI, Anthropic, Gemini, Ollama). The CLI already has `messages` in `ParsedSession` -- the same data the web uses for analysis. Estimated effort: ~500-800 lines (prompts, LLM client, local storage for insights).
- **Option B: Insights remain web-only.** Users who want insights use the web dashboard. The CLI is a "raw stats" tool, the web is the "intelligent analysis" tool. This is a clean separation of concerns.
- **Option C: Hybrid.** CLI generates basic insights (summaries) locally. Advanced insights (prompt quality, cross-session patterns) remain web-only.

**Recommendation:** Start with Option B. If user demand exists for local insights, implement Option A as a separate feature (not entangled with the stats command).

### 20.2 `code-insights learnings --today`

The architecture directly supports this:

1. **Query layer:** Add an `InsightsDataSource` (parallel to `StatsDataSource`) or extend `StatsDataSource` with `getInsights()`. For Firestore: query `insights` collection. For local: read from a local insights store.

2. **Aggregation:** Minimal -- insights are already structured. Group by session/project.

3. **Rendering:** Reuse `render/colors.ts`, `render/format.ts`, and `render/layout.ts`. Insight-specific rendering (multiline text wrapping, bullet points) would go in a new `render/insights.ts`.

4. **Command registration:** Same `addCommand()` pattern.

**Estimated effort:** ~200 lines (1 query function, 1 action handler, 1 render helper).

### 20.3 `code-insights decisions --project X`

Same pattern as learnings with `type === 'decision'`. Additional rendering for:
- Confidence percentage
- Alternatives list
- Reasoning text

**Estimated effort:** ~250 lines.

### 20.4 `--json` Output Mode

The three-layer architecture makes JSON output trivial:

1. Queries + aggregation run identically.
2. Instead of calling `render/*` functions, serialize the aggregated type directly:
   ```typescript
   if (flags.json) {
     console.log(JSON.stringify(overview, null, 2));
     return;
   }
   ```

**Estimated effort:** ~20 lines (flag + conditional in each action handler).

### 20.5 `--watch` Mode (Live Dashboard)

The rendering layer uses `console.log()` which supports cursor manipulation:

1. Clear screen + reposition cursor.
2. Re-run query + aggregation + render on an interval.
3. `ora` spinner for "refreshing..." indicator.

This would require refactoring render functions to return strings instead of printing directly (some already do, some would need adjustment). The aggregation layer is already pure functions and supports this without changes.

**Estimated effort:** ~100 lines (screen clearing, interval loop, render-to-string refactor).

### 20.6 Additional Data Sources (Future)

The `StatsDataSource` interface is intentionally generic. Future implementations could include:
- **SQLite data source:** A local SQLite database for power users who want full-text search, complex queries, and cross-session analysis. Would replace the JSON cache.
- **API data source:** Reads from a REST API (e.g., a self-hosted analytics server). Would enable team-wide stats aggregation.

---

## Appendix A: Data Flow Diagram

```
User runs: code-insights stats cost --period 30d --project my-app

  |
  v
index.ts
  |-- statsCommand.addCommand(costCommand)
  |-- costCommand.action(costAction)
  |
  v
actions/cost.ts :: costAction(flags)
  |
  |-- 1. resolveDataSource(flags)
  |       |-- --local flag?                    -> LocalDataSource
  |       |-- --remote flag?                   -> FirestoreDataSource
  |       |-- config.dataSource === 'local'?   -> LocalDataSource
  |       |-- config.dataSource === 'firebase'?-> FirestoreDataSource
  |       |-- No config?                       -> LocalDataSource (zero-config fallback)
  |
  |-- 2. source.prepare(flags)
  |       |-- [Firestore] initFirebase() + runSync({ quiet: true })
  |       |     spinner: "Synced 2 new sessions" or "Up to date"
  |       |-- [Local] cache.refresh()
  |             spinner: "Parsed 3 new sessions (47 total)" or "47 sessions cached"
  |
  |-- 3. source.resolveProjectId('my-app')
  |       |-- [Firestore] getProjects() from Firestore, fuzzy match -> projectId
  |       |-- [Local] scan cached rows, fuzzy match -> projectId
  |
  |-- 4. source.getSessions({
  |       |    periodStart: 30 days ago,
  |       |    projectId: 'abc123...',
  |       |  })
  |       |-- [Firestore] Firestore query with .where() chaining
  |       |-- [Local] filter cached SessionRow[] in-memory
  |       |
  |       +-- Returns SessionRow[]  (IDENTICAL SHAPE from both sources)
  |
  |-- 5. computeCostBreakdown(sessions, '30d')    <-- UNCHANGED
  |       |-- Client-side aggregation
  |       +-- Returns CostBreakdown
  |
  |-- 6. Render                                    <-- UNCHANGED
        |-- sectionHeader('COST BREAKDOWN', 'Last 30 days')
        |-- metricGrid([...])
        |-- sectionHeader('DAILY TREND')
        |-- sparkline(breakdown.dailyTrend)
        |-- sectionHeader('BY MODEL')
        |-- barChart(breakdown.byModel, getBarWidth())
        |-- hints
```

## Appendix B: Firestore Read Budget per Command

| Command | Firestore reads | Collections touched |
|---|---|---|
| `stats` (7d) | projects (N) + sessions (~50) = ~70 | `projects`, `sessions` |
| `stats` (all) | projects (N) + stats/usage (1) + sessions (all, ~500) = ~520 | `projects`, `stats`, `sessions` |
| `stats cost` (30d) | projects (N) + sessions (~100) = ~120 | `projects`, `sessions` |
| `stats projects` (7d) | projects (N) + sessions (~50) = ~70 | `projects`, `sessions` |
| `stats today` | sessions (~10) = ~10 | `sessions` |
| `stats models` (30d) | sessions (~100) = ~100 | `sessions` |

Where N = number of projects (typically 3-20).

## Appendix C: Model Name Shortening Rules

```typescript
export function shortenModelName(model: string): string {
  // Strip date suffixes: claude-sonnet-4-5-20250929 -> claude-sonnet-4-5
  let name = model.replace(/-\d{8}$/, '');

  // Shorten claude-3-5-* to claude-3.5-*
  name = name.replace('claude-3-5-', 'claude-3.5-');

  return name;
}
```

## Appendix D: Period Start Date Calculation

```typescript
export function periodStartDate(period: Period): Date | undefined {
  if (period === 'all') return undefined;

  const now = new Date();
  const days = { '7d': 7, '30d': 30, '90d': 90 }[period];

  const start = new Date(now);
  start.setDate(start.getDate() - days);
  start.setHours(0, 0, 0, 0);
  return start;
}
```
