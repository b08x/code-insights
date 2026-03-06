import { useQuery } from '@tanstack/react-query';
import { fetchFacetAggregation, fetchFacetSummary } from '@/lib/api';
import type { FacetAggregation, FacetSummary } from '@/lib/api';

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

export function useFacetSummary(params?: {
  project?: string;
  period?: string;
  source?: string;
}) {
  return useQuery<FacetSummary>({
    queryKey: ['facets', 'summary', params?.project, params?.period, params?.source],
    queryFn: () => fetchFacetSummary(params),
    staleTime: 30_000,
  });
}
