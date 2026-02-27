# Phase 4: Feature Parity Audit — Design Document

**Date:** 2026-02-27
**Author:** Orchestrator (Brainstorming Session)
**Status:** Approved by Founder
**Parent Plan:** `docs/plans/2026-02-27-local-first-migration.md` (Phase 4)

---

## Summary

Port all user-visible features from the web dashboard (`code-insights-web`) to the embedded Vite + React SPA (`dashboard/`). The approach is **layer-by-layer (bottom-up)**: foundation → data → LLM engine → components → pages → polish.

## Scope

**Target:** Full feature parity (everything except explicitly dropped items).

**Included:**
- All dashboard pages (dashboard, sessions, session detail, insights, analytics, settings, export, journal)
- Full chat conversation view with tool panels and markdown rendering
- LLM analysis engine ported to server (all 4 providers: Anthropic, OpenAI, Gemini, Ollama)
- CLI command for LLM provider configuration (`code-insights config llm`)
- Session rename, analyze, bulk analyze, prompt quality analysis
- Multi-source filter support (Claude Code, Cursor, Codex CLI, Copilot CLI)
- Dark mode with FOUC prevention
- Guided empty states (replaces demo mode)

**Excluded:**
- Authentication (login, auth callback, Supabase middleware)
- Firebase/Firestore config flow (ConfigDialog, FirebaseSetupGuide, FirebaseConfigForm)
- Marketing/landing page components (11 files)
- Demo mode data/banner
- Framer Motion animations (CSS transitions only)
- Gemini EnhanceButton (evaluated as redundant with general LLM analysis)
- Export reminders/scheduler
- SSE real-time updates (v3.1 — polling at 2s for v3.0)

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Execution approach | Layer-by-layer (bottom-up) | Each layer testable before next builds on it |
| LLM integration | Full server-side port | End-to-end analysis works. Config via CLI and UI. |
| Animations | CSS transitions only | Drop Framer Motion (~30KB savings, fewer deps) |
| Polling interval | 2 seconds | Per reviewer amendment #4 |
| Empty states | Guided (with embedded instructions) | Per reviewer amendment #2 (replaces demo mode) |
| Config access | CLI + dashboard UI | `code-insights config llm` + settings page |

---

## Layer 1: Foundation (~1 day)

### Purpose
Install all UI primitives and shared utilities so every subsequent layer can import them.

### Work Items

**shadcn/ui components (26):**
Install via `npx shadcn@latest add`: alert, alert-dialog, badge, button, card, checkbox, collapsible, dialog, dropdown-menu, empty-state (custom), input, scroll-area, select, separator, sheet, skeleton, sonner, switch, tabs, tooltip.

**Shared utilities:**
- `dashboard/src/lib/utils.ts` — `cn()` (clsx + tailwind-merge), `formatDurationMinutes()`, `estimateTokenCost()`
- `dashboard/src/lib/types.ts` — Import from CLI's `types.ts` where possible, add UI-specific types
- `dashboard/src/lib/constants/colors.ts` — `SOURCE_TOOL_COLORS`, `SESSION_CHARACTER_COLORS`

