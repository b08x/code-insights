// Per-page suggested prompts for the agent chat panel (agent-9).
// Prompts rely on the page context sent with each message, so "this session"
// resolves server-side without the user typing an ID.

import type { PageContext } from '@/lib/types';

const DEFAULT_PROMPTS = [
  'Summarize my sessions from the last week',
  'What friction keeps recurring across my sessions?',
  'Which decisions did I make recently and why?',
];

export const SUGGESTED_PROMPTS: Record<string, string[]> = {
  session: [
    'Summarize this session',
    'What decisions were made in this session?',
    'Where did this session hit friction?',
    'Draft a note capturing the key learning from this session',
  ],
  sessions: [
    'Which recent sessions were the longest, and why?',
    'Find sessions where I debugged a failing test',
    'Group my recent sessions by theme',
  ],
  insights: [
    'What are my most common learnings this month?',
    'List recent decisions with their trade-offs',
    'Which insights contradict each other?',
  ],
  analytics: [
    'Explain the trends in my recent activity',
    'Which projects consumed the most sessions this month?',
    'How has my session length changed over time?',
  ],
  patterns: [
    'Explain my top friction pattern with examples',
    'Which effective patterns should I use more often?',
  ],
  dashboard: DEFAULT_PROMPTS,
  journal: [
    'Summarize what I worked on this week',
    'Draft a journal note for today',
  ],
  // Optimization pages (phases 2-4) set these page types; prompts are ready ahead of them.
  label: [
    'Summarize this session before I label it',
    'Draft key points for labeling this session',
  ],
  run: [
    'Summarize this run',
    'Which round improved the score the most?',
  ],
  version: [
    'What changed in this prompt version?',
    'Compare this version with the active one',
  ],
};

export function getSuggestedPrompts(context: PageContext | null | undefined): string[] {
  const page = context?.page;
  if (page && SUGGESTED_PROMPTS[page]) return SUGGESTED_PROMPTS[page];
  return DEFAULT_PROMPTS;
}

/** Short human label for the context chip in the panel header, e.g. "Session a1b2c3d4". */
export function describePageContext(context: PageContext | null | undefined): string | null {
  if (!context?.page) return null;
  const shortId = (id: string) => (id.length > 8 ? id.slice(0, 8) : id);
  if (context.sessionId) return `Session ${shortId(context.sessionId)}`;
  if (context.runId) return `Run ${shortId(context.runId)}`;
  if (context.versionId) return `Version ${shortId(context.versionId)}`;
  return context.page.charAt(0).toUpperCase() + context.page.slice(1);
}
