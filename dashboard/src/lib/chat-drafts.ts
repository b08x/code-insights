// Save handler for agent draft payloads (agent-10).
//
// STUB: the server has no endpoint that persists drafts yet (the agent is
// read-only by design; notes/labels/prompts are written by later phases).
// Until then "Save" copies the draft to the clipboard as Markdown. Replace the
// body of saveDraft with the real mutation when the endpoint exists; callers
// already await it and toast on the returned result.

import type { ChatDraft } from '@/lib/types';

export type SaveDraftResult = { kind: 'copied' } | { kind: 'saved' };

export function draftToMarkdown(draft: ChatDraft): string {
  const lines = [`## ${draft.title}`, ''];
  if (draft.sessionId) lines.push(`Session: /sessions/${draft.sessionId}`, '');
  lines.push(draft.content);
  return lines.join('\n');
}

export async function saveDraft(draft: ChatDraft): Promise<SaveDraftResult> {
  await navigator.clipboard.writeText(draftToMarkdown(draft));
  return { kind: 'copied' };
}
