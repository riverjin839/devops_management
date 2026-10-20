import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { checkMatrixApi } from '@/services/api';
import type {
  CheckMatrixGrid, CheckMatrixItemInput, CheckMatrixItemPreviewInput, CheckMatrixSourceConfigEntry,
} from '@/types';

export const checkMatrixKeys = {
  items: ['checkMatrixItems'] as const,
  catalog: ['checkMatrixCatalog'] as const,
  grid: ['checkMatrixGrid'] as const,
  itemDetail: (itemId: string) => ['checkMatrixItemDetail', itemId] as const,
  history: (itemId: string, clusterId: string, days: number) =>
    ['checkMatrixHistory', itemId, clusterId, days] as const,
  settings: ['checkMatrixSettings'] as const,
  runbook: (itemId: string, clusterId: string) =>
    ['checkMatrixRunbook', itemId, clusterId] as const,
  itemSourceConfig: (itemId: string) => ['checkMatrixItemSourceConfig', itemId] as const,
  runs: (filter: CheckMatrixRunFilter) => ['checkMatrixRuns', filter] as const,
  run: (runId: string) => ['checkMatrixRun', runId] as const,
  activeRuns: ['checkMatrixActiveRuns'] as const,
};

/** 점검 매트릭스 관련 캐시 전부(그리드·항목·항목 상세·설정 폼·런북·이력·수행 로그) — 항목/정의/설정을
 *  바꾸면 어느 화면이 그 값을 들고 있는지 일일이 맞추지 않고 접두사로 한 번에 무효화한다.
 *  (예전엔 items/grid 만 갱신해 /checks/:id 상세·편집 폼·런북이 이전 값을 보여 줬다.) */
function invalidateAllCheckMatrix(qc: ReturnType<typeof useQueryClient>) {
  return qc.invalidateQueries({
    predicate: (q) => typeof q.queryKey[0] === 'string' && (q.queryKey[0] as string).startsWith('checkMatrix'),
  });
}

/** 실행을 큐잉한 직후 — 실행 중 표시(activeRuns)와 수행 로그를 바로 당겨 온다. */
function invalidateRunState(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: checkMatrixKeys.activeRuns });
  qc.invalidateQueries({ queryKey: ['checkMatrixRuns'] });
}

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

/** 등록 마법사 카탈로그 — 실행기술별 점검 종류 목록. 자주 안 바뀌므로 오래 캐시한다. */
export function useCheckMatrixCatalog() {
  return useQuery({
    queryKey: checkMatrixKeys.catalog,
    queryFn: async () => {
      const { data } = await checkMatrixApi.getCatalog();
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
}

/** 등록 마법사의 "테스트" 단계 — 저장 없이 1회 실행. */
export function usePreviewCheckMatrixItem() {
  return useMutation({
    mutationFn: (body: CheckMatrixItemPreviewInput) =>
      checkMatrixApi.previewItem(body).then((r) => r.data),
  });
}

/** 행(카드) 단위 임계값/파라미터 — 기본 등록 카드도 설정을 확인·수정할 수 있게 한다. */
export function useCheckMatrixItemSourceConfig(itemId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: checkMatrixKeys.itemSourceConfig(itemId ?? ''),
    queryFn: async () => {
      const { data } = await checkMatrixApi.getItemSourceConfig(itemId as string);
      return data;
    },
    enabled: !!itemId && enabled,
  });
}

export function useUpdateCheckMatrixItemSourceConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: {
      itemId: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: { thresholds?: Record<string, any>; params?: Record<string, any>; dedicated?: boolean };
    }) => checkMatrixApi.putItemSourceConfig(itemId, body).then((r) => r.data),
    onSuccess: () => invalidateAllCheckMatrix(qc),
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

/** 항목 상세(`/checks/:itemId`) 진입 데이터 — 이 항목의 클러스터별 cron/최근 결과. */
export function useCheckMatrixItemDetail(itemId: string | undefined) {
  return useQuery({
    queryKey: checkMatrixKeys.itemDetail(itemId ?? 'none'),
    queryFn: async () => {
      const { data } = await checkMatrixApi.getItemDetail(itemId!);
      return data;
    },
    enabled: !!itemId,
    staleTime: 30 * 1000,
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
  return invalidateAllCheckMatrix(qc);
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

/**
 * 행 순서 변경 — 낙관적 갱신. 예전엔 서버 응답 전까지 행이 제자리로 튀었고, 성공 콜백이 재조회를
 * 기다리지 않아 연속으로 ↑↓ 를 누르면 이전 순서 기준으로 계산돼 첫 이동이 되돌려졌다.
 */
export function useReorderCheckMatrixItems() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemIds: string[]) => checkMatrixApi.reorderItems(itemIds),
    onMutate: async (itemIds) => {
      await qc.cancelQueries({ queryKey: checkMatrixKeys.grid });
      const prev = qc.getQueryData<CheckMatrixGrid>(checkMatrixKeys.grid);
      if (prev) {
        const byId = new Map(prev.items.map((i) => [i.id, i]));
        const head = itemIds.map((id) => byId.get(id)).filter((i): i is NonNullable<typeof i> => !!i);
        const rest = prev.items.filter((i) => !itemIds.includes(i.id));
        const items = [...head, ...rest].map((i, idx) => ({ ...i, sortOrder: (idx + 1) * 10 }));
        qc.setQueryData<CheckMatrixGrid>(checkMatrixKeys.grid, { ...prev, items });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(checkMatrixKeys.grid, ctx.prev);
    },
    onSettled: () => invalidateGridAndItems(qc),
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
      qc.invalidateQueries({ queryKey: checkMatrixKeys.itemDetail(itemId) });
      qc.invalidateQueries({ queryKey: ['checkMatrixRuns'] });
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
    onSuccess: (_, { itemId }) => {
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
      qc.invalidateQueries({ queryKey: checkMatrixKeys.itemDetail(itemId) });
    },
  });
}

