# Graph Report - code-insights  (2026-08-10)

## Corpus Check
- 379 files · ~254,158 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2101 nodes · 5802 edges · 101 communities (89 shown, 12 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.64)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `88521718`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- aggregation.ts
- Database Migration and Sync
- MessageBubble.tsx
- LlmProviderCard.tsx
- Agent Rules and Metadata
- cli/src/index.ts
- share-card-utils.ts
- SessionDetailPanel.tsx
- copilot-cli.ts
- PromptQualityCard.tsx
- analysis/analysis-db.ts
- AnalyticsPage.tsx
- lib/types.ts
- SavedFiltersDropdown.tsx
- Prompt Optimization Engine
- routes/reflect.ts
- queue-worker.ts
- registry.ts
- store.ts
- llm/analysis.ts
- cn
- generateTitle
- server/src/index.ts
- PatternsPage.tsx
- LLM Client Factory
- commands/insights.ts
- sync.ts
- utils/config.ts
- jsonl.ts
- button.tsx
- InsightListItem.tsx
- codex.ts
- src/types.ts
- analysis/prompt-quality-normalize.ts
- analysis/prompts.ts
- Optimization Runner Logic
- runInsightsCommand
- ChatConversation.tsx
- SessionsPage.tsx
- LLM Provider Adapters
- analysis/prompt-types.ts
- cursor.ts
- App.tsx
- utils/telemetry.ts
- mistral-vibe.ts
- getDb
- lib/utils.ts
- ParsedSession
- Insight Program Diagnostics
- commands/reflect.ts
- Optimization Prompt Templates
- OpenCode Provider Integration
- useProjects.ts
- StatsDataSource
- AnalysisCostLine.tsx
- recurring-insights.ts
- Insight Scoring Metrics
- api.ts
- findSimilarNames
- Optimization Service Factory
- Search Result Components
- Insight Program Structure
- copilot.ts
- LLM Analysis Tests
- Facet Extraction Tests
- session-end.ts
- useInsights
- Model Discovery Routes
- Analysis Route Tests
- Schema Validation Tests
- ThemeProvider.tsx
- Browser Open Commands
- Optimization Runner Tests
- Recurring Insight Tests
- Reflect Command Tests
- Analysis Usage Database
- LLM Rate Limiter
- Hook Installation Tests
- LLM Configuration Banner
- SQLite Vector POC
- Telemetry Service Tests
- Analysis Queue Management
- Claude Command Insights
- CLI Changelog Documentation
- Project Convention Docs
- Dashboard Index Page

