// Public API for the server-side LLM engine.

export type { LLMClient, LLMMessage, LLMResponse, ChatOptions } from '@code-insights/cli/llm/types';
export type { LLMProvider, LLMProviderConfig } from '@code-insights/cli/llm/types';
export { createLLMClient, createClientFromConfig, loadLLMConfig, isLLMConfigured, testLLMConfig } from '@code-insights/cli/llm/client';
export { analyzeSession, analyzePromptQuality, findRecurringInsights, extractFacetsOnly } from './analysis.js';
export type { AnalysisResult, RecurringInsightResult } from './analysis.js';
export type { InsightRow, SessionData } from './analysis-db.js';
export { discoverOllamaModels } from '@code-insights/cli/llm/providers/ollama';
