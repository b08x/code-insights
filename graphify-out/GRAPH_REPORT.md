# Graph Report - .  (2026-08-10)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 2090 nodes · 5773 edges · 103 communities (93 shown, 10 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 19 edges (avg confidence: 0.64)
- Token cost: 4,985 input · 1,146 output

## Graph Freshness
- Built from commit: `3eb1d4da`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Cost and Usage Models
- Database Migration and Sync
- Chat UI Components
- Session Analysis Hooks
- Agent Rules and Metadata
- CLI Initialization and Settings
- User Profile and Activity
- Analysis Context Provider
- Title and Metadata Extraction
- Agent Tool Panels
- Insight Database Storage
- Dashboard Activity Charts
- Insight and Pattern UI
- Project and Filter Management
- Prompt Optimization Engine
- LLM Prompt Normalization
- Native LLM Runners
- Session Data Providers
- Insight Deduplication Logic
- Session Analysis Core
- UI Component Library
- Prompt Quality Metrics
- Server Routes and Analytics
- Category and Date Selectors
- LLM Client Factory
- Vector Embedding Management
- CLI Session Lifecycle
- CLI Configuration Commands
- JSONL Session Parsing
- Dialog and Search Components
- Insight Metadata Cards
- Codex Provider Integration
- Crush Provider Integration
- Category Normalization Utilities
- Message Formatting Utilities
- Optimization Runner Logic
- Insight Command Processing
- Chat Conversation UI
- Navigation and Layout
- LLM Provider Adapters
- Response Parsing and Heuristics
- Cursor Provider Integration
- App Routing and Errors
- Activity Feed Components
- Mistral Provider Integration
- Database Write Operations
- Session Stats and Export
- Hermes Provider Integration
- Insight Program Diagnostics
- CLI Reflect Commands
- Optimization Prompt Templates
- OpenCode Provider Integration
- Project Management Hooks
- Layout and Theme Shell
- Analysis Cost Tracking
- Recurring Insight Clustering
- Insight Scoring Metrics
- Export Generation Hooks
- Analysis API Routes
- Optimization Service Factory
- Search Result Components
- Insight Program Structure
- Copilot Provider Integration
- LLM Analysis Tests
- Facet Extraction Tests
- CLI Welcome and Banner
- Insight Management Hooks
- Model Discovery Routes
- Analysis Route Tests
- CLI Search Commands
- Schema Validation Tests
- Theme Context Provider
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
- Native Runner Tests

## God Nodes (most connected - your core abstractions)
1. `cn()` - 110 edges
2. `getDb()` - 65 edges
3. `trackEvent()` - 38 edges
4. `ParsedSession` - 36 edges
5. `Button()` - 33 edges
6. `generateTitle()` - 29 edges
7. `request()` - 29 edges
8. `runInsightsCommand()` - 28 edges
9. `SessionProvider` - 26 edges
10. `runMigrations()` - 25 edges

## Surprising Connections (you probably didn't know these)
- `initTestDb()` --calls--> `runMigrations()`  [EXTRACTED]
  server/src/routes/export.test.ts → cli/src/db/migrate.ts
- `getSessionAnalysisUsage()` --calls--> `getDb()`  [EXTRACTED]
  cli/src/analysis/analysis-usage-db.ts → cli/src/db/client.ts
- `getDeletedSessionCount()` --calls--> `getDb()`  [EXTRACTED]
  cli/src/db/read.ts → cli/src/db/client.ts
- `TeammateMessageCard()` --calls--> `cn()`  [EXTRACTED]
  dashboard/src/components/chat/message/AgentMessageBubble.tsx → dashboard/src/lib/utils.ts
- `InsightCardProps` --references--> `Insight`  [EXTRACTED]
  dashboard/src/components/insights/InsightCard.tsx → dashboard/src/lib/types.ts

## Import Cycles
- None detected.

