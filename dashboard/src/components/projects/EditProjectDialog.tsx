import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useProjectMutation } from '@/hooks/useProjects';
import { toast } from 'sonner';

interface EditProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  currentName: string;
  currentUrl: string | null;
  onRenamed?: () => void;
}

export function EditProjectDialog({
  open,
  onOpenChange,
  projectId,
  currentName,
  currentUrl,
  onRenamed,
}: EditProjectDialogProps) {
  const [name, setName] = useState(currentName);
  const [url, setUrl] = useState(currentUrl || '');
  const projectMutation = useProjectMutation();

  useEffect(() => {
    if (open) {
      setName(currentName);
      setUrl(currentUrl || '');
    }
  }, [open, currentName, currentUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      toast.error('Project name is required');
      return;
    }
    
    try {
      await projectMutation.mutateAsync({ 
        id: projectId, 
        name: name.trim(), 
        gitRemoteUrl: url.trim() || undefined 
      });
      toast.success('Project updated successfully');
      onRenamed?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update project');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Edit Project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Project Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Code Insights"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="url">Git Remote URL</Label>
            <Input
              id="url"
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="e.g. https://github.com/user/repo"
            />
            <p className="text-[10px] text-muted-foreground">
              Optional. Links project names to their repository.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={projectMutation.isPending}>
              {projectMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
