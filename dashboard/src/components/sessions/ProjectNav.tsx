import { useState, useMemo } from 'react';
import { Folder, FolderOpen, MoreVertical, Pencil } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { Project } from '@/lib/types';
import { EditProjectDialog } from '@/components/projects/EditProjectDialog';

interface ProjectNavProps {
  projects: Project[];
  selectedProject: string;
  selectedSource: string;
  onSelectProject: (projectId: string) => void;
  onSelectSource: (source: string) => void;
}

export function ProjectNav({
  projects,
  selectedProject,
  selectedSource,
  onSelectProject,
  onSelectSource,
}: ProjectNavProps) {
  const [search, setSearch] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const showSearch = projects.length > 8;

  const totalSessions = useMemo(
    () => projects.reduce((sum, p) => sum + p.session_count, 0),
    [projects]
  );

  const filteredProjects = useMemo(() => {
    if (!search) return projects;
    const q = search.toLowerCase();
    return projects.filter((p) => p.name.toLowerCase().includes(q));
  }, [projects, search]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 space-y-2">
        {showSearch && (
          <Input
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-xs"
          />
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-1.5">
        {/* All Projects */}
        <button
          onClick={() => onSelectProject('all')}
          aria-current={selectedProject === 'all' ? 'true' : undefined}
          className={cn(
            'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors',
            selectedProject === 'all'
              ? 'bg-accent text-accent-foreground font-medium'
              : 'text-foreground hover:bg-accent/50'
          )}
        >
          <span className="truncate">All Projects</span>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">{totalSessions}</span>
        </button>

        <Separator className="my-1.5" />

        {/* Project list */}
        {filteredProjects.map((project) => {
          const isActive = selectedProject === project.id;
          const Icon = isActive ? FolderOpen : Folder;
          return (
            <div
              key={project.id}
              className={cn(
                'group w-full flex items-center gap-1 rounded-md transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              )}
            >
              <button
                onClick={() => onSelectProject(project.id)}
                aria-current={isActive ? 'true' : undefined}
                className={cn(
                  'flex-1 flex items-center gap-2 px-2.5 py-1.5 text-sm min-w-0',
                  isActive ? 'font-medium' : ''
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate text-left flex-1">{project.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums shrink-0 mr-1">
                  {project.session_count}
                </span>
              </button>
              
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button 
                    variant="ghost" 
                    size="icon" 
                    className="h-6 w-6 shrink-0 mr-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 transition-opacity"
                  >
                    <MoreVertical className="h-3.5 w-3.5" />
                    <span className="sr-only">Project options</span>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditingProject(project)}>
                    <Pencil className="h-3.5 w-3.5 mr-2" />
                    Edit Project
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>

      {/* Source filter at bottom */}
      <div className="p-3 border-t">
        <Select value={selectedSource} onValueChange={onSelectSource}>
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="All Sources" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Sources</SelectItem>
            <SelectItem value="claude-code">Claude Code</SelectItem>
            <SelectItem value="cursor">Cursor</SelectItem>
            <SelectItem value="codex-cli">Codex CLI</SelectItem>
            <SelectItem value="copilot-cli">Copilot CLI</SelectItem>
            <SelectItem value="copilot">Copilot</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {editingProject && (
        <EditProjectDialog
          open={!!editingProject}
          onOpenChange={(open) => !open && setEditingProject(null)}
          projectId={editingProject.id}
          currentName={editingProject.name}
          currentUrl={editingProject.git_remote_url}
        />
      )}
    </div>
  );
}
