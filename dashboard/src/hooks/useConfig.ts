import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchLlmConfig, saveLlmConfig, fetchPlans, savePlans, fetchRunnerModels } from '@/lib/api';
import type { AnalysisRunnerName, PricingPlan } from '@/lib/types';

export function useLlmConfig() {
  return useQuery({
    queryKey: ['config', 'llm'],
    queryFn: () => fetchLlmConfig(),
  });
}

export function useSaveLlmConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof saveLlmConfig>[0]) => saveLlmConfig(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config', 'llm'] });
    },
  });
}

/** Runners whose CLI can list its models; the others use free text only. */
export const RUNNERS_WITH_MODEL_LIST: readonly AnalysisRunnerName[] = ['antigravity', 'opencode'];

export function useRunnerModels(runner: AnalysisRunnerName | undefined) {
  return useQuery({
    queryKey: ['config', 'models', runner],
    queryFn: () => fetchRunnerModels(runner!).then((r) => r.models),
    enabled: !!runner && RUNNERS_WITH_MODEL_LIST.includes(runner),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

export function usePlans() {
  return useQuery({
    queryKey: ['config', 'plans'],
    queryFn: () => fetchPlans().then((r) => r.plans),
  });
}

export function useSavePlans() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (plans: Record<string, PricingPlan>) => savePlans(plans),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config', 'plans'] });
      queryClient.invalidateQueries({ queryKey: ['analytics'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

