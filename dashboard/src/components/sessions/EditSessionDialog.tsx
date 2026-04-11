import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useSessionMutation } from '@/hooks/useSessions';
import { toast } from 'sonner';

interface EditSessionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  currentTitle: string;
  currentProjectName: string;
  currentUrl: string | null;
  onUpdated?: () => void;
}

export function EditSessionDialog({
  open,
  onOpenChange,
  sessionId,
  currentTitle,
  currentProjectName,
  currentUrl,
  onUpdated,
}: EditSessionDialogProps) {
  const [title, setTitle] = useState(currentTitle);
  const [projectName, setProjectName] = useState(currentProjectName);
  const [url, setUrl] = useState(currentUrl || '');
  const sessionMutation = useSessionMutation();

  useEffect(() => {
    if (open) {
      setTitle(currentTitle);
      setProjectName(currentProjectName);
      setUrl(currentUrl || '');
    }
  }, [open, currentTitle, currentProjectName, currentUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectName.trim()) {
      toast.error('Project name is required');
      return;
    }

    try {
      await sessionMutation.mutateAsync({
        id: sessionId,
        customTitle: title,
        projectName: projectName.trim(),
        gitRemoteUrl: url.trim() || undefined
      });
      toast.success('Session updated');
      onUpdated?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update session');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Session</DialogTitle>
          <DialogDescription>
            Modify session details. Clear the title field to revert to the auto-generated title.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="title">Custom Title</Label>
            <Input
              id="title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Enter a custom title..."
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="projectName">Project Name Override</Label>
            <Input
              id="projectName"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="e.g. Code Insights"
            />
            <p className="text-[10px] text-muted-foreground">
              Overrides the project name just for this session.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="url">Git Remote URL Override</Label>
            <Input
              id="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="e.g. https://github.com/user/repo"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={sessionMutation.isPending}>
              {sessionMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
