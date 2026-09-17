// Annotated conversation chunker — groups messages into analytically-rich chunks.
// Each chunk carries phase, significance, why_context, and related_to metadata.
// Used for retrieval-augmented analysis of long conversations.

import type { SQLiteMessageRow } from '../analysis/prompt-types.js';
import { chunkText } from './chunker.js';
import type { ParsedToolCall, ParsedToolResult } from '../analysis/message-format.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type ChunkPhase =
  | 'decision'
  | 'debug'
  | 'exploration'
  | 'planning'
  | 'execution'
  | 'review';

export type ChunkSignificance = 'high' | 'medium' | 'low';

export interface AnalysisChunk {
  id: string;
  sessionId: string;
  index: number;
  parentChunkId: string | null;
  content: string;           // raw conversation text for this chunk
  annotatedContent: string;  // annotated text used for embedding
  phase: ChunkPhase;
  significance: ChunkSignificance;
  whyContext: string;
  relatedTo: string[];       // related chunk IDs
  messageIds: string[];      // source message IDs in this chunk
}

export interface ExchangeGroup {
  messages: SQLiteMessageRow[];
  startIndex: number;
  endIndex: number;
}

export interface ChunkerConfig {
  parentMaxLength: number;
  childMaxLength: number;
  delimiters: string[];
}

export const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
  parentMaxLength: 4000,
  childMaxLength: 512,
  delimiters: ['\n\n', '\n', '.', '?', '!', ',', ' '],
};

// ── JSON parsing helpers ─────────────────────────────────────────────────────

function parseToolCalls(json: string): ParsedToolCall[] {
  try {
    return JSON.parse(json || '[]') as ParsedToolCall[];
  } catch {
    return [];
  }
}

function parseToolResults(json: string): ParsedToolResult[] {
  try {
    return JSON.parse(json || '[]') as ParsedToolResult[];
  } catch {
    return [];
  }
}

// ── Exchange grouping ────────────────────────────────────────────────────────

/**
 * Group messages into role-boundary exchanges.
 * Each exchange is a logical unit: user turn + assistant response + tool results.
 * Boundaries are detected by role transitions (user→assistant, assistant→user)
 * and by significant time gaps (>60s between messages).
 */
export function groupIntoExchanges(messages: SQLiteMessageRow[]): ExchangeGroup[] {
  if (messages.length === 0) return [];

  const groups: ExchangeGroup[] = [];
  let currentMessages: SQLiteMessageRow[] = [messages[0]];
  let currentStart = 0;

  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1];
    const curr = messages[i];
    const prevTime = new Date(prev.timestamp).getTime();
    const currTime = new Date(curr.timestamp).getTime();
    const timeDeltaSeconds = (currTime - prevTime) / 1000;

    const roleChanged = prev.type !== curr.type && !isToolMessage(curr);
    const timeGap = timeDeltaSeconds > 60;
    const toolBoundary = isToolMessage(prev) && curr.type === 'assistant';

    if (roleChanged || timeGap || toolBoundary) {
      groups.push({
        messages: currentMessages,
        startIndex: currentStart,
        endIndex: i - 1,
      });
      currentMessages = [curr];
      currentStart = i;
    } else {
      currentMessages.push(curr);
    }
  }

  groups.push({
    messages: currentMessages,
    startIndex: currentStart,
    endIndex: messages.length - 1,
  });

  return groups;
}

function isToolMessage(msg: SQLiteMessageRow): boolean {
  if (msg.type === 'user') {
    try {
      const toolResults = JSON.parse(msg.tool_results || '[]') as ParsedToolResult[];
      return toolResults.length > 0;
    } catch {
      return false;
    }
  }
  return false;
}

// ── Phase classification ─────────────────────────────────────────────────────

const DECISION_SIGNALS = [
  'decided', 'chose', 'select', 'prefer', 'instead', 'trade-off', 'tradeoff',
  'alternative', 'approach', 'strategy', 'decision', 'go with', 'use.*instead',
  'let\'s go with', 'we should', 'plan is', 'going to do',
];

const DEBUG_SIGNALS = [
  'error', 'fail', 'bug', 'issue', 'broken', 'fix', 'debug', 'traceback',
  'exception', 'crash', 'wrong', 'doesn\'t work', 'not working', 'problem',
  'trouble', 'stuck', 'retry', 'failed to', 'unable to',
];

const EXPLORATION_SIGNALS = [
  'what', 'how', 'why', 'explore', 'look at', 'check', 'investigate',
  'understand', 'explain', 'read', 'grep', 'search', 'find', 'show me',
  'let me see', 'can you',
];

