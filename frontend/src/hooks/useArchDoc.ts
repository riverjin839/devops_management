import { useCallback, useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { architectureDocsApi } from '@/services/api';
import type { ArchDoc, ArchViewType } from '@/types';

/** 모듈별 문서 요약 목록 (문서 미생성 모듈 포함). */
export function useArchDocs(clusterId: string | null) {
  return useQuery({
    queryKey: ['arch-docs', clusterId],
    queryFn: async () => (await architectureDocsApi.list(clusterId ?? undefined)).data,
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

/**
 * 노드 배치 영속화 — 드래그 중 잦은 호출을 800ms 디바운스로 모아 bulk PATCH.
 * (MindMap bulkUpdatePositions 패턴)
 */
export function useUpdateArchLayout(serviceId: string | null) {
  const qc = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Map<string, { x: number; y: number }>>(new Map());
  const viewRef = useRef<ArchViewType>('architecture');

  const mutation = useMutation({
    mutationFn: ({ view, positions }: {
      view: ArchViewType;
      positions: { id: string; x: number; y: number }[];
    }) => architectureDocsApi.patchLayout(serviceId!, view, positions).then((r) => r.data),
    onSuccess: (doc: ArchDoc) => {
      qc.setQueryData(['arch-doc', serviceId], doc);
    },
  });

  const flush = useCallback(() => {
    if (!serviceId || pending.current.size === 0) return;
    const positions = Array.from(pending.current.entries()).map(([id, p]) => ({ id, ...p }));
    pending.current = new Map();
    mutation.mutate({ view: viewRef.current, positions });
  }, [serviceId, mutation]);

  const queuePosition = useCallback(
    (view: ArchViewType, id: string, x: number, y: number) => {
      if (view !== viewRef.current) {
        // 뷰가 바뀌면 이전 뷰 분량 먼저 반영
        if (timer.current) clearTimeout(timer.current);
        flush();
        viewRef.current = view;
      }
      pending.current.set(id, { x, y });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, 800);
    },
    [flush],
  );

  // 페이지 이탈 시 미반영분 flush
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return { queuePosition, flush, isSaving: mutation.isPending };
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
