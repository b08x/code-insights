═══════════════════════════════════════════════════════════════
                    A3 PROBLEM ANALYSIS
═══════════════════════════════════════════════════════════════

TITLE: Gemini CLI Sessions Failing to Sync (.jsonl format)
OWNER: Gemini CLI Agent
DATE: 2026-04-23

┌─────────────────────────────────────────────────────────────┐
│ 1. BACKGROUND                                               │
├─────────────────────────────────────────────────────────────┤
│ • Gemini CLI recently updated its session storage format     │
│ • Users reported that latest sessions were not syncing      │
│ • Code Insights depends on accurate session tracking for    │
│   analytics and historical context                          │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. CURRENT CONDITION                                        │
├─────────────────────────────────────────────────────────────┤
│ • `GeminiCliProvider.discover` only filtered for `.json`    │
│ • `GeminiCliProvider.parse` only handled standard JSON      │
│ • Recent Gemini CLI sessions use `.jsonl` format            │
│ • Sub-agent sessions are stored in subdirectories of `chats/`│
│ • Sync output showed "0 synced" for recent sessions         │
│ • Sub-agent sessions were synced as independent entities,    │
│   cluttering the dashboard and losing hierarchical context  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 3. GOAL/TARGET                                              │
├─────────────────────────────────────────────────────────────┤
│ • Restore synchronization for all Gemini CLI sessions       │
│ • Support both legacy `.json` and new `.jsonl` formats      │
│ • Implement recursive discovery and bundling for sub-agents │
│ • Consolidate sub-agent interactions into the parent session│
│ • Verify fix with local sync run and automated tests        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 4. ROOT CAUSE ANALYSIS                                      │
├─────────────────────────────────────────────────────────────┤
│ 5 Whys:                                                     │
│ Problem: Recent Gemini CLI sessions are missing in sync     │
│ Why 1: Provider ignores files ending in `.jsonl`            │
│ Why 2: Extension filter was hardcoded to `.json`            │
│ Why 3: Gemini CLI format change wasn't tracked/implemented  │
│ Why 4: No recursive discovery to find sub-sessions          │
│ Why 5: Directory-based sub-agent structure was unrecognized │
│                                                             │
│ ROOT CAUSE: Provider implementation lacked flexibility for  │
│             format changes and directory structure depth    │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 5. COUNTERMEASURES                                          │
├─────────────────────────────────────────────────────────────┤
│ 1. Update `discover` to include `.jsonl` extension          │
│ 2. Implement recursive `findFiles` for `chats/` directory   │
│ 3. Implement `parseJsonl` for line-by-line parsing          │
│ 4. Implement `parseBundledSession` to merge sub-agents      │
│ 5. Update `discover` to group sub-directories with parents  │
│ 6. Override `sessionId` in merged messages to ensure linking│
│ 7. Add automated tests for recursive & JSONL discovery      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 6. IMPLEMENTATION PLAN                                      │
├─────────────────────────────────────────────────────────────┤
│ • [DONE] Update `GeminiCliProvider.ts` with bundling logic  │
│ • [DONE] Add tests to `gemini-cli.test.ts`                  │
│ • [DONE] Run `pnpm build` to verify types                   │
│ • [DONE] Execute `code-insights sync` to verify in prod     │
│ • [DONE] Manually clean up orphaned sub-session entries      │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 7. FOLLOW-UP                                                │
├─────────────────────────────────────────────────────────────┤
│ Success Metrics:                                            │
│ • 111 new sessions synced successfully in first run         │
│ • 2070 messages imported                                    │
│ • Sub-agent sessions correctly merged into parent           │
│ • (e.g. Session 49134ff0... now has 138 merged messages)    │
│ • Tests passing (8/8)                                       │
│                                                             │
│ Prevention:                                                 │
│ • Periodically check for storage format changes in common   │
│   AI CLI tools                                              │
└─────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════
