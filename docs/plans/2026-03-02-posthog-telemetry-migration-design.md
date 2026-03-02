# PostHog Telemetry Migration — Design

**Date:** 2026-03-02
**Status:** Approved (Founder + TA)
**Replaces:** Supabase Edge Function telemetry (cli-telemetry-v2)

---

## Problem

The current telemetry system sends raw events to a Supabase Edge Function with no analytics UI. Monthly-rotating machine IDs prevent accurate unique user counts. Key signals are missing: performance timing, exact session counts, per-provider sync breakdown, LLM provider usage, and dashboard engagement.

## Solution

Migrate to PostHog with two SDKs (posthog-node for CLI/server, posthog-js for dashboard SPA), a stable machine identity, and an expanded event schema that captures what we need to understand adoption, feature usage, and performance.

---

## Architecture

```
CLI commands ──► posthog-node (server-side) ──► PostHog Cloud
                     ▲
Server routes ───────┘
                                                     ▲
Dashboard SPA ──► posthog-js (client-side) ──────────┘
```

- **posthog-node** (~20KB, no native deps) in `cli/package.json` — used by CLI commands and server-side Hono routes via existing `@code-insights/cli/utils/telemetry` import.
- **posthog-js** (~45KB) in `dashboard/package.json` — used by dashboard SPA for page views and load timing.
- **Shared identity:** Server exposes `GET /api/telemetry/identity` so the SPA uses the same `distinct_id` as CLI/server.
- **Supabase fully removed:** Endpoint URL, HMAC signing key, `signPayload()`, and edge function are deleted.

---

## Identity & Privacy

### Stable Machine ID

```
SHA-256(hostname:username:code-insights)[0:16]
```

- No monthly salt — same machine always produces the same ID
- No PII transmitted — hostname and username are hashed, never sent
- Deterministic — survives reinstalls, no stored file needed
- PostHog configured with `ip: false` on both SDKs to discard IP addresses

### Opt-Out Mechanisms (preserved)

1. `CODE_INSIGHTS_TELEMETRY_DISABLED=1` env var
2. `DO_NOT_TRACK=1` env var (community standard)
3. `code-insights telemetry disable` (persists to config)

### Dashboard SPA Opt-Out

`GET /api/telemetry/identity` returns `{ enabled: false }` when telemetry is disabled. The SPA does not initialize posthog-js at all.

### Disclosure Notice

Re-shown to all existing users. The `.telemetry-notice-shown` touch file is version-stamped (CLI version written as content). If version < this release, notice re-shown.

Updated text:
```
Code Insights collects anonymous usage data to improve the CLI and dashboard.
Includes: commands, page views, OS, CLI version, AI tool types, session counts,
LLM provider, performance timing.
Never includes: file paths, project names, session content, API keys, or personal data.
```

---

## Event Schema

### Common Properties (registered once via posthog.identify)

| Property | Example | Source |
|----------|---------|--------|
| cli_version | 3.3.0 | package.json |
| node_version | 22.5.1 | process.version |
| os | darwin | process.platform |
| arch | arm64 | process.arch |
| installed_providers | ['claude-code', 'cursor'] | Directory existence check |
| has_hook | true | Claude settings.json check |
| total_sessions | 347 | Exact count from SQLite (person property via identify, not per-event) |

### CLI Events (posthog-node)

| Event | Properties |
|-------|-----------|
| cli_sync | duration_ms, sessions_synced, sessions_by_provider, errors, source_filter, success |
| cli_stats | duration_ms, subcommand, period, source_filter, success |
| cli_dashboard | port, success |
| cli_init | success |
| cli_config | subcommand, success |
| cli_reset | success |
| cli_install_hook | success |

### Server Events (posthog-node, from Hono routes)

| Event | Properties |
|-------|-----------|
| analysis_run | type (session/prompt-quality/recurring), llm_provider, llm_model, duration_ms, success |
| insight_generated | type (summary/decision/learning/technique/prompt_quality), count |
| export_run | format, session_count, success |

### Dashboard Events (posthog-js, client-side)

| Event | Properties |
|-------|-----------|
| $pageview | path (automatic from posthog-js on route change) |
| dashboard_loaded | page, load_time_ms |

### Dropped Fields

| Field | Reason |
|-------|--------|
| sessionCountBucket | Replaced by exact total_sessions person property |
| dataSource | Always 'local', no value |
| machineId in payload | PostHog uses distinct_id natively |
| timestamp in payload | PostHog timestamps events server-side |

---

## trackEvent Signature

```typescript
// Before
trackEvent(command: string, success: boolean, subcommand?: string): void

// After
type TelemetryEventName =
  | 'cli_sync' | 'cli_stats' | 'cli_dashboard' | 'cli_init'
  | 'cli_config' | 'cli_reset' | 'cli_install_hook'
  | 'analysis_run' | 'insight_generated' | 'export_run'
  | 'dashboard_loaded';

trackEvent(event: TelemetryEventName, properties?: Record<string, unknown>): void
```

