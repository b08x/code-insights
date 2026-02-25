# CLI Stats Command — Design Document

> **Date:** 2026-02-25
> **Status:** Pending Founder Approval
> **Authors:** UX Engineer (terminal output), Technical Architect (architecture)
> **Companion docs:**
> - [UX Design](./2026-02-25-cli-stats-ux-design.md) — Full terminal mockups, color system, edge cases
> - [Architecture](./2026-02-25-cli-stats-architecture.md) — Data source abstraction, Firestore + local implementations, types, implementation plan

---

## Summary

Add a `code-insights stats` command suite to the CLI, providing terminal-based analytics so users can see their coding stats without opening the web dashboard. Five commands, zero new dependencies, zero cross-repo impact.

**Key architectural addition (v2):** A **Data Source Abstraction Layer** that allows stats to work with Firestore (when configured) OR local session files (when Firebase is not configured, or when `--local` is passed). This prepares the CLI for a potential future where Firebase is removed entirely, making the tool fully offline and zero-config.

**Key architectural addition (v3):** A **Data Source Preference** (`dataSource: 'local' | 'firebase'`) stored in the CLI config that determines the default behavior of all commands. New users choose their data source during `init` (local is the recommended default). Existing Firebase users are not disrupted -- their preference is inferred from existing Firebase credentials. A new `config` command allows switching between data sources at any time without re-running `init`.

## What We're Building

### Stats Commands

| Command | Purpose |
|---|---|
| `code-insights stats` | Quick overview — key metrics, 7-day sparkline, top projects |
| `code-insights stats cost` | Cost breakdown by project, model, time period |
| `code-insights stats projects` | Per-project detail — sessions, time, cost, models, activity |
| `code-insights stats today` | Today's sessions with titles, duration, character, cost |
| `code-insights stats models` | Model usage distribution, cost per model, trends |

### Config + Init Changes

| Command | Purpose |
|---|---|
| `code-insights init` | **(Modified)** Now prompts for data source choice first (local vs Firebase) |
| `code-insights config` | **(New)** Show current configuration summary |
| `code-insights config set-source <local\|firebase>` | **(New)** Switch data source preference without re-running init |

### Shared Flags (Stats Commands)

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--period <val>` | `-p` | `7d` | Time range: `7d`, `30d`, `90d`, `all` |
| `--project <name>` | — | none | Scope to a single project (fuzzy match) |
| `--source <tool>` | — | none | Filter by source tool (claude-code, cursor, etc.) |
| `--no-sync` | — | false | Skip auto-sync / cache refresh before display |
| `--local` | — | false | Force local data source (override config preference) |
| `--remote` | — | false | Force Firestore data source (override config preference) |

### Data Source Resolution Priority

When `stats` runs, the data source is determined by this priority chain:

```
1. --local flag            -> Local       (explicit override, always wins)
2. --remote flag           -> Firestore   (explicit override, error if no Firebase creds)
3. config.dataSource       -> as configured ('local' or 'firebase')
4. No config, Firebase creds present -> Firestore (backward compat for existing users)
5. No config at all        -> Local       (zero-config first run)
```

The `--local` and `--remote` flags are **overrides** -- they take precedence over the stored preference. Without flags, the stored `dataSource` preference determines the default.

## Key Design Decisions

### 1. Data Source Abstraction (NEW)
A `StatsDataSource` interface decouples the data layer from Firestore. Two implementations ship in v1:
- **`FirestoreDataSource`** — reads from the user's Firestore (auto-syncs first). This is the default when Firebase is configured.
- **`LocalDataSource`** — reads directly from session files on disk (JSONL, SQLite) using the existing provider infrastructure. This is the default when Firebase is NOT configured, and can be forced with `--local`.

**Why now:** The founder is considering removing Firebase entirely from the CLI. This abstraction makes that a clean, low-effort operation. The aggregation and rendering layers NEVER know where data came from.

### 2. Auto-Prepare Before Stats
Every `stats` command calls `source.prepare()` first (unless `--no-sync`):
- **Firestore mode:** Auto-syncs, spinner shows "Synced 3 new sessions" or "Up to date".
- **Local mode:** Refreshes the local cache, spinner shows "Parsed 3 new sessions (47 total)" or "47 sessions cached".
On failure, shows warning and proceeds with stale/cached data.

### 3. Output Style: Chalk + Unicode (A+C Hybrid)
Plain text with chalk colors, plus Unicode sparklines and block bar charts. No new terminal UI dependencies.

### 4. Four-Layer Architecture
```
data/source.ts       → resolveDataSource()   → StatsDataSource
data/firestore.ts    → Firestore reads       → SessionRow[]
  OR
