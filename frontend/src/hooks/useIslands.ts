import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { islandsApi } from '@/services/api';
import { getAuthToken } from '@/stores/authStore';
import { formatApiError } from '@/lib/utils';
import type {
  Island, IslandCreatePayload, IslandListResponse, IslandPanel, IslandUpdatePayload,
} from '@/types';

export const islandKeys = {
  all: ['islands'] as const,
};

/** 내 아일랜드 + 남이 공유한 아일랜드. */
export function useIslands() {
  return useQuery({
    queryKey: islandKeys.all,
    queryFn: async (): Promise<IslandListResponse> => {
      const { data } = await islandsApi.list();
      return data;
    },
    enabled: !!getAuthToken(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useCreateIsland() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: IslandCreatePayload) => islandsApi.create(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: islandKeys.all }),
  });
}

// ── 아일랜드 수정: 낙관적 갱신 + 아일랜드별 직렬화 + 서버 버전 확인(B-12) ─────────────

/** 서버가 `expected_updated_at` 불일치로 409 를 줄 때 보여줄 문구(서버 detail 이 우선). */
export const ISLAND_CONFLICT_MESSAGE = '다른 곳에서 바뀌었습니다. 새로고침하세요';

/** 패널 변경은 함수로 넘기면 "직전 변경까지 서버에 반영된 최신 패널"을 받아 계산한다. */
export type IslandPanelsUpdater = (current: IslandPanel[]) => IslandPanel[];

export interface IslandPatch extends Omit<IslandUpdatePayload, 'panels' | 'expectedUpdatedAt'> {
  id: string;
  panels?: IslandPanel[] | IslandPanelsUpdater;
}

/** 409 충돌 뒤 줄 서 있던 변경 — 옛 기준으로 계산된 것이라 보내지 않고 버린다(토스트도 띄우지 않는다). */
export class IslandUpdateSupersededError extends Error {
  constructor() {
    super('superseded by a conflicting update');
    this.name = 'IslandUpdateSupersededError';
  }
}

function errorStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

export function isIslandConflict(err: unknown): boolean {
  return errorStatus(err) === 409;
}

export function isIslandUpdateSuperseded(err: unknown): boolean {
  return err instanceof IslandUpdateSupersededError;
}

/**
 * 저장 실패 토스트 문구. 409 는 "다른 곳에서 바뀌었습니다" — 훅이 이미 최신본을 다시 불러왔으므로
 * 방금 변경이 저장되지 않았다는 점을 덧붙인다. 그 외는 서버 사유를 그대로 보여준다.
 */
export function describeIslandSaveError(err: unknown, title: string): { title: string; description: string } {
  if (isIslandConflict(err)) {
    return {
      title: formatApiError(err, ISLAND_CONFLICT_MESSAGE),
      description: '최신 내용을 다시 불러왔습니다. 방금 변경은 저장되지 않았습니다.',
    };
  }
  return { title, description: formatApiError(err) };
}

interface PendingOp {
  patch: IslandPatch;
  epoch: number;
}

/**
 * 아일랜드 1개의 저장 상태.
 * - `base`: 서버가 마지막으로 확인해 준 값(응답 원본). 요청 본문과 `expected_updated_at` 은 여기서 계산한다.
 * - `pending`: 아직 응답이 오지 않은 변경. 화면(캐시)에는 `base + pending` 을 그린다(낙관적 갱신).
 * - `tail`: 직렬화 체인 — 앞 요청이 끝나야 다음 요청을 보낸다. 패널 배열을 통째로 PUT 하므로
 *   동시에 보내면 앞 변경이 사라진다(lost update).
 * - `epoch`: 409 가 나면 올린다. 그 전에 줄 선 변경은 옛 기준이라 버린다.
 */
interface IslandSync {
  base: Island;
  pending: PendingOp[];
  tail: Promise<unknown>;
  epoch: number;
}

const syncs = new Map<string, IslandSync>();

function findIsland(list: IslandListResponse | undefined, id: string): Island | null {
  if (!list) return null;
  return list.data.find((i) => i.id === id) ?? list.shared.find((i) => i.id === id) ?? null;
}

function writeIsland(qc: QueryClient, island: Island) {
  qc.setQueryData<IslandListResponse>(islandKeys.all, (prev) =>
    prev
      ? {
        ...prev,
        data: prev.data.map((i) => (i.id === island.id ? island : i)),
        shared: prev.shared.map((i) => (i.id === island.id ? island : i)),
      }
      : prev,
  );
}

function resolvePanels(panels: IslandPatch['panels'], current: IslandPanel[]): IslandPanel[] | undefined {
  if (panels === undefined) return undefined;
  return typeof panels === 'function' ? panels(current) : panels;
}

function applyPatch(island: Island, patch: IslandPatch): Island {
  const next: Island = { ...island };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.icon !== undefined) next.icon = patch.icon;
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.layoutMode !== undefined) next.layoutMode = patch.layoutMode;
  if (patch.isShared !== undefined) next.isShared = patch.isShared;
  const panels = resolvePanels(patch.panels, island.panels);
  if (panels !== undefined) next.panels = panels;
  return next;
}

