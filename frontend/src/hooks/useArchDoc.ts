import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { architectureDocsApi } from '@/services/api';
import type { ArchDoc, ArchViewType } from '@/types';

/**
 * 모듈별 문서 요약 목록 (문서 미생성 모듈 포함).
 * 클러스터를 고르기 전에는 부르지 않는다 — `cluster_id` 없는 목록은 admin 전용(그 외 422).
 */
export function useArchDocs(clusterId: string | null) {
  return useQuery({
    queryKey: ['arch-docs', clusterId],
    queryFn: async () => (await architectureDocsApi.list(clusterId ?? undefined)).data,
    enabled: !!clusterId,
    staleTime: 1000 * 15,
  });
}

/** 단일 문서 전체 (auto 그래프 + 수동 레이어 + LLM 콘텐츠). */
export function useArchDoc(serviceId: string | null) {
  return useQuery({
    queryKey: ['arch-doc', serviceId],
    queryFn: async () => (await architectureDocsApi.get(serviceId!)).data,
    enabled: !!serviceId,
    staleTime: 1000 * 15,
  });
}

function useInvalidateDoc(serviceId: string | null) {
  const qc = useQueryClient();
  return useCallback(() => {
    qc.invalidateQueries({ queryKey: ['arch-doc', serviceId] });
    qc.invalidateQueries({ queryKey: ['arch-docs'] });
  }, [qc, serviceId]);
}

export function useSyncArchDoc(serviceId: string | null) {
  const qc = useQueryClient();
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: (opts?: { prune?: boolean }) =>
      architectureDocsApi.sync(serviceId!, opts).then((r) => r.data),
    onSuccess: (doc) => {
      qc.setQueryData(['arch-doc', serviceId], doc);
      invalidate();
    },
  });
}

export function useRegenerateLlm(serviceId: string | null) {
  const qc = useQueryClient();
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: () => architectureDocsApi.llmRegenerate(serviceId!).then((r) => r.data),
    onSuccess: (doc) => {
      qc.setQueryData(['arch-doc', serviceId], doc);
      invalidate();
    },
  });
}

export function usePatchArchDoc(serviceId: string | null) {
  const qc = useQueryClient();
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: (data: {
      summaryOverride?: string | null;
      annotations?: { id: string; text: string | null }[];
      autoSyncEnabled?: boolean;
    }) => architectureDocsApi.patch(serviceId!, data).then((r) => r.data),
    onSuccess: (doc: ArchDoc) => {
      qc.setQueryData(['arch-doc', serviceId], doc);
      invalidate();
    },
  });
}

/** serviceId → view → nodeId → 좌표. 대기분을 모듈별로 따로 들고 있어야 모듈 전환 때 섞이지 않는다. */
type PendingLayout = Map<string, Map<ArchViewType, Map<string, { x: number; y: number }>>>;

/**
 * 노드 배치 영속화 — 드래그 중 잦은 호출을 800ms 디바운스로 모아 bulk PATCH.
 *
 * - 대기분은 **큐에 넣은 시점의 serviceId 별로** 보관한다. 모듈을 바꾼 직후 타이머가 터져도
 *   이전 모듈 좌표는 이전 모듈 문서로 간다(예전엔 새 모듈 layout 에 섞였다).
 * - `serviceId` 가 바뀌거나 화면을 떠나면(언마운트·pagehide) 대기분을 즉시 보낸다.
 * - 저장이 실패하면 `onError` 로 알리고 서버 값으로 되돌린다 — 문서를 다시 읽고 `revision` 을 올려
 *   캔버스의 로컬 드래그 좌표를 버리게 한다(`resetKey` 에 넣어 쓴다).
 */