## Communities (103 total, 10 thin omitted)

### Community 0 - "Cost and Usage Models"
Cohesion: 0.05
Nodes (108): costAction(), handleStatsError(), modelsAction(), overviewAction(), AggregatedData, patternsAction(), projectsAction(), todayAction() (+100 more)

### Community 1 - "Database Migration and Sync"
Cohesion: 0.05
Nodes (38): getAllProviders, insertMessages, insertSessionWithProjectAndReturnIsNew, recalculateUsageStats, saveSyncState, syncState, MockAntigravityRunner, MockClaudeRunner (+30 more)

### Community 2 - "Chat UI Components"
Cohesion: 0.06
Nodes (44): ChatConversationProps, ContextBreakDivider(), ContextBreakDividerProps, ConversationSearchProps, InlineEventChip(), InlineEventChipProps, AgentMessageBubble(), AgentMessageBubbleProps (+36 more)

### Community 3 - "Session Analysis Hooks"
Cohesion: 0.08
Nodes (49): RenameSessionDialog(), SessionDetailPanel(), useAnalyzeSession(), useAnalysisQueue(), useQueuedSessionIds(), Range, useDashboardStats(), useSaveLlmConfig() (+41 more)

### Community 4 - "Agent Rules and Metadata"
Cohesion: 0.08
Nodes (33): formatAgentRules(), parseMetadata(), asString(), formatKnowledgeBase(), InsightRow, parseBullets(), parseMetadata(), renderDecisions() (+25 more)

### Community 5 - "CLI Initialization and Settings"
Cohesion: 0.09
Nodes (41): configCommand, dashboardCommand(), DashboardOptions, isPortInUse(), initCommand(), InitOptions, CLAUDE_SETTINGS_DIR, ClaudeSettings (+33 more)

### Community 6 - "User Profile and Activity"
Cohesion: 0.09
Nodes (40): OUTCOME_COLORS, OUTCOME_LABELS, WeekAtAGlanceStrip(), WeekAtAGlanceStripProps, ProfilePromptDialog(), ProfilePromptDialogProps, fetchAvatarAsDataUrl(), isProfileComplete() (+32 more)

### Community 7 - "Analysis Context Provider"
Cohesion: 0.13
Nodes (34): AnalysisContext, AnalysisContextValue, AnalysisProvider(), AnalysisState, AnalysisType, buildToastMessage(), makeKey(), makeToastId() (+26 more)

### Community 8 - "Title and Metadata Extraction"
Cohesion: 0.09
Nodes (31): cleanTitle(), detectSessionCharacter(), EDIT_TOOLS, extractBugDescription(), extractFromUserMessage(), extractToolFilePath(), extractTopic(), generateCharacterTitle() (+23 more)

### Community 9 - "Agent Tool Panels"
Cohesion: 0.15
Nodes (32): CollapsibleToolPanel(), CollapsibleToolPanelProps, AgentToolPanel(), AgentToolPanelProps, getAgentDisplayName(), getAgentInitials(), AskUserQuestionPanel(), AskUserQuestionPanelProps (+24 more)

### Community 10 - "Insight Database Storage"
Cohesion: 0.19
Nodes (13): ANALYSIS_VERSION, convertPQToInsightRow(), convertToInsightRows(), DeleteOptions, insertInsightsBatch(), saveInsightsToDb(), saveInsightsToDbWithDedup(), SessionData (+5 more)

### Community 11 - "Dashboard Activity Charts"
Cohesion: 0.13
Nodes (25): ActivityChart(), ActivityChartProps, InsightTypeChart(), InsightTypeChartProps, LABELS, DashboardActivityChart(), DashboardActivityChartProps, DashboardRange (+17 more)

### Community 12 - "Insight and Pattern UI"
Cohesion: 0.10
Nodes (31): INSIGHT_TYPES, InsightTypePills(), InsightTypePillsProps, PatternGroup, RecurringPatternsSection(), RecurringPatternsSectionProps, DATE_PRESETS, SessionListPanel() (+23 more)