**Styling:**
- Port `globals.css` theme variables and dark mode CSS custom properties
- Add inline `<script>` in `index.html` for dark mode FOUC prevention (amendment #5)

**Layout shell:**
- `components/layout/Header.tsx` — Simplified navigation (no auth), theme toggle
- `components/layout/Footer.tsx` — Branding and links
- `components/layout/ThemeToggle.tsx` — Dark/light mode toggle
- `components/layout/ThemeProvider.tsx` — Replace `next-themes` with custom provider

**Router enhancements:**
- `ScrollRestoration` component (amendment)
- `document.title` updates on route change

**Dependencies to add:**
- `clsx`, `tailwind-merge`, `class-variance-authority` (for shadcn/ui)
- Radix UI primitives (as needed by shadcn components)

### Exit Criteria
- `pnpm build` passes
- Dashboard loads with navigation, theme toggle, styled page stubs
- Dark mode toggle works without FOUC

---

## Layer 2: Data Layer (~2-3 days)

### Purpose
Replace the web repo's `useFirestore.ts` (789 lines) with React Query hooks backed by the Hono API.

### Hooks to Create

| Hook | API Function | Query Type | Options |
|------|-------------|------------|---------|
| `useProjects()` | `fetchProjects()` | `useQuery` | 2s polling |
| `useSessions(filters)` | `fetchSessions(params)` | `useQuery` | projectId, sourceTool, limit, offset |
| `useSession(id)` | `fetchSession(id)` | `useQuery` | |
| `useMessages(sessionId)` | `fetchMessages(sessionId, params)` | `useInfiniteQuery` | Paginated, offset-based |
| `useInsights(filters)` | `fetchInsights(params)` | `useQuery` | projectId, sessionId, type |
| `useDashboardStats(range)` | `fetchDashboardStats(range)` | `useQuery` | 7d/30d/90d/all |
| `useUsageStats()` | `fetchUsageStats()` | `useQuery` | |
| `useLlmConfig()` | `fetchLlmConfig()` / `saveLlmConfig()` | `useQuery` + `useMutation` | |
| `useAnalyzeSession()` | `analyzeSession(id)` | `useMutation` | |
| `useExportMarkdown()` | `exportMarkdown(body)` | `useMutation` | |

### Polling Strategy
- List queries: `refetchInterval: 2000` (2s, per amendment #4)
- Single-item queries: Standard staleTime (5s)
- Mutations: Invalidate related queries on success

### API Client Verification
- Verify all 13 functions in `dashboard/src/lib/api.ts` match current server endpoints
- Add any missing functions for new endpoints

### Exit Criteria
- All hooks return typed data from the API
- No Firestore imports exist in dashboard
- Data flows verified via console logging

---

## Layer 3: Server-Side LLM Engine (~2-3 days)

### Purpose
Port the web repo's LLM abstraction to the Hono server. Implement 3 analysis endpoints. Add CLI config command.

### Server Port (`server/src/llm/`)

| File | Source | Changes |
|------|--------|---------|
| `types.ts` | `web:lib/llm/types.ts` | None (framework-agnostic) |
| `client.ts` | `web:lib/llm/client.ts` | Read config from file instead of localStorage |
| `providers/anthropic.ts` | `web:lib/llm/providers/anthropic.ts` | Drop `dangerous-direct-browser-access` header |
| `providers/openai.ts` | `web:lib/llm/providers/openai.ts` | None |
| `providers/gemini.ts` | `web:lib/llm/providers/gemini.ts` | None |
| `providers/ollama.ts` | `web:lib/llm/providers/ollama.ts` | No CORS issues server-side |
| `prompts.ts` | `web:lib/llm/prompts.ts` | None (pure string templates) |
| `analysis.ts` | `web:lib/llm/analysis.ts` | Read messages from SQLite, write insights to SQLite |

### Server Route Implementations

| Endpoint | What It Does |
|----------|-------------|
| `POST /api/analysis/session` | Read messages from SQLite → format for LLM → call provider → write insights to SQLite → return results |
| `POST /api/analysis/prompt-quality` | Evaluate prompt patterns in session messages → generate prompt quality insight |
| `POST /api/analysis/recurring` | Query insights across sessions → find cross-session patterns via LLM |

### Config Route Updates

| Endpoint | Change |
|----------|--------|
| `GET /api/config/llm` | Return full LLM config (provider, model, API key masked) |
| `PUT /api/config/llm` | Save LLM config to `~/.code-insights/config.json` |

### CLI Command

```
code-insights config llm                    # Interactive: select provider, enter API key, choose model
code-insights config llm --show             # Display current LLM config (mask API key)
code-insights config llm --provider anthropic --model claude-sonnet-4-20250514 --api-key sk-ant-...
code-insights config llm --provider ollama --model llama3.2  # No API key needed
```

Config stored at `~/.code-insights/config.json` under `dashboard.llm` key.

### Exit Criteria
- `POST /api/analysis/session` returns real analysis results
- All 4 providers functional (Anthropic, OpenAI, Gemini, Ollama)
- `code-insights config llm` works interactively and non-interactively
- `code-insights config llm --show` displays masked config

---

## Layer 4: Component Layer (~3-4 days)

### Purpose
Port all reusable React components from the web repo. These are the building blocks pages assemble.

### Components to Port

**Chat system (1,066 lines — port 1:1):**
- Conversation: `ChatConversation`, `LoadMoreSentinel`, `DateSeparator`
- Messages: `MessageBubble`, `ThinkingBlock`, `CopyButton`, `AssistantMarkdown`, `UserMarkdown`, `preprocess.ts`
- Tool panels (7): `ToolPanel`, `FileToolPanel`, `SearchToolPanel`, `TerminalToolPanel`, `AgentToolPanel`, `AskUserQuestionPanel`, `GenericToolPanel`, `ToolPanelHeader`

**Dashboard components (425 lines):**
- `StatsHero` — Stats cards from API data
- `DashboardActivityChart` — Recharts BarChart with range toggle
- `ActivityFeed` — Recent sessions feed

**Insights components (462 lines):**
- `InsightCard`, `InsightList`, `InsightListItem`, `PromptQualityCard`

**Sessions components (261 lines):**
- `SessionList`, `SessionCard`
- `RenameSessionDialog` — Uses `patchSession()` via React Query mutation

**Analysis components (752 lines — point to server API):**
- `AnalyzeButton` — Calls `useAnalyzeSession()` mutation
- `AnalyzeDropdown` — Multi-action menu
- `AnalyzePromptQualityButton` — Prompt quality trigger
- `BulkAnalyzeButton` — Batch analysis with progress

**Chart components (194 lines — port 1:1):**
- `ActivityChart`, `InsightTypeChart`

**Analysis context:**
- `AnalysisContext` — React context for tracking analysis progress

**Brand:**
- `Logo` — Brand logo

**New: Guided empty states (replaces demo mode):**
- `EmptyDashboard` — "Run `code-insights sync` to get started"
- `EmptySessions` — "No sessions found. Sync your first session."
- `EmptyInsights` — "Analyze a session to generate insights."

### Dependencies to Add
- `react-markdown`, `remark-gfm` — Markdown rendering
- `react-syntax-highlighter` — Code syntax highlighting
- `recharts` — Charts
- `sonner` — Toast notifications
- `date-fns` — Date formatting

### Exit Criteria
- All components render correctly in isolation
- No Firestore/Firebase imports
- `pnpm build` passes

---

## Layer 5: Page Layer (~3-4 days)

### Purpose
Replace all 9 page stubs with full implementations, wiring components to hooks.

### Page Implementations

| Route | Key Components | Data Sources |
|-------|---------------|-------------|
| `/dashboard` | StatsHero, DashboardActivityChart, ActivityFeed | `useDashboardStats`, `useSessions` |
| `/sessions` | SessionList, SessionCard, filters (project, source, character, search) | `useSessions`, `useProjects` |
| `/sessions/:id` | ChatConversation, MessageBubble, tool panels, AnalyzeButton, RenameSessionDialog, insights sidebar | `useSession`, `useMessages`, `useInsights` |
| `/insights` | InsightTypeChart, InsightList, InsightCard, PromptQualityCard, filters | `useInsights`, `useProjects` |
| `/analytics` | Usage charts, cost breakdown, model distribution | `useUsageStats`, `useDashboardStats` |
| `/settings` | LLM provider config (provider select, API key, model, test connection) | `useLlmConfig` |
| `/export` | Range selection, format selection (plain/obsidian/notion), preview | `useExportMarkdown`, `useSessions` |
| `/journal` | Interactive insights chat journal | `useInsights`, `useAnalyzeSession` |
| `/` | Auto-redirect to `/dashboard` | None |

### Key Adaptations from Web Repo

| Web Pattern | Dashboard Replacement |
|------------|----------------------|
| `useProjects()` Firestore hook | `useProjects()` React Query hook |
| `useSessions()` Firestore hook | `useSessions(filters)` React Query hook |
| `next/link` | `react-router Link` |
| `next/navigation` (useRouter, usePathname) | `react-router` (useNavigate, useLocation) |
| `next/image` | Standard `<img>` tags |
| `next-themes` | Custom ThemeProvider |
| Firestore cursor pagination (`startAfter`) | Offset-based pagination (`?limit=&offset=`) |

### Exit Criteria
- Every page renders real data from SQLite
- All interactions work (rename, analyze, export, settings save)
- Navigation between pages works
- Dark mode works throughout

---

## Layer 6: Polish & Integration (~1-2 days)

### Purpose
Cross-cutting quality concerns and final integration verification.

### Work Items

- **FOUC prevention** — Verify inline script in `index.html` prevents flash
- **Scroll restoration** — Verify `ScrollRestoration` works across navigations
- **Document titles** — Verify every route updates `document.title`
- **Error states** — Empty states with guidance for all pages (not blank screens)
- **Loading states** — Skeleton components during data fetches
- **Toast notifications** — Success/error toasts for all mutations
- **Responsive cleanup** — Desktop-first, responsive but no mobile-specific nav
- **Bundle size audit** — Measure `dashboard/dist/` (target: under 5MB)
- **react-syntax-highlighter** — Check bundle impact; consider lighter alternatives if >2MB
- **Full integration test** — `pnpm build` → `code-insights dashboard` → verify all pages

### Exit Criteria
- Dashboard feels polished, no console errors
- All features work end-to-end
- `pnpm build` passes from workspace root
- `code-insights dashboard` starts and serves everything
- Total dashboard dist under 5MB

---

## Timeline Estimate

| Layer | Effort | Dependencies |
|-------|--------|-------------|
| Layer 1: Foundation | ~1 day | None |
| Layer 2: Data Layer | ~2-3 days | Layer 1 |
| Layer 3: LLM Engine | ~2-3 days | None (can parallel with Layer 2) |
| Layer 4: Components | ~3-4 days | Layers 1, 2 |
| Layer 5: Pages | ~3-4 days | Layers 2, 3, 4 |
| Layer 6: Polish | ~1-2 days | Layer 5 |
| **Total** | **~12-17 days** | |

**Parallelization opportunity:** Layers 2 and 3 can run in parallel (data hooks + LLM engine are independent). Layer 4 depends on both being complete.

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|-----------|
| `react-syntax-highlighter` bundles Prism at 2-3MB | Large package size | Measure early; switch to `shiki` or lazy-load languages if too large |
| Tailwind CSS 4 config differences between Next.js and Vite | Broken styling | Test globals.css port early in Layer 1 |
| `next/image` scattered through components | Build errors | Mechanical find-and-replace with `<img>` |
| useFirestore.ts has hidden aggregation logic | Missing features | Review each function carefully; some stats computed client-side in Firestore hooks |
| Ollama CORS no longer an issue server-side | Positive risk | Celebrate (per amendment); simplify Ollama provider |

---

## Files Created/Modified (Summary)

**New files (~40-50):**
- `dashboard/src/components/` — ~30 component files
- `dashboard/src/hooks/` — ~10 hook files
- `dashboard/src/lib/` — ~5 utility/constant files
- `server/src/llm/` — ~8 LLM files
- `cli/src/commands/config-llm.ts` — CLI config command

**Modified files (~10-15):**
- All 9 page files in `dashboard/src/pages/`
- `server/src/routes/analysis.ts` — Implement 3 endpoints
- `server/src/routes/config.ts` — Update LLM config endpoints
- `cli/src/commands/config.ts` — Add `llm` subcommand
- `dashboard/index.html` — FOUC prevention script
- `dashboard/src/App.tsx` — ScrollRestoration, layout wrapper
