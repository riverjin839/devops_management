import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { mindmapApi } from '@/services/api';
import { useToastSafe } from '@/components/common/Toast';
import { formatApiError } from '@/lib/utils';
import type { MindMapCreate, MindMapUpdate, MindMapNodeCreate, MindMapNodeUpdate } from '@/types';

/*
 * 실패 피드백(15차 A-11) — 모든 쓰기는 hook 의 onError 가 토스트로 알린다. 화면은 결과를 기다려
 * (mutateAsync) 성공했을 때만 편집기·다이얼로그를 닫고, 실패하면 입력을 그대로 둔다(토스트는 여기서 한 번만).
 */

const keys = {
  all: ['mindmaps'] as const,
  detail: (id: string) => ['mindmaps', id] as const,
};

export function useMindMaps() {
  return useQuery({
    queryKey: keys.all,
    queryFn: () => mindmapApi.list().then((r) => r.data),
  });
}

/** 동시 편집(정책 ⑦) — 노드 단위 마지막 저장이 이긴다. 탭이 보일 때만 30초마다 다시 읽는다. */
export function useMindMap(id: string | null) {
  return useQuery({
    queryKey: keys.detail(id ?? ''),
    queryFn: () => mindmapApi.get(id!).then((r) => r.data),
    enabled: !!id,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useCreateMindMap() {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: (data: MindMapCreate) => mindmapApi.create(data).then((r) => r.data),
    // invalidate 를 반환해 mutateAsync 가 목록 갱신 뒤에 끝나게 한다 — 화면이 새 맵을 바로 선택한다.
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
    onError: (e) => toast.error('마인드맵 생성 실패', formatApiError(e)),
  });
}

export function useUpdateMindMap() {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: MindMapUpdate }) =>
      mindmapApi.update(id, data).then((r) => r.data),
    onSuccess: (_, { id }) => Promise.all([
      qc.invalidateQueries({ queryKey: keys.all }),
      qc.invalidateQueries({ queryKey: keys.detail(id) }),
    ]),
    onError: (e) => toast.error('마인드맵 수정 실패', formatApiError(e)),
  });
}

export function useDeleteMindMap() {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: (id: string) => mindmapApi.delete(id),
    // 상세 캐시는 지우지 않는다 — 관찰 중인 쿼리를 지우면 삭제된 맵을 다시 불러 404 가 잠깐 보인다.
    // 목록 갱신 뒤 화면의 선택 보정 effect 가 다른 맵으로 옮긴다.
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.all }),
    onError: (e) => toast.error('마인드맵 삭제 실패', formatApiError(e)),
  });
}

export function useCreateNode(mapId: string) {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: (data: MindMapNodeCreate) => mindmapApi.createNode(mapId, data).then((r) => r.data),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: keys.detail(mapId) }),
      qc.invalidateQueries({ queryKey: keys.all }),
    ]),
    onError: (e) => toast.error('노드 추가 실패', formatApiError(e)),
  });
}

export function useUpdateNode(mapId: string) {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: ({ nodeId, data }: { nodeId: string; data: MindMapNodeUpdate }) =>
      mindmapApi.updateNode(mapId, nodeId, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.detail(mapId) }),
    onError: (e) => toast.error('노드 수정 실패', formatApiError(e)),
  });
}

export function useDeleteNode(mapId: string) {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: (nodeId: string) => mindmapApi.deleteNode(mapId, nodeId),
    onSuccess: () => Promise.all([
      qc.invalidateQueries({ queryKey: keys.detail(mapId) }),
      qc.invalidateQueries({ queryKey: keys.all }),
    ]),
    onError: (e) => toast.error('노드 삭제 실패', formatApiError(e)),
  });
}

/**
 * 좌표 저장 — 움직인 노드만 보낸다(서버는 부분 갱신을 받는다). 실패하면 토스트를 띄우고 서버 값을 다시
 * 읽는다(화면 좌표 되돌리기는 호출부가 mutate 의 onError 로 처리).
 */
export function useBulkUpdatePositions(mapId: string) {
  const qc = useQueryClient();
  const toast = useToastSafe();
  return useMutation({
    mutationFn: (updates: { id: string; x: number; y: number }[]) =>
      mindmapApi.bulkUpdatePositions(mapId, updates).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.detail(mapId) }),
    onError: (e) => {
      toast.error('노드 위치 저장 실패', formatApiError(e));
      qc.invalidateQueries({ queryKey: keys.detail(mapId) });
    },
  });
}