### Community 13 - "Project and Filter Management"
Cohesion: 0.09
Nodes (28): SavedFiltersDropdown(), SavedFiltersDropdownProps, SaveFilterPopover(), SaveFilterPopoverProps, EditProjectDialog(), BulkEditSessionsDialog(), ProjectNavProps, OUTCOME_OPTIONS (+20 more)

### Community 14 - "Prompt Optimization Engine"
Cohesion: 0.14
Nodes (34): applyVersion(), buildOptimizeCommand(), compareVersionsCmd(), deleteVersionCmd(), extractTopicsFromTranscript(), listVersionsCmd(), loadTrainingData(), runOptimize() (+26 more)

### Community 15 - "LLM Prompt Normalization"
Cohesion: 0.09
Nodes (24): FRICTION_WINS_SYSTEM_PROMPT, generateFrictionWinsPrompt(), generateRulesSkillsPrompt(), generateWorkingStylePrompt(), RULES_SKILLS_SYSTEM_PROMPT, sampleEffectivePatterns, sampleFrictionCategories, WORKING_STYLE_SYSTEM_PROMPT (+16 more)

### Community 16 - "Native LLM Runners"
Cohesion: 0.11
Nodes (23): AntigravityNativeRunner, CodexNativeRunner, MistralVibeRunner, ClaudeEvent, ClaudeNativeRunner, ClaudeResultEvent, extractResultFromEnvelope(), ProcessQueueOptions (+15 more)

### Community 17 - "Session Data Providers"
Cohesion: 0.10
Nodes (19): AntigravityProvider, ClaudeCodeProvider, discoverJsonlFiles(), antigravity, claudeCode, codex, copilot, copilotCli (+11 more)

### Community 18 - "Insight Deduplication Logic"
Cohesion: 0.11
Nodes (23): DedupMetrics, EMPTY_DEDUP_METRICS, InsightRow, mockEmbedFn(), NOTE: saveInsightsToDbWithDedup uses getDb() singleton internally for writes,, syncMockEmbedFn(), createAllVectorTables(), createVectorTable() (+15 more)

### Community 19 - "Session Analysis Core"
Cohesion: 0.17
Nodes (22): analyzeSession(), chunkMessages(), deduplicateByTitle(), DEFAULT_RETRIEVAL_CONFIG, getRetrievalConfig(), AnalysisOptions, AnalysisProgress, AnalysisResult (+14 more)

### Community 20 - "UI Component Library"
Cohesion: 0.10
Nodes (25): Alert(), AlertDescription(), AlertTitle(), alertVariants, AlertDialogMedia(), AlertDialogOverlay(), Checkbox(), DialogOverlay() (+17 more)

### Community 21 - "Prompt Quality Metrics"
Cohesion: 0.09
Nodes (29): AntiPattern, CategoryBadge(), DIMENSION_LABELS, DimensionScores(), getScoreColor(), LegacyContent(), NewSchemaContent(), PQDimensionScores (+21 more)

### Community 22 - "Server Routes and Analytics"
Cohesion: 0.09
Nodes (19): createApp(), ServerOptions, startServer(), app, app, Range, VALID_RANGES, app (+11 more)

### Community 23 - "Category and Date Selectors"
Cohesion: 0.13
Nodes (26): CategoryItem, CollapsibleCategoryList(), CollapsibleCategoryListProps, formatUtcDate(), formatWeekLabel(), WeekSelector(), WeekSelectorProps, useFacetAggregation() (+18 more)

### Community 24 - "LLM Client Factory"
Cohesion: 0.19
Nodes (20): createClientFromConfig(), initRateLimiterFromConfig(), PROVIDER_API_KEY_ENV, resolveApiKey(), testLLMConfig(), createAnthropicClient(), createGeminiClient(), createMistralClient() (+12 more)

