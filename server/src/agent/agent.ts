// Plain function-calling chat agent (no code runtime, no RLM, no output template).
//
// An AxGen program with `functions` runs the tool loop: the model calls tools, Ax feeds the
// results back, and the final `reply` streams to the caller. `runChatAgent` turns that into a
// small typed event stream the chat route maps onto SSE.

import { ai, ax } from '@ax-llm/ax';
import type { AxAIService, AxFunction } from '@ax-llm/ax';
import { loadConfig } from '@code-insights/cli/utils/config';
import { loadLLMConfig } from '../llm/client.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { toDraftPayload, toolRegistry, type DraftPayload } from './tools.js';

export interface PageContext {
  /** e.g. 'session', 'sessions', 'run', 'version', 'dashboard' */
  page?: string;
  sessionId?: string;
  runId?: string;
  versionId?: string;
  [key: string]: unknown;
}

export interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; args: unknown; ok: boolean; ms: number }
  | { type: 'citation'; sessionId: string }
  | { type: 'draft'; draft: DraftPayload };

export interface RunChatAgentParams {
  llm: AxAIService;
  userQuery: string;
  pageContext?: PageContext | null;
  history?: HistoryMessage[];
  tools?: AxFunction[];
  signal?: AbortSignal;
  maxSteps?: number;
}

/** Inputs passed to the program's forward call. Exported so tests can assert pageContext reaches the model (agent-8). */
export function buildForwardInputs(params: Pick<RunChatAgentParams, 'userQuery' | 'pageContext' | 'history'>) {
  return {
    userQuery: params.userQuery,
    pageContext: params.pageContext ?? {},
    history: params.history ?? [],
  };
}

export function createChatProgram() {
  return ax('userQuery:string, pageContext?:json, history?:json -> reply:string', {
    description: SYSTEM_PROMPT,
  });
}

/** Collect session IDs from a tool result so the UI can show citations (agent-5). */
export function extractSessionIds(result: unknown, out: Set<string> = new Set()): Set<string> {
  let value = result;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return out; }
  }
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (k === 'sessionId' && typeof x === 'string') out.add(x);
      else walk(x, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * Run one agent turn. Yields text deltas as they stream, plus tool_call / citation / draft
 * events as tools finish. Throws on LLM errors; the caller decides how to surface them.
 */
export async function* runChatAgent(params: RunChatAgentParams): AsyncGenerator<AgentEvent> {
  const program = createChatProgram();
  const tools = params.tools ?? toolRegistry.functions(loadConfig());
  const pending: AgentEvent[] = [];
  const cited = new Set<string>();

  const stream = program.streamingForward(params.llm, buildForwardInputs(params), {
    functions: tools,
    maxSteps: params.maxSteps ?? 8,
    abortSignal: params.signal,
    onFunctionCall: (call) => {
      const name = call.fn;
      pending.push({ type: 'tool_call', name, args: call.args, ok: call.ok, ms: call.ms });
      if (!call.ok) return;
      for (const sid of extractSessionIds(call.result)) {
        if (!cited.has(sid)) { cited.add(sid); pending.push({ type: 'citation', sessionId: sid }); }
      }
      if (name === 'proposeDraft' || name.endsWith('.proposeDraft')) {
        const r = call.result as { draft?: DraftPayload } | string;
        const draft = typeof r === 'object' && r?.draft ? r.draft : toDraftPayload((call.args ?? {}) as Record<string, unknown>);
        pending.push({ type: 'draft', draft });
      }
    },
  });

  for await (const chunk of stream) {
    while (pending.length) yield pending.shift()!;
    const delta = chunk?.delta?.reply;
    if (delta) yield { type: 'text', text: delta };
  }
  while (pending.length) yield pending.shift()!;
}

// ─── LLM resolution ───────────────────────────────────────────────────────────

const ENV_VARS: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

/**
 * Resolve the agent's LLM: config.dashboard.agent, else the main dashboard LLM, else env keys.
 * Returns an error string (for a 400) when no key is available.
 */
export function resolveAgentLLM(): { llm: AxAIService } | { error: string } {
  const config = loadConfig();
  const agentConfig = config?.dashboard?.agent;
  const fallback = loadLLMConfig();

  const provider = agentConfig?.provider || fallback?.provider || 'openai';
  const model = agentConfig?.model || fallback?.model || 'gpt-4o-mini';
  let apiKey = agentConfig?.apiKey || fallback?.apiKey;
  if (!apiKey && ENV_VARS[provider]) apiKey = process.env[ENV_VARS[provider]];
  const isOllama = provider === 'ollama';
  if (!apiKey && !isOllama) {
    return { error: 'No API key configured for the Agent. Please set it in the Settings page.' };
  }

  let name: string = provider;
  if (provider === 'gemini') name = 'google-gemini';
  if (isOllama || provider === 'openrouter') name = 'openai';

  const options: Record<string, unknown> = { name, apiKey: apiKey ?? 'ollama', config: { model, embedModel: model } };
  const baseUrl = agentConfig?.baseUrl || fallback?.baseUrl;
  if (baseUrl) {
    const clean = baseUrl.replace(/\/+$/, '');
    options.apiURL = isOllama ? (clean.endsWith('/v1') ? clean : `${clean}/v1`) : clean;
  } else if (isOllama) {
    options.apiURL = 'http://localhost:11434/v1';
  } else if (provider === 'openrouter') {
    options.apiURL = 'https://openrouter.ai/api/v1';
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { llm: ai(options as any) };
}
