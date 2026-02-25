# `code-insights stats` — Terminal UX Design

> Comprehensive terminal output specification for the stats command suite.
> Covers every subcommand, every state, edge cases, color system, and responsive behavior.

---

## Table of Contents

1. [Design System](#1-design-system)
2. [Auto-Sync UX](#2-auto-sync-ux)
3. [`stats` (Overview)](#3-stats-overview)
4. [`stats cost`](#4-stats-cost)
5. [`stats projects`](#5-stats-projects)
6. [`stats today`](#6-stats-today)
7. [`stats models`](#7-stats-models)
8. [Empty States](#8-empty-states)
9. [Error States](#9-error-states)
10. [Edge Cases](#10-edge-cases)
11. [Responsive Width](#11-responsive-width)
12. [Future Vision](#12-future-vision)

---

## 1. Design System

### 1.1 Color Palette

All colors use chalk. The system is designed to work on both dark and light terminals.

| Element             | chalk call               | Hex approx | Purpose                          |
|---------------------|--------------------------|------------|----------------------------------|
| Section headers     | `chalk.cyan.bold`        | #00BFFF    | "OVERVIEW", "COST", etc.         |
| Metric labels       | `chalk.gray`             | #808080    | "Sessions:", "Total cost:", etc.  |
| Metric values       | `chalk.white.bold`       | #FFFFFF    | Numbers, durations, counts       |
| Money values        | `chalk.green.bold`       | #00FF00    | Dollar amounts (positive)        |
| Money (high spend)  | `chalk.yellow.bold`      | #FFFF00    | Cost values above $10/day        |
| Sparkline chars     | `chalk.cyan`             | #00BFFF    | Unicode sparkline blocks         |
| Bar chart filled    | `chalk.cyan`             | #00BFFF    | Filled portion of bars           |
| Bar chart empty     | `chalk.gray`             | #808080    | Unfilled portion (dim blocks)    |
| Project names       | `chalk.white`            | #FFFFFF    | In lists and breakdowns          |
| Timestamps/dates    | `chalk.gray`             | #808080    | Relative ("2h ago") or absolute  |
| Hints/tips          | `chalk.gray.italic`      | #808080    | "Run stats cost for details"     |
| Dividers            | `chalk.gray`             | #808080    | Horizontal rules (dim ─ chars)   |
| Success indicators  | `chalk.green`            | #00FF00    | Checkmarks, "up to date"         |
| Warning indicators  | `chalk.yellow`           | #FFFF00    | Missing data, partial results    |
| Error indicators    | `chalk.red`              | #FF0000    | Failed operations                |
| Session characters  | (see 1.3)               |            | Color-coded by type              |
| Model names         | `chalk.magenta`          | #FF00FF    | claude-sonnet-4, gpt-4o, etc.   |
| Source tools        | `chalk.blue`             | #0000FF    | claude-code, cursor, codex       |

### 1.2 Typography Conventions

```
SECTION HEADER    chalk.cyan.bold, ALL CAPS, preceded by blank line
  Label:          chalk.gray, 2-space indent
  Value           chalk.white.bold, follows label on same line or right-aligned
  ─────────       chalk.gray, thin horizontal rule (Unicode U+2500)
  Hint text       chalk.gray.italic, 2-space indent, prefixed with arrow
```

### 1.3 Session Character Colors

Each session character type gets a distinct color for its badge/indicator:

| Character       | Display          | chalk call          |
|-----------------|------------------|---------------------|
| `deep_focus`    | `[deep focus]`   | `chalk.blue`        |
| `bug_hunt`      | `[bug hunt]`     | `chalk.red`         |
| `feature_build` | `[feature]`      | `chalk.green`       |
| `exploration`   | `[exploration]`  | `chalk.yellow`      |
| `refactor`      | `[refactor]`     | `chalk.magenta`     |
| `learning`      | `[learning]`     | `chalk.cyan`        |
| `quick_task`    | `[quick task]`   | `chalk.gray`        |

### 1.4 Numeric Formatting

| Type           | Format                  | Examples                          |
|----------------|-------------------------|-----------------------------------|
| Dollars        | `$X.XX`                 | `$0.47`, `$12.30`, `$148.92`     |
| Large dollars  | `$X,XXX.XX`             | `$1,234.56`                       |
| Token counts   | Compact with suffix     | `1.2M`, `450K`, `89K`            |
| Durations      | Smart units             | `23m`, `1h 42m`, `3h 15m`        |
| Percentages    | Integer when >10        | `67%`, `12%`, `3.2%`             |
| Dates          | Relative when < 7d      | `2h ago`, `yesterday`, `3d ago`  |
| Dates          | Absolute when >= 7d     | `Feb 18`, `Jan 3`                |
| Session counts | Plain integer           | `47`, `3`, `182`                  |

### 1.5 Unicode Characters

| Character | Unicode  | Usage                    |
|-----------|----------|--------------------------|
| `▁`       | U+2581   | Sparkline: lowest        |
| `▂`       | U+2582   | Sparkline: low           |
| `▃`       | U+2583   | Sparkline: mid-low       |
| `▅`       | U+2585   | Sparkline: mid-high      |
| `▇`       | U+2587   | Sparkline: high          |
| `█`       | U+2588   | Bar chart: filled        |
| `░`       | U+2591   | Bar chart: empty         |
| `─`       | U+2500   | Horizontal rule          |
| `│`       | U+2502   | Vertical separator       |
| `●`       | U+25CF   | Bullet point / dot       |
| `◦`       | U+25E6   | Secondary bullet         |
| `→`       | U+2192   | Hint prefix              |

### 1.6 Sparkline Algorithm

Sparklines map a series of values to 5 block characters: `▁▂▃▅▇`

```
Characters: ['▁', '▂', '▃', '▅', '▇']  (indices 0-4)
```

**Normalization:**
1. Find `max` of the series. If `max === 0`, all values map to `▁`.
2. For each value: `index = Math.round((value / max) * 4)`
3. Zero values always map to `▁` (not blank).

**Day labels:** The 7-day sparkline shows M T W T F S S below the blocks for orientation.

### 1.7 Bar Chart Algorithm

Horizontal bars use `█` (filled) and `░` (empty).

```
Max bar width: 20 characters (configurable based on terminal width)
```

**Normalization:**
1. Find `max` across all items being charted.
2. For each item: `filledCount = Math.round((value / max) * maxWidth)`
3. Remaining chars filled with `░`.

**Label alignment:** Right-align all labels to the longest label width. Truncate labels longer than 20 characters with `...`.

```
  code-insights  ████████████████░░░░  47 sessions
  batonship-web  ████████░░░░░░░░░░░░  23 sessions
  my-super-lo... ██░░░░░░░░░░░░░░░░░░   5 sessions
```

### 1.8 No-Color Fallback

When `chalk.level === 0` (no color support, piped output, `NO_COLOR` env var):
- All formatting degrades gracefully (chalk handles this automatically)
- Sparklines and bar charts still render (they are Unicode, not color-dependent)
- Section headers use `=== SECTION ===` framing instead of color
- Values remain readable because the layout provides structure

---

## 2. Auto-Sync UX

Every `stats` subcommand auto-syncs before displaying data, unless `--no-sync` is passed.

### 2.1 Normal Sync (Nothing New)

```
  ● Syncing...  ✓ Up to date

```

The spinner shows for ~1-3 seconds while checking for new files.
On completion it transitions to the checkmark.
One blank line separates sync status from stats output.

Implementation: Use `ora` spinner. Spinner text: `"Syncing..."`. On completion:
- Nothing new: `spinner.succeed("Up to date")`
- New sessions: `spinner.succeed("Synced 3 new sessions")`

### 2.2 Sync Finds New Data

```
  ● Syncing...  ✓ Synced 3 new sessions

```

### 2.3 Sync Error (Non-Fatal)

If sync fails, show a warning and proceed with stale data:

```
  ● Syncing...  ⚠ Sync failed (showing cached data)

```

Implementation: `spinner.warn("Sync failed (showing cached data)")` — yellow warning.
Stats still display with whatever data is in Firestore.

### 2.4 Sync Error (Fatal — No Config)

```
  ✗ Not configured. Run `code-insights init` first.
```

This exits immediately. Same behavior as existing commands.

### 2.5 --no-sync Flag

When `--no-sync` is passed, skip the sync entirely. No spinner, no message.
Go straight to stats output.

---

## 3. `stats` (Overview)

The default command with no subcommands. Designed to be the "dashboard glance" — key numbers readable in 2 seconds.

### 3.1 Full Output (Normal State)

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

### 3.2 Visual Hierarchy

1. **First eye-catch:** The 6-metric grid at the top (Sessions, Cost, Time, Messages, Tokens, Projects). Bold white values on gray labels.
2. **Second eye-catch:** The sparkline — a visual "heartbeat" of the week. Cyan blocks draw the eye.
3. **Third eye-catch:** Top projects bar chart — shows distribution at a glance.
4. **Fourth:** Today/Yesterday/This week quick stats — recent context.
5. **Last:** Hint arrows — guide the user deeper.

### 3.3 Color Annotations for 3.1

```
  CODE INSIGHTS                                         Last 7 days
  ^^^^^^^^^^^^^                                         ^^^^^^^^^^^
  chalk.cyan.bold                                       chalk.gray

  Sessions     47        Cost       $12.30        Time      18h 42m
  ^^^^^^^^     ^^        ^^^^       ^^^^^^        ^^^^      ^^^^^^^
  chalk.gray   white.b   chalk.gray green.bold    chalk.gray white.bold

  ACTIVITY                                      ▁▃▇▅▂▅▃
                                                ^^^^^^^
                                                chalk.cyan
  Today          5 sessions    $2.14    3h 20m
  ^^^^^          ^^^^^^^^^^    ^^^^^    ^^^^^^
  chalk.white    chalk.gray    green.b  chalk.gray

  TOP PROJECTS
  code-insights  ████████████████░░░░  23 sessions   $5.80
  ^^^^^^^^^^^^^  ^^^^^^^^              ^^^^^^^^^^^    ^^^^^
  chalk.white    chalk.cyan  chalk.gray chalk.gray    green.bold

  → Run stats cost for cost breakdown
  ^
  chalk.gray.italic (entire hint line)
```

### 3.4 Metric Grid Layout

The 6 metrics arrange in a 3x2 grid with consistent column widths:

```
  {label}  {value}        {label}  {value}        {label}  {value}
```

Each column is ~22 characters wide. Label is right-padded to 10 chars, value left-padded.
On narrow terminals (< 80 cols), this wraps to 2 rows of 2 or a vertical list (see section 11).

### 3.5 Period Flag Behavior

The `--period` flag changes the header text and data range:

| Flag value | Header text    | Sparkline          | Activity breakdown       |
|------------|----------------|--------------------|--------------------------|
| `7d`       | "Last 7 days"  | 7 daily bars       | Today/Yesterday/This week|
| `30d`      | "Last 30 days" | 4 weekly bars      | This week/Last week/Month|
| `90d`      | "Last 90 days" | 12 weekly bars     | This month/Last month    |
| `all`      | "All time"     | 12 monthly bars    | This month/Last 3 months |

Sparkline adapts:
- `7d`: 7 chars, labeled M T W T F S S
- `30d`: 4 chars, labeled W1 W2 W3 W4
- `90d`: 12 chars, labeled by week number
- `all`: 12 chars, labeled by month abbreviation (J F M A ... D)

### 3.6 --project Flag

When scoped to a single project:

```
  CODE INSIGHTS — code-insights-web                     Last 7 days
  ─────────────────────────────────────────────────────────────────

  Sessions     23        Cost        $5.80        Time       9h 30m
  Messages    642        Tokens      2.1M         Models          2

  ACTIVITY                                      ▃▅▇▂▁▃▅
  ──────────────────────────────────────────────  M T W T F S S

  Models used:  claude-sonnet-4 (78%)  claude-opus-4 (22%)

  → Run stats models --project code-insights-web for model details
```

The "TOP PROJECTS" section is replaced with "Models used" when scoped to one project.
The "Projects" metric in the grid changes to "Models" count.

---

## 4. `stats cost`

Detailed cost analysis with breakdowns by project, model, and time.

### 4.1 Full Output

```
  ● Syncing...  ✓ Up to date

  COST BREAKDOWN                                        Last 7 days
  ─────────────────────────────────────────────────────────────────

  Total          $12.30          Avg/day       $1.76
  Avg/session     $0.26          Sessions       47 (42 with cost data)

  DAILY TREND                                   ▁▃▇▅▂▅▃
  ──────────────────────────────────────────────  M T W T F S S
  Peak: Wednesday $3.47 (8 sessions)

  BY PROJECT
  ─────────────────────────────────────────────────────────────────
  code-insights    ████████████████░░░░  $5.80   47.2%   23 sessions
  batonship-web    ████████░░░░░░░░░░░░  $3.20   26.0%   12 sessions
  my-dotfiles      █████░░░░░░░░░░░░░░░  $1.90   15.4%    7 sessions
  side-project     ██░░░░░░░░░░░░░░░░░░  $0.82    6.7%    3 sessions
  experiments      █░░░░░░░░░░░░░░░░░░░  $0.58    4.7%    2 sessions

  BY MODEL
  ─────────────────────────────────────────────────────────────────
  claude-sonnet-4  ██████████████░░░░░░  $7.20   58.5%   38 sessions
  claude-opus-4    ██████░░░░░░░░░░░░░░  $4.10   33.3%    6 sessions
  claude-haiku-4-5 █░░░░░░░░░░░░░░░░░░░  $0.62    5.0%    8 sessions
  gpt-4o           █░░░░░░░░░░░░░░░░░░░  $0.38    3.1%    2 sessions

  TOKEN BREAKDOWN
  ─────────────────────────────────────────────────────────────────
  Input tokens       1.8M     ████████████░░░░░░░░   $5.40
  Output tokens      890K     ██████░░░░░░░░░░░░░░   $4.45
  Cache creation     320K     ██░░░░░░░░░░░░░░░░░░   $1.20
  Cache reads        1.2M     ████████░░░░░░░░░░░░   $0.22
  Cache hit rate     40%

  → Run stats cost --period 30d for monthly trends
  → Run stats models for detailed model analysis
```

### 4.2 Color Annotations for 4.1

```
  COST BREAKDOWN                                        Last 7 days
  ^^^^^^^^^^^^^^                                        ^^^^^^^^^^^
  chalk.cyan.bold                                       chalk.gray

  Total          $12.30          Avg/day       $1.76
  ^^^^^          ^^^^^^          ^^^^^^^       ^^^^^
  chalk.gray     green.bold      chalk.gray    green.bold

  code-insights    ████████████████░░░░  $5.80   47.2%   23 sessions
  ^^^^^^^^^^^^^    ^^^^^^^^^^^^^^^^      ^^^^^   ^^^^^   ^^^^^^^^^^^
  chalk.white      cyan / gray           green.b chalk.gray chalk.gray
```

### 4.3 Sessions Without Cost Data

Some sessions (especially from Cursor, Codex) may not have token/cost data.
The "(42 with cost data)" annotation in the summary makes this clear.

If fewer than 50% of sessions have cost data:

```
  Total          $5.80           Sessions       47 (12 with cost data)
                                                    ^^^^^^^^^^^^^^^^^^
                                                    chalk.yellow

  ⚠ 35 sessions have no cost data (Cursor, Codex sessions lack token info)
  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  chalk.yellow
```

### 4.4 Cost Thresholds

Daily cost coloring:
- `< $5/day`: `chalk.green.bold`
- `$5-$20/day`: `chalk.yellow.bold`
- `> $20/day`: `chalk.red.bold`

This helps users spot expensive days quickly in the trend.

---

## 5. `stats projects`

Per-project detail view. Shows all projects with their stats.

### 5.1 Full Output

```
  ● Syncing...  ✓ Up to date

  PROJECTS                                              Last 7 days
  ─────────────────────────────────────────────────────────────────

  5 projects, 47 sessions, $12.30 total

  ─ code-insights ──────────────────────────────────────────────────
    Sessions   23          Cost      $5.80          Time     9h 30m
    Messages  642          Tokens    2.1M           Model    sonnet-4
    Last active  2h ago                  Source  claude-code
    Activity  ▃▅▇▂▁▃▅

  ─ batonship-web ──────────────────────────────────────────────────
    Sessions   12          Cost      $3.20          Time     4h 45m
    Messages  340          Tokens    1.1M           Model    sonnet-4
    Last active  5h ago                  Source  claude-code
    Activity  ▁▁▃▇▅▁▂

  ─ my-dotfiles ────────────────────────────────────────────────────
    Sessions    7          Cost      $1.90          Time     2h 15m
    Messages  189          Tokens    620K           Model    sonnet-4
    Last active  1d ago                  Source  claude-code
    Activity  ▅▁▁▁▁▇▁

  ─ side-project ───────────────────────────────────────────────────
    Sessions    3          Cost      $0.82          Time     1h 10m
    Messages   84          Tokens    280K           Model    opus-4
    Last active  3d ago                  Source  cursor
    Activity  ▁▁▁▁▃▁▁

  ─ experiments ────────────────────────────────────────────────────
    Sessions    2          Cost      $0.58          Time     1h 02m
    Messages   29          Tokens    150K           Model    sonnet-4
    Last active  5d ago                  Source  claude-code
    Activity  ▁▁▃▁▁▁▁

  → Run stats projects --project code-insights for single project focus
  → Run stats cost --project code-insights for project cost breakdown
```

### 5.2 Project Card Layout

Each project is a "card" with:
- Header line using `─` characters with project name embedded
- 3x2 metric grid (same layout as overview)
- Last active + source tool on one line
- 7-day sparkline

### 5.3 Color Annotations

```
  ─ code-insights ──────────────────────────────────────────────────
  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  chalk.gray (dim rule), project name in chalk.white.bold

    Sessions   23          Cost      $5.80          Time     9h 30m
    ^^^^^^^^   ^^          ^^^^      ^^^^^          ^^^^     ^^^^^^
    chalk.gray white.bold  chalk.gray green.bold    chalk.gray white.bold

    Last active  2h ago                  Source  claude-code
    ^^^^^^^^^^^  ^^^^^^                  ^^^^^^  ^^^^^^^^^^^
    chalk.gray   chalk.gray              chalk.gray chalk.blue
```

### 5.4 Sorting

Projects are sorted by session count (descending) by default.
Within the `--period` window only. "All time" uses total session count.

### 5.5 --project Flag (Single Project Deep Dive)

When `--project <name>` is passed, show only that project with additional detail:

```
  PROJECT — code-insights                               Last 7 days
  ─────────────────────────────────────────────────────────────────

  Sessions   23          Cost      $5.80          Time     9h 30m
  Messages  642          Tokens    2.1M           Avg cost  $0.25

  ACTIVITY                                      ▃▅▇▂▁▃▅
  ──────────────────────────────────────────────  M T W T F S S

  MODELS USED
  ─────────────────────────────────────────────────────────────────
  claude-sonnet-4  ██████████████████░░  $4.50   78%   18 sessions
  claude-opus-4    ████░░░░░░░░░░░░░░░░  $1.30   22%    5 sessions

  RECENT SESSIONS
  ─────────────────────────────────────────────────────────────────
  Today  2h ago   Fix auth callback redirect loop        32m   $0.47
  Today  5h ago   Add Firestore index error surfacing    1h 12m $0.89
  Yest.  1d ago   Implement session character badges     45m   $0.34
  Yest.  1d ago   Update sidebar navigation active state 18m   $0.12
  Feb 22 3d ago   Refactor LLM provider factory          2h 5m  $1.20

  → Run stats cost --project code-insights for full cost analysis
```

---

## 6. `stats today`

Today's sessions in detail. The "what did I do today?" view.

### 6.1 Full Output

```
  ● Syncing...  ✓ Up to date

  TODAY                                            Tue, Feb 25, 2026
  ─────────────────────────────────────────────────────────────────

  Sessions      5          Cost      $2.14          Time     3h 20m
  Messages    138          Tokens    890K

  ─────────────────────────────────────────────────────────────────

  10:32 AM  code-insights                                   32m  $0.47
            Fix auth callback redirect loop
            [bug hunt]  sonnet-4  47 messages

   8:45 AM  code-insights                                 1h 12m  $0.89
            Add Firestore index error surfacing
            [feature]  sonnet-4  62 messages

   7:20 AM  batonship-web                                   45m  $0.34
            Implement session character badges
            [feature]  sonnet-4  38 messages

   6:50 AM  batonship-web                                   18m  $0.12
            Update sidebar navigation active state
            [quick task]  sonnet-4  12 messages

   6:15 AM  my-dotfiles                                     22m  $0.32
            Configure zsh completion for code-insights
            [exploration]  opus-4  19 messages

  ─────────────────────────────────────────────────────────────────
  Daily total    5 sessions    $2.14    3h 20m    890K tokens

  → Run stats cost --period 7d for weekly cost trends
```

### 6.2 Session Row Layout

Each session gets 3 lines:

```
  {time}  {project}                                 {duration}  {cost}
          {title}
          [{character}]  {model}  {message_count} messages
```

Line 1: Time (left), project name (left-after-time), duration + cost (right-aligned)
Line 2: Session title — uses same priority as web: customTitle > generatedTitle > summary > "Untitled Session"
Line 3: Character badge (colored), model (magenta), message count (gray)

### 6.3 Color Annotations

```
  10:32 AM  code-insights                                   32m  $0.47
  ^^^^^^^^  ^^^^^^^^^^^^^                                   ^^^  ^^^^^
  chalk.gray chalk.white                                    gray green.bold

            Fix auth callback redirect loop
            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
            chalk.white.bold

            [bug hunt]  sonnet-4  47 messages
            ^^^^^^^^^^  ^^^^^^^^  ^^^^^^^^^^^
            chalk.red   chalk.magenta chalk.gray
```

### 6.4 Time Format

Sessions are listed in reverse chronological order (most recent first).
Times use 12-hour format: `10:32 AM`, `2:15 PM`.

### 6.5 Sessions Without Titles

If a session has no title at all (no customTitle, generatedTitle, or summary):

```
   8:45 AM  code-insights                                 1h 12m  $0.89
            Untitled Session
            [deep focus]  sonnet-4  62 messages
```

`"Untitled Session"` displayed in `chalk.gray.italic`.

### 6.6 Sessions Without Cost Data

```
  10:32 AM  side-project                                    32m      —
            Debug cursor integration
            [bug hunt]  —  47 messages
```

Cost shows as `—` (em dash) in `chalk.gray`. Model shows as `—` too.

---

## 7. `stats models`

Model usage distribution, cost per model, and trends.

### 7.1 Full Output

```
  ● Syncing...  ✓ Up to date

  MODEL USAGE                                           Last 7 days
  ─────────────────────────────────────────────────────────────────

  4 models across 47 sessions

  ─ claude-sonnet-4 ────────────────────────────────────────────────
    Sessions  38 (80.9%)      Cost    $7.20 (58.5%)
    Tokens    3.2M            Avg/session  $0.19
    Input     $3.80           Output  $2.90      Cache  $0.50
    Trend     ▂▃▇▅▃▅▃

  ─ claude-opus-4 ──────────────────────────────────────────────────
    Sessions   6 (12.8%)      Cost    $4.10 (33.3%)
    Tokens    480K            Avg/session  $0.68
    Input     $1.80           Output  $2.10      Cache  $0.20
    Trend     ▁▁▃▁▁▅▁

  ─ claude-haiku-4-5 ───────────────────────────────────────────────
    Sessions   8 (17.0%)      Cost    $0.62 (5.0%)
    Tokens    310K            Avg/session  $0.08
    Input     $0.18           Output  $0.40      Cache  $0.04
    Trend     ▁▅▃▁▃▁▁

  ─ gpt-4o ─────────────────────────────────────────────────────────
    Sessions   2 (4.3%)       Cost    $0.38 (3.1%)
    Tokens    150K            Avg/session  $0.19
    Input     $0.12           Output  $0.22      Cache  $0.04
    Trend     ▁▁▁▁▁▃▁

  COST DISTRIBUTION
  ─────────────────────────────────────────────────────────────────
  claude-sonnet-4  ████████████████████░░░░░░░░░░░░░░  58.5%  $7.20
  claude-opus-4    ███████████░░░░░░░░░░░░░░░░░░░░░░░  33.3%  $4.10
  claude-haiku-4-5 ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   5.0%  $0.62
  gpt-4o           █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   3.1%  $0.38

  → Run stats cost for time-based cost analysis
```

### 7.2 Model Card Layout

Each model gets a compact card:
- Header with model name in `─` rule
- Sessions count with percentage, Cost with percentage
- Token total, average cost per session
- Input/Output/Cache cost breakdown
- 7-day sparkline for the model's usage trend

### 7.3 Model Name Display

Model names are shortened for display while remaining unambiguous:

| Full model ID                     | Display               |
|-----------------------------------|-----------------------|
| `claude-sonnet-4`                 | `claude-sonnet-4`     |
| `claude-sonnet-4-5-20250929`      | `claude-sonnet-4-5`   |
| `claude-opus-4-6`                 | `claude-opus-4-6`     |
| `claude-3-5-sonnet-20241022`      | `claude-3.5-sonnet`   |
| `gpt-4o`                          | `gpt-4o`              |

Strip date suffixes. Shorten `claude-3-5-*` to `claude-3.5-*` for readability.

### 7.4 Note on Session Percentage > 100%

A session can use multiple models. Session percentages for models may sum to > 100%.
This is because `primaryModel` counts per-session, but a session with 2 models appears in both.
The `(80.9%)` reflects "% of sessions where this model was the primaryModel".

---

## 8. Empty States

### 8.1 No Sessions At All (Fresh Install)

Applies to all subcommands:

```
  ● Syncing...  ✓ Up to date

  No sessions found.

  Get started:
    1. Use Claude Code, Cursor, or Codex on a project
    2. Run code-insights sync to upload your sessions
    3. Run code-insights stats to see your analytics

```

### 8.2 No Sessions in Period

When there are sessions overall, but none in the selected period:

```
  CODE INSIGHTS                                         Last 7 days
  ─────────────────────────────────────────────────────────────────

  No sessions in the last 7 days.

  Last session: Feb 18 (7 days ago) in code-insights

  → Run stats --period 30d to expand the time range
```

### 8.3 No Cost Data

When sessions exist but none have cost data:

```
  COST BREAKDOWN                                        Last 7 days
  ─────────────────────────────────────────────────────────────────

  No cost data available.

  Cost tracking requires token usage data from your AI tool.
  Currently supported:
    ● Claude Code — full token + cost tracking
    ● Cursor     — session data only (no token info)
    ● Codex      — session data only (no token info)

  → Re-sync with latest CLI: code-insights sync --force
```

### 8.4 No Sessions Today (`stats today`)

```
  TODAY                                            Tue, Feb 25, 2026
  ─────────────────────────────────────────────────────────────────

  No sessions yet today.

  Last session: yesterday at 11:42 PM in code-insights
    "Fix authentication callback redirect loop"

  → Start a coding session and run stats today to see it here
```

### 8.5 No Model Data (`stats models`)

```
  MODEL USAGE                                           Last 7 days
  ─────────────────────────────────────────────────────────────────

  No model data available.

  Model tracking requires token usage data.
  Re-sync to pick up model info: code-insights sync --force
```

### 8.6 Single Project Only

When there is only 1 project, the "TOP PROJECTS" section in overview adjusts:

```
  TOP PROJECTS
  ─────────────────────────────────────────────────────────────────
  code-insights  ████████████████████  47 sessions   $12.30

  → You have 1 project. Run stats projects for details.
```

No bar chart comparison needed with a single project — just show a full bar.

---

## 9. Error States

### 9.1 Firebase Connection Failed

```
  ✗ Failed to connect to Firebase

  Check your configuration:
    code-insights status

  Common fixes:
    ● Verify your service account key hasn't expired
    ● Check your network connection
    ● Re-initialize: code-insights init
```

### 9.2 Firestore Query Error

```
  ● Syncing...  ✓ Up to date

  ✗ Failed to load stats

  Error: Missing Firestore index for sessions query.
  Create it here: https://console.firebase.google.com/...

  If this persists, try: code-insights sync --force
```

### 9.3 Project Not Found (--project flag)

```
  ● Syncing...  ✓ Up to date

  Project "batonshipp" not found.

  Did you mean?
    ● batonship-web

  Available projects:
    ● code-insights (23 sessions)
    ● batonship-web (12 sessions)
    ● my-dotfiles (7 sessions)
```

Uses simple Levenshtein distance for "Did you mean?" suggestions.

### 9.4 Invalid Period Flag

```
  Invalid period "2w". Expected: 7d, 30d, 90d, or all

  Examples:
    code-insights stats --period 30d
    code-insights stats cost --period all
```

---

## 10. Edge Cases

### 10.1 Very Long Project Names

Project names are truncated to 20 characters with `...` in bar charts and tables:

```
  my-super-long-pro...  ██████████░░░░░░░░░░  12 sessions   $3.20
```

In project cards (section headers), the full name is shown:

```
  ─ my-super-long-project-name ─────────────────────────────────────
```

### 10.2 No Cost Data for Some Sessions (Mixed State)

Show available data with a note:

```
  Sessions      47          Cost      $9.80          Time     18h 42m
  Messages   1,284          Tokens    3.8M

  ⚠ 5 of 47 sessions have no cost data (cursor sessions)
```

The warning appears only once, below the metric grid. Sessions without cost data
are simply excluded from cost calculations. Session counts always include all sessions.

### 10.3 Single Session Only

When there is only one session total:

```
  CODE INSIGHTS                                            All time
  ─────────────────────────────────────────────────────────────────

  Sessions      1          Cost      $0.47          Time       32m
  Messages     47          Tokens    180K           Projects     1

  Your first session! Keep coding to build up your stats.

  → Run stats today for session details
```

No sparkline (not meaningful with 1 data point). No bar chart.
Encouraging message instead.

### 10.4 Very High Session Counts

When session count > 999, use compact format in the metric grid:

```
  Sessions   1,284       Cost     $148.92        Time    142h 30m
```

Numbers get comma-separated. Time shows hours even when > 24h (not days).
This is intentional — developers think in hours for coding time, not days.

### 10.5 $0.00 Cost

When cost data exists but rounds to zero:

```
  Total          $0.00           Avg/day       $0.00
```

Still shown as green. Not hidden or replaced with "Free".

### 10.6 Source Tool Filtering (--source flag)

```
  CODE INSIGHTS — claude-code only                      Last 7 days
  ─────────────────────────────────────────────────────────────────

  Sessions     42        Cost       $11.80        Time      16h 30m
```

The header shows the filter. All data is scoped to that source tool.

### 10.7 Multiple Source Tools

When user has sessions from multiple tools, the overview adds a source breakdown:

```
  SOURCES
  ─────────────────────────────────────────────────────────────────
  claude-code   ██████████████████░░  42 sessions   $11.80
  cursor        ██░░░░░░░░░░░░░░░░░░   5 sessions       —
```

This appears after TOP PROJECTS only if there are 2+ sources.

### 10.8 Cost Exactly $0.00 vs Missing

- `estimatedCostUsd === 0` : Show `$0.00` (the session had usage but cost was negligible)
- `estimatedCostUsd === undefined` : Show `—` (no cost data exists)

---

## 11. Responsive Width

### 11.1 Detection

Use `process.stdout.columns` (or default to 80 if unavailable).

### 11.2 Wide Terminal (>= 100 cols)

Full layout as shown in all mockups above. Bar charts use 20-char width.
Metric grid uses 3-column layout.

### 11.3 Standard Terminal (80-99 cols)

Same layout but bar charts shrink to 16 chars. Everything else fits.

### 11.4 Narrow Terminal (60-79 cols)

- Metric grid becomes 2 columns:
  ```
  Sessions     47        Cost       $12.30
  Messages   1,284       Tokens     4.2M
  Time      18h 42m      Projects     5
  ```

- Bar charts shrink to 12 chars:
  ```
  code-insights  ████████░░░░  23   $5.80
  batonship-web  ████░░░░░░░░  12   $3.20
  ```

- Session rows in `stats today` truncate titles:
  ```
  10:32  code-insights              32m  $0.47
         Fix auth callback redi...
         [bug hunt]  sonnet-4
  ```

### 11.5 Very Narrow Terminal (< 60 cols)

- Metric grid becomes single column:
  ```
  Sessions   47
  Cost       $12.30
  Time       18h 42m
  Messages   1,284
  Tokens     4.2M
  Projects   5
  ```

- Bar charts replaced with simple list:
  ```
  code-insights   23 sessions  $5.80
  batonship-web   12 sessions  $3.20
  ```

- Sparklines still shown (they are only 7 chars wide).

### 11.6 Implementation

```typescript
function getTerminalWidth(): number {
  return process.stdout.columns || 80;
}

function getBarWidth(): number {
  const width = getTerminalWidth();
  if (width >= 100) return 20;
  if (width >= 80) return 16;
  if (width >= 60) return 12;
  return 0; // disable bar charts
}

function getGridColumns(): number {
  const width = getTerminalWidth();
  if (width >= 80) return 3;
  if (width >= 60) return 2;
  return 1;
}
```

---

## 12. Future Vision

> These commands are **not in scope** for the current `stats` implementation.
> They are documented here as future direction for the CLI.

### 12.1 `code-insights learnings`

Bring insight browsing from the web dashboard to the terminal. Query the `insights`
collection in Firestore and display learnings in a terminal-friendly format.

```
code-insights learnings --today
code-insights learnings --project code-insights --period 7d
code-insights learnings --type technique
```

**Potential output:**

```
  LEARNINGS                                        Tue, Feb 25, 2026
  ─────────────────────────────────────────────────────────────────

  3 learnings from today's sessions

  ● Firestore composite indexes must be created manually
    Session: "Fix auth callback redirect loop"
    Project: code-insights
    When Firestore queries use orderBy with a where clause on different
    fields, a composite index is required. The error message includes a
    direct URL to create the needed index in Firebase Console.

  ● chalk.level detection for CI environments
    Session: "Add terminal color support checks"
    Project: code-insights
    In CI pipelines, chalk.level may be 0 even if the terminal supports
    colors. Use FORCE_COLOR=1 env var to override.

  ● Commander.js subcommand groups via .addCommand()
    Session: "Implement stats command suite"
    Project: code-insights
    Unlike .command(), addCommand() allows building command trees where
    the parent command has its own action handler.
```

### 12.2 `code-insights decisions`

Browse architectural and technical decisions extracted from sessions.

```
code-insights decisions --project batonship --timeline today
code-insights decisions --project code-insights --period 30d
code-insights decisions --type architecture
```

**Potential output:**

```
  DECISIONS — batonship                                       Today
  ─────────────────────────────────────────────────────────────────

  1 decision from today

  ● Use Supabase Auth instead of Firebase Auth
    Session: "Evaluate auth providers for BYOF model"
    Confidence: 87%

    Chose Supabase for auth-only use case because it cleanly separates
    authentication (Supabase) from data storage (user's Firebase),
    supporting the BYOF model without conflating concerns.

    Alternatives considered:
      ◦ Firebase Auth — would couple auth to user's Firebase project
      ◦ Auth0 — more complex setup, higher cost at scale
      ◦ Clerk — good DX but vendor lock-in concerns
```

### 12.3 General Insight Querying

A unified interface for querying any insight type from the terminal:

```
code-insights insights --type summary --period 7d
code-insights insights --type prompt_quality --project code-insights
code-insights insights --search "caching strategy"
```

This would mirror the web dashboard's insight browsing page but for terminal users
who prefer staying in the CLI.

### 12.4 Design Principles for Future Commands

These future commands should follow the same design system:
- Same color palette and typography conventions
- Same section header style (CAPS, cyan bold, horizontal rules)
- Same metric formatting (durations, costs, tokens)
- Same empty/error state patterns
- Same hint arrow pattern for progressive disclosure
- Content-heavy output (insight text) uses regular white, not bold
- Long text wraps at terminal width minus 4 (2-char indent each side)

---

## Appendix A: Complete Flag Reference

| Flag | Short | Applies to | Default | Description |
|------|-------|------------|---------|-------------|
| `--period <val>` | `-p` | all | `7d` | Time range: `7d`, `30d`, `90d`, `all` |
| `--project <name>` | none | all | none | Scope to single project |
| `--source <tool>` | none | all | none | Filter by source tool |
| `--no-sync` | none | all | false | Skip auto-sync before display |

## Appendix B: Data Requirements per Subcommand

| Subcommand | Firestore collections read | Key fields used |
|------------|---------------------------|-----------------|
| `stats` | `sessions`, `projects` | startedAt, endedAt, estimatedCostUsd, projectName, messageCount, totalInputTokens, totalOutputTokens |
| `stats cost` | `sessions`, `projects` | estimatedCostUsd, primaryModel, totalInputTokens, totalOutputTokens, cacheCreationTokens, cacheReadTokens |
| `stats projects` | `sessions`, `projects` | All session fields, project.lastActivity, project.sessionCount |
| `stats today` | `sessions` | startedAt, endedAt, customTitle, generatedTitle, summary, sessionCharacter, primaryModel, estimatedCostUsd, messageCount, projectName |
| `stats models` | `sessions` | primaryModel, modelsUsed, estimatedCostUsd, totalInputTokens, totalOutputTokens, cacheCreationTokens, cacheReadTokens |

## Appendix C: Firestore Query Patterns

All subcommands need time-range filtering. The primary query pattern:

```typescript
// Sessions in period
firestore.collection('sessions')
  .where('startedAt', '>=', periodStart)
  .orderBy('startedAt', 'desc')
  .get()
```

With project filter:
```typescript
firestore.collection('sessions')
  .where('projectId', '==', projectId)
  .where('startedAt', '>=', periodStart)
  .orderBy('startedAt', 'desc')
  .get()
```

With source filter:
```typescript
firestore.collection('sessions')
  .where('sourceTool', '==', sourceTool)
  .where('startedAt', '>=', periodStart)
  .orderBy('startedAt', 'desc')
  .get()
```

**Index requirements:** These queries require composite Firestore indexes:
- `sessions`: `(startedAt DESC)` — already exists
- `sessions`: `(projectId ASC, startedAt DESC)` — may need creation
- `sessions`: `(sourceTool ASC, startedAt DESC)` — may need creation

The implementation should handle index-missing errors gracefully and print the
Firebase Console URL for index creation (same pattern as the web dashboard).