### Community 25 - "Vector Embedding Management"
Cohesion: 0.17
Nodes (25): buildEmbeddingConfig(), buildEmbeddingsCommand(), embeddingsBackfillCommand(), embeddingsRecomputeCommand(), embeddingsSearchCommand(), embeddingsStatusCommand(), statusRowToInt(), backfillAll() (+17 more)

### Community 26 - "CLI Session Lifecycle"
Cohesion: 0.11
Nodes (25): CLI_ENTRY, readStdin(), sessionEndCommand(), SessionEndOptions, spawnWorker(), WORKER_LOG_PATH, filterFilesToSync(), runSync() (+17 more)

### Community 27 - "CLI Configuration Commands"
Cohesion: 0.13
Nodes (26): describeApiKeySource(), llmCommand, PROVIDER_API_KEY_ENV, runInteractiveLLMConfig(), saveLLMConfig(), showConfigAction(), disableAction(), enableAction() (+18 more)

### Community 28 - "JSONL Session Parsing"
Cohesion: 0.12
Nodes (25): buildSession(), classifyUserMessage(), extractProjectName(), extractProjectPath(), extractSessionId(), extractSlashCommandName(), extractTextContent(), extractThinkingContent() (+17 more)

### Community 29 - "Dialog and Search Components"
Cohesion: 0.22
Nodes (16): ConversationSearch(), EditProjectDialogProps, BulkEditSessionsDialogProps, EditSessionDialog(), EditSessionDialogProps, RenameSessionDialogProps, Button(), buttonVariants (+8 more)

### Community 30 - "Insight Metadata Cards"
Cohesion: 0.13
Nodes (22): DecisionContent(), FIELD_CONFIG, LearningContent(), OUTCOME_CONFIG, OutcomeBadge(), renderTypeContent(), InsightCard(), InsightCardProps (+14 more)

### Community 31 - "Codex Provider Integration"
Cohesion: 0.11
Nodes (18): CodexProvider, CodexRolloutLine, CodexSessionMeta, CodexUsage, collectRolloutFiles(), extractContent(), extractFormatBContent(), filterByProject() (+10 more)

### Community 32 - "Crush Provider Integration"
Cohesion: 0.08
Nodes (23): CrushProvider, MockDatabase, EffectivePattern, ExportTemplate, FileHistorySnapshot, FileSyncState, FrictionPoint, FrictionWinsResult (+15 more)

### Community 33 - "Category Normalization Utilities"
Cohesion: 0.15
Nodes (17): FRICTION_ALIASES, normalizeFrictionCategory(), kebabToTitleCase(), levenshtein(), normalizeCategory(), NormalizerConfig, getPatternCategoryLabel(), normalizePatternCategory() (+9 more)

### Community 34 - "Message Formatting Utilities"
Cohesion: 0.16
Nodes (20): classifyStoredUserMessage(), formatMessagesForAnalysis(), formatSessionMetaLine(), ParsedToolCall, ParsedToolResult, safeParseJson(), CANONICAL_FRICTION_CATEGORIES, CANONICAL_PATTERN_CATEGORIES (+12 more)

### Community 35 - "Optimization Runner Logic"
Cohesion: 0.13
Nodes (17): getVersionDir(), saveArtifact(), saveMetadata(), saveScores(), classifyCompileError(), createGEPARunner(), OptimizationErrorKind, OptimizationLogEntry (+9 more)

### Community 36 - "Insight Command Processing"
Cohesion: 0.14
Nodes (25): deleteSessionInsights(), markInsightStale(), saveFacetsToDb(), updateSessionTitle(), processQueue(), insightsCheckCommand(), isAlreadyAnalyzed(), loadSessionForAnalysis() (+17 more)