function toBody(base: Island, patch: IslandPatch): IslandUpdatePayload {
  const body: IslandUpdatePayload = { expectedUpdatedAt: base.updatedAt };
  if (patch.name !== undefined) body.name = patch.name;
  if (patch.icon !== undefined) body.icon = patch.icon;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.layoutMode !== undefined) body.layoutMode = patch.layoutMode;
  if (patch.isShared !== undefined) body.isShared = patch.isShared;
  const panels = resolvePanels(patch.panels, base.panels);
  if (panels !== undefined) body.panels = panels;
  return body;
}

function project(sync: IslandSync): Island {
  return sync.pending
    .filter((op) => op.epoch === sync.epoch)
    .reduce((acc, op) => applyPatch(acc, op.patch), sync.base);
}

/** 변경 1건을 줄 세운다. 캐시는 즉시 바꾸고(낙관적), 실패하면 그 변경만 빼고 다시 그린다(롤백). */
function enqueueIslandUpdate(qc: QueryClient, patch: IslandPatch): Promise<Island> {
  let sync = syncs.get(patch.id);
  if (!sync) {
    const current = findIsland(qc.getQueryData<IslandListResponse>(islandKeys.all), patch.id);
    if (!current) return Promise.reject(new Error('아일랜드를 찾을 수 없습니다. 새로고침하세요.'));
    sync = { base: current, pending: [], tail: Promise.resolve(), epoch: 0 };
    syncs.set(patch.id, sync);
  }
  const s = sync;
  const op: PendingOp = { patch, epoch: s.epoch };
  s.pending.push(op);
  // 진행 중인 목록 재조회가 낙관적 값을 덮지 않게 끊는다.
  void qc.cancelQueries({ queryKey: islandKeys.all, exact: true });
  writeIsland(qc, project(s));

  const run = async (): Promise<Island> => {
    try {
      if (op.epoch !== s.epoch) throw new IslandUpdateSupersededError();
      const { data } = await islandsApi.update(patch.id, toBody(s.base, patch));
      s.base = data;
      return data;
    } catch (err) {
      if (isIslandConflict(err)) {
        // 다른 기기·탭이 먼저 저장했다. 서버 최신본을 새 기준으로 삼고, 줄 서 있던 옛 변경은 버린다.
        s.epoch += 1;
        try {
          await qc.refetchQueries({ queryKey: islandKeys.all, exact: true });
        } catch {
          /* 재조회 실패는 무시 — 다음 변경이 다시 409 를 받으면 또 알린다. */
        }
        const fresh = findIsland(qc.getQueryData<IslandListResponse>(islandKeys.all), patch.id);
        if (fresh) s.base = fresh;
      }
      throw err;
    } finally {
      s.pending = s.pending.filter((p) => p !== op);
      if (s.pending.length === 0 && syncs.get(patch.id) === s) syncs.delete(patch.id);
      writeIsland(qc, project(s));
    }
  };
  const result = s.tail.then(run, run);
  s.tail = result.catch(() => undefined);
  return result;
}

export interface IslandUpdateCallbacks {
  onSuccess?: (island: Island) => void;
  /** 실패(409 포함) 시 호출. 이미 캐시는 롤백돼 있다. 409 뒤 버려진 변경에는 호출하지 않는다. */
  onError?: (err: unknown) => void;
}

/**
 * 아일랜드 수정. `mutate` 는 호출 순서대로 직렬 전송되고, 화면은 즉시(낙관적으로) 바뀐다.
 * 실패하면 그 변경만 빠진 상태로 되돌아간다. 서버는 `expected_updated_at` 으로 다른 곳의
 * 저장을 감지해 409 를 돌려주며, 그때 목록을 다시 불러온다.
 *
 * 호출마다 콜백이 보장되도록 TanStack `useMutation` 대신 자체 큐를 쓴다
 * (`mutate(vars, { onError })` 는 연속 호출 시 마지막 호출의 콜백만 실행된다).
 */
export function useUpdateIsland() {
  const qc = useQueryClient();
  const mutateAsync = useCallback((patch: IslandPatch) => enqueueIslandUpdate(qc, patch), [qc]);
  const mutate = useCallback((patch: IslandPatch, callbacks?: IslandUpdateCallbacks) => {
    enqueueIslandUpdate(qc, patch).then(
      (island) => callbacks?.onSuccess?.(island),
      (err: unknown) => {
        if (isIslandUpdateSuperseded(err)) return;
        callbacks?.onError?.(err);
      },
    );
  }, [qc]);
  return { mutate, mutateAsync };
}

export function useDeleteIsland() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => islandsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: islandKeys.all }),
  });
}

export function useCloneIsland() {
  const qc = useQueryClient();
  return useMutation<{ data: Island }, unknown, string>({
    mutationFn: (id: string) => islandsApi.clone(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: islandKeys.all }),
  });
}

export function useReorderIslands() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (order: string[]) => islandsApi.reorder(order),
    onSuccess: (res) => qc.setQueryData(islandKeys.all, res.data),
  });
}
