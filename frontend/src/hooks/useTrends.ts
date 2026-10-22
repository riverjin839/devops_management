import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { trendsApi } from '@/services/api';
import type { TrendDigest, TrendSourceCreate, TrendSettingsUpdate } from '@/types';

/** 수집·요약이 진행 중인 다이제스트 상태 — 이 동안만 목록을 5초마다 다시 읽는다(A-9). */
export const TREND_DIGEST_IN_PROGRESS: ReadonlyArray<TrendDigest['status']> = ['collecting', 'summarizing'];
const LIVE_REFETCH_MS = 5000;

export function isDigestInProgress(d?: Pick<TrendDigest, 'status'> | null): boolean {
  return !!d && TREND_DIGEST_IN_PROGRESS.includes(d.status);
}

export function useTrendDigests(limit = 30) {
  return useQuery({
    queryKey: ['trends', 'digests', limit],
    queryFn: () => trendsApi.listDigests(limit).then((r) => r.data),
    staleTime: 1000 * 60 * 5,
    // 수집·요약 중인 다이제스트가 있을 때만 폴링 — 스피너가 멈춘 채로 남지 않게.
    refetchInterval: (query) => (query.state.data?.some(isDigestInProgress) ? LIVE_REFETCH_MS : false),
  });
}

/** `live` 면(해당 다이제스트가 수집·요약 중) 항목도 5초마다 다시 읽어 요약이 채워지는 걸 보여준다. */
export function useTrendItems(date: string, category?: string, itemType?: string, live = false) {
  return useQuery({
    queryKey: ['trends', 'items', date, category, itemType],
    queryFn: () => trendsApi.listItems(date, category, itemType).then((r) => r.data),
    enabled: !!date,
    staleTime: 1000 * 60 * 5,
    refetchInterval: live ? LIVE_REFETCH_MS : false,
  });
}

export function useTrendSources() {
  return useQuery({
    queryKey: ['trends', 'sources'],
    queryFn: () => trendsApi.listSources().then((r) => r.data),
    staleTime: 1000 * 60 * 10,
  });
}

/** 단건 수집(구 서버 폴백 — `/trends/collect/stream` 이 없을 때만 쓴다). */
export function useTriggerCollect() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars?: { targetDate?: string; lookbackDays?: number }) =>
      trendsApi
        .triggerCollect(vars?.targetDate, vars?.lookbackDays)
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trends'] });
    },
  });
}

/** SSE 수집처럼 mutation 밖에서 돈 실행 뒤에 동향 캐시 전체를 다시 읽게 한다. */
export function useInvalidateTrends() {
  const qc = useQueryClient();
  return useCallback(() => qc.invalidateQueries({ queryKey: ['trends'] }), [qc]);
}

export function useToggleSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      trendsApi.toggleSource(id, enabled).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trends', 'sources'] });
    },
  });
}

export function useCreateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: TrendSourceCreate) => trendsApi.createSource(data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trends', 'sources'] });
    },
  });
}

export function useUpdateSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<TrendSourceCreate> }) =>
      trendsApi.updateSource(id, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trends', 'sources'] });
    },
  });
}

/** 기본은 비활성화(과거 다이제스트 보존). `hard` = admin 전용 완전 삭제. */
export function useDeleteSource() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, hard = false }: { id: string; hard?: boolean }) => trendsApi.deleteSource(id, hard),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trends'] });
    },
  });
}

/** GitHub API 주소·허용 호스트·토큰 설정 여부(A-19). `enabled` 는 설정 창이 열릴 때만 읽게 한다. */
export function useTrendSettings(enabled = true) {
  return useQuery({
    queryKey: ['trends', 'settings'],
    queryFn: () => trendsApi.getSettings().then((r) => r.data),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

export function useUpdateTrendSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: TrendSettingsUpdate) => trendsApi.updateSettings(data).then((r) => r.data),
    onSuccess: (data) => {
      qc.setQueryData(['trends', 'settings'], data);
    },
  });
}
