import { useState } from 'react';
import { Link } from 'react-router';
import { Check, FileText, Save, Tag, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { saveDraft } from '@/lib/chat-drafts';
import type { ChatDraft, ChatDraftKind } from '@/lib/types';

const KIND_META: Record<ChatDraftKind, { label: string; icon: typeof FileText }> = {
  note: { label: 'Note', icon: FileText },
  label: { label: 'Label', icon: Tag },
  prompt: { label: 'Prompt', icon: Wand2 },
};

/**
 * A draft the agent proposed. The agent never writes; the user must click Save
 * (agent-10). Save is currently a clipboard stub — see lib/chat-drafts.ts.
 */
export function DraftCard({ draft }: { draft: ChatDraft }) {
  const [saved, setSaved] = useState(false);
  const meta = KIND_META[draft.kind] ?? KIND_META.note;
  const Icon = meta.icon;

  const handleSave = async () => {
    try {
      const result = await saveDraft(draft);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      if (result.kind === 'copied') {
        toast.success('Draft copied to clipboard', {
          description: 'Saving drafts in the dashboard is not available yet.',
        });
      } else {
        toast.success('Draft saved');
      }
    } catch (err) {
      toast.error('Could not save draft', { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <div className="rounded-lg border border-dashed bg-muted/30 p-3 text-sm" role="group" aria-label={`Draft ${meta.label.toLowerCase()}: ${draft.title}`}>
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <Badge variant="outline" className="text-[10px]">Draft {meta.label.toLowerCase()}</Badge>
        <span className="min-w-0 flex-1 truncate font-medium">{draft.title}</span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          onClick={handleSave}
          title="Save draft (copies to clipboard until draft saving is available)"
        >
          {saved ? <Check className="h-3.5 w-3.5 text-emerald-600" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
          {saved ? 'Copied' : 'Save'}
        </Button>
      </div>
      <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs text-foreground/80">
        {draft.content}
      </pre>
      {draft.sessionId && (
        <Link
          to={`/sessions/${draft.sessionId}`}
          className="mt-1 inline-block font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          session {draft.sessionId.slice(0, 8)}
        </Link>
      )}
    </div>
  );
}