export function usePutClusterCron() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ clusterId, checkCronExpr, checkCronEnabled }: {
      clusterId: string; checkCronExpr: string | null; checkCronEnabled?: boolean;
    }) => checkMatrixApi.putClusterCron(clusterId, checkCronExpr, checkCronEnabled),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
      // core_bundle 은 모든 항목 상세가 같은 클러스터 cron 을 공유하므로 전부 무효화.
      qc.invalidateQueries({ queryKey: ['checkMatrixItemDetail'] });
    },
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
    onSuccess: () => invalidateAllCheckMatrix(qc),
  });
}

// ── 수동 실행 ──────────────────────────────────────────────────────────────
/** 셀 1건 실행 — 큐잉 후 즉시 queued 수행이 돌아온다. 진행은 `useCheckMatrixRun(id)` 가 2초 폴링하고,
 *  끝나면 activeRuns 감시(PlatformStatusMatrix)가 그리드를 갱신한다. */
export function useRunCheckMatrixCell() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, clusterId }: { itemId: string; clusterId: string }) =>
      checkMatrixApi.runCell(itemId, clusterId).then((r) => r.data),
    onSuccess: (_, { itemId }) => {
      invalidateRunState(qc);
      qc.invalidateQueries({ queryKey: checkMatrixKeys.itemDetail(itemId) });
    },
  });
}

/** 클러스터(열) 일괄 실행 — 큐잉만 하므로 결과는 batchId 로 폴링한다. */
export function useRunCheckMatrixCluster() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (clusterId: string) => checkMatrixApi.runCluster(clusterId).then((r) => r.data),
    onSuccess: () => invalidateRunState(qc),
  });
}

/** 공통 점검 항목(행) 일괄 실행 — 실행 권한(operate)이 있는 클러스터 대상. */
export function useRunCheckMatrixItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) => checkMatrixApi.runItem(itemId).then((r) => r.data),
    onSuccess: (_, itemId) => {
      invalidateRunState(qc);
      qc.invalidateQueries({ queryKey: checkMatrixKeys.itemDetail(itemId) });
    },
  });
}

/** 대기/실행 중 수행 취소 — 단건(runId) 또는 일괄(batchId). 끝나면 진행 상태를 즉시 다시 받는다. */
export function useCancelCheckMatrixRuns() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (target: { runId?: string; batchId?: string }) =>
      (target.batchId ? checkMatrixApi.cancelBatch(target.batchId) : checkMatrixApi.cancelRun(target.runId!))
        .then((r) => r.data),
    onSuccess: (_, target) => {
      invalidateRunState(qc);
      if (target.runId) qc.invalidateQueries({ queryKey: checkMatrixKeys.run(target.runId) });
      qc.invalidateQueries({ queryKey: checkMatrixKeys.grid });
    },
  });
}

// ── 실행 로그 ──────────────────────────────────────────────────────────────
/** 수행 로그 목록. `live` 면 실행 중인 배치를 따라가도록 짧은 주기로 폴링한다. */
/** `live`: true = 3초 폴링, 숫자 = 그 주기(ms) 폴링, false = 폴링 없음. */
export function useCheckMatrixRuns(filter: CheckMatrixRunFilter, enabled = true, live: boolean | number = false) {
  return useQuery({
    queryKey: checkMatrixKeys.runs(filter),
    queryFn: async () => {
      const { data } = await checkMatrixApi.listRuns(filter);
      return data;
    },
    enabled,
    refetchInterval: live === true ? 3000 : typeof live === 'number' ? live : false,
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
    queryKey: checkMatrixKeys.activeRuns,
    queryFn: async () => {
      const { data } = await checkMatrixApi.listRuns({ runState: 'queued,running', limit: 200 });
      return data;
    },
    enabled,
    // 실행 중인 것이 있으면 3초, 없으면 20초 — 아무것도 안 돌 때 4초마다 두드리지 않는다.
    // 실행을 트리거한 쪽은 invalidateRunState 로 즉시 당겨 오므로 시작 표시가 늦지 않는다.
    refetchInterval: (query) => {
      if (!enabled) return false;
      return (query.state.data?.total ?? 0) > 0 ? 3000 : 20000;
    },
  });
}
