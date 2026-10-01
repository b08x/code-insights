import { useParams, Link } from 'react-router';
import { ArrowLeft, Tags } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SessionDetailPanel } from '@/components/sessions/SessionDetailPanel';
import { useInsights } from '@/hooks/useInsights';
import { parseJsonField, type InsightMetadata } from '@/lib/types';
import { FcaMatrixCard } from '@/components/insights/FcaMatrixCard';
import { useRegisterPageContext } from '@/components/chat/panel/PageContextProvider';

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: insights = [] } = useInsights(id ? { sessionId: id } : undefined);
  // Lets the chat panel resolve "this session" without the user typing an ID (agent-8).
  useRegisterPageContext(id ? { page: 'session', sessionId: id } : null);

  if (!id) return null;

  const summaryInsight = insights.find((i) => i.type === 'summary');
  const summaryMeta = summaryInsight
    ? parseJsonField<InsightMetadata>(summaryInsight.metadata, {})
    : null;
  const stepMatrix = summaryMeta?.step_matrix;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-6 py-2 border-b bg-muted/10 shrink-0">
        <Button variant="ghost" size="sm" asChild className="gap-1.5 text-xs">
          <Link to="/sessions">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Sessions
          </Link>
        </Button>
        {/* label-9: manual entry point into the labeling page for this session. */}
        <Button variant="outline" size="sm" asChild className="ml-auto gap-1.5 text-xs">
          <Link to={`/label/${id}`}>
            <Tags className="h-3.5 w-3.5" aria-hidden />
            Label this session
          </Link>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto">
        <SessionDetailPanel sessionId={id} />
        {stepMatrix && stepMatrix.length > 0 && (
          <div className="px-6 py-4 border-t">
            <FcaMatrixCard sessionId={id} stepMatrix={stepMatrix} />
          </div>
        )}
      </div>
    </div>
  );
}
