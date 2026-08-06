import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { checkMatrixApi } from '@/services/api';
import type { CheckMatrixItemInput, CheckMatrixSourceConfigEntry } from '@/types';

export const checkMatrixKeys = {
  items: ['checkMatrixItems'] as const,
  grid: ['checkMatrixGrid'] as const,
  history: (itemId: string, clusterId: string, days: number) =>
    ['checkMatrixHistory', itemId, clusterId, days] as const,
  settings: ['checkMatrixSettings'] as const,
  runbook: (itemId: string, clusterId: string) =>
    ['checkMatrixRunbook', itemId, clusterId] as const,
  runs: (filter: CheckMatrixRunFilter) => ['checkMatrixRuns', filter] as const,
  run: (runId: string) => ['checkMatrixRun', runId] as const,
};

export interface CheckMatrixRunFilter {
  itemId?: string;
  clusterId?: string;
  batchId?: string;
  trigger?: string;
  /** 콤마 구분 다중값 (예: `queued,running`) — "지금 실행 중"만 가볍게 폴링할 때 사용. */
  runState?: string;
  limit?: number;
  offset?: number;
}

export function useCheckMatrixItems() {
  return useQuery({
    queryKey: checkMatrixKeys.items,
    queryFn: async () => {
      const { data } = await checkMatrixApi.listItems();
      return data;
    },
  });
}

export function useCheckMatrixGrid() {
  return useQuery({
    queryKey: checkMatrixKeys.grid,
    queryFn: async () => {
      const { data } = await checkMatrixApi.getGrid();
      return data;
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
  });
}

/**
 * 홈 KPI 스트립의 "점검 실패" 신호 — critical 상태인 셀 개수만 파생한다.
 * `useCheckMatrixGrid()` 와 같은 쿼리키를 써 캐시를 공유하므로, 홈 탭이 어느 쪽이든
 * (업무/플랫폼) `/check-matrix/grid` 요청은 여전히 최대 60초에 한 번뿐이다.
 */
export function useCheckMatrixFailureCount() {
  return useQuery({
    queryKey: checkMatrixKeys.grid,
    queryFn: async () => {
      const { data } = await checkMatrixApi.getGrid();
      return data;
    },
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
    select: (grid) => {
      let count = 0;
      for (const rowCells of Object.values(grid.cells)) {
        for (const cell of Object.values(rowCells)) {
          if (cell.status === 'critical') count += 1;
        }
      }
      return count;
    },
  });
}

export function useCheckMatrixCellHistory(itemId: string | undefined, clusterId: string | undefined, days = 30) {
  return useQuery({
    queryKey: checkMatrixKeys.history(itemId || '', clusterId || '', days),
    queryFn: async () => {
      const { data } = await checkMatrixApi.getCellHistory(itemId!, clusterId!, days);
      return data;
    },
    enabled: !!itemId && !!clusterId,
  });
}

function invalidateGridAndItems(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: checkMatrixKeys.items });
  qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
}

export function useCreateCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CheckMatrixItemInput) => checkMatrixApi.createItem(body),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function useUpdateCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: CheckMatrixItemInput }) =>
      checkMatrixApi.updateItem(id, body),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function useDeleteCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => checkMatrixApi.removeItem(id),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function useReorderCheckMatrixItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => checkMatrixApi.reorderItems(itemIds),
    onSuccess: () => invalidateGridAndItems(qc),
  });
}

export function usePostManualEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId, clusterId, status, value, message,
    }: { itemId: string; clusterId: string; status: string; value?: number | null; message?: string | null }) =>
      checkMatrixApi.postManualEntry(itemId, clusterId, { status, value, message }),
    onSuccess: (_, { itemId, clusterId }) => {
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
      qc.invalidateQueries({ queryKey: ['checkMatrixHistory', itemId, clusterId] });
    },
  });
}

export function usePutSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      itemId, clusterId, cronExpr, enabled,
    }: { itemId: string; clusterId: string; cronExpr: string | null; enabled: boolean }) =>
      checkMatrixApi.putSchedule(itemId, clusterId, { cronExpr, enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: checkMatrixKeys.grid }),
  });
}

export function usePutClusterCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, checkCronExpr, checkCronEnabled }: {
      clusterId: string; checkCronExpr: string | null; checkCronEnabled?: boolean;
    }) => checkMatrixApi.putClusterCron(clusterId, checkCronExpr, checkCronEnabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: checkMatrixKeys.grid }),
  });
}

export function useCheckMatrixSettings() {
  return useQuery({
    queryKey: checkMatrixKeys.settings,
    queryFn: async () => {
      const { data } = await checkMatrixApi.getSettings();
      return data;
    },
  });
}

export function useUpdateCheckMatrixSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (retentionDays: number) => checkMatrixApi.putSettings(retentionDays),
    onSuccess: () => qc.invalidateQueries({ queryKey: checkMatrixKeys.settings }),
  });
}

// ── 실행 계획(런북) ─────────────────────────────────────────────────────────
/** 셀이 대상 클러스터에서 실제로 도는 명령·단계. 정의/애드온 등록 상태에 따라 바뀌므로
 *  모달을 열 때마다 새로 받되, 열려 있는 동안은 캐시를 재사용한다. */
export function useCheckMatrixRunbook(
  itemId: string | undefined,
  clusterId: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: checkMatrixKeys.runbook(itemId || '', clusterId || ''),
    queryFn: async () => {
      const { data } = await checkMatrixApi.getCellRunbook(itemId!, clusterId!);
      return data;
    },
    enabled: enabled && !!itemId && !!clusterId,
    staleTime: 30 * 1000,
  });
}

/** 소스 설정(deep_check thresholds/params · addon config) 저장 — 런북과 그리드를 새로 그린다. */
export function useUpdateSourceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, clusterId, entries }: {
      itemId: string; clusterId: string; entries: CheckMatrixSourceConfigEntry[];
    }) => checkMatrixApi.putSourceConfig(itemId, clusterId, entries).then((r) => r.data),
    onSuccess: (_, { itemId, clusterId }) => {
      qc.invalidateQueries({ queryKey: checkMatrixKeys.runbook(itemId, clusterId) });
      // 글로벌 정의 수정은 다른 클러스터 셀의 런북에도 영향을 준다.
      qc.invalidateQueries({ queryKey: ['checkMatrixRunbook'] });
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
    },
  });
}

// ── 수동 실행 ──────────────────────────────────────────────────────────────
/** 셀 1건 동기 실행 — 응답에 결과가 담겨 오므로 성공 즉시 그리드를 무효화한다. */
export function useRunCheckMatrixCell() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, clusterId }: { itemId: string; clusterId: string }) =>
      checkMatrixApi.runCell(itemId, clusterId).then((r) => r.data),
    onSuccess: (_, { itemId, clusterId }) => {
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
      qc.invalidateQueries({ queryKey: ['checkMatrixHistory', itemId, clusterId] });
      qc.invalidateQueries({ queryKey: ['checkMatrixRuns'] });
    },
  });
}

/** 클러스터(열) 일괄 실행 — 큐잉만 하므로 결과는 batchId 로 폴링한다. */
export function useRunCheckMatrixCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clusterId: string) => checkMatrixApi.runCluster(clusterId).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkMatrixRuns'] }),
  });
}

/** 공통 점검 항목(행) 일괄 실행 — 등록된 모든 클러스터 대상. */
export function useRunCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => checkMatrixApi.runItem(itemId).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['checkMatrixRuns'] }),
  });
}

// ── 실행 로그 ──────────────────────────────────────────────────────────────
/** 수행 로그 목록. `live` 면 실행 중인 배치를 따라가도록 짧은 주기로 폴링한다. */
export function useCheckMatrixRuns(filter: CheckMatrixRunFilter, enabled = true, live = false) {
  return useQuery({
    queryKey: checkMatrixKeys.runs(filter),
    queryFn: async () => {
      const { data } = await checkMatrixApi.listRuns(filter);
      return data;
    },
    enabled,
    refetchInterval: live ? 3000 : false,
  });
}

export function useCheckMatrixRun(runId: string | undefined) {
  return useQuery({
    queryKey: checkMatrixKeys.run(runId || ''),
    queryFn: async () => {
      const { data } = await checkMatrixApi.getRun(runId!);
      return data;
    },
    enabled: !!runId,
    // 대기열/실행 중이면 끝날 때까지 짧은 주기로 폴링 — 상세 로그가 실시간에 가깝게 갱신되도록.
    refetchInterval: (query) => {
      const state = query.state.data?.runState;
      return state === 'queued' || state === 'running' ? 2000 : false;
    },
  });
}

/** 매트릭스 전역에서 지금 대기열/실행 중인 수행만 — 클러스터 cron 배지의 '실행중' 판정에 쓴다.
 *  `limit=1` 조회로 그리드/셀마다 별도 쿼리를 두지 않고 한 번의 가벼운 폴링으로 공유한다. */
export function useCheckMatrixActiveRuns(enabled = true) {
  return useQuery({
    queryKey: ['checkMatrixActiveRuns'],
    queryFn: async () => {
      const { data } = await checkMatrixApi.listRuns({ runState: 'queued,running', limit: 100 });
      return data;
    },
    enabled,
    refetchInterval: enabled ? 4000 : false,
  });
}
