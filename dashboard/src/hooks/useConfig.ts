import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchLlmConfig, saveLlmConfig, fetchPlans, savePlans } from '@/lib/api';
import type { PricingPlan } from '@/lib/types';

export function useLlmConfig() {
  return useQuery({
    queryKey: ['config', 'llm'],
    queryFn: () => fetchLlmConfig(),
  });
}

export function useSaveLlmConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      dashboardPort?: number;
      provider?: string;
      model?: string;
      apiKey?: string;
      baseUrl?: string;
      agent?: {
        provider?: string;
        model?: string;
        apiKey?: string;
        baseUrl?: string;
      };
      embedding?: {
        provider?: string;
        model?: string;
        apiKey?: string;
        baseUrl?: string;
      };
    }) => saveLlmConfig(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['config', 'llm'] });
    },
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