String literal union for event names (autocomplete + typo prevention). `Record<string, unknown>` for properties (matches PostHog SDK types, avoids per-event type maintenance).

`success` is an explicit boolean property on all events — not inferred from error absence.

---

## SDK Initialization (TA Review Items #4, #7)

### CLI: Lazy Init with Immediate Flush

```typescript
let client: PostHog | null = null;

function getPostHogClient(): PostHog | null {
  if (!isTelemetryEnabled()) return null;
  if (!client) {
    client = new PostHog(API_KEY, {
      flushAt: 1,        // Flush immediately (CLI is short-lived)
      flushInterval: 0,  // No background timer
    });
  }
  return client;
}
```

- `flushAt: 1` — each capture() flushes immediately; CLI exits too fast for batching
- `flushInterval: 0` — no background timer; avoids keeping process alive
- Lazy initialization — `code-insights --help` pays zero cost

### Server: Shutdown Hook (TA Review Item #1)

```typescript
export async function shutdownTelemetry(): Promise<void> {
  if (client) {
    await client.shutdown();
    client = null;
  }
}
```

Wired into server SIGINT/SIGTERM handler before `process.exit(0)`.

### Person Properties via identify() (TA Review Item #4)

`total_sessions` and other common properties set via `posthog.identify()` once per CLI invocation, not per-event. Called at the point where the DB is already open for the actual command. Commands that never open DB (e.g., `telemetry status`) skip the identify call — PostHog retains person properties from previous calls.

### Dashboard: posthog-js Config (TA Review Item #5)

```typescript
posthog.init(API_KEY, {
  autocapture: false,
  capture_pageview: true,
  capture_pageleave: false,
  persistence: 'memory',
  disable_session_recording: true,
  ip: false,
});
```

---

## Files Changed

| File | Change |
|------|--------|
| cli/src/utils/telemetry.ts | Rewrite: posthog-node, stable ID, lazy init, identify(), shutdownTelemetry() |
| cli/src/commands/sync.ts | Add duration_ms, sessions_synced, sessions_by_provider, source_filter |
| cli/src/commands/stats/actions/*.ts | Add duration_ms to all 5 subcommands |
| cli/src/commands/telemetry.ts | Update status preview to PostHog event shape |
| cli/src/commands/dashboard.ts | No change (already fires trackEvent) |
| server/src/routes/analysis.ts | Add duration_ms, llm_provider, llm_model; add insight_generated events |
| server/src/routes/export.ts | Add session_count |
| server/src/routes/ (new or config.ts) | GET /api/telemetry/identity endpoint |
| server/src/index.ts | Wire shutdownTelemetry() into SIGINT/SIGTERM handler |
| dashboard/src/ (new telemetry init) | posthog-js setup, fetch identity, conditional init |
| dashboard/src/App.tsx or router | Wire posthog-js page view tracking |

## New Dependencies

| Package | Added To | Size |
|---------|----------|------|
| posthog-node | cli/package.json | ~20KB |
| posthog-js | dashboard/package.json | ~45KB |

## Removed

- Supabase endpoint URL constant
- HMAC_KEY constant
- signPayload() function
- getMachineId() (monthly-rotating version)
- getSessionCountBucket() function
- getDataSource() function
- sendEvent() raw fetch function

---

## TA Review Summary

Reviewed 2026-03-02. Verdict: **Approved — proceed.**

| # | Issue | Severity | Resolution |
|---|-------|----------|------------|
| 1 | PostHog flush on process exit | Medium | shutdownTelemetry() + server SIGINT handler |
| 2 | trackEvent type safety | Low | String literal union for names, Record for properties |
| 3 | Identity endpoint security | None | Localhost-only, hash not PII |
| 4 | total_sessions per-event query | Medium | Person properties via identify() once per process |
| 5 | posthog-js bundle size | Low | ~2.6% increase, disable autocapture/session-recording |
| 6 | Disclosure re-show mechanism | Low | Version-stamp the touch file |
| 7 | SDK lifecycle in short-lived CLI | Medium | Lazy init, flushAt: 1, flushInterval: 0 |
| 8 | success field dropped | Low | Keep as explicit boolean property |
| 9 | Identity hash change | None | Fresh PostHog project, no continuity issue |
| 10 | API key management | None | Hardcoded write-only key, standard PostHog pattern |

---

## Questions Resolved

| Question | Decision |
|----------|----------|
| Machine ID approach | Self-managed stable hash (no monthly rotation) |
| Dashboard telemetry | Server + Dashboard client (posthog-js for page views) |
| Disclosure notice | Re-show to all existing users with updated text |
| PostHog vs Supabase | PostHog (replaces Supabase entirely) |
