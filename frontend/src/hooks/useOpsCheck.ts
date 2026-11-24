import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { opsCheckApi } from '@/services/api';
import type { ClusterCheckSummary, OpsCheckRunRequestItem } from '@/types';

export const opsCheckKeys = {
  catalog: (clusterId: string) => ['opsCheckCatalog', clusterId] as const,
  runs: (clusterId: string) => ['opsCheckRuns', clusterId] as const,
  run: (runId: string) => ['opsCheckRun', runId] as const,
  runItems: (runId: string) => ['opsCheckRunItems', runId] as const,
  summary: ['opsCheckSummary'] as const,
};

/**
 * 볼 수 있는 클러스터별 점검 탭 상태 요약(`GET /ops-checks/summary`) — 클러스터 상태 아이콘의 원천.
 * 사이드바·허브 헤더가 같은 쿼리 하나를 공유한다. 반환은 clusterId → 요약 Map.
 */
export function useClusterCheckSummaries(enabled = true) {
  const q = useQuery({
    queryKey: opsCheckKeys.summary,
    queryFn: async () => (await opsCheckApi.summary()).data,
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const byId = useMemo(() => {
    const m = new Map<string, ClusterCheckSummary>();
    for (const row of q.data ?? []) m.set(row.clusterId, row);
    return m;
  }, [q.data]);
  return { ...q, byId };
}

/** 클러스터별 점검 항목 카탈로그 */
export function useOpsCheckCatalog(clusterId: string | undefined) {
  return useQuery({
    queryKey: opsCheckKeys.catalog(clusterId || ''),
    queryFn: async () => {
      const { data } = await opsCheckApi.catalog(clusterId!);
      return data;
    },
    enabled: !!clusterId,
  });
}

/** 선택 항목 일괄 실행 (백그라운드) → run 반환 */
export function useStartOpsRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, items }: { clusterId: string; items: OpsCheckRunRequestItem[] }) =>
      opsCheckApi.run(clusterId, items).then((r) => r.data),
    onSuccess: (_run, { clusterId }) => {
      qc.invalidateQueries({ queryKey: opsCheckKeys.runs(clusterId) });
    },
  });
}

/** 대기·실행 중인 묶음 취소 — 진행 상태·항목을 바로 다시 받는다. */
export function useCancelOpsRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runId: string) => opsCheckApi.cancelRun(runId).then((r) => r.data),
    onSuccess: (_run, runId) => {
      qc.invalidateQueries({ queryKey: opsCheckKeys.run(runId) });
      qc.invalidateQueries({ queryKey: opsCheckKeys.runItems(runId) });
    },
  });
}

/** 실행 묶음 진행 상태 — 완료 전까지 폴링 */
export function useOpsRun(runId: string | undefined) {
  const q = useQuery({
    queryKey: opsCheckKeys.run(runId || ''),
    queryFn: async () => {
      const { data } = await opsCheckApi.getRun(runId!);
      return data;
    },
    enabled: !!runId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'done' || status === 'cancelled' ? false : 2000;
    },
  });
  // 실행이 끝나면 점검 탭 결과(카탈로그)와 클러스터 상태 아이콘(요약)을 새로 받는다.
  const qc = useQueryClient();
  const status = q.data?.status;
  const clusterId = q.data?.clusterId;
  const prev = useRef(status);
  useEffect(() => {
    const finished = (s?: string) => s === 'done' || s === 'cancelled';
    if (finished(status) && prev.current && !finished(prev.current)) {
      if (clusterId) void qc.invalidateQueries({ queryKey: opsCheckKeys.catalog(clusterId) });
      void qc.invalidateQueries({ queryKey: opsCheckKeys.summary });
    }
    prev.current = status;
  }, [status, clusterId, qc]);
  return q;
}

/** 실행 묶음의 항목별 결과 — 완료 전까지 폴링 */
export function useOpsRunItems(runId: string | undefined, isRunning: boolean) {
  return useQuery({
    queryKey: opsCheckKeys.runItems(runId || ''),
    queryFn: async () => {
      const { data } = await opsCheckApi.getRunItems(runId!);
      return data;
    },
    enabled: !!runId,
    refetchInterval: isRunning ? 2000 : false,
  });
}
