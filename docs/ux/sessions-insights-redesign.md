# Sessions & Insights Page Redesign

> UX Audit + Redesign Proposal
> Status: PARTIALLY IMPLEMENTED (Tier 1 + Tier 2 complete)
> Date: 2026-03-02 (updated 2026-03-03)

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [UX Audit Findings](#2-ux-audit-findings)
3. [Redesign Proposal: Sessions Page](#3-redesign-proposal-sessions-page)
4. [Redesign Proposal: Insights Page](#4-redesign-proposal-insights-page)
5. [Cross-Cutting Improvements](#5-cross-cutting-improvements)
6. [ASCII Wireframes](#6-ascii-wireframes)
7. [Implementation Priority](#7-implementation-priority)

---

## 1. Current State Analysis

### 1.1 Sessions Page (`/sessions`)

> **IMPLEMENTED (PR #96).** Now a three-panel master-detail layout. See `docs/ux/sessions-three-panel-design.md` for the full spec.

**Current state (post-Tier 2):**
- Three-panel layout: Panel A (project nav, 220px) + Panel B (session list, 320px) + Panel C (session detail, flex-1)
- Session selection via URL query param: `/sessions?session=<id>&project=<id>`
- Panel B: compact session rows grouped by date, search + character/status filters
- Panel C: VitalsStrip (horizontal grid) + tabs (Overview/Conversation)
- Responsive: xl=3 panels, lg=2+drawer, below lg=Sheet slide-over
- Old `/sessions/:id` URLs redirect to `/sessions?session=<id>`

**Data available but NOT surfaced in the list:**
- `estimated_cost_usd` -- available on Session type but not shown in SessionRow (only in SessionCard)
- `primary_model` / `models_used` -- not shown in list
- `git_branch` -- not shown in SessionRow
- `summary` -- not shown in SessionRow (only in SessionCard)
- `user_message_count` / `assistant_message_count` -- only total shown
- Token counts (input/output/cache) -- not surfaced in list
- `device_hostname` / `device_platform` -- not surfaced anywhere meaningful
- Insight count per session -- fetched but only used for analyzed/unanalyzed badge

**Components involved (post-Tier 2):**
- `SessionsPage.tsx` (page) -- three-panel container
- `ProjectNav.tsx` -- Panel A project navigation
- `SessionListPanel.tsx` + `CompactSessionRow.tsx` -- Panel B session list
- `SessionDetailPanel.tsx` + `VitalsStrip.tsx` -- Panel C session detail

### 1.2 Session Detail (`/sessions?session=<id>`)

> **IMPLEMENTED (PR #96).** Now renders inline in Panel C of the three-panel layout instead of as a standalone page. `/sessions/:id` redirects to `/sessions?session=<id>`.

**Current state (post-Tier 2):**
- Renders in Panel C (flex-1) of the three-panel layout
- Compact header: title, character badge, outcome badge, rename, analyze, export
- VitalsStrip: horizontal 4-column grid (duration, messages, tools, cost) + secondary row (tokens with input/cache/output breakdown, model, branch, source)
- Two tabs: Overview | Conversation
- Overview: Summary, PR links, Insights (prompt quality, learnings, decisions)
- Conversation: search bar with prev/next match navigation, message highlighting

**Remaining gaps (for future tiers):**
- Prev/next session navigation solved by Panel B list (click to switch)
- Deep linking to specific insights within a session not yet implemented
- Inline text highlighting in conversation search (only message-level highlighting)

### 1.3 Insights Page (`/insights`)

**Current behavior:**
- List/grid toggle
- Filters: search, project, type
- Prompt quality cards shown first, then other insights
- List mode: InsightListItem (expandable accordion)
- Grid mode: InsightCard (compact card)
- Each insight has: type icon, type badge, title, bullets, confidence, timestamp, "View session" link

**Data available but not well surfaced:**
- Rich decision metadata (situation, choice, alternatives, reasoning, trade_offs, revisit_when) -- shown only when expanded in list view, crammed into plain text
- Rich learning metadata (symptom, root_cause, takeaway, applies_when) -- shown only when expanded
- `linked_insight_ids` / recurring patterns -- shown as "Recurring Nx" badge but no grouping
- Session context (session title, duration, character) -- only session_id link shown
- Insight `scope` (session/project/overall) -- never shown
- `analysis_version` -- never shown
- Cross-project patterns -- no way to see insights that span projects
- No sorting beyond the API's timestamp DESC default

---

## 2. UX Audit Findings

### 2.1 Information Hierarchy Issues

**Sessions Page:**
1. **Cost is invisible.** The most financially relevant data point (estimated_cost_usd) is not shown in SessionRow at all. Users cannot scan for expensive sessions.
2. **Analyzed status is binary and low-signal.** "analyzed" / "not analyzed" doesn't tell you WHAT was found. A session with 5 learnings looks the same as one with only a summary.
3. **Session character gets no explanation.** The badge says "Bug Hunt" but there's no tooltip explaining what that means or why it was classified that way.
4. **Date grouping is too coarse.** "This Week" and "Earlier" are enormous buckets. A user with 20 sessions/day sees a wall of rows.
5. **No summary preview.** Users must click into a session to discover what it was about.

**Session Detail Page:**
1. **Overview tab is a vertical scroll.** Summary, PR links, vitals, usage, insights are all stacked. With many insights, key info (vitals, summary) scrolls off.
2. **Insights on Overview lack the rich metadata.** The page uses InsightCard which only shows bullets and evidence. The decomposed metadata (situation, reasoning, alternatives) is only in InsightListItem's expanded state. Users see a worse version of their own insights on the detail page than on the insights page.
3. **Conversation and Insights are disconnected.** You can't see which message an insight came from. There's no way to jump from an insight to the conversation context.
4. **Usage stats are hidden behind a collapsible.** Cost and model info are important enough to be always-visible.
5. **No session outcome indicator.** The summary insight has an `outcome` field (success/partial/abandoned/blocked) but it's never rendered.

**Insights Page:**
1. **All insight types are rendered identically.** Decisions, learnings, techniques, and summaries use the same card layout. But their metadata structures are fundamentally different. A decision has situation/choice/alternatives/trade-offs. A learning has symptom/root-cause/takeaway. Rendering both as "title + bullets" wastes the rich structure.
2. **No grouping or aggregation.** Insights are a flat chronological list. There's no way to see "all decisions I made this week" or "recurring patterns across projects."
3. **Recurring insights have no navigation.** The "Recurring 3x" badge doesn't let you click through to see the linked insights.
4. **Search is basic text matching.** No ability to search by metadata fields (e.g., "all decisions where I chose TypeScript over Python").
5. **No relationship to session context.** The "View session" link is a tiny text link at the bottom of expanded items. There's no session title, project, or date context shown inline.

### 2.2 Navigation & Flow Problems

1. **Sessions -> Insights is one-way.** From session detail, you can see its insights. But from the Insights page, the only link back is a small "View session" text link.
2. **No deep linking to specific insights.** You can't share a URL to a specific insight.
3. **No "related sessions" navigation.** From a session, you can't find other sessions in the same project, on the same branch, or of the same character type.
4. **Filter state is lost on navigation.** Going from Sessions (filtered by project) to a session detail and back loses the filter state.
5. **Conversation tab has no way to search/filter.** In a 200-message session, finding a specific discussion is scroll-only.

### 2.3 Interaction Gaps

1. **No bulk operations on Sessions page.** Can't select multiple sessions to analyze, export, or compare.
2. **No sorting options.** Sessions are always newest-first. Can't sort by cost, duration, message count, or character.
3. **No keyboard shortcuts.** j/k navigation, Enter to open, Esc to go back.
4. **Insights can't be bookmarked/starred.** No way to mark an insight as particularly important.
5. **No insight deletion from the Insights page.** Delete endpoint exists but no UI for it.
6. **No conversation search.** Can't Cmd+F through messages effectively because of pagination.

### 2.4 Content Presentation Issues

1. **Decision insights need a structured layout.** Situation -> Choice -> Reasoning -> Alternatives -> Trade-offs is a natural flow that the current bullet list destroys.
2. **Learning insights need a cause-effect layout.** Symptom -> Root Cause -> Takeaway -> Applies When tells a story that flat bullets can't convey.
3. **Prompt quality score is visually weak.** A number with a color is the only indicator. A progress ring or gauge would communicate the score more intuitively.
4. **Tool panels in conversation lack density.** Each tool call takes significant vertical space. File reads with long outputs are especially wasteful. Collapsing by default with a preview would help.
5. **Thinking blocks could be more compact.** They expand to full height. A "thinking..." indicator with expand-on-click would be better.

---

## 3. Redesign Proposal: Sessions Page

### 3.1 Session List: Enhanced Row

Replace the current flat row with a richer, more scannable format.

**New data surfaced per row:**
- Cost badge (color-coded: green <$0.10, yellow <$0.50, red >$0.50)
- Model name (compact, e.g., "Opus 4" not "claude-opus-4-20250514")
- 1-line summary preview (from session summary or first insight title)
- Insight count with type breakdown (e.g., "3 insights: 2 learnings, 1 decision")
- Outcome badge (if analyzed: success/partial/abandoned/blocked from summary insight metadata)
- Git branch (if present, as a subtle mono label)

**Removed from default view:**
- "analyzed" / "not analyzed" text -- replaced by insight count (0 = unanalyzed)

### 3.2 Session List: Compact Table Mode

Add a toggle between the current "card" view and a dense table view for power users who want to scan many sessions quickly.

Table columns: Title | Project | Character | Cost | Messages | Duration | Model | Insights | Date

The table should support:
- Click column headers to sort
- Resize columns (stretch, not drag)
- Sticky header on scroll

### 3.3 Session List: Improved Grouping & Pagination

- Replace "This Week" / "Earlier" with daily groups (Mon Mar 3, Sun Mar 2, etc.)
- Add virtual scrolling for large lists (>100 sessions)
- Add a "Load more" button at the bottom instead of fixed limit=200
- Show a count per day group: "Tuesday, Mar 4 (7 sessions)"

### 3.4 Session List: Quick Actions

On hover/right-click, show:
- Analyze (if not analyzed)
- Export as Markdown
- Rename
- Copy session ID

### 3.5 Session Filters: Enhancements

**New filter options:**
- Sort by: newest, oldest, most expensive, longest, most messages, most tool calls
- Date range picker (not just the relative groups)
- Cost range (free, <$0.10, <$0.50, >$0.50)
- Model filter (from the distinct models in the dataset)
- Has insights / no insights (replaces the analyzed/unanalyzed dropdown with an insight count filter)
- Git branch filter (populated from distinct branches)

**Filter UX improvement:**
- Move filters to a collapsible filter bar (hidden by default, toggle with a Filter icon button)
- Show active filter count as a badge on the Filter button
- Each active filter shown as a removable chip/tag below the search bar

### 3.6 Session Detail Layout

> **IMPLEMENTED (PR #96).** Evolved into a page-level three-panel layout instead of a detail-page sidebar. See `docs/ux/sessions-three-panel-design.md`.

The original proposal was a sidebar within the detail page. This was built (SessionSidebar, w-72) but then superseded by the three-panel master-detail layout where:
- Panel A (220px) provides project navigation (replaces "Same project" link)
- Panel B (320px) provides session list (replaces prev/next navigation)
- Panel C (flex-1) renders session detail with VitalsStrip (horizontal grid, replaces vertical sidebar)

**Why the sidebar was replaced:** With 540px consumed by Panels A+B, a 288px sidebar in Panel C would require 1308px minimum viewport. The VitalsStrip presents the same data in a compact horizontal grid that works at any Panel C width.

**Mobile:** Sidebar collapses into a horizontal pill strip above the main content.

### 3.7 Session Detail: Overview Improvements

1. **Outcome badge in header.** Show success/partial/abandoned/blocked as a prominent badge next to the title.
2. **Summary card with better layout.** Title + bullets + outcome in a styled card.
3. **Insight cards use type-specific layouts** (see Section 4 for details). Decisions show the structured situation/choice/reasoning format. Learnings show symptom/root-cause/takeaway.
4. **Cost and model always visible.** Move from collapsible to always-shown in sidebar.
5. **Related sessions section.** "Other sessions in code-insights" linking to filtered sessions list.

### 3.8 Session Detail: Conversation Improvements

1. **Message search.** Add a search bar at the top of the Conversation tab. Highlights matching messages and provides prev/next navigation.
2. **Message anchoring from insights.** Each insight should link to the message range it was derived from. Clicking an insight on the overview scrolls to that point in the conversation.
3. **Thinking blocks collapsed by default.** Show "Claude was thinking..." with expand toggle. Saves vertical space.
4. **Tool call panels collapsed by default.** Show a compact 1-line summary (e.g., "Read: src/index.ts"). Expand on click to see full content. Exception: Edit panels show the diff summary always.
5. **Message timestamp on every message.** Currently only shown on group-start messages.

---

## 4. Redesign Proposal: Insights Page

### 4.1 Type-Specific Insight Cards

The biggest functional improvement: render each insight type with a layout designed for its data structure.

#### Decision Card

```
+----------------------------------------------------+
| (GitCommit) DECISION          <blue badge>         |
|                                                     |
| Title: "Chose SQLite over PostgreSQL"               |
|                                                     |
| SITUATION                                           |
| Needed a database for local session storage.        |
|                                                     |
| CHOICE                                              |
| SQLite via better-sqlite3                           |
|                                                     |
| REASONING                                           |
| Zero config, no server process, single file,        |
| WAL mode for concurrent reads.                      |
|                                                     |
| ALTERNATIVES CONSIDERED                             |
| - PostgreSQL (rejected: requires server process)    |
| - LevelDB (rejected: no SQL queries)               |
|                                                     |
| TRADE-OFFS                                          |
| Limited concurrent writes, 2GB practical limit.     |
|                                                     |
| REVISIT WHEN                                        |
| Multi-device sync or team features needed.          |
|                                                     |
| [code-insights] · 3 days ago · View session ->      |
+----------------------------------------------------+
```

Each section is a labeled field, not a bullet point. Empty fields are omitted. The "situation -> choice -> reasoning -> alternatives -> trade-offs -> revisit" flow tells the complete decision story.

#### Learning Card

```
+----------------------------------------------------+
| (BookOpen) LEARNING           <green badge>        |
|                                                     |
| Title: "Tailwind v4 requires explicit dark variant" |
|                                                     |
| WHAT HAPPENED (symptom)                             |
| Dark mode styles weren't applying after upgrading   |
| to Tailwind v4.                                     |
|                                                     |
| WHY (root cause)                                    |
| Tailwind v4 removed automatic dark: variant support |
| requiring @custom-variant declaration.              |
|                                                     |
| TAKEAWAY                                            |
| Add @custom-variant dark (&:where(.dark, .dark *)); |
| to globals.css for class-based dark mode.           |
|                                                     |
| APPLIES WHEN                                        |
| Any Tailwind v3 -> v4 migration with class-based    |
| dark mode.                                          |
|                                                     |
| Evidence: globals.css, ThemeProvider.tsx             |
|                                                     |
| [code-insights] · 5 days ago · View session ->      |
+----------------------------------------------------+
```

The symptom -> root cause -> takeaway -> applies when flow matches how developers naturally think about lessons learned.

#### Prompt Quality Card (Enhanced)

```
+----------------------------------------------------+
| (Target) PROMPT QUALITY       <rose badge>         |
|                                                     |
| +----------+  72/100 Good                          |
| | [Ring]   |  Could save ~4 messages               |
| | 72       |                                       |
| +----------+                                       |
|                                                     |
| SESSION TRAITS                                      |
| [!] Context Drift (high)  [!] Late Context (med)   |
| [+] Well Structured (positive)                     |
|                                                     |
| ANTI-PATTERNS            WASTED TURNS (3)          |
| - Vague instructions 2x  Msg #4: Too broad...     |
| - Missing context 1x     Msg #7: Forgot to...     |
|                          Msg #12: Repeated...      |
|                                                     |
| TIPS                                                |
| - Start with clear scope                           |
| - Provide file paths upfront                       |
|                                                     |
| [code-insights] · 2 days ago · View session ->      |
+----------------------------------------------------+
```

The score gets a progress ring visualization. Traits, anti-patterns, and wasted turns are shown in a compact two-column layout. Tips remain as bullets.

#### Summary Card

```
+----------------------------------------------------+
| (FileText) SUMMARY            <purple badge>       |
|                                  [success badge]    |
| Title: "Implemented session character classifier"   |
|                                                     |
| - Added 7 character types based on tool call        |
|   distribution analysis                             |
| - Integrated with sync pipeline and dashboard       |
| - Tests passing for all classification thresholds   |
|                                                     |
| [code-insights] · 1 day ago · View session ->       |
+----------------------------------------------------+
```

Summaries get an outcome badge (success/partial/abandoned/blocked) rendered prominently.

### 4.2 Insights Page: Grouped Views

Replace the flat chronological list with multiple view modes:

1. **Timeline (default):** Chronological with date headers. Same as current but with type-specific cards.
2. **By Type:** Tabbed or accordion view. All decisions together, all learnings together, etc. Within each type, sorted by recency.
3. **By Project:** Group insights by project name. Each project section collapsible. Shows insight counts per type.
4. **By Session:** Group insights by their source session. Each group shows the session title + metadata, then its insights. This is the "session journal" view.

View mode selector as a segmented control: [Timeline | By Type | By Project | By Session]

### 4.3 Insights Page: Enhanced Filtering

**New filters:**
- Confidence slider (0.0 - 1.0)
- Has alternatives (for decisions)
- Recurring only (insights with linked_insight_ids)
- Date range picker
- Sort by: newest, oldest, highest confidence, most recurring

**Active filters as chips:**
```
Filters: [Decision x] [code-insights x] [Confidence > 0.7 x]   [Clear all]
```

### 4.4 Insights Page: Recurring Patterns Section

When recurring insights exist, show a dedicated "Patterns" section at the top of the page:

```
+----------------------------------------------------+
| RECURRING PATTERNS (3 found)                        |
|                                                     |
| "Always provide file paths in prompts"              |
| Seen 4x across 3 projects · Last: 2 days ago       |
| [View all occurrences ->]                           |
|                                                     |
| "SQLite WAL mode needed for concurrent access"      |
| Seen 3x in code-insights · Last: 5 days ago        |
| [View all occurrences ->]                           |
+----------------------------------------------------+
```

Clicking "View all occurrences" filters the list to show only the linked insights.

### 4.5 Insight Detail Expansion

When clicking an insight (in any view mode), expand it inline to show:
- Full content text (not truncated)
- All metadata fields (for that type)
- Session context: session title, project, date, character, duration
- "Open session" button that navigates to the session detail page
- "Open in conversation" button that navigates to the conversation tab, scrolled to the relevant messages (if message anchoring is implemented)
- Delete button (with confirmation)

### 4.6 Insight Search: Full-Text + Metadata

Upgrade search from simple text matching to include metadata fields:
- Search across: title, content, summary, bullets, metadata.situation, metadata.choice, metadata.reasoning, metadata.symptom, metadata.root_cause, metadata.takeaway

This means searching for "TypeScript" would find a decision where TypeScript was mentioned as an alternative, not just in the title.

---

## 5. Cross-Cutting Improvements

### 5.1 Sessions <-> Insights Navigation

1. **Insight counts on session rows.** Show "3 insights" with a mini breakdown icon. Zero insights = show "Analyze" CTA.
2. **Session context on insight cards.** Show session title, project name, and a "View session" link prominently (not buried at the bottom of expanded content).
3. **Deep linking.** `/insights?highlight=<id>` should scroll to and expand that specific insight on the Insights page. Session deep links use `/sessions?session=<id>`.
4. ~~**Breadcrumb context.**~~ **SOLVED** by three-panel layout: project nav (Panel A) and session list (Panel B) are always visible on desktop. Mobile uses Sheet slide-over with "Back to list" button.

### 5.2 Consistent Patterns

1. **Filter bar pattern.** Both pages should use the same collapsible filter bar with chip-based active filters.
2. **Card expansion pattern.** Both pages should use inline expansion (click to expand) rather than navigation for viewing details.
3. **Empty states.** Both pages should have the same style of empty state with clear CTA.
4. **Loading states.** Both pages should use the same skeleton pattern.

### 5.3 Responsive / Mobile

> **IMPLEMENTED (PR #96).** Three-panel responsive strategy:

- **Desktop >=1280px (xl):** Full three-panel layout (Panel A + B + C)
- **Desktop >=1024px (lg):** Two panels (B + C), Panel A in Sheet drawer
- **Tablet/Mobile <1024px:** Panel B full-width, Panel C as Sheet slide-over from right with "Back to list" button
- Insights page: unchanged (single-column with view mode tabs)

### 5.4 URL State Persistence

> **IMPLEMENTED (PR #96)** via `useFilterParams` hook.

All filter state encoded in URL query params:
- Sessions: `/sessions?project=<id>&session=<id>&source=<tool>&q=<search>&character=<type>&status=<status>`
- Insights: `/insights?project=<id>&type=<type>&view=<mode>&q=<search>&pattern=<key>`
- Browser back/forward preserves state. Shareable links. Clean URLs (only non-default values written).

---

## 6. ASCII Wireframes

### 6.1–6.3 Sessions Page + Session Detail

> **IMPLEMENTED (PR #96).** Wireframes 6.1, 6.2, and 6.3 are superseded by the three-panel layout.
> See `docs/ux/sessions-three-panel-design.md` for the authoritative wireframes.

**Key differences from original wireframes:**
- Sessions page is now a three-panel layout (Panel A: project nav, Panel B: session list, Panel C: detail)
- Session detail is no longer a separate page — it renders inline in Panel C
- Session ID is a query param (`?session=<id>`), not a route param (`:id`)
- SessionSidebar (w-72) replaced by VitalsStrip (horizontal grid in Panel C)
- Breadcrumbs replaced by always-visible Panel A/B context
- Prev/next navigation replaced by clicking in Panel B session list
- Table view (6.2) deferred — would need a Panel B-scoped compact variant
- Source tools shown with full names (Claude Code, Cursor) not abbreviations

### 6.4 Insights Page (Redesigned)

```
+------------------------------------------------------------------+
|  [INSIGHTS PAGE]                                  [STATUS: draft]
|  Context: /insights
|  Breakpoint: desktop
+------------------------------------------------------------------+

+--------------------------------------------------------------+
| Insights                                                      |
| 47 insights across 8 projects                                |
+--------------------------------------------------------------+
| [____Search insights..._____]   (Filter) <1>                |
|                                                               |
| View: [*Timeline*] [By Type] [By Project] [By Session]      |
+--------------------------------------------------------------+
|                                                               |
| RECURRING PATTERNS (2)                              [v Hide] |
| +----------------------------------------------------------+ |
| | "Always provide file paths upfront"                      | |
| | Seen 4x across 3 projects · Last: 2 days ago            | |
| | [View all occurrences ->]                                | |
| +----------------------------------------------------------+ |
| +----------------------------------------------------------+ |
| | "Use WAL mode for SQLite concurrent access"              | |
| | Seen 3x in code-insights · Last: 5 days ago             | |
| | [View all occurrences ->]                                | |
| +----------------------------------------------------------+ |
|                                                               |
| ------ TODAY ------                                           |
|                                                               |
| +----------------------------------------------------------+ |
| | (Target) PROMPT QUALITY              <rose badge>        | |
| |                                                          | |
| |  +------+                                                | |
| |  | [72] |  72/100 Good · Could save ~4 messages          | |
| |  +------+                                                | |
| |                                                          | |
| | Traits: [!Context Drift] [!Late Context] [+Structured]   | |
| | Anti-patterns: Vague instructions (2x), Missing ctx (1x) | |
| |                                                          | |
| | code-insights · "Implement character classifier"         | |
| |                                   2 hours ago            | |
| +----------------------------------------------------------+ |
|                                                               |
| +----------------------------------------------------------+ |
| | (GitCommit) DECISION                 <blue badge>        | |
| |                                                          | |
| | Chose SQLite over PostgreSQL for local storage           | |
| |                                                          | |
| | Situation: Needed a database for local session storage   | |
| | Choice: SQLite via better-sqlite3                        | |
| | Alternatives: PostgreSQL, LevelDB (rejected)            | |
| |                                                          | |
| | code-insights · "Implement data layer"                   | |
| |                                   3 hours ago  [v More]  | |
| +----------------------------------------------------------+ |
|                                                               |
| +----------------------------------------------------------+ |
| | (BookOpen) LEARNING                  <green badge>       | |
| |                                                          | |
| | Tailwind v4 requires explicit dark variant declaration   | |
| |                                                          | |
| | What happened: Dark mode styles not applying             | |
| | Why: v4 removed automatic dark: variant support          | |
| | Takeaway: Add @custom-variant declaration                | |
| |                                                          | |
| | code-insights · "Fix dark mode" · 5 hours ago  [v More] | |
| +----------------------------------------------------------+ |
|                                                               |
| ------ YESTERDAY ------                                       |
| ...                                                           |
+--------------------------------------------------------------+

ANNOTATIONS:
- @A: Recurring patterns section appears only when recurring insights exist
- @B: "View all occurrences" filters the timeline to show only linked insights
- @C: [v More] expands the card inline to show all metadata fields
- @D: Session title shown inline (e.g., "Implement character classifier")
- @E: View modes: Timeline (chrono), By Type (tabbed), By Project (grouped), By Session (grouped)
- @F: Click insight to expand inline with full metadata + delete button
- @G: Filter button opens collapsible filter panel with chips

TAILWIND MAPPING:
- View mode selector: inline-flex items-center rounded-lg bg-muted p-1 (ToggleGroup)
- Recurring patterns: rounded-lg border-l-4 border-amber-500 bg-amber-500/5 p-4
- Decision card: rounded-lg border p-4
- Metadata fields: grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm

SHADCN COMPONENTS:
- View mode -> <ToggleGroup type="single">
- Filter panel -> custom collapsible
- Insight cards -> <Card> with type-specific inner layouts
- Recurring section -> <Collapsible>
```

### 6.5 Insights Page: "By Type" View

```
+------------------------------------------------------------------+
|  [INSIGHTS PAGE - BY TYPE VIEW]                   [STATUS: draft]
|  Context: /insights?view=type
+------------------------------------------------------------------+

+--------------------------------------------------------------+
| Insights · By Type                                            |
| [____Search..._____]   (Filter)                              |
| View: [Timeline] [*By Type*] [By Project] [By Session]      |
+--------------------------------------------------------------+
|                                                               |
| [Decisions (8)] [Learnings (12)] [Techniques (5)]            |
| [Summaries (15)] [Prompt Quality (7)]                        |
|                                                               |
| ------ DECISIONS (8) ------                                   |
|                                                               |
| +----------------------------------------------------------+ |
| | Chose SQLite over PostgreSQL                             | |
| | Situation: Needed a database for local session storage   | |
| | Choice: SQLite via better-sqlite3                        | |
| | code-insights · 3 hours ago                              | |
| +----------------------------------------------------------+ |
| +----------------------------------------------------------+ |
| | Chose pnpm workspace over separate repos                 | |
| | Situation: Needed to manage 3 packages with shared types | |
| | Choice: pnpm workspace monorepo                          | |
| | code-insights · 2 days ago                               | |
| +----------------------------------------------------------+ |
| ...                                                           |
|                                                               |
| ------ LEARNINGS (12) ------                                  |
| ...                                                           |
+--------------------------------------------------------------+

ANNOTATIONS:
- @A: Type pills at top are clickable to scroll to that section
- @B: Each section is collapsible
- @C: Count in parentheses updates with filters
- @D: Cards use type-specific layout (decision layout here)
```

### 6.6 Decision Card Component (Detailed)

```
+------------------------------------------------------------------+
|  [DECISION CARD]                                  [STATUS: draft]
|  Context: Used in InsightsPage, SessionDetailPage
+------------------------------------------------------------------+

+--------------------------------------------------------------+
| (GitCommit) DECISION                     <blue badge>        |
| [Recurring 3x]                                               |
|                                                               |
| Chose SQLite over PostgreSQL for local storage               |
|                                                               |
| +----------------------------------------------------------+ |
| | SITUATION                                                | |
| | Needed a database for local session storage that works   | |
| | without requiring users to install or configure anything.| |
| +----------------------------------------------------------+ |
| | CHOICE                                                   | |
| | SQLite via better-sqlite3 with WAL mode enabled.         | |
| +----------------------------------------------------------+ |
| | REASONING                                                | |
| | Zero config, no server process, single file database,    | |
| | WAL mode for concurrent reads during CLI sync,           | |
| | better-sqlite3 is synchronous (no async overhead).       | |
| +----------------------------------------------------------+ |
| | ALTERNATIVES CONSIDERED                                  | |
| | - PostgreSQL                                             | |
| |   Rejected: Requires server process, user must install   | |
| | - LevelDB                                                | |
| |   Rejected: No SQL queries, limited query flexibility    | |
| +----------------------------------------------------------+ |
| | TRADE-OFFS                                               | |
| | Limited concurrent writes. 2GB practical size limit.     | |
| | No network access for multi-device sync.                 | |
| +----------------------------------------------------------+ |
| | REVISIT WHEN                                             | |
| | Multi-device sync or team collaboration features needed. | |
| +----------------------------------------------------------+ |
|                                                               |
| Evidence: schema.sql, db/client.ts, sync.ts                 |
| Confidence: 92%                                              |
|                                                               |
| code-insights · "Implement data layer" · 3 hours ago        |
| [Open session ->]                                            |
+--------------------------------------------------------------+

TAILWIND MAPPING:
- Outer: rounded-lg border p-4 space-y-3
- Section headers: text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1
- Section content: text-sm text-foreground
- Sections: rounded-md bg-muted/30 px-3 py-2
- Alternative items: border-l-2 border-muted pl-3 space-y-0.5
- Evidence: text-xs text-muted-foreground font-mono
```

### 6.7 Learning Card Component (Detailed)

```
+------------------------------------------------------------------+
|  [LEARNING CARD]                                  [STATUS: draft]
|  Context: Used in InsightsPage, SessionDetailPage
+------------------------------------------------------------------+

+--------------------------------------------------------------+
| (BookOpen) LEARNING                    <green badge>         |
|                                                               |
| Tailwind v4 requires explicit dark variant declaration       |
|                                                               |
| +----------------------------------------------------------+ |
| | WHAT HAPPENED                                            | |
| | Dark mode styles weren't applying after upgrading to     | |
| | Tailwind v4. All dark: prefixed classes were ignored.    | |
| +----------------------------------------------------------+ |
| | WHY                                                      | |
| | Tailwind v4 removed automatic dark: variant support.     | |
| | It now requires an explicit @custom-variant declaration  | |
| | in the CSS entry point.                                  | |
| +----------------------------------------------------------+ |
| | TAKEAWAY                                                 | |
| | Add this to globals.css:                                 | |
| | @custom-variant dark (&:where(.dark, .dark *));          | |
| +----------------------------------------------------------+ |
| | APPLIES WHEN                                             | |
| | Any Tailwind v3 to v4 migration project using class-     | |
| | based dark mode (not media query based).                 | |
| +----------------------------------------------------------+ |
|                                                               |
| Evidence: globals.css, ThemeProvider.tsx                      |
| Confidence: 95%                                              |
|                                                               |
| code-insights · "Fix dark mode regression" · 5 hours ago    |
| [Open session ->]                                            |
+--------------------------------------------------------------+

TAILWIND MAPPING:
- Same outer structure as Decision card
- Section accent: border-l-2 border-green-500/30 for learning sections
- Takeaway section: bg-green-500/5 (slightly highlighted as the key insight)
```

---

## 7. Implementation Priority

### Tier 1: High Impact, Moderate Effort (Do First)

| Item | Impact | Effort | Rationale |
|------|--------|--------|-----------|
| Type-specific insight cards (Decision, Learning) | HIGH | Medium | The most data is wasted here. Rich metadata exists but is invisible. |
| Cost badge on session rows | HIGH | Low | Single most requested data point for session scanning. |
| Summary preview on session rows | HIGH | Low | Users can find sessions without clicking into each one. |
| Insight count + type breakdown on session rows | HIGH | Low | Replaces meaningless "analyzed/not analyzed" binary. |
| Outcome badge on session detail | MEDIUM | Low | Surfaces valuable summary metadata that's currently hidden. |
| Always-visible usage stats on session detail | MEDIUM | Low | Just un-collapsible the section. |

### Tier 2: Significant Improvement, Medium Effort — ✅ COMPLETE (PR #96)

| Item | Impact | Effort | Status |
|------|--------|--------|--------|
| ~~Session detail sidebar layout~~ → Three-panel master-detail layout | HIGH | High | ✅ Evolved from sidebar into page-level three-panel (Panel A + B + C) |
| Insights page view modes (Timeline, By Type, By Project, By Session) | HIGH | Medium | ✅ Four Tabs-based view modes with grouped sections |
| URL-persisted filter state | MEDIUM | Medium | ✅ `useFilterParams` hook on Sessions + Insights pages |
| Enhanced prompt quality card (progress ring) | MEDIUM | Low | ✅ Custom SVG ProgressRing component |
| Conversation message search | MEDIUM | Medium | ✅ Debounced search with prev/next match navigation |
| Recurring patterns section on Insights page | MEDIUM | Medium | ✅ Union-find grouping on linked_insight_ids |

### Tier 3: Nice to Have, Higher Effort

| Item | Impact | Effort | Status | Rationale |
|------|--------|--------|--------|-----------|
| Collapsible tool panels (default collapsed) | MEDIUM | Medium | Open | Conversation density improvement. |
| Thinking blocks collapsed by default | LOW | Low | Open | Minor density improvement. |
| Daily date grouping (replacing "This Week"/"Earlier") | LOW | Low | Open | Better session scanning. |
| Inline text highlighting in conversation search | MEDIUM | Medium | Open | Currently highlights at message level; inline would be more precise. |
| Deep linking to specific insights | LOW | Medium | Open | `/insights?highlight=<id>` scrolls to and expands that insight. |
| ~~Table view for sessions~~ | ~~MEDIUM~~ | -- | Deferred | Would need a Panel B-scoped compact variant (320px). Revisit based on user feedback. |
| ~~Previous/next session navigation~~ | ~~LOW~~ | -- | **SOLVED** | Three-panel layout: click in Panel B to switch sessions. |
| ~~Breadcrumb navigation~~ | ~~LOW~~ | -- | **SOLVED** | Three-panel layout keeps project + session list visible. Mobile has "Back to list" button. |
| ~~Keyboard shortcuts (j/k, Enter, Esc)~~ | ~~LOW~~ | -- | Deferred | Revisit based on user feedback. |

### Tier 4: Future (Depends on New API Capabilities)

| Item | Impact | Effort | Rationale |
|------|--------|--------|-----------|
| Message anchoring (insight -> conversation) | HIGH | High | Needs message index data in insight metadata. |
| Date range filter | MEDIUM | Medium | Needs server-side date filtering. |
| Sort by cost/duration/messages | MEDIUM | Medium | Needs server-side sorting params. |
| Git branch filter | LOW | Low | Needs server-side branch filtering. |
| Insight bookmarking/starring | LOW | Medium | Needs new DB column + API. |
| Bulk session analysis from list | MEDIUM | Medium | Analysis endpoint already exists, needs UI. |
| ~~Conversation search (full text)~~ | ~~MEDIUM~~ | -- | **SOLVED** — client-side search implemented in Tier 2 (loads all messages, filters by content). Server-side search deferred unless performance requires it. |

---

## Appendix A: Data Fields Inventory

### Session Fields — Current Usage (Post-Tier 2)

| Field | Panel B (Session List) | Panel C (Session Detail) | Notes |
|-------|----------------------|--------------------------|-------|
| custom_title / generated_title | Shown (line-clamp-2) | Header | |
| session_character | Badge | Header badge | |
| project_name | Shown when "All Projects" | Header + Panel A context | |
| source_tool | Full name (Claude Code, etc.) | VitalsStrip badge | |
| started_at / ended_at | Date group headers | Header date range + VitalsStrip duration | |
| message_count | Stats line | VitalsStrip (total + user/asst breakdown) | |
| tool_call_count | Stats line | VitalsStrip | |
| estimated_cost_usd | Stats line | VitalsStrip | |
| models_used | -- | VitalsStrip secondary row | |
| git_branch | -- | VitalsStrip secondary row | |
| summary | -- | Overview section | |
| token counts | -- | VitalsStrip (input/cache/output breakdown) | |
| outcome | Badge | Header badge | From summary insight metadata |
| insight counts | Stats line (excl. summary) | Overview section | |
| device_hostname | -- | -- | Low value |

### Insight Fields — Current Usage vs. Proposed

| Field | Current (InsightsPage) | Current (SessionDetail) | Proposed |
|-------|----------------------|------------------------|----------|
| type | Badge + icon | Badge + icon | Badge + icon + type-specific layout |
| title | Shown | Shown | Shown (prominent) |
| content | Expanded only | -- | Expanded view |
| summary | Collapsed | -- | Always shown |
| bullets | 3 shown, rest hidden | 3 shown | Full in expanded view |
| confidence | Expanded only | -- | Shown in footer |
| metadata.situation | Expanded text | -- | **NEW: Labeled section** |
| metadata.choice | Expanded text | -- | **NEW: Labeled section** |
| metadata.reasoning | Expanded text | -- | **NEW: Labeled section** |
| metadata.alternatives | Expanded text | -- | **NEW: Labeled section with rejection reasons** |
| metadata.trade_offs | Expanded text | -- | **NEW: Labeled section** |
| metadata.revisit_when | Expanded text | -- | **NEW: Labeled section** |
| metadata.symptom | Expanded text | -- | **NEW: Labeled section** |
| metadata.root_cause | Expanded text | -- | **NEW: Labeled section** |
| metadata.takeaway | Expanded text | -- | **NEW: Labeled section (highlighted)** |
| metadata.applies_when | Expanded text | -- | **NEW: Labeled section** |
| metadata.efficiencyScore | Score number | Score number | **NEW: Progress ring** |
| metadata.wastedTurns | List (max 5) | List (max 5) | List with better layout |
| metadata.antiPatterns | List | List | Compact two-column |
| metadata.sessionTraits | List | List | Badge pills |
| linked_insight_ids | "Recurring Nx" badge | "Recurring Nx" badge | **NEW: Clickable, links to group** |
| scope | -- | -- | -- (future use) |
| analysis_version | -- | -- | -- (low value) |
| metadata.outcome | -- | -- | **NEW: Badge on summary cards** |
| metadata.evidence | Expanded text | -- | Shown in footer |

---

## Appendix B: Component Architecture

### Component Architecture (Updated Post-Tier 2)

**Implemented in Tier 1 (PR #95):**
```
dashboard/src/components/insights/
  DecisionCard.tsx        ✅ Type-specific decision layout
  LearningCard.tsx        ✅ Type-specific learning layout
  SummaryCard.tsx         ✅ Summary with outcome badge
  PromptQualityCard.tsx   ✅ Enhanced with progress ring
```

**Implemented in Tier 2 (PR #96):**
```
dashboard/src/components/sessions/
  ProjectNav.tsx           ✅ Panel A: project navigation (220px)
  SessionListPanel.tsx     ✅ Panel B: session list with filters (320px)
  CompactSessionRow.tsx    ✅ Compact row for Panel B
  SessionDetailPanel.tsx   ✅ Panel C: session detail (extracted from page)
  VitalsStrip.tsx          ✅ Horizontal vitals grid (replaces SessionSidebar)

dashboard/src/components/shared/
  ProgressRing.tsx         ✅ SVG progress ring for prompt quality scores

dashboard/src/components/insights/
  RecurringPatternsSection.tsx ✅ Recurring patterns with union-find grouping

dashboard/src/components/chat/conversation/
  ConversationSearch.tsx   ✅ Message search with prev/next navigation

dashboard/src/hooks/
  useFilterParams.ts       ✅ URL-persisted filter state

dashboard/src/lib/
  utils.ts                 ✅ getDateGroup + DATE_GROUP_ORDER (extracted)
```

**Deprecated/Deleted:**
```
  SessionSidebar.tsx       ❌ Deleted (replaced by VitalsStrip)
  SessionDetailPage.tsx    ⚠️  Now just a redirect to /sessions?session=<id>
```

**Remaining (for future tiers):**
```
dashboard/src/components/insights/
  InsightDetail.tsx       -- Expanded inline detail view (deep linking target)

dashboard/src/components/sessions/
  SessionTable.tsx        -- Dense table view for Panel B (deferred)
```