data/local.ts        → Disk reads + cache    → SessionRow[]
data/aggregation.ts  → Pure functions         → StatsOverview, CostBreakdown, etc.
render/*.ts          → Terminal output        → stdout
```
The aggregation and rendering layers are COMPLETELY UNCHANGED regardless of data source. The `--local`/`--remote` flags, `--json`, and `--watch` modes are enabled by swapping only the data source or renderer.

### 5. Minimal Cross-Repo Impact
Stats is read-only. No changes to web dashboard, Firestore schema, or type contract. Modifications to existing CLI code: extract `runSync()` from `sync.ts`, export `getDb()` from `firebase/client.ts`, make `firebase` optional in `ClaudeInsightConfig`, add data source preference resolution to `config.ts`, refactor `init.ts` for data source prompt, and add data source gates to `sync`, `status`, `install-hook`, `reset`.

### 6. Local Cache for Performance
Parsing all JSONL/SQLite files on every `stats` invocation is too slow. A local cache (`~/.code-insights/stats-cache.json`) stores pre-parsed `SessionRow[]` keyed by source file path. Cache invalidation is by file modification time. Warm-cache stats completes in < 200ms.

### 7. Data Source Preference on Installation (NEW)

When a user first runs `code-insights init`, they are prompted to choose their data source before anything else:
- **Local only (recommended)** -- zero config, sessions stay on disk, stats computed locally
- **Firebase (cloud sync)** -- sync to Firestore for web dashboard + cross-device access

This preference is stored as `dataSource: 'local' | 'firebase'` in `~/.code-insights/config.json` and becomes the default for all commands. Users who choose "local" never see Firebase prompts.

**Why local is the default:**
- Zero friction first-run experience (no Firebase project required)
- Stats works immediately with `code-insights stats`
- Users can upgrade to Firebase later without data loss

**Non-interactive mode:** `--from-json` and `--web-config` flags auto-set `dataSource: 'firebase'` (the user is explicitly providing Firebase credentials).

### 8. Config Command for Data Source Switching (NEW)

A `code-insights config` command lets users view and change their data source preference without re-running `init`:

```
code-insights config                     # Show current config summary
code-insights config set-source local    # Switch to local
code-insights config set-source firebase # Switch to Firebase (requires existing Firebase creds)
```

**Why `config` not `migrate`:** "Migrate" implies data movement. Switching data source does not move data -- local reads from disk, Firebase data stays in Firestore. "Config" accurately describes what is changing (a preference).

**Key behavior:** Switching from Firebase to local does NOT delete Firebase credentials from the config. The user can switch back without re-entering credentials. `dataSource` is a toggle, not a destructive operation.

### 9. Backward Compatibility for Existing Users (CRITICAL)

Existing users who have Firebase configured and are using `sync` + the web dashboard must NOT be disrupted. When the CLI upgrades:
- If config has Firebase credentials but no `dataSource` field, the system infers `dataSource: 'firebase'`
- All commands continue working exactly as before
- The user only encounters the new data source prompt if they re-run `init`
- The config file is NOT automatically rewritten -- the `dataSource` field is only added when the user explicitly runs `init` or `config set-source`

### 10. Existing Commands Respect Data Source (NEW)

The `dataSource` preference gates Firebase-dependent commands:
- **`sync`**: Warns when `dataSource: 'local'`; offers `--force-remote` for one-off syncs
- **`connect`**: Only meaningful for Firebase; hints at switching when local
- **`install-hook`**: Installs sync hook for Firebase, warns for local
- **`status`**: Shows data source preference and adapts sections accordingly
- **`reset`**: Guards against accidental Firestore deletion when in local mode

## Terminal Mockup — `code-insights stats`

```
  ● Syncing...  ✓ Up to date

  CODE INSIGHTS                                         Last 7 days
  ─────────────────────────────────────────────────────────────────

  Sessions     47        Cost       $12.30        Time      18h 42m
  Messages   1,284       Tokens     4.2M          Projects     5

  ACTIVITY                                      ▁▃▇▅▂▅▃
  ──────────────────────────────────────────────  M T W T F S S

  Today          5 sessions    $2.14    3h 20m
  Yesterday      8 sessions    $3.47    4h 15m
  This week     32 sessions    $9.80   14h 30m

  TOP PROJECTS
  ─────────────────────────────────────────────────────────────────
  code-insights  ████████████████░░░░  23 sessions   $5.80
  batonship-web  ████████░░░░░░░░░░░░  12 sessions   $3.20
  my-dotfiles    ████░░░░░░░░░░░░░░░░   7 sessions   $1.90
  side-project   ██░░░░░░░░░░░░░░░░░░   3 sessions   $0.82
  experiments    █░░░░░░░░░░░░░░░░░░░   2 sessions   $0.58

  → Run stats cost for cost breakdown
  → Run stats today for today's sessions
  → Run stats projects for project details
```

(Full mockups for all 5 subcommands, empty states, error states, and edge cases are in the [UX Design doc](./2026-02-25-cli-stats-ux-design.md).)

## File Structure

```
cli/src/
  types.ts                      # MODIFIED: add DataSourcePreference, make firebase optional
  utils/
    config.ts                   # MODIFIED: add resolveDataSourcePreference(), isFirebaseConfigured()
  commands/
    init.ts                     # MODIFIED: data source prompt at start, restructured flow
    config.ts                   # NEW: config show + config set-source subcommands
    sync.ts                     # MODIFIED: extract runSync(), add dataSource gate
    status.ts                   # MODIFIED: show data source preference
    install-hook.ts             # MODIFIED: local mode warning
    reset.ts                    # MODIFIED: local mode guard
    stats/
      index.ts                  # Command registration
      shared.ts                 # Shared flags (incl. --local, --remote)
      data/
        types.ts                # StatsDataSource interface, SessionRow, aggregated types
        source.ts               # Data source factory (resolveDataSource())
        firestore.ts            # FirestoreDataSource — Firestore queries
        local.ts                # LocalDataSource — disk-based reads via providers
        cache.ts                # Local stats cache (~/.code-insights/stats-cache.json)
        aggregation.ts          # Pure computation functions (source-agnostic)
      render/
        colors.ts               # Semantic color helpers
        format.ts               # Number/duration/date formatting
        charts.ts               # Sparkline + bar chart rendering
        layout.ts               # Terminal width, grids, sections
      actions/
        overview.ts             # stats (no args)
        cost.ts                 # stats cost
        projects.ts             # stats projects
        today.ts                # stats today
        models.ts               # stats models
```

**18 new files (~2,090 lines) + 9 existing files modified (~170 lines)**

## Firestore Impact (Firestore mode only)

> **Note:** When using `--local` or when Firebase is not configured, there is zero Firestore impact. No reads, no indexes, no cost.

### Queries
- Primary query: `getSessionsInPeriod()` with conditional `.where()` chaining for period/project/source filters
- Secondary: `getProjects()` (existing), `getUsageStats()` (reads `stats/usage` aggregate doc for all-time totals)

### New Composite Indexes (2)
Users must create these in their Firebase console (auto-surfaced via error URL):

| Collection | Fields | Order |
|---|---|---|
| `sessions` | `projectId`, `startedAt` | ASC, DESC |
| `sessions` | `sourceTool`, `startedAt` | ASC, DESC |

### Read Cost
Negligible: ~50-500 reads per invocation. Running `stats` 100x/day = $0.012/day at Firestore pricing.

## Local Mode Impact

- **Zero Firebase dependency.** No config, no network, no cost.
- **Local cache:** `~/.code-insights/stats-cache.json` (< 1MB for most users).
- **Cold cache:** 5-15 seconds (first run, parses all session files).
- **Warm cache:** < 200ms (common path, just file `stat()` checks).
- **Data scope:** Current device only (no cross-device session aggregation).

## Implementation Phases

| Phase | What | Files |
|---|---|---|
| 1. Foundation | Types + `StatsDataSource` interface + factory | `data/types.ts`, `data/source.ts` |
| 2. Firestore source | Firestore queries + `FirestoreDataSource` class | `data/firestore.ts`, `firebase/client.ts` |
| 3. Local source | Cache + `LocalDataSource` class | `data/cache.ts`, `data/local.ts` |
| 4. Aggregation | Pure computation functions (source-agnostic) | `data/aggregation.ts` |
| 5. Rendering | Color system + formatting + charts + layout | `render/colors.ts`, `render/format.ts`, `render/charts.ts`, `render/layout.ts` |
| 6. Wiring | Sync refactor + shared flags + command tree | `commands/sync.ts`, `shared.ts`, `index.ts` |
| 7. Actions | One handler per subcommand | `actions/overview.ts`, `cost.ts`, `projects.ts`, `today.ts`, `models.ts` |
| 8. Integration | Wire into CLI entry point + build + smoke test | `index.ts` (root) |
| 9. Data source pref | Config schema + preference resolution + init refactor | `types.ts`, `utils/config.ts`, `commands/init.ts`, `commands/config.ts` |
| 10. Command gates | Data source awareness in existing commands | `commands/sync.ts`, `status.ts`, `install-hook.ts`, `reset.ts` |

**Note:** Phase 9 can be parallelized with Phases 2-7 since it touches different files. Phase 10 depends on Phase 9 (needs `resolveDataSourcePreference()`).

## Dependencies

**Zero new npm dependencies.** Everything built with chalk, ora, commander, firebase-admin (all already installed).

## Future Vision (Not In Scope)

These are documented for strategic planning but NOT part of this implementation:

### Removing Firebase from the CLI

The founder is considering making the CLI fully offline/local. The data source abstraction makes this a clean operation:
- **What stays:** `stats` (local source), `install-hook`, all providers, aggregation, rendering
- **What goes:** `sync`, `connect`, `init` (Firebase config), `firebase-admin` dependency (~30MB)
- **What doesn't change:** Aggregation and rendering layers require ZERO modifications
- **Migration path:** deprecation warning → removal, fully backward-compatible at each stage

See [Architecture doc, Section 20.1](./2026-02-25-cli-stats-architecture.md#201-scenario-removing-firebase-from-the-cli-entirely) for the full impact analysis.

### Insight Querying
```
code-insights learnings --today
code-insights learnings --project code-insights --period 7d
code-insights decisions --project batonship --timeline today
```

These would extend the `StatsDataSource` with `getInsights()` or define a parallel `InsightsDataSource`. Estimated ~200-250 lines each.

### Additional Future Modes
- `--json` flag — serialize aggregated types instead of rendering (~20 lines per action)
- `--watch` flag — live terminal dashboard with auto-refresh (~100 lines)
- SQLite data source — for power users who want complex queries and cross-session analysis

## Approval Checklist

### Stats Commands
- [ ] Command names and flags look right (including new `--local` / `--remote`)
- [ ] Output style (A+C hybrid) approved
- [ ] Subcommand set is complete (or missing something?)
- [ ] Data source abstraction approach approved
- [ ] Local cache strategy (`stats-cache.json`) approved

### Data Source Preference (NEW)
- [ ] `dataSource: 'local' | 'firebase'` config field approved
- [ ] Source resolution priority chain approved (flags > config.dataSource > inferred from Firebase creds > local fallback)
- [ ] Backward compat strategy approved (existing Firebase users infer `'firebase'` from creds, no config rewrite)
- [ ] Making `firebase` optional on `ClaudeInsightConfig` approved

### Modified `init` Flow (NEW)
- [ ] Data source prompt as first step in `init` approved
- [ ] "Local only (recommended)" as default choice approved
- [ ] Non-interactive mode (`--from-json`, `--web-config`) auto-sets `dataSource: 'firebase'` approved
- [ ] Re-init menu (keep / switch / reconfigure) approved

### `config` Command (NEW)
- [ ] Command name `config` (not `migrate`) approved
- [ ] `config` (no args) shows summary approved
- [ ] `config set-source local` behavior approved (preserves Firebase creds)
- [ ] `config set-source firebase` behavior approved (requires existing creds or directs to `init`)

### Impact on Existing Commands (NEW)
- [ ] `sync` warns when `dataSource: 'local'` approved; `--force-remote` flag approved
- [ ] `install-hook` warns when local approved
- [ ] `status` shows data source preference approved
- [ ] `reset` guards against local mode approved

### Strategy
- [ ] "Remove Firebase" strategic direction acknowledged
- [ ] Future vision direction is aligned
- [ ] Ready for implementation planning