export function useUpdateArchLayout(
  serviceId: string | null,
  opts: { onError?: (e: unknown) => void } = {},
) {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<PendingLayout>(new Map());
  const [inFlight, setInFlight] = useState(0);
  const [revision, setRevision] = useState(0);
  const onErrorRef = useRef(opts.onError);
  useEffect(() => { onErrorRef.current = opts.onError; });

  /** 한 모듈의 대기분을 지금 보낸다(동기 호출 — 요청은 언마운트 뒤에도 끝까지 간다). */
  const send = useCallback((sid: string) => {
    const byView = pending.current.get(sid);
    if (!byView) return;
    pending.current.delete(sid);
    for (const [view, posMap] of byView) {
      if (posMap.size === 0) continue;
      const positions = Array.from(posMap, ([id, p]) => ({ id, ...p }));
      setInFlight((n) => n + 1);
      architectureDocsApi.patchLayout(sid, view, positions)
        .then((r) => { qc.setQueryData(['arch-doc', sid], r.data); })
        .catch((e: unknown) => {
          onErrorRef.current?.(e);
          qc.invalidateQueries({ queryKey: ['arch-doc', sid] });
          setRevision((v) => v + 1);
        })
        .finally(() => setInFlight((n) => n - 1));
    }
  }, [qc]);

  const flushAll = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    for (const sid of Array.from(pending.current.keys())) send(sid);
  }, [send]);

  const queuePosition = useCallback(
    (view: ArchViewType, id: string, x: number, y: number) => {
      if (!serviceId) return;
      let byView = pending.current.get(serviceId);
      if (!byView) { byView = new Map(); pending.current.set(serviceId, byView); }
      let posMap = byView.get(view);
      if (!posMap) { posMap = new Map(); byView.set(view, posMap); }
      posMap.set(id, { x, y });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flushAll, 800);
    },
    [serviceId, flushAll],
  );

  // 모듈 전환 — 이전 모듈 대기분을 바로 보낸다.
  useEffect(() => {
    const sid = serviceId;
    return () => { if (sid) send(sid); };
  }, [serviceId, send]);

  // 화면 이탈(언마운트) · 탭 닫기 — 남은 대기분 전부.
  useEffect(() => {
    const onHide = () => flushAll();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushAll();
    };
  }, [flushAll]);

  return { queuePosition, flush: flushAll, isSaving: inFlight > 0, revision };
}

export function useCreateManualNode(serviceId: string | null) {
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: (data: {
      label: string; kind: string; description?: string | null;
    }) => architectureDocsApi.createManualNode(serviceId!, data),
    onSuccess: invalidate,
  });
}

export function useUpdateManualNode(serviceId: string | null) {
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: ({ nodePk, data }: {
      nodePk: string;
      data: { label?: string; kind?: string; description?: string | null };
    }) => architectureDocsApi.updateManualNode(serviceId!, nodePk, data),
    onSuccess: invalidate,
  });
}

export function useDeleteManualNode(serviceId: string | null) {
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: (nodePk: string) => architectureDocsApi.deleteManualNode(serviceId!, nodePk),
    onSuccess: invalidate,
  });
}

export function useCreateManualEdge(serviceId: string | null) {
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: (data: {
      sourceId: string; targetId: string; edgeType?: string;
      label?: string | null; description?: string | null;
      view?: ArchViewType | 'both'; sortOrder?: number;
    }) => architectureDocsApi.createManualEdge(serviceId!, data),
    onSuccess: invalidate,
  });
}

export function useDeleteManualEdge(serviceId: string | null) {
  const invalidate = useInvalidateDoc(serviceId);
  return useMutation({
    mutationFn: (edgePk: string) => architectureDocsApi.deleteManualEdge(serviceId!, edgePk),
    onSuccess: invalidate,
  });
}

/** 전역 현행화 cron(모든 클러스터·모듈 공통). 조회는 누구나, 변경은 admin. */
export function useArchDocSchedule(enabled = true) {
  return useQuery({
    queryKey: ['arch-doc-schedule'],
    queryFn: async () => (await architectureDocsApi.getSchedule()).data,
    enabled,
    staleTime: 1000 * 30,
  });
}

export function useSetArchDocSchedule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { enabled: boolean; cron: string }) =>
      architectureDocsApi.setSchedule(data).then((r) => r.data),
    onSuccess: (s) => { qc.setQueryData(['arch-doc-schedule'], s); },
  });
}