### Community 37 - "Chat Conversation UI"
Cohesion: 0.12
Nodes (16): ChatConversation(), shouldShowDateSeparator(), DateSeparator(), DateSeparatorProps, LoadMoreSentinel(), LoadMoreSentinelProps, isAgentMessage(), CommandPalette() (+8 more)

### Community 38 - "Navigation and Layout"
Cohesion: 0.14
Nodes (16): Logo(), LogoProps, BOTTOM_TABS, HeaderProps, NAV_ITEMS, ProjectNav(), Sheet(), SheetContent() (+8 more)

### Community 39 - "LLM Provider Adapters"
Cohesion: 0.13
Nodes (16): LLMChatFn, LLMMessage, LLMResponse, makeAnthropicChat(), makeChatFn(), makeGeminiChat(), makeMistralChat(), makeOllamaChat() (+8 more)

### Community 40 - "Response Parsing and Heuristics"
Cohesion: 0.18
Nodes (15): detectRageLoopHeuristic(), RageLoopSignal, ContentBlock, ParseError, ParseResult, PromptQualityDimensionScores, PromptQualityFinding, PromptQualityTakeaway (+7 more)

### Community 41 - "Cursor Provider Integration"
Cohesion: 0.19
Nodes (17): isVerbose(), collectLexicalText(), CURSOR_MESSAGE_ARRAY_KEYS, CursorProvider, extractFilePath(), extractLexicalText(), extractMessages(), extractProjectPathFromBubbles() (+9 more)

### Community 42 - "App Routing and Errors"
Cohesion: 0.12
Nodes (14): App(), ROUTE_TITLES, RouteEffects(), ErrorBoundary, Props, State, captureDashboardLoaded(), capturePageView() (+6 more)

### Community 43 - "Activity Feed Components"
Cohesion: 0.12
Nodes (16): ActivityFeed(), ActivityFeedProps, FeedItem, insightTypeIcons, insightTypeLabels, formatCharacterName(), WorkingStyleHighlights(), WorkingStyleHighlightsProps (+8 more)

### Community 44 - "Mistral Provider Integration"
Cohesion: 0.14
Nodes (11): MistralVibeProvider, VibeMessage, VibeMeta, SyncState, ToolCall, CONFIG_DIR, CONFIG_FILE, getGeminiTmpDir() (+3 more)

### Community 45 - "Database Write Operations"
Cohesion: 0.21
Nodes (17): sessionExists(), getStmts(), insertMessages(), insertSessionWithProject(), insertSessionWithProjectAndReturnIsNew(), insertSessionWithProjectInternal(), truncate(), updateGlobalUsageStats() (+9 more)

### Community 46 - "Session Stats and Export"
Cohesion: 0.21
Nodes (14): SessionFeedItem(), formatCompact(), StatsHero(), StatsHeroProps, formatTimeRange(), VitalsStrip(), VitalsStripProps, exportSession() (+6 more)

### Community 47 - "Hermes Provider Integration"
Cohesion: 0.22
Nodes (3): HermesAgentProvider, MockDatabase, getHermesHomeDir()

### Community 48 - "Insight Program Diagnostics"
Cohesion: 0.17
Nodes (14): args, BUILTIN_SAMPLES, parseResponse(), runDiagnostics(), sampleIdx, verbose, createInsightProgram(), INSIGHT_INSTRUCTION (+6 more)

### Community 49 - "CLI Reflect Commands"
Cohesion: 0.24
Nodes (15): backfillAction(), backfillBatch(), backfillBatchToEndpoint(), backfillCommand, backfillPqAction(), backfillPqBatch(), checkLlmConfigured(), checkServer() (+7 more)

### Community 50 - "Optimization Prompt Templates"
Cohesion: 0.24
Nodes (15): GEPARunnerConfig, buildStudentPrompt(), buildTeacherPrompt(), DEFAULT_TEMPLATE_CONFIG, escapeRegExp(), fillTemplate(), INSTRUCTION_INVARIANTS, ObjectiveFeedback (+7 more)

