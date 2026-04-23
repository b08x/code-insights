═══════════════════════════════════════════════════════════════
                    A3 PROBLEM ANALYSIS
═══════════════════════════════════════════════════════════════

TITLE: OpenCode Messages Not Being Extracted From Session Data
OWNER: Robert Pannick (rwpannick@gmail.com)
DATE: 2026-04-19

┌─────────────────────────────────────────────────────────────┐
│ 1. BACKGROUND (Why this matters)                            │
├─────────────────────────────────────────────────────────────┤
│ • Code Insights supports 8 AI coding tools including OpenCode │
│ • OpenCode is a popular AI coding assistant used by many devs │
│ • Users expect to see their OpenCode sessions in the dashboard │
│ • Missing message extraction breaks core analytics features:  │
│   - Session analysis and insights                            │
│   - Cross-tool pattern recognition                           │
│   - Complete coding session history                          │
│ • Privacy-first tool depends on comprehensive local parsing  │
│ • OpenCode provider was recently modified (commit 9df6694)   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 2. CURRENT CONDITION (What's happening)                     │
├─────────────────────────────────────────────────────────────┤
│ Observable Facts:                                            │
│ • OpenCode provider exists in cli/src/providers/opencode.ts │
│ • Provider has dual data source architecture:               │
│   - SQLite database: ~/.local/share/opencode/opencode.db    │
│   - JSON files: ~/.local/share/opencode/storage/session/    │
│ • Complex message storage structure:                        │
│   - Messages: storage/message/<session_id>/*.json           │
│   - Parts: storage/part/<part_id>.json                      │
│   - Cross-references between session, messages, and parts   │
│                                                              │
│ Symptoms:                                                    │
│ • Sessions discovered but empty message arrays              │
│ • Dashboard shows OpenCode sessions with 0 messages         │
│ • No error logs indicating discovery failures               │
│ • Provider tests pass but only test basic functionality     │
│                                                              │
│ Data Flow Issues:                                            │
│ • parseJsonSession() handles complex file lookups           │
│ • parseDatabaseSession() queries SQLite message table       │
│ • No validation of message directory existence              │
│ • JSON parsing not robust against malformed data            │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 3. GOAL/TARGET (What success looks like)                    │
├─────────────────────────────────────────────────────────────┤
│ • 100% of OpenCode messages extracted successfully          │
│ • Zero OpenCode sessions with empty message arrays          │
│ • Complete message metadata (content, tool calls, usage)    │
│ • Robust error handling with clear diagnostic messages      │
│ • Comprehensive test coverage for message extraction        │
│ • Achieve within 48 hours (before next user demo)           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 4. ROOT CAUSE ANALYSIS (Why problem exists)                 │
├─────────────────────────────────────────────────────────────┤
│ 5 Whys Analysis:                                             │
│ Problem: OpenCode messages not extracted from session data  │
│ Why 1: Message parsing logic fails silently                 │
│ Why 2: Complex multi-file data structure not handled properly │
│ Why 3: Provider assumes OpenCode data format without validation │
│ Why 4: No comprehensive integration testing with real data  │
│ Why 5: OpenCode provider developed without OpenCode expertise │
│                                                              │
│ Contributing Factors (Fishbone):                             │
│ PROCESS:                                                     │
│ • No real OpenCode data for testing during development      │
│ • Provider testing focused on API, not data parsing         │
│ • Recent "robust parsing" fix may have introduced issues    │
│                                                              │
│ TECHNICAL:                                                   │
│ • OpenCode uses most complex storage format (vs other tools) │
│ • Cross-file references require careful ordering            │
│ • JSON parsing without error recovery                       │
│ • Silent failures in try-catch blocks                       │
│                                                              │
│ DATA STRUCTURE:                                              │
│ • Messages split across multiple files per session          │
│ • Parts referenced by ID from messages                      │
│ • Inconsistent data format between SQLite and JSON sources  │
│                                                              │
│ ROOT CAUSE: OpenCode's complex multi-file storage format    │
│             requires specific parsing logic that wasn't     │
│             properly implemented and tested                  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 5. COUNTERMEASURES (Solutions addressing root causes)       │
├─────────────────────────────────────────────────────────────┤
│ Immediate (24 Hours):                                        │
│ 1. Debug with real OpenCode session data                    │
│ 2. Add detailed logging to message parsing functions        │
│ 3. Fix silent failures in parseJsonSession()                │
│ 4. Validate message directory existence before processing   │
│ 5. Add JSON parsing error recovery with jsonrepair          │
│                                                              │
│ Short-term (48 Hours):                                       │
│ 6. Implement robust cross-file reference resolution         │
│ 7. Add message parsing validation and error reporting       │
│ 8. Create comprehensive test suite with real data           │
│ 9. Add OpenCode data format documentation                   │
│ 10. Test both SQLite and JSON parsing paths                 │
│                                                              │
│ Long-term (1 Week):                                          │
│ 11. Add OpenCode data format validation utility             │
│ 12. Create OpenCode session debugging command               │
│ 13. Add provider health check to CLI                        │
│ 14. Document provider testing best practices                │
│ 15. Add integration tests for all providers                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 6. IMPLEMENTATION PLAN (Who, What, When)                    │
├─────────────────────────────────────────────────────────────┤
│ Day 1 (April 19, 2026):                                     │
│ Hour 0-2: Investigate with real OpenCode data [Developer]   │
│ • Find/generate OpenCode session data                       │
│ • Trace message parsing execution with debugger             │
│ • Identify specific failure points                          │
│                                                              │
│ Hour 2-6: Fix critical parsing bugs [Developer]             │
│ • Add error logging to parseJsonSession()                   │
│ • Fix directory existence checks                            │
│ • Add JSON parsing error handling                           │
│ • Test fixes with real data                                 │
│                                                              │
│ Hour 6-8: Deploy and validate fixes [Developer]             │
│ • Build and test locally                                    │
│ • Validate message extraction working                       │
│ • Create minimal test case                                  │
│                                                              │
│ Day 2 (April 20, 2026):                                     │
│ Hour 0-4: Comprehensive testing [Developer]                 │
│ • Create test suite with real OpenCode data                 │
│ • Test edge cases (missing files, malformed JSON)           │
│ • Validate both SQLite and JSON parsing                     │
│                                                              │
│ Hour 4-8: Documentation and cleanup [Developer]             │
│ • Document OpenCode data format                             │
│ • Add provider debugging utilities                          │
│ • Update provider tests                                     │
│                                                              │
│ Dependencies: Access to real OpenCode session data          │
│ Resources: 1 developer (full-time for 2 days)               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ 7. FOLLOW-UP (Verification & Prevention)                    │
├─────────────────────────────────────────────────────────────┤
│ Success Metrics:                                             │
│ • OpenCode sessions show correct message counts             │
│ • All message types extracted (user, assistant, tool calls) │
│ • No parser errors in logs during sync                      │
│ • Test suite passes with 100% real data coverage            │
│                                                              │
│ Verification Plan:                                           │
│ • Day 1 evening: Basic message extraction working           │
│ • Day 2 evening: Comprehensive test suite passing           │
│ • Week 1: Real user validation with existing OpenCode data  │
│ • Week 2: Monitor sync logs for any parsing errors          │
│                                                              │
│ Prevention Measures:                                         │
│ • Require real data testing for all new providers           │
│ • Add provider integration tests to CI pipeline             │
│ • Document data format requirements for each provider       │
│ • Create provider debugging/validation utilities            │
│ • Regular health checks for all provider parsing logic      │
│                                                              │
│ Review Schedule:                                             │
│ • Daily standup: Progress check and blocker resolution      │
│ • End of Day 2: Technical review and testing validation     │
│ • End of Week 1: User acceptance and real-world validation  │
│ • End of Week 2: Close A3 if no regression issues          │
│                                                              │
│ Knowledge Sharing:                                           │
│ • Share findings about OpenCode data format with team       │
│ • Update provider development guidelines                    │
│ • Create troubleshooting guide for provider issues          │
└─────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════