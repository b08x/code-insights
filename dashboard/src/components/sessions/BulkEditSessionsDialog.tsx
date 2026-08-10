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
import { Checkbox } from '@/components/ui/checkbox';
import { useBatchUpdateSessions } from '@/hooks/useSessions';
import { toast } from 'sonner';

interface BulkEditSessionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionIds: string[];
  onUpdated?: () => void;
}

export function BulkEditSessionsDialog({
  open,
  onOpenChange,
  sessionIds,
  onUpdated,
}: BulkEditSessionsDialogProps) {
  const [projectName, setProjectName] = useState('');
  const [url, setUrl] = useState('');
  
  // Toggles to determine if the field should be updated in the batch operation
  const [updateProjectName, setUpdateProjectName] = useState(true);
  const [updateUrl, setUpdateUrl] = useState(false);

  const batchUpdateMutation = useBatchUpdateSessions();

  useEffect(() => {
    if (open) {
      setProjectName('');
      setUrl('');
      setUpdateProjectName(true);
      setUpdateUrl(false);
    }
  }, [open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!updateProjectName && !updateUrl) {
      toast.error('Please select at least one field to update');
      return;
    }

    if (updateProjectName && !projectName.trim()) {
      toast.error('Project name override cannot be empty');
      return;
    }

    try {
      await batchUpdateMutation.mutateAsync({
        ids: sessionIds,
        projectName: updateProjectName ? projectName.trim() : undefined,
        gitRemoteUrl: updateUrl ? (url.trim() || undefined) : undefined,
      });
      toast.success(`Successfully updated ${sessionIds.length} session(s)`);
      onUpdated?.();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update sessions');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Bulk Edit Sessions</DialogTitle>
          <DialogDescription>
            Modify details for the {sessionIds.length} selected session(s). Check the fields you want to update.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 py-4">
          <div className="space-y-4">
            {/* Project Name Override */}
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="updateProjectName"
                  checked={updateProjectName}
                  onCheckedChange={(checked) => setUpdateProjectName(!!checked)}
                />
                <Label htmlFor="updateProjectName" className="font-medium cursor-pointer">
                  Update Project Name Override
                </Label>
              </div>
              {updateProjectName && (
                <div className="pl-6 space-y-1">
                  <Input
                    id="projectName"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="e.g. Code Insights"
                    autoFocus
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Overrides the project name for all selected sessions.
                  </p>
                </div>
              )}
            </div>

            {/* Git Remote URL Override */}
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="updateUrl"
                  checked={updateUrl}
                  onCheckedChange={(checked) => setUpdateUrl(!!checked)}
                />
                <Label htmlFor="updateUrl" className="font-medium cursor-pointer">
                  Update Git Remote URL Override
                </Label>
              </div>
              {updateUrl && (
                <div className="pl-6 space-y-1">
                  <Input
                    id="url"
                    type="url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="e.g. https://github.com/user/repo"
                  />
                  <p className="text-[10px] text-muted-foreground">
                    Leave blank to clear the remote URL, or enter a new URL.
                  </p>
                </div>
              )}
            </div>
          </div>

          <DialogFooter className="pt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={batchUpdateMutation.isPending}>
              {batchUpdateMutation.isPending ? 'Saving...' : `Update ${sessionIds.length} Session(s)`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
