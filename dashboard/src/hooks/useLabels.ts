import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchLabel,
  fetchLabelCategories,
  fetchLabelProgress,
  fetchLabelQueue,
  saveLabel,
  deleteLabel,
} from '@/lib/api';
import type { LabelInput } from '@/lib/types';

export function useLabelCategories() {
  return useQuery({
    queryKey: ['labels', 'categories'],
    queryFn: fetchLabelCategories,
    staleTime: Infinity,
  });
}

export function useLabelQueue(limit = 20) {
  return useQuery({
    queryKey: ['labels', 'queue', limit],
    queryFn: () => fetchLabelQueue(limit),
  });
}

export function useLabelProgress() {
  return useQuery({
    queryKey: ['labels', 'progress'],
    queryFn: fetchLabelProgress,
  });
}

export function useLabel(sessionId: string | undefined) {
  return useQuery({
    queryKey: ['labels', 'session', sessionId],
    queryFn: () => fetchLabel(sessionId!),
    enabled: !!sessionId,
  });
}

function useInvalidateLabels() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['labels'] });
}

export function useSaveLabel() {
  const invalidate = useInvalidateLabels();
  return useMutation({
    mutationFn: ({ sessionId, input }: { sessionId: string; input: LabelInput }) => saveLabel(sessionId, input),
    onSuccess: invalidate,
  });
}

export function useDeleteLabel() {
  const invalidate = useInvalidateLabels();
  return useMutation({
    mutationFn: (sessionId: string) => deleteLabel(sessionId),
    onSuccess: invalidate,
  });
}
