import { useState, useRef } from 'react';
import { Sparkles, Loader2, CheckCircle, AlertCircle, StopCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useAnalysis } from './AnalysisContext';
import { useLlmConfig } from '@/hooks/useConfig';
import type { Session } from '@/lib/types';

interface BulkAnalyzeButtonProps {
  sessions: Session[];
  onComplete?: () => void;
}

export function BulkAnalyzeButton({ sessions, onComplete }: BulkAnalyzeButtonProps) {
  const [open, setOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [currentSessionTitle, setCurrentSessionTitle] = useState<string | null>(null);
  const [result, setResult] = useState<{
    successful: number;
    failed: number;
    errors: string[];
    stopped?: boolean;
  } | null>(null);
  const stopRequestedRef = useRef(false);
  const { startAnalysis, getAnalysisState, cancelAnalysis } = useAnalysis();
  const { data: llmConfig } = useLlmConfig();

  const configured = !!(llmConfig?.provider && llmConfig?.model);

  const handleAnalyze = async () => {
    if (!configured || sessions.length === 0) return;

    setAnalyzing(true);
    stopRequestedRef.current = false;
    setProgress({ completed: 0, total: sessions.length });
    setResult(null);

    let successful = 0;
    let failed = 0;
    const errors: string[] = [];
    let stopped = false;

    for (const session of sessions) {
      if (stopRequestedRef.current) {
        stopped = true;
        break;
      }

      try {
        setCurrentSessionTitle(session.generated_title || session.custom_title || 'Untitled Session');
        await startAnalysis(session, 'session');
        
        // After startAnalysis completes, check the final state for this session
        const state = getAnalysisState(session.id, 'session');
        if (state?.status === 'complete' && state.result?.success) {
          successful++;
        } else {
          // If we requested stop, startAnalysis returns resolving the current one.
          // We shouldn't necessarily count it as "failed" if it was just aborted.
          if (stopRequestedRef.current) {
             stopped = true;
             break;
          }
          failed++;
          errors.push(state?.result?.error || `Failed: ${session.id}`);
        }
      } catch (error) {
        if (stopRequestedRef.current) {
          stopped = true;
          break;
        }
        failed++;
        errors.push(error instanceof Error ? error.message : `Failed: ${session.id}`);
      }
      setProgress((prev) => ({ ...prev, completed: prev.completed + 1 }));
    }

    setResult({ successful, failed, errors, stopped });
    setAnalyzing(false);
    setCurrentSessionTitle(null);
    onComplete?.();
  };

  const handleStop = () => {
    stopRequestedRef.current = true;
    // Cancel any currently active analysis
    const currentSession = sessions[progress.completed];
    if (currentSession) {
      cancelAnalysis(currentSession.id, 'session');
    }
  };

  const handleClose = (newOpen: boolean) => {
    if (!newOpen && !analyzing) {
      setOpen(false);
      setResult(null);
      setProgress({ completed: 0, total: 0 });
    }
  };

  if (!configured) {
    return (
      <Button variant="outline" disabled className="gap-2">
        <Sparkles className="h-4 w-4" />
        Analyze Selected
        <span className="text-xs text-muted-foreground ml-1">(Configure AI first)</span>
      </Button>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <Button
        variant="outline"
        className="gap-2"
        disabled={sessions.length === 0}
        onClick={() => setOpen(true)}
      >
        <Sparkles className="h-4 w-4" />
        Analyze {sessions.length} Session{sessions.length !== 1 ? 's' : ''}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bulk Analysis</DialogTitle>
          <DialogDescription>
            Generate AI insights for {sessions.length} selected session
            {sessions.length !== 1 ? 's' : ''}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {!analyzing && !result && (
            <>
              <p className="text-sm text-muted-foreground">
                This will use your configured LLM provider to analyze each session and generate insights.
              </p>
              <Button onClick={handleAnalyze} className="w-full gap-2">
                <Sparkles className="h-4 w-4" />
                Start Analysis
              </Button>
            </>
          )}

          {analyzing && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
                <span className="text-sm font-medium">
                  Analyzing session {progress.completed + 1} of {progress.total}...
                </span>
              </div>
              {currentSessionTitle && (
                <p className="text-xs text-muted-foreground truncate italic">
                  Currently: {currentSessionTitle}
                </p>
              )}
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className="bg-primary h-2 rounded-full transition-all"
                  style={{ width: `${progress.total > 0 ? (progress.completed / progress.total) * 100 : 0}%` }}
                />
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleStop} 
                className="w-full gap-2 text-red-600 hover:text-red-700 hover:bg-red-50"
              >
                <StopCircle className="h-3.5 w-3.5" />
                Stop Analysis
              </Button>
            </div>
          )}

          {result && (
            <div className="space-y-3">
              <div className={`flex items-center gap-2 ${result.stopped ? 'text-amber-600' : 'text-green-600'}`}>
                {result.stopped ? (
                  <StopCircle className="h-4 w-4" />
                ) : (
                  <CheckCircle className="h-4 w-4" />
                )}
                <span className="font-medium">
                  {result.stopped ? 'Analysis Stopped' : 'Analysis Complete'}
                </span>
              </div>
              <div className="text-sm text-muted-foreground space-y-1 pl-6">
                <p>{result.successful} session{result.successful !== 1 ? 's' : ''} successfully analyzed</p>
                {result.failed > 0 && <p className="text-red-500">{result.failed} failed</p>}
                {result.stopped && <p>{sessions.length - result.successful - result.failed} sessions skipped</p>}
              </div>
              
              {result.failed > 0 && (
                <div className="space-y-1 pl-6">
                  <ul className="text-[11px] text-muted-foreground list-disc list-inside max-h-24 overflow-y-auto">
                    {result.errors.slice(0, 5).map((err, i) => (
                      <li key={i} className="truncate">{err}</li>
                    ))}
                    {result.errors.length > 5 && (
                      <li>...and {result.errors.length - 5} more</li>
                    )}
                  </ul>
                </div>
              )}
              <Button onClick={() => handleClose(false)} className="w-full">
                Done
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
