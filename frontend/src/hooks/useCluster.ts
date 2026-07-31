import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clustersApi, healthApi, historyApi } from '@/services/api';
import { useClusterStore } from '@/stores/clusterStore';
import { Cluster, Addon, ClusterManageUpdate } from '@/types';
import { parseUTC } from '@/lib/utils';

// Query Keys
export const queryKeys = {
  clusters: ['clusters'] as const,
  cluster: (id: string) => ['clusters', id] as const,
  addons: (clusterId: string) => ['addons', clusterId] as const,
  summary: ['summary'] as const,
  logs: (clusterId?: string) => ['logs', clusterId] as const,
  kubeconfig: (id: string) => ['kubeconfig', id] as const,
};

// Clusters
export function useClusters() {
  const { setClusters } = useClusterStore();

  return useQuery({
    queryKey: queryKeys.clusters,
    queryFn: async () => {
      const { data } = await clustersApi.getAll();
      // 사용자 지정 seq 우선, 동률은 createdAt 으로 안정 정렬.
      const clusters = (data?.data ?? []).sort((a, b) => {
        const sa = a.seq ?? 1000;
        const sb = b.seq ?? 1000;
        if (sa !== sb) return sa - sb;
        return parseUTC(a.createdAt).getTime() - parseUTC(b.createdAt).getTime();
      });
      setClusters(clusters);
      return clusters;
    },
    refetchInterval: 30000, // 30초마다 자동 리페치
  });
}

export function useCluster(id: string) {
  return useQuery({
    queryKey: queryKeys.cluster(id),
    queryFn: async () => {
      const { data } = await clustersApi.getById(id);
      return data.data;
    },
    enabled: !!id,
  });
}

// Create Cluster
export function useCreateCluster() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Cluster> & { kubeconfigContent?: string; skipConnectivityCheck?: boolean }) =>
      clustersApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clusters });
    },
  });
}

// Kubeconfig
export function useKubeconfig(clusterId: string) {
  return useQuery({
    queryKey: queryKeys.kubeconfig(clusterId),
    queryFn: async () => {
      const { data } = await clustersApi.getKubeconfig(clusterId);
      return data;
    },
    enabled: !!clusterId,
    retry: false,
  });
}

export function useUpdateKubeconfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) =>
      clustersApi.updateKubeconfig(id, content),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.kubeconfig(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.cluster(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clusters });
    },
  });
}

// Update Cluster
export function useUpdateCluster() {
  const queryClient = useQueryClient();

  return useMutation({
    // 값 해제는 `null` 전송이 필요하므로 `ClusterManageUpdate`(null 허용)도 받는다 (D-041).
    // 에러 고지는 호출부 책임 — SettingsPage 등이 자체 인라인 에러를 쓰므로 훅 공통 토스트는 두지 않는다.
    mutationFn: ({ id, data }: { id: string; data: Partial<Cluster> | ClusterManageUpdate }) =>
      clustersApi.update(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.cluster(id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.clusters });
    },
  });
}

// Reorder Clusters (drag-and-drop) — 받은 순서대로 seq 일괄 갱신
export function useReorderClusters() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (clusterIds: string[]) => clustersApi.reorder(clusterIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clusters });
    },
  });
}

// Delete Cluster
export function useDeleteCluster() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => clustersApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.clusters });
    },
  });
}

// Summary
export function useSummary() {
  const { setSummary } = useClusterStore();

  return useQuery({
    queryKey: queryKeys.summary,
    queryFn: async () => {
      const { data } = await healthApi.getSummary();
      // Backend /health/summary는 data wrapper 없이 직접 반환
      const raw = data?.data ?? data;
      const summary = {
        totalClusters: raw?.totalClusters ?? 0,
        healthy: raw?.healthy ?? 0,
        warning: raw?.warning ?? 0,
        critical: raw?.critical ?? 0,
      };
      setSummary(summary);
      return summary;
    },
    refetchInterval: 30000,
  });
}

// Addons
export function useAddons(clusterId: string) {
  const { setAddons } = useClusterStore();

  return useQuery({
    queryKey: queryKeys.addons(clusterId),
    queryFn: async () => {
      const { data } = await healthApi.getAddons(clusterId);
      const addons = data?.data ?? [];
      setAddons(clusterId, addons);
      return addons;
    },
    enabled: !!clusterId,
    refetchInterval: 30000,
  });
}

// Create Addon
export function useCreateAddon() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Addon>) => healthApi.createAddon(data),
    onSuccess: (_, variables) => {
      const clusterId = variables.clusterId;
      if (clusterId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.addons(clusterId) });
      }
    },
  });
}

export function useUpdateAddon() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<Addon> }) =>
      healthApi.updateAddon(id, data),
    onSuccess: (_, variables) => {
      const clusterId = variables.data.clusterId;
      if (clusterId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.addons(clusterId) });
      }
    },
  });
}

export function useDeleteAddon() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ addonId }: { addonId: string; clusterId: string }) =>
      healthApi.deleteAddon(addonId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.addons(variables.clusterId) });
    },
  });
}

// Health Check
export function useHealthCheck() {
  const queryClient = useQueryClient();
  const { setIsChecking, setLastCheckTime } = useClusterStore();

  return useMutation({
    mutationFn: (clusterId: string) => healthApi.runCheck(clusterId),
    onMutate: () => {
      setIsChecking(true);
    },
    onSuccess: async (_, clusterId) => {
      setLastCheckTime(new Date().toISOString());
      // refetchQueries: invalidate + 즉시 refetch 보장
      await Promise.all([
        queryClient.refetchQueries({ queryKey: queryKeys.addons(clusterId) }),
        queryClient.refetchQueries({ queryKey: queryKeys.cluster(clusterId) }),
        queryClient.refetchQueries({ queryKey: queryKeys.summary }),
        queryClient.refetchQueries({ queryKey: queryKeys.logs() }),
      ]);
    },
    onError: (error) => {
      console.error('Health check failed:', error);
    },
    onSettled: () => {
      setIsChecking(false);
    },
  });
}


export function useAddonHealthCheck() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ clusterId, addonId }: { clusterId: string; addonId: string }) =>
      healthApi.runAddonCheck(clusterId, addonId),
    onSuccess: async (_, { clusterId }) => {
      await Promise.all([
        queryClient.refetchQueries({ queryKey: queryKeys.addons(clusterId) }),
        queryClient.refetchQueries({ queryKey: queryKeys.cluster(clusterId) }),
        queryClient.refetchQueries({ queryKey: queryKeys.summary }),
        queryClient.refetchQueries({ queryKey: queryKeys.logs() }),
      ]);
    },
  });
}

// Recent Check History — cluster × time Heat Map (DESIGN_SYSTEM §5③).
// pageSize 는 백엔드 상한(100, history 라우터 page_size le=100)까지 최대로 잡아 heat map 이
// "여러 클러스터 × 최근 N일" 을 최대한 커버하게 한다. 날짜 구간 필터는 백엔드에 없어
// 컴포넌트 쪽에서 클라이언트 필터링한다.
export function useCheckHistoryHeatmap() {
  return useQuery({
    // queryKeys.logs() 와 동일한 키 — Run Check 뮤테이션이 이 키를 invalidate 하므로
    // 점검 실행 직후 heat map 도 함께 갱신된다.
    queryKey: queryKeys.logs(),
    queryFn: async () => {
      const { data } = await historyApi.getLogs(undefined, 1, 100);
      return data?.data ?? [];
    },
    refetchInterval: 60000,
  });
}