const PLANNING_SIGNALS = [
  'plan', 'todo', 'step', 'first', 'then', 'next', 'after that', 'before',
  'we need to', 'should we', 'let\'s start', 'implement', 'create', 'build',
  'write', 'add', 'refactor',
];

const EXECUTION_SIGNALS = [
  'running', 'executed', 'applied', 'created', 'wrote', 'added', 'modified',
  'updated', 'deleted', 'saved', 'committed', 'pushed', 'deployed',
  'installed', 'configured', 'set up',
];

const REVIEW_SIGNALS = [
  'review', 'check', 'verify', 'test', 'validate', 'confirm', 'audit',
  'looks good', 'approve', 'done', 'complete', 'finished', 'summary',
  'overview',
];

function classifyPhase(text: string): ChunkPhase {
  const lower = text.toLowerCase();

  const scores: Record<ChunkPhase, number> = {
    decision: DECISION_SIGNALS.filter(s => lower.includes(s)).length,
    debug: DEBUG_SIGNALS.filter(s => lower.includes(s)).length,
    exploration: EXPLORATION_SIGNALS.filter(s => lower.includes(s)).length,
    planning: PLANNING_SIGNALS.filter(s => lower.includes(s)).length,
    execution: EXECUTION_SIGNALS.filter(s => lower.includes(s)).length,
    review: REVIEW_SIGNALS.filter(s => lower.includes(s)).length,
  };

  const maxPhase = Object.entries(scores).reduce((a, b) => b[1] > a[1] ? b : a);
  return maxPhase[1] > 0 ? (maxPhase[0] as ChunkPhase) : 'execution';
}

// ── Significance scoring ─────────────────────────────────────────────────────