## God Nodes (most connected - your core abstractions)
1. `cn()` - 112 edges
2. `getDb()` - 65 edges
3. `trackEvent()` - 38 edges
4. `ParsedSession` - 36 edges
5. `Button()` - 34 edges
6. `generateTitle()` - 29 edges
7. `request()` - 29 edges
8. `runInsightsCommand()` - 28 edges
9. `SessionProvider` - 26 edges
10. `runMigrations()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `initTestDb()` --calls--> `runMigrations()`  [EXTRACTED]
  server/src/routes/export.test.ts → cli/src/db/migrate.ts
- `markInsightStale()` --calls--> `getDb()`  [EXTRACTED]
  cli/src/analysis/analysis-db.ts → cli/src/db/client.ts
- `getSessionAnalysisUsage()` --calls--> `getDb()`  [EXTRACTED]
  cli/src/analysis/analysis-usage-db.ts → cli/src/db/client.ts
- `InsightsCommandOptions` --references--> `AnalysisRunner`  [EXTRACTED]
  cli/src/commands/insights.ts → cli/src/analysis/runner-types.ts
- `TeammateMessageCard()` --calls--> `cn()`  [EXTRACTED]
  dashboard/src/components/chat/message/AgentMessageBubble.tsx → dashboard/src/lib/utils.ts

## Import Cycles
- None detected.

## Communities (101 total, 12 thin omitted)

### Community 0 - "aggregation.ts"
Cohesion: 0.07
Nodes (92): costAction(), handleStatsError(), modelsAction(), overviewAction(), AggregatedData, patternsAction(), projectsAction(), todayAction() (+84 more)

### Community 1 - "Database Migration and Sync"
Cohesion: 0.05
Nodes (38): getAllProviders, insertMessages, insertSessionWithProjectAndReturnIsNew, recalculateUsageStats, saveSyncState, syncState, MockAntigravityRunner, MockClaudeRunner (+30 more)

### Community 2 - "MessageBubble.tsx"
Cohesion: 0.07
Nodes (40): ContextBreakDivider(), ContextBreakDividerProps, InlineEventChip(), InlineEventChipProps, AgentMessageBubble(), AgentMessageBubbleProps, getStatusBadgeClass(), TaskNotificationCard() (+32 more)

### Community 3 - "LlmProviderCard.tsx"
Cohesion: 0.08
Nodes (39): BulkEditSessionsDialog(), RenameSessionDialog(), LLMProvider, LlmProviderCard(), LlmProviderCardProps, ProviderInfo, PROVIDERS, Collapsible() (+31 more)

### Community 4 - "Agent Rules and Metadata"
Cohesion: 0.08
Nodes (33): formatAgentRules(), parseMetadata(), asString(), formatKnowledgeBase(), InsightRow, parseBullets(), parseMetadata(), renderDecisions() (+25 more)

### Community 5 - "cli/src/index.ts"
Cohesion: 0.10
Nodes (29): dashboardCommand(), DashboardOptions, isPortInUse(), initCommand(), InitOptions, CLAUDE_SETTINGS_DIR, ClaudeSettings, CLI_ENTRY (+21 more)

### Community 6 - "share-card-utils.ts"
Cohesion: 0.09
Nodes (41): OUTCOME_COLORS, OUTCOME_LABELS, WeekAtAGlanceStrip(), WeekAtAGlanceStripProps, ProfilePromptDialog(), ProfilePromptDialogProps, fetchAvatarAsDataUrl(), isProfileComplete() (+33 more)

### Community 7 - "SessionDetailPanel.tsx"
Cohesion: 0.12
Nodes (36): AnalysisContext, AnalysisContextValue, AnalysisProvider(), AnalysisState, AnalysisType, buildToastMessage(), makeKey(), makeToastId() (+28 more)

### Community 8 - "copilot-cli.ts"
Cohesion: 0.26
Nodes (9): collectEventsFiles(), CopilotCliProvider, CopilotEvent, extractText(), filterByProject(), getCopilotHome(), parseCopilotSession(), parseTimestamp() (+1 more)

### Community 9 - "PromptQualityCard.tsx"
Cohesion: 0.07
Nodes (57): CollapsibleToolPanel(), CollapsibleToolPanelProps, AgentToolPanel(), AgentToolPanelProps, getAgentDisplayName(), getAgentInitials(), AskUserQuestionPanel(), AskUserQuestionPanelProps (+49 more)

### Community 10 - "analysis/analysis-db.ts"
Cohesion: 0.16
Nodes (14): ANALYSIS_VERSION, convertPQToInsightRow(), convertToInsightRows(), DeleteOptions, deleteSessionInsights(), insertInsightsBatch(), markInsightStale(), saveInsightsToDb() (+6 more)

### Community 11 - "AnalyticsPage.tsx"
Cohesion: 0.13
Nodes (26): ActivityChart(), ActivityChartProps, InsightTypeChart(), InsightTypeChartProps, LABELS, DashboardActivityChart(), DashboardActivityChartProps, DashboardRange (+18 more)

### Community 12 - "lib/types.ts"
Cohesion: 0.09
Nodes (27): ActivityFeed(), ActivityFeedProps, FeedItem, insightTypeIcons, insightTypeLabels, SessionFeedItem(), INSIGHT_TYPES, InsightTypePills() (+19 more)

### Community 13 - "SavedFiltersDropdown.tsx"
Cohesion: 0.39
Nodes (6): SavedFiltersDropdown(), SavedFiltersDropdownProps, readStorage(), SavedFilter, useSavedFilters(), writeStorage()

### Community 14 - "Prompt Optimization Engine"
Cohesion: 0.14
Nodes (34): applyVersion(), buildOptimizeCommand(), compareVersionsCmd(), deleteVersionCmd(), extractTopicsFromTranscript(), listVersionsCmd(), loadTrainingData(), runOptimize() (+26 more)

### Community 15 - "routes/reflect.ts"
Cohesion: 0.09
Nodes (25): FRICTION_WINS_SYSTEM_PROMPT, generateFrictionWinsPrompt(), generateRulesSkillsPrompt(), generateWorkingStylePrompt(), RULES_SKILLS_SYSTEM_PROMPT, sampleEffectivePatterns, sampleFrictionCategories, WORKING_STYLE_SYSTEM_PROMPT (+17 more)

### Community 16 - "queue-worker.ts"
Cohesion: 0.12
Nodes (19): AntigravityNativeRunner, CodexNativeRunner, MistralVibeRunner, ClaudeEvent, ClaudeNativeRunner, ClaudeResultEvent, extractResultFromEnvelope(), ProcessQueueOptions (+11 more)

### Community 17 - "registry.ts"
Cohesion: 0.10
Nodes (16): ClaudeCodeProvider, discoverJsonlFiles(), antigravity, claudeCode, codex, copilot, copilotCli, crush (+8 more)

### Community 18 - "store.ts"
Cohesion: 0.07
Nodes (56): DedupMetrics, EMPTY_DEDUP_METRICS, InsightRow, mockEmbedFn(), NOTE: saveInsightsToDbWithDedup uses getDb() singleton internally for writes,, syncMockEmbedFn(), buildEmbeddingConfig(), buildEmbeddingsCommand() (+48 more)

### Community 19 - "llm/analysis.ts"
Cohesion: 0.13
Nodes (30): analyzeSession(), chunkMessages(), deduplicateByTitle(), DEFAULT_RETRIEVAL_CONFIG, getRetrievalConfig(), AnalysisOptions, AnalysisProgress, AnalysisResult (+22 more)

### Community 20 - "cn"
Cohesion: 0.08
Nodes (37): ProjectNavProps, AlertDialogMedia(), AlertDialogOverlay(), CardAction(), CardFooter(), DialogOverlay(), DropdownMenuCheckboxItem(), DropdownMenuContent() (+29 more)

### Community 21 - "generateTitle"
Cohesion: 0.16
Nodes (8): cleanTitle(), detectSessionCharacter(), generateTitle(), AntigravityProvider, CrushProvider, MockDatabase, ParsedMessage, getGeminiHomeDir()

### Community 22 - "server/src/index.ts"
Cohesion: 0.08
Nodes (22): createApp(), ServerOptions, startServer(), app, getSessionTranscriptTool, insightAgent, searchSessionsTool, app (+14 more)

### Community 23 - "PatternsPage.tsx"
Cohesion: 0.10
Nodes (32): CategoryItem, CollapsibleCategoryList(), CollapsibleCategoryListProps, formatUtcDate(), formatWeekLabel(), WeekSelector(), WeekSelectorProps, formatCharacterName() (+24 more)

### Community 24 - "LLM Client Factory"
Cohesion: 0.19
Nodes (20): createClientFromConfig(), initRateLimiterFromConfig(), PROVIDER_API_KEY_ENV, resolveApiKey(), testLLMConfig(), createAnthropicClient(), createGeminiClient(), createMistralClient() (+12 more)

### Community 25 - "commands/insights.ts"
Cohesion: 0.14
Nodes (14): detectRageLoopHeuristic(), RageLoopSignal, SQLiteMessageRow, __dirname, __filename, insightsCommand(), InsightsCommandOptions, isAlreadyAnalyzed() (+6 more)

### Community 26 - "sync.ts"
Cohesion: 0.14
Nodes (22): statusCommand(), filterFilesToSync(), runSync(), SyncOptions, SyncResult, syncSingleFile(), TrivialSession, updateSyncState() (+14 more)

### Community 27 - "utils/config.ts"
Cohesion: 0.11
Nodes (30): configCommand, describeApiKeySource(), llmCommand, PROVIDER_API_KEY_ENV, runInteractiveLLMConfig(), saveLLMConfig(), showConfigAction(), disableAction() (+22 more)

### Community 28 - "jsonl.ts"
Cohesion: 0.11
Nodes (27): buildSession(), classifyUserMessage(), extractProjectName(), extractProjectPath(), extractSessionId(), extractSlashCommandName(), extractTextContent(), extractThinkingContent() (+19 more)

### Community 29 - "button.tsx"
Cohesion: 0.16
Nodes (23): EditProjectDialogProps, CommandPalette(), CommandPaletteProps, NAV_ITEMS, pushRecent(), readRecent(), RecentItem, ResultItem (+15 more)

### Community 30 - "InsightListItem.tsx"
Cohesion: 0.10
Nodes (26): DecisionContent(), FIELD_CONFIG, LearningContent(), OUTCOME_CONFIG, OutcomeBadge(), renderTypeContent(), InsightCard(), DOT_COLORS (+18 more)

### Community 31 - "codex.ts"
Cohesion: 0.11
Nodes (18): buildSession(), CodexProvider, CodexRolloutLine, CodexSessionMeta, CodexUsage, collectRolloutFiles(), extractContent(), extractFormatBContent() (+10 more)

### Community 32 - "src/types.ts"
Cohesion: 0.07
Nodes (35): EDIT_TOOLS, extractBugDescription(), extractFromUserMessage(), extractToolFilePath(), extractTopic(), generateCharacterTitle(), isEditTool(), isReadTool() (+27 more)

### Community 33 - "analysis/prompt-quality-normalize.ts"
Cohesion: 0.14
Nodes (18): saveFacetsToDb(), FRICTION_ALIASES, normalizeFrictionCategory(), kebabToTitleCase(), levenshtein(), normalizeCategory(), NormalizerConfig, getPatternCategoryLabel() (+10 more)

### Community 34 - "analysis/prompts.ts"
Cohesion: 0.15
Nodes (21): classifyStoredUserMessage(), formatMessagesForAnalysis(), formatSessionMetaLine(), ParsedToolCall, ParsedToolResult, safeParseJson(), CANONICAL_PATTERN_CATEGORIES, CANONICAL_PQ_CATEGORIES (+13 more)

### Community 35 - "Optimization Runner Logic"
Cohesion: 0.13
Nodes (17): getVersionDir(), saveArtifact(), saveMetadata(), saveScores(), classifyCompileError(), createGEPARunner(), OptimizationErrorKind, OptimizationLogEntry (+9 more)

### Community 36 - "runInsightsCommand"
Cohesion: 0.17
Nodes (17): processQueue(), insightsCheckCommand(), runInsightsCommand(), buildQueueCommand(), queueProcessCommand(), queuePruneCommand(), queueRetryCommand(), queueStatusCommand() (+9 more)

### Community 37 - "ChatConversation.tsx"
Cohesion: 0.12
Nodes (15): ChatConversation(), ChatConversationProps, shouldShowDateSeparator(), ConversationSearch(), ConversationSearchProps, DateSeparator(), DateSeparatorProps, LoadMoreSentinel() (+7 more)

### Community 38 - "SessionsPage.tsx"
Cohesion: 0.11
Nodes (19): Logo(), LogoProps, BOTTOM_TABS, Header(), HeaderProps, NAV_ITEMS, Layout(), ProjectNav() (+11 more)

### Community 39 - "LLM Provider Adapters"
Cohesion: 0.13
Nodes (16): LLMChatFn, LLMMessage, LLMResponse, makeAnthropicChat(), makeChatFn(), makeGeminiChat(), makeMistralChat(), makeOllamaChat() (+8 more)

### Community 40 - "analysis/prompt-types.ts"
Cohesion: 0.25
Nodes (12): AnalysisResponse, ParseError, ParseResult, PromptQualityDimensionScores, PromptQualityFinding, PromptQualityResponse, PromptQualityTakeaway, buildResponsePreview() (+4 more)

### Community 41 - "cursor.ts"
Cohesion: 0.18
Nodes (17): isVerbose(), collectLexicalText(), CURSOR_MESSAGE_ARRAY_KEYS, CursorProvider, extractFilePath(), extractLexicalText(), extractMessages(), extractProjectPathFromBubbles() (+9 more)

### Community 42 - "App.tsx"
Cohesion: 0.12
Nodes (14): App(), ROUTE_TITLES, RouteEffects(), ErrorBoundary, Props, State, captureDashboardLoaded(), capturePageView() (+6 more)

### Community 43 - "utils/telemetry.ts"
Cohesion: 0.26
Nodes (12): statusAction(), buildEventPreview(), detectHook(), detectProviders(), getCliVersion(), getPostHogClient(), getStableMachineId(), isTelemetryEnabled() (+4 more)

### Community 44 - "mistral-vibe.ts"
Cohesion: 0.21
Nodes (4): MistralVibeProvider, VibeMessage, VibeMeta, ToolResult

### Community 45 - "getDb"
Cohesion: 0.11
Nodes (30): LocalDataSource, PrepareResult, ProjectResolution, UsageStatsDoc, getDb(), getDeletedSessionCount(), getLastSession(), getProjectList() (+22 more)

### Community 46 - "lib/utils.ts"
Cohesion: 0.14
Nodes (22): formatCompact(), StatsHero(), StatsHeroProps, CompactSessionRow(), CompactSessionRowProps, SCORE_TEXT_COLORS, SOURCE_LABELS, formatTimeRange() (+14 more)

### Community 47 - "ParsedSession"
Cohesion: 0.21
Nodes (4): HermesAgentProvider, MockDatabase, ParsedSession, getHermesHomeDir()

### Community 48 - "Insight Program Diagnostics"
Cohesion: 0.17
Nodes (14): args, BUILTIN_SAMPLES, parseResponse(), runDiagnostics(), sampleIdx, verbose, createInsightProgram(), INSIGHT_INSTRUCTION (+6 more)

### Community 49 - "commands/reflect.ts"
Cohesion: 0.27
Nodes (14): backfillAction(), backfillBatch(), backfillBatchToEndpoint(), backfillCommand, backfillPqAction(), backfillPqBatch(), checkLlmConfigured(), checkServer() (+6 more)

### Community 50 - "Optimization Prompt Templates"
Cohesion: 0.24
Nodes (15): GEPARunnerConfig, buildStudentPrompt(), buildTeacherPrompt(), DEFAULT_TEMPLATE_CONFIG, escapeRegExp(), fillTemplate(), INSTRUCTION_INVARIANTS, ObjectiveFeedback (+7 more)

### Community 51 - "OpenCode Provider Integration"
Cohesion: 0.29
Nodes (3): OpenCodeProvider, SessionUsage, getOpenCodeDir()

### Community 52 - "useProjects.ts"
Cohesion: 0.19
Nodes (13): EditProjectDialog(), useFilterParams(), useProject(), useProjectMutation(), useProjects(), fetchProject(), fetchProjects(), patchProject() (+5 more)

### Community 54 - "AnalysisCostLine.tsx"
Cohesion: 0.13
Nodes (18): AnalyzeDropdown(), SaveFilterPopover(), SaveFilterPopoverProps, AnalysisCostLine(), AnalysisCostLineProps, analysisTypeLabel(), formatTokens(), PopoverContent (+10 more)

### Community 55 - "recurring-insights.ts"
Cohesion: 0.24
Nodes (16): createLLMClient(), isLLMConfigured(), cosineSimilarity(), dotProduct(), findGroupsByVectorSimilarity(), findRecurringInsights(), findRecurringInsightsByLLM(), findRecurringInsightsByVector() (+8 more)

### Community 56 - "Insight Scoring Metrics"
Cohesion: 0.34
Nodes (13): InsightOutput, ACTIONABLE_PATTERNS, clamp01(), EVIDENCE_PATTERNS, FILLER_PATTERNS, MetricInput, multiObjectiveMetric(), normalizeInsights() (+5 more)

### Community 57 - "api.ts"
Cohesion: 0.09
Nodes (31): useAnalysisQueue(), useQueuedSessionIds(), ExportGenerateState, ExportGenerateStatus, ExportParams, IDLE_STATE, useExportGenerate(), useExportMarkdown() (+23 more)

### Community 59 - "Optimization Service Factory"
Cohesion: 0.18
Nodes (4): createAIService(), defaultLogger(), GEPARunner, OptimizationError

### Community 60 - "Search Result Components"
Cohesion: 0.24
Nodes (10): SearchHighlight(), SearchHighlightProps, formatRelativeDate(), INSIGHT_ICONS, InsightResultProps, InsightSearchResult(), SessionResultProps, SessionSearchResult() (+2 more)

### Community 62 - "copilot.ts"
Cohesion: 0.22
Nodes (9): collectJsonFiles(), CopilotProvider, CopilotRequest, CopilotResponseItem, CopilotSession, getVSCodeUserDir(), parseCopilotSession(), resolveWorkspacePath() (+1 more)

### Community 63 - "LLM Analysis Tests"
Cohesion: 0.18
Nodes (6): MessageOverrides, mockChat, mockIsConfigured, SessionOverrides, VALID_ANALYSIS_RESPONSE, VALID_PQ_RESPONSE

### Community 64 - "Facet Extraction Tests"
Cohesion: 0.18
Nodes (3): mockAnalyzePromptQuality, mockExtractFacetsOnly, mockIsLLMConfigured

### Community 65 - "session-end.ts"
Cohesion: 0.18
Nodes (16): CLI_ENTRY, readStdin(), sessionEndCommand(), SessionEndOptions, spawnWorker(), WORKER_LOG_PATH, enqueue(), getVersion() (+8 more)

### Community 66 - "useInsights"
Cohesion: 0.16
Nodes (13): Range, useDashboardStats(), InsightParams, useDeleteInsight(), useInsights(), deleteInsight(), fetchDashboardStats(), fetchInsights() (+5 more)

### Community 67 - "Model Discovery Routes"
Cohesion: 0.27
Nodes (6): DiscoveredModel, discoverModels(), discoverOllamaModels(), app, PROVIDER_API_KEY_ENV, VALID_PROVIDERS

### Community 68 - "Analysis Route Tests"
Cohesion: 0.20
Nodes (5): mockAnalyzePromptQuality, mockAnalyzeSession, mockFindRecurringInsights, mockIsLLMConfigured, mockLoadLLMConfig

### Community 70 - "Schema Validation Tests"
Cohesion: 0.25
Nodes (6): ANALYSIS_FACETS_REQUIRED, ANALYSIS_RESPONSE_TOP_LEVEL_REQUIRED, DIMENSION_SCORES_REQUIRED, __dirname, PROMPT_QUALITY_RESPONSE_TOP_LEVEL_REQUIRED, schemasDir

### Community 71 - "ThemeProvider.tsx"
Cohesion: 0.21
Nodes (11): applyTheme(), getSystemTheme(), Theme, ThemeContext, ThemeContextValue, ThemeProvider(), ThemeProviderProps, useTheme() (+3 more)

### Community 72 - "Browser Open Commands"
Cohesion: 0.48
Nodes (5): getCurrentProjectName(), openCommand(), OpenOptions, noop(), openUrl()

### Community 75 - "Reflect Command Tests"
Cohesion: 0.33
Nodes (4): mockChat, mockIsLLMConfigured, seedMultipleSessions(), seedSessionWithFacets()

### Community 76 - "Analysis Usage Database"
Cohesion: 0.38
Nodes (4): AnalysisUsageRow, getSessionAnalysisUsage(), saveAnalysisUsage(), SaveAnalysisUsageData

### Community 78 - "Hook Installation Tests"
Cohesion: 0.60
Nodes (4): hooksFile(), _mockOs, readSettings(), writeSettings()

### Community 79 - "LLM Configuration Banner"
Cohesion: 0.50
Nodes (4): LlmNudgeBanner(), LlmNudgeBannerProps, localStorageKey(), TITLES

### Community 80 - "SQLite Vector POC"
Cohesion: 0.83
Nodes (3): embed(), main(), vecToBlob()

## Knowledge Gaps
- **357 isolated node(s):** `args`, `verbose`, `sampleIdx`, `BUILTIN_SAMPLES`, `SESSION` (+352 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **12 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getDb()` connect `getDb` to `analysis/prompt-quality-normalize.ts`, `Database Migration and Sync`, `session-end.ts`, `runInsightsCommand`, `cli/src/index.ts`, `analysis/analysis-db.ts`, `Analysis Usage Database`, `Prompt Optimization Engine`, `store.ts`, `commands/insights.ts`, `sync.ts`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `cn()` connect `cn` to `MessageBubble.tsx`, `ChatConversation.tsx`, `SessionsPage.tsx`, `SessionDetailPanel.tsx`, `PromptQualityCard.tsx`, `App.tsx`, `AnalyticsPage.tsx`, `lib/types.ts`, `lib/utils.ts`, `AnalysisCostLine.tsx`, `PatternsPage.tsx`, `button.tsx`, `InsightListItem.tsx`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `ParsedSession` connect `ParsedSession` to `src/types.ts`, `Database Migration and Sync`, `copilot-cli.ts`, `cursor.ts`, `mistral-vibe.ts`, `getDb`, `registry.ts`, `OpenCode Provider Integration`, `generateTitle`, `jsonl.ts`, `copilot.ts`, `codex.ts`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `args`, `verbose`, `sampleIdx` to the rest of the system?**
  _357 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `aggregation.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07176539935160625 - nodes in this community are weakly interconnected._
- **Should `Database Migration and Sync` be split into smaller, more focused modules?**
  _Cohesion score 0.05493863237872589 - nodes in this community are weakly interconnected._
- **Should `MessageBubble.tsx` be split into smaller, more focused modules?**
  _Cohesion score 0.06980392156862746 - nodes in this community are weakly interconnected._