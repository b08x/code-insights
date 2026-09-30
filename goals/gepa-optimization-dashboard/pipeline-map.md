# Analysis pipeline map (Phase 1, step 6a)

Derived from reading the code and from the goldens in `cli/src/analysis/__tests__/fixtures/pipeline/golden/`. Every difference marked `[pinned: <golden>]` is asserted by a characterization test; changing it in 6c must update that golden deliberately.

## Call graph

CLI path
- Entry: `cli/src/commands/insights.ts` `runInsightsCommand(options)`.
- Callers: `insightsCommand` (CLI command, `--hook`), `insightsCheckCommand` (batch, `_runner` reused, lines ~598/664/734), `cli/src/analysis/queue-worker.ts:126` (queue: native items pass a pre-built native runner; other items pass no runner, so `runInsightsCommand` builds `ProviderRunner.fromConfig()`).
- Callees: runner selection (`ProviderRunner.fromConfig()` | `ClaudeNativeRunner` | `CodexNativeRunner` | `AntigravityNativeRunner` | `MistralVibeRunner`, with native fallback chain codex -> claude -> antigravity -> vibe), `formatMessagesForAnalysis`, dynamic `embeddings/retrieval` + `embeddings/analysis-pipeline`, `detectRageLoopHeuristic`, `codebase-memory-mcp cli get_architecture` (execFileSync), `buildSessionAnalysisInstructions`, `buildPromptQualityInstructions`, `runner.runAnalysis`, `parseAnalysisResponse`, `parsePromptQualityResponse`, `convertToInsightRows`, `convertPQToInsightRow`, `saveInsightsToDb`, `deleteSessionInsights`, `saveFacetsToDb`, `saveSessionStepsToDb`, `updateSessionTitle`, `saveAnalysisUsage`, `renderAnalysisReport`.
- Transport: `AnalysisRunner.runAnalysis({systemPrompt, userPrompt, jsonSchema})`; provider transport is `ProviderRunner` `make*Chat` (plain string messages, no `ContentBlock`).

Server path
- Entries: `server/src/llm/analysis.ts` `analyzeSession`; `server/src/llm/prompt-quality-analysis.ts` `analyzePromptQuality`. Both re-exported from `server/src/llm/index.ts`.
- Callers: `server/src/routes/analysis.ts` (`POST /session` and a separate prompt-quality endpoint, both through the SSE/`analysisFn` helper in `route-helpers.ts`), `server/src/routes/facets.ts` (`analyzePromptQuality` backfill; `extractFacetsOnly` is a third, facet-only entry that is out of scope for 6c unless folded in).
- Callees: `createLLMClient` (`server/src/llm/client.ts` -> `providers/*`), `formatMessagesForAnalysis`, `retrieveRelatedInsights` (sqlite-vec), `shouldUseRetrieval`/`retrieveAnalysisChunks`/`chunkAndEmbedSession` from `cli/dist/embeddings/*`, `chunkMessages` + `mergeAnalysisResponses` (local), `buildFacetOnlyInstructions`, `extractJsonPayload` + `jsonrepair`, `calculateAnalysisCost`, the same prompt builders, parsers, `analysis-db` converters (re-exports of cli `analysis-db`).
- Transport: `LLMClient.chat(LLMMessage[], {signal})`; content blocks with `cache_control` are sent as-is to Anthropic and flattened for every other provider.
- Title write (`applyGeneratedTitle`) and telemetry live in the route, not in `analyzeSession`.

Shared (not divergent): `cli/src/analysis/{prompts,prompt-constants,message-format,response-parsers,*-normalize,analysis-db}.ts` (server files are re-export shims over `cli/dist`), `parseAnalysisResponse`/`parsePromptQualityResponse` both already call `jsonrepair`.

## Orchestration differences

| # | Area | CLI path | Server path | Pinned |
|---|---|---|---|---|
| D1 | Passes per entry | One call runs session pass then prompt-quality pass; any parse failure throws (`Session analysis failed: ...`) | Two independent functions/endpoints; failures returned as `AnalysisResult{success:false,error_type,response_preview}`, never thrown | short, failure-invalid-structure |
| D2 | Prompt assembly | One string: conversation block text + retrieval + architecture + `\n` + instructions, sent as a single user string | `ContentBlock[]`: block 0 = conversation (`cache_control: ephemeral`), block 1 = retrieval + instructions. Flattened without the extra `\n` for non-Anthropic providers | short, transport-* |
| D3 | Retrieval thresholds | `retrieveAnalysisChunks(..., defaults)`: topK 20, similarity 0.5, maxInputTokens 128k, ratio 0.8; no `sessionMeta`; no embeddingConfig | config `dashboard.analysis.retrieval` (defaults topK 5, similarity 0.75), `maxInputTokens: 80000`, ratio 0.8, passes `sessionMeta` and an embedding config | long-retrieval |
| D4 | Retrieval trigger | `shouldUseRetrieval(formatted)` with module defaults (fires above ~102.4k estimated tokens) | Same call, so the same trigger, but then retrieves with the 80k config; result: retrieval fires only for sessions that are also above the 80k chunk threshold | long-chunked (no retrieval at 89k tokens), long-retrieval |
| D5 | Related insights (AutoRefine) | None | `retrieveRelatedInsights`: embeds first 4000 chars, sqlite-vec top-K same project, similarity >= 0.75, content cut to 300 chars, injected as `<related_insights>` in session and facet-only prompts (not in prompt-quality) | short-related |
| D6 | Architecture context | `codebase-memory-mcp cli get_architecture` (15 s timeout) appended as `<project_architecture>` to both passes when available | None | long-retrieval |
| D7 | Rage-loop signal | `detectRageLoopHeuristic` result injected as `<detected_signals>` in session pass | Not computed | prompt-quality |
| D8 | Session metadata | `sessionMeta` always an object (zeros/empty list) | `buildSessionMeta` returns `undefined` when no compacts/slash commands. Rendered prompt text is identical either way (`formatSessionMetaLine` returns '' for zeros) | short, short-related |
| D9 | Long sessions | No chunking: sends the whole conversation (plus retrieval) in one prompt, regardless of size | Above 80k estimated tokens: `chunkMessages` (64k-token chunks), one call per chunk (retrieval block repeated in every chunk prompt), `mergeAnalysisResponses` (first summary, decisions capped at 3, learnings at 5, title-dedup), unparseable chunks silently skipped, all-chunks-fail returns `json_parse_error` | long-chunked, long-retrieval |
| D10 | Facets on chunked sessions | Facets come from the single response | Extra facet-only call (`buildFacetOnlyInstructions`); truncated to ~80k tokens if over; `JSON.parse` then `jsonrepair` fallback; failure is silent | long-chunked, long-retrieval |
| D11 | jsonrepair | Inside `parseAnalysisResponse` only | Inside `parseAnalysisResponse` plus an explicit `jsonrepair` fallback for the chunked facet call | long-chunked |
| D12 | Prompt-quality input | No gate; `humanMessageCount` = every `type='user'` row (tool-result and system-artifact rows included); `toolExchangeCount` = rows with truthy `tool_calls`; no truncation; no timeout | Gate: needs >= 2 genuine human messages (`classifyStoredUserMessage`); `humanMessageCount` = genuine only; `toolExchangeCount` = total - human - assistant; truncates to ~80k tokens; 120 s `AbortSignal.timeout` | prompt-quality, gate-one-human, short |
| D13 | Prompt-quality context | Architecture context appended | None | long-retrieval (cli) |
| D14 | Persist: old-row cleanup after PQ | `deleteSessionInsights(excludeTypes: [summary, decision, learning], excludeIds: [new])` (deletes every type not in that list) | `deleteSessionInsights(includeOnlyTypes: [prompt_quality], excludeIds: [new])` | source-level; same rows in goldens (only `prompt_quality` exists) |
| D15 | Persist: facets | `saveFacetsToDb(id, facets)` (default analysis version) | `saveFacetsToDb(id, facets, ANALYSIS_VERSION)`; both store `3.1.0` today | short |
| D16 | Persist: session title | `updateSessionTitle` inside the command (`generated_title` set) | Not in `analyzeSession`; route `applyGeneratedTitle` does it after `analyzeSession` only | short (`generated_title` null on server) |
| D17 | Usage/cost recording | `estimated_cost_usd` always 0; `session_message_count` set (drives resume detection); provider/model from runner (`stub-*` in tests, `claude-native`/`claude-code-native` for native); `chunk_count` left at 1 | Cost via `calculateAnalysisCost(llmConfig.provider, model, ...)` using the configured LLM (not the client); `chunk_count` = chunks; `session_message_count` NULL; token totals summed over chunk + facet calls; skipped when no usage | short, long-chunked |
| D18 | Usage for native runners | Tokens 0 (runner cannot report) | n/a | transport-native-claude |
| D19 | Structured output | Passes `jsonSchema` (session-analysis.json / prompt-quality.json) to runners; native Claude uses `--json-schema`; ProviderRunner ignores it | No schema is sent | transport-native-claude, pipeline goldens (`jsonSchemaTopLevelKeys`) |
| D20 | Native runner fallback | codex -> claude -> antigravity -> vibe on "usage limit reached" (only for plain `--native`) | n/a | not pinned (see gaps) |
| D21 | Resume detection | `--hook` skips when `analysis_usage.session_message_count` matches | none | not pinned |
| D22 | Progress/abort | console output only; no AbortSignal | `onProgress` phases (`analyzing`, per-chunk, `saving`), `AbortSignal` through `chat`, `AbortError` -> `error_type: 'abort'` | short, long-chunked |
| D23 | Transport parity | Provider params identical to server for all 6 providers (temperature 0.7, max_tokens 8192 where applicable, headers) | Same | transport-* (bodies differ only by D2, and Anthropic receives `cache_control` blocks from the server vs one plain string from `ProviderRunner`) |
| D24 | Non-canonical categories | Stored as returned (`totally-made-up-category` is persisted in `session_facets.friction_points`); normalizers run at read time, not at save | Same | short |

## Gaps: what is not driven end to end

- Codex, Antigravity and Mistral Vibe native runners: only `ClaudeNativeRunner` is captured (argv/stdin/system-prompt file/schema file). Their argv is covered by the existing per-runner unit tests; the pipeline above the runner is identical to the Claude case.
- The server cannot drive any native runner (it has no `AnalysisRunner`), so native output parsing is CLI-only.
- Real embeddings/sqlite-vec retrieval is stubbed: retrieval arguments and prompt placement are pinned, retrieval quality is not.
- Native fallback chain (D20), resume detection (D21) and `insights check` batch mode are unchanged and unpinned.
- Server route layer (`route-helpers.ts` SSE, `applyGeneratedTitle`, telemetry) and `extractFacetsOnly` are not in the goldens.
- Provider error paths (HTTP errors, rate limiter) are not pinned.
- The server path consumes `cli/dist` (workspace exports map), so `pnpm --filter @code-insights/cli build` must precede the tests; the root build-then-test order already does this.

## Resolutions (Phase 1, step 6c)

`cli/src/analysis/pipeline.ts` `analyzeSessionPipeline(sessionId, { runner, passes?, input?, identity?, promptResolution?, onProgress?, signal?, log? })` is now the only implementation. Runner capabilities come from optional `AnalysisRunner` metadata: `provider`/`model` (priced + Anthropic blocks), `maxInputTokens` (chunking budget), `estimateTokens`. `ProviderRunner` declares all four (budget 80k); native CLI runners declare none.

| # | Resolution in the unified pipeline | Notes / residual |
|---|---|---|
| D1 | One function with `passes` (`session`, `prompt_quality`; default both). Failures are returned as `{success:false, error_type, failedPass, completedPasses}`; the CLI wrapper throws, the server wrappers map to `AnalysisResult`. With both passes requested, a prompt-quality gate failure skips that pass (`skipped.prompt_quality`) instead of failing the run; prompt-quality-only returns `insufficient_messages`. | Server keeps two functions/endpoints as thin wrappers (`passes:['session']`, `passes:['prompt_quality']`). |
| D2 | One canonical prompt string `conversation block + retrieval + architecture + "\n" + instructions`. Runners with `provider === 'anthropic'` also receive it split into `[cached conversation block, rest]` (`userContent`); flattened blocks equal the string byte for byte, so the prompt hash does not depend on transport. | |
| D3 | Single config: `dashboard.analysis.retrieval` over defaults topK 5, similarity 0.75, sameProjectOnly; `maxInputTokens` = `runner.maxInputTokens ?? 80000`, ratio 0.8; `sessionMeta` and `embeddingConfig` always passed. | CLI previously used topK 20 / 0.5 / 128k. |
| D4 | Trigger unchanged: `shouldUseRetrieval(formatted)` with the module default (~102.4k estimated tokens). Both former paths already shared it. | Sessions between the 80k chunk budget and 102k chunk without retrieval (as server did). |
| D5 | Related insights run in both entry points whenever embeddings are configured, defined as: `retrieval.enabled !== false` and the `vec_insights` table exists. Injected into session, chunk and facet-only prompts, not prompt-quality. | No table or no embedding backend -> no related insights, silently. |
| D6, D13 | Architecture context (`codebase-memory-mcp cli get_architecture`, 15 s) is gathered once and added to session, chunk and prompt-quality prompts for every entry point when available. Facet-only pass omits it (as before). Uses async `execFile` so the server event loop is not blocked. | |
| D7 | Rage-loop signal on for all entry points: injected into the single-call session prompt; for chunked sessions the signal goes to the facet-only pass (whole conversation) because its turn range is session-global. | Chunk prompts omit it. |
| D8 | Server `buildSessionMeta` semantics (undefined when no compacts/slash commands). Rendered prompt identical. | |
| D9 | Chunk + merge when the prompt's estimated tokens exceed `runner.maxInputTokens`; chunk size 0.8 x budget; merge unchanged (first summary, 3 decisions, 5 learnings, title dedup, unparseable chunks skipped, all-fail -> `json_parse_error`). Native runners declare no budget and never chunk. | The estimate covers the whole prompt (conversation + retrieval + architecture + instructions), not only the conversation as the server did. |
| D10 | Extra facet-only call only on chunked sessions, conversation truncated to the budget, no `jsonSchema` (the session schema does not describe it). Cancellation inside it now propagates (previously swallowed). | |
| D11 | `jsonrepair` fallback for the facet-only payload lives in the pipeline; `parseAnalysisResponse`/`parsePromptQualityResponse` keep theirs. | |
| D12 | Server gate (>= 2 genuine human messages via `classifyStoredUserMessage`), genuine-only `humanMessageCount`, `toolExchangeCount = total - human - assistant`, 80k truncation (`runner.maxInputTokens ?? 80000`), 120 s timeout combined with the caller signal. | Native runners cannot honor the signal. |
| D14 | `deleteSessionInsights(includeOnlyTypes:['prompt_quality'], excludeIds:[new])` (server form; never deletes other types). | |
| D15 | `saveFacetsToDb(id, facets, ANALYSIS_VERSION)` everywhere. | Same stored value (3.1.0). |
| D16 | `generated_title` written by the pipeline (session pass). Route `applyGeneratedTitle` removed in 6d. | |
| D17 | Usage row always recorded per pass: provider/model from the runner result, tokens summed over chunk + facet calls, `chunk_count`, `session_message_count` set, cost from `calculateAnalysisCost(provider, model)` when the runner declares a provider, 0 for native runners. | Server rows previously had NULL `session_message_count` and were skipped when no usage was reported. `calculateAnalysisCost` moved to `cli/src/analysis/analysis-pricing.ts` (server shim re-exports). |
| D18 | Unchanged: native runners report 0 tokens. | |
| D19 | `jsonSchema` still passed to every runner; native Claude uses it, `ProviderRunner` ignores it. | |
| D20 | Native fallback chain (codex -> claude -> antigravity -> vibe) stays CLI-only as a runner wrapper in `insights.ts`; the pipeline sees one runner. | Not unified: the server has no native runners. |
| D21 | Resume detection stays in the CLI command (hook mode only). | Not unified by design: it is a hook concern. |
| D22 | `onProgress` + `signal` for every entry point; CLI passes `log` for its console lines. | |
| D23 | Already one transport (6b). | |
| D24 | Unchanged: non-canonical friction categories are stored as returned; normalizers run at read time. | |