### Community 51 - "OpenCode Provider Integration"
Cohesion: 0.29
Nodes (3): OpenCodeProvider, SessionUsage, getOpenCodeDir()

### Community 52 - "Project Management Hooks"
Cohesion: 0.15
Nodes (14): CardDescription(), useProject(), useProjectMutation(), useProjects(), ExportGenerateDepth, ExportGenerateFormat, ExportGenerateScope, fetchProject() (+6 more)

### Community 53 - "Layout and Theme Shell"
Cohesion: 0.21
Nodes (11): Header(), Layout(), useTheme(), ThemeToggle(), Props, Toaster(), Tooltip(), TooltipContent() (+3 more)

### Community 54 - "Analysis Cost Tracking"
Cohesion: 0.18
Nodes (13): AnalysisCostLine(), AnalysisCostLineProps, analysisTypeLabel(), formatTokens(), AnalysisCostData, AnalysisUsageRow, useAnalysisCost(), estimateAnalysisCost() (+5 more)

### Community 55 - "Recurring Insight Clustering"
Cohesion: 0.24
Nodes (14): cosineSimilarity(), dotProduct(), findGroupsByVectorSimilarity(), findRecurringInsights(), findRecurringInsightsByLLM(), findRecurringInsightsByVector(), InsightEmbedding, l2Norm() (+6 more)

### Community 56 - "Insight Scoring Metrics"
Cohesion: 0.34
Nodes (13): InsightOutput, ACTIONABLE_PATTERNS, clamp01(), EVIDENCE_PATTERNS, FILLER_PATTERNS, MetricInput, multiObjectiveMetric(), normalizeInsights() (+5 more)

### Community 57 - "Export Generation Hooks"
Cohesion: 0.21
Nodes (12): ExportGenerateState, ExportGenerateStatus, ExportParams, IDLE_STATE, useExportGenerate(), useExportMarkdown(), ExportGenerateMetadata, ExportGenerateRequest (+4 more)

### Community 58 - "Analysis API Routes"
Cohesion: 0.29
Nodes (10): FacetRow, loadSessionForAnalysis(), loadSessionMessages(), ProgressMessageFn, requireLLM(), streamBatchBackfill(), StreamBatchBackfillOptions, streamSessionAnalysis() (+2 more)

### Community 59 - "Optimization Service Factory"
Cohesion: 0.18
Nodes (4): createAIService(), defaultLogger(), GEPARunner, OptimizationError

### Community 60 - "Search Result Components"
Cohesion: 0.24
Nodes (10): SearchHighlight(), SearchHighlightProps, formatRelativeDate(), INSIGHT_ICONS, InsightResultProps, InsightSearchResult(), SessionResultProps, SessionSearchResult() (+2 more)

### Community 62 - "Copilot Provider Integration"
Cohesion: 0.24
Nodes (7): collectJsonFiles(), CopilotProvider, CopilotRequest, CopilotResponseItem, CopilotSession, getVSCodeUserDir(), resolveWorkspacePath()

### Community 63 - "LLM Analysis Tests"
Cohesion: 0.18
Nodes (6): MessageOverrides, mockChat, mockIsConfigured, SessionOverrides, VALID_ANALYSIS_RESPONSE, VALID_PQ_RESPONSE

### Community 64 - "Facet Extraction Tests"
Cohesion: 0.18
Nodes (3): mockAnalyzePromptQuality, mockExtractFacetsOnly, mockIsLLMConfigured

### Community 65 - "CLI Welcome and Banner"
Cohesion: 0.38
Nodes (8): getAllProviders(), getVersion(), printBanner(), purple, ensureConfigDir(), countAllSessions(), showWelcomeIfFirstRun(), touchWelcomeMarker()

### Community 66 - "Insight Management Hooks"
Cohesion: 0.33
Nodes (8): InsightParams, useDeleteInsight(), useInsights(), deleteInsight(), fetchInsights(), getWeekKey(), getWeekLabel(), JournalPage()

