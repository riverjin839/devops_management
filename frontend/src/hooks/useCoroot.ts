import { useQuery } from '@tanstack/react-query';
import { corootApi } from '@/services/api';

/** 전역 coroot 가용성 (offline 이어도 200 으로 상태만 반환). */
export function useCorootHealth() {
  return useQuery({
    queryKey: ['coroot', 'health'],
    queryFn: async () => (await corootApi.health()).data,
    staleTime: 1000 * 60,
    refetchOnWindowFocus: false,
  });
}

/** 클러스터에 매핑된 coroot project 의 application 요약. */
export function useCorootSummary(clusterId: string | null) {
  return useQuery({
    queryKey: ['coroot', 'summary', clusterId],
    queryFn: async () => (await corootApi.getSummary(clusterId!)).data,
    enabled: !!clusterId,
    staleTime: 1000 * 30,
    refetchOnWindowFocus: false,
  });
}

/** 클러스터별 coroot UI 딥링크 (새 탭으로 열기 / iframe src 용). */
export function useCorootDeepLink(clusterId: string | null) {
  return useQuery({
    queryKey: ['coroot', 'deeplink', clusterId],
    queryFn: async () => (await corootApi.getDeepLink(clusterId!)).data,
    enabled: !!clusterId,
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
  });
}