function scoreSignificance(text: string, messages: SQLiteMessageRow[]): ChunkSignificance {
  let score = 0;
  const lower = text.toLowerCase();

  // High significance signals
  if (DECISION_SIGNALS.some(s => lower.includes(s))) score += 3;
  if (DEBUG_SIGNALS.some(s => lower.includes(s))) score += 2;
  if (text.includes('MUST') || text.includes('IMPORTANT') || text.includes('CRITICAL')) score += 2;

  // Tool complexity
  const toolCount = messages.filter(m => {
    try {
      const calls = JSON.parse(m.tool_calls || '[]');
      return calls.length > 0;
    } catch { return false; }
  }).length;
  if (toolCount > 3) score += 2;
  else if (toolCount > 0) score += 1;

  // Message count (longer exchanges more significant)
  if (messages.length > 5) score += 1;
  if (messages.length > 10) score += 1;

  // Thinking presence (assistant reasoning)
  const hasThinking = messages.some(m => m.thinking && m.thinking.length > 100);
  if (hasThinking) score += 1;

  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

// ── Why context generation ───────────────────────────────────────────────────

function generateWhyContext(
  phase: ChunkPhase,
  significance: ChunkSignificance,
  text: string,
  messages: SQLiteMessageRow[],
): string {
  const lower = text.toLowerCase();

  const parts: string[] = [];

  // Phase description
  switch (phase) {
    case 'decision':
      parts.push('Contains a key decision or trade-off');
      break;
    case 'debug':
      parts.push('Debugging session with error resolution');
      break;
    case 'exploration':
      parts.push('Exploratory investigation or information gathering');
      break;
    case 'planning':
      parts.push('Planning or task organization');
      break;
    case 'execution':
      parts.push('Implementation or execution phase');
      break;
    case 'review':
      parts.push('Review or verification of work');
      break;
  }

  // Specific signals
  if (lower.includes('error') || lower.includes('fail')) {
    parts.push('error encountered');
  }
  if (DECISION_SIGNALS.some(s => lower.includes(s))) {
    parts.push('decision point');
  }

  // Tool context
  const tools = messages.flatMap(m => {
    try {
      return (JSON.parse(m.tool_calls || '[]') as ParsedToolCall[])
        .map(t => t.name)
        .filter(Boolean);
    } catch { return []; }
  });
  if (tools.length > 0) {
    const uniqueTools = [...new Set(tools)];
    parts.push(`uses: ${uniqueTools.slice(0, 3).join(', ')}`);
  }

  return parts.join('; ');
}

// ── Main chunking function ───────────────────────────────────────────────────

/**
 * Chunk a conversation into analytically-annotated AnalysisChunks.
 *
 * 1. Group messages into role-boundary exchanges
 * 2. Concatenate exchange text into parent chunks (max 4000 chars)
 * 3. Classify each chunk with phase, significance, why_context
 * 4. Split parent chunks into child chunks (max 512 chars) for embedding
 */
export function chunkConversation(
  sessionId: string,
  messages: SQLiteMessageRow[],
  config: ChunkerConfig = DEFAULT_CHUNKER_CONFIG,
): AnalysisChunk[] {
  if (messages.length === 0) return [];

  const exchanges = groupIntoExchanges(messages);
  const chunks: AnalysisChunk[] = [];
  let chunkIndex = 0;

  for (const exchange of exchanges) {
    // Build exchange text
    const exchangeText = formatExchangeText(exchange.messages);
    const parentChunks = chunkText(exchangeText, config.parentMaxLength, config.delimiters);

    for (const parentText of parentChunks) {
      const phase = classifyPhase(parentText);
      const significance = scoreSignificance(parentText, exchange.messages);
      const whyContext = generateWhyContext(phase, significance, parentText, exchange.messages);
      const messageIds = exchange.messages.map(m => m.id);

      const parentChunkId = `${sessionId}_c${chunkIndex}`;
      const annotatedContent = buildAnnotatedContent(parentText, phase, significance, whyContext);

      chunks.push({
        id: parentChunkId,
        sessionId,
        index: chunkIndex,
        parentChunkId: null,
        content: parentText,
        annotatedContent,
        phase,
        significance,
        whyContext,
        relatedTo: [],
        messageIds,
      });

      chunkIndex++;
    }
  }

  // Link related chunks by topic similarity (simple keyword overlap)
  linkRelatedChunks(chunks);

  return chunks;
}

function formatExchangeText(messages: SQLiteMessageRow[]): string {
  return messages.map(m => {
    const role = m.type === 'user' ? 'User' : 'Assistant';
    const toolCalls = parseToolCalls(m.tool_calls);
    const toolResults = parseToolResults(m.tool_results);

    let text = `[${role}]: ${m.content}`;
    if (m.thinking) text += `\n[Thinking]: ${m.thinking.slice(0, 500)}`;
    if (toolCalls.length > 0) {
      text += `\n[Tools: ${toolCalls.map(t => t.name).join(', ')}]`;
    }
    if (toolResults.length > 0) {
      const results = toolResults.map(r => (r.output || '').slice(0, 300)).join(' | ');
      text += `\n[Results: ${results}]`;
    }
    return text;
  }).join('\n\n');
}

function buildAnnotatedContent(
  text: string,
  phase: ChunkPhase,
  significance: ChunkSignificance,
  whyContext: string,
): string {
  return `[phase=${phase}] [significance=${significance}] [why=${whyContext}]\n\n${text}`;
}

// ── Related chunk linking ────────────────────────────────────────────────────

function linkRelatedChunks(chunks: AnalysisChunk[]): void {
  for (let i = 0; i < chunks.length; i++) {
    const keywords = extractKeywords(chunks[i].content);
    const related: string[] = [];

    for (let j = 0; j < chunks.length; j++) {
      if (i === j) continue;
      const otherKeywords = extractKeywords(chunks[j].content);
      const overlap = keywords.filter(k => otherKeywords.includes(k));
      if (overlap.length >= 2) {
        related.push(chunks[j].id);
      }
    }

    chunks[i].relatedTo = related.slice(0, 5);
  }
}

function extractKeywords(text: string): string[] {
  const lower = text.toLowerCase();
  const words = lower.split(/[^a-z0-9]+/).filter(w => w.length > 3);
  const freq = new Map<string, number>();
  for (const w of words) {
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([w]) => w);
}

// ── Child chunk splitting ────────────────────────────────────────────────────

export interface ChildChunk {
  id: string;
  parentId: string;
  text: string;
  annotatedText: string;
  sessionId: string;
  parentIndex: number;
  childIndex: number;
  phase: ChunkPhase;
  significance: ChunkSignificance;
  whyContext: string;
}

/**
 * Split AnalysisChunks into child chunks for embedding.
 * Each child inherits parent's annotations.
 */
export function splitIntoChildChunks(
  chunks: AnalysisChunk[],
  config: ChunkerConfig = DEFAULT_CHUNKER_CONFIG,
): ChildChunk[] {
  const children: ChildChunk[] = [];

  for (const chunk of chunks) {
    const childTexts = chunkText(chunk.annotatedContent, config.childMaxLength, config.delimiters);

    childTexts.forEach((childText, childIdx) => {
      children.push({
        id: `${chunk.id}_c${childIdx}`,
        parentId: chunk.id,
        text: childText,
        annotatedText: childText,
        sessionId: chunk.sessionId,
        parentIndex: chunk.index,
        childIndex: childIdx,
        phase: chunk.phase,
        significance: chunk.significance,
        whyContext: chunk.whyContext,
      });
    });
  }

  return children;
}
