import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchProjects, fetchProject, patchProject } from '@/lib/api';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: () => fetchProjects().then((r) => r.projects),
    refetchInterval: 60_000,
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    queryFn: () => fetchProject(id!).then((r) => r.project),
    enabled: !!id,
  });
}

export function useProjectMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, gitRemoteUrl }: { id: string; name?: string; gitRemoteUrl?: string }) =>
      patchProject(id, { name, gitRemoteUrl }),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['project', variables.id] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      // Invalidate sessions and insights since cascading updates might have changed their names/urls
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      queryClient.invalidateQueries({ queryKey: ['session'] });
      queryClient.invalidateQueries({ queryKey: ['insights'] });
    },
  });
}
