import { useQuery } from '@tanstack/react-query';
import { fetchFacetAggregation, fetchReflectSnapshot } from '@/lib/api';
import type { FacetAggregation, ReflectSnapshot } from '@/lib/api';

export function useFacetAggregation(params?: {
  project?: string;
  period?: string;
  source?: string;
}) {
  return useQuery<FacetAggregation>({
    queryKey: ['facets', 'aggregated', params?.project, params?.period, params?.source],
    queryFn: () => fetchFacetAggregation(params),
    staleTime: 30_000,
  });
}

export function useReflectSnapshot(params?: {
  period?: string;
  project?: string;
}) {
  return useQuery<{ snapshot: ReflectSnapshot | null }>({
    queryKey: ['reflect', 'snapshot', params?.period, params?.project],
    queryFn: () => fetchReflectSnapshot(params),
    staleTime: 30_000,
  });
}
