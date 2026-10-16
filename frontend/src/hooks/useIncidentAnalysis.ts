import { useMutation, useQuery } from '@tanstack/react-query';
import { analyzeApi } from '@/services/api';
import type { IncidentAnalysisRequest } from '@/types';
import { useDebouncedValue } from './useDebouncedValue';

export function useAnalyzerHealth() {
  return useQuery({
    queryKey: ['analyzer', 'health'],
    queryFn: () => analyzeApi.health().then((r) => r.data),
    staleTime: 1000 * 60,
    retry: false,
  });
}

export function useAnalyzeIncident() {
  return useMutation({
    mutationFn: (context: IncidentAnalysisRequest) =>
      analyzeApi.analyze(context).then((r) => r.data),
  });
}

/** 선택된 클러스터의 namespace 드롭다운 데이터.
 *
 *  큰 클러스터 대비 — 기본은 fast path (백엔드 with_counts=false) 로 ns 이름만 빠르게.
 *  ``onlyWithIssues=true`` 거나 ``withCounts=true`` 일 때만 클러스터 전체 pod fetch
 *  (느린 경로) 가 발동된다. ``namespacePattern`` / ``podPattern`` 으로 그 비용을 좁힐 수 있다.
 *
 *  패턴 값은 300ms 동안 안정된 뒤에야 queryKey 에 반영 — 타이핑 중 refetch 폭주 방지. */
export function useAnalyzeNamespaces(
  clusterId: string,
  onlyWithIssues = false,
  withCounts = false,
  namespacePattern = '',
  podPattern = '',
) {
  const dNsPattern  = useDebouncedValue(namespacePattern, 300);
  const dPodPattern = useDebouncedValue(podPattern, 300);
  return useQuery({
    queryKey: ['analyzer', 'namespaces', clusterId, onlyWithIssues, withCounts, dNsPattern, dPodPattern],
    queryFn: () =>
      analyzeApi
        .listNamespaces(clusterId, onlyWithIssues, withCounts, dNsPattern, dPodPattern)
        .then((r) => r.data),
    enabled: !!clusterId,
    staleTime: 1000 * 30,
  });
}

/** 선택된 namespace 의 pod 리스트. */
export function useAnalyzePods(
  clusterId: string,
  namespace: string,
  onlyWithIssues = false,
) {
  return useQuery({
    queryKey: ['analyzer', 'pods', clusterId, namespace, onlyWithIssues],
    queryFn: () =>
      analyzeApi.listPods(clusterId, namespace, onlyWithIssues).then((r) => r.data),
    enabled: !!clusterId && !!namespace,
    staleTime: 1000 * 15,
  });
}

/** 선택된 pod 의 logs/events/describe 를 한 번에 가져오는 mutation 형태(트리거 버튼용). */
export function useFetchIncidentContext() {
  return useMutation({
    mutationFn: (vars: {
      clusterId: string;
      namespace: string;
      podName: string;
      tailLines?: number;
    }) =>
      analyzeApi
        .fetchContext(vars.clusterId, vars.namespace, vars.podName, vars.tailLines ?? 200)
        .then((r) => r.data),
  });
}