### Community 67 - "Model Discovery Routes"
Cohesion: 0.27
Nodes (6): DiscoveredModel, discoverModels(), discoverOllamaModels(), app, PROVIDER_API_KEY_ENV, VALID_PROVIDERS

### Community 68 - "Analysis Route Tests"
Cohesion: 0.20
Nodes (5): mockAnalyzePromptQuality, mockAnalyzeSession, mockFindRecurringInsights, mockIsLLMConfigured, mockLoadLLMConfig

### Community 69 - "CLI Search Commands"
Cohesion: 0.58
Nodes (8): buildEmbeddingConfig(), buildSearchCommands(), getMessage(), queryCommand(), searchCommand(), truncateString(), vsearchCommand(), embedOne()

### Community 70 - "Schema Validation Tests"
Cohesion: 0.25
Nodes (6): ANALYSIS_FACETS_REQUIRED, ANALYSIS_RESPONSE_TOP_LEVEL_REQUIRED, DIMENSION_SCORES_REQUIRED, __dirname, PROMPT_QUALITY_RESPONSE_TOP_LEVEL_REQUIRED, schemasDir

### Community 71 - "Theme Context Provider"
Cohesion: 0.32
Nodes (7): applyTheme(), getSystemTheme(), Theme, ThemeContext, ThemeContextValue, ThemeProvider(), ThemeProviderProps

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

### Community 102 - "Native Runner Tests"
Cohesion: 0.40
Nodes (3): mockExecFileSync, mockUnlinkSync, mockWriteFileSync

## Knowledge Gaps
- **352 isolated node(s):** `args`, `verbose`, `sampleIdx`, `BUILTIN_SAMPLES`, `SESSION` (+347 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **10 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `getDb()` connect `Insight Command Processing` to `Cost and Usage Models`, `Database Migration and Sync`, `CLI Initialization and Settings`, `CLI Search Commands`, `Insight Database Storage`, `Analysis Usage Database`, `Database Write Operations`, `Prompt Optimization Engine`, `Native LLM Runners`, `Vector Embedding Management`, `CLI Session Lifecycle`?**
  _High betweenness centrality (0.040) - this node is a cross-community bridge._
- **Why does `cn()` connect `UI Component Library` to `Chat UI Components`, `Session Analysis Hooks`, `Chat Conversation UI`, `Navigation and Layout`, `Analysis Context Provider`, `Agent Tool Panels`, `Activity Feed Components`, `Insight and Pattern UI`, `Project and Filter Management`, `Dashboard Activity Charts`, `Session Stats and Export`, `Project Management Hooks`, `Layout and Theme Shell`, `Prompt Quality Metrics`, `Dialog and Search Components`, `Insight Metadata Cards`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Why does `ParsedSession` connect `Session Data Providers` to `Crush Provider Integration`, `Database Migration and Sync`, `Title and Metadata Extraction`, `Cursor Provider Integration`, `Mistral Provider Integration`, `Database Write Operations`, `Hermes Provider Integration`, `OpenCode Provider Integration`, `JSONL Session Parsing`, `Copilot Provider Integration`, `Codex Provider Integration`?**
  _High betweenness centrality (0.015) - this node is a cross-community bridge._
- **What connects `args`, `verbose`, `sampleIdx` to the rest of the system?**
  _352 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Cost and Usage Models` be split into smaller, more focused modules?**
  _Cohesion score 0.050880626223091974 - nodes in this community are weakly interconnected._
- **Should `Database Migration and Sync` be split into smaller, more focused modules?**
  _Cohesion score 0.05493863237872589 - nodes in this community are weakly interconnected._
- **Should `Chat UI Components` be split into smaller, more focused modules?**
  _Cohesion score 0.0632996632996633 - nodes in this community are weakly interconnected._