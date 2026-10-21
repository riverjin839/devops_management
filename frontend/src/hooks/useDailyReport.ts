// 일일 리포트 — 공개 조회(비인증) + 설정(admin) 서버 상태(TanStack Query).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { dailyReportApi } from '@/services/api';
import type { DailyReportRankBy, DailyReportSettings, NsOwnersSettings } from '@/types';

export function useDailyReportClusters() {
  return useQuery({
    queryKey: ['daily-report-clusters'],
    queryFn: async () => (await dailyReportApi.clusters()).data,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useDailyReport(clusterId: string, date: string, rankBy: DailyReportRankBy, isToday: boolean) {
  return useQuery({
    queryKey: ['daily-report', clusterId, date, rankBy],
    queryFn: async () => (await dailyReportApi.report(clusterId, date, rankBy)).data,
    enabled: !!clusterId && !!date,
    // 지난 날짜는 롤업이라 변하지 않는다 — 오늘(진행 중)만 주기적으로 다시 읽는다.
    staleTime: isToday ? 60_000 : 30 * 60_000,
    refetchInterval: isToday ? 5 * 60_000 : false,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** 본인 업무 모듈 찾기 — NS·워크로드·파드 이름 부분 일치(2자 이상). */
export function useDailyReportSearch(clusterId: string, date: string, q: string, rankBy: DailyReportRankBy) {
  const term = q.trim();
  return useQuery({
    queryKey: ['daily-report-search', clusterId, date, term, rankBy],
    queryFn: async () => (await dailyReportApi.search(clusterId, date, term, rankBy)).data,
    enabled: !!clusterId && !!date && term.length >= 2,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** 주간·월간 — 일자별 사용률 추이 + 기간 평균 비효율 랭킹. 지난 날짜 롤업이라 자주 다시 읽지 않는다. */
export function useDailyReportPeriod(clusterId: string, end: string, period: 'week' | 'month' | null, rankBy: DailyReportRankBy) {
  return useQuery({
    queryKey: ['daily-report-period', clusterId, end, period, rankBy],
    queryFn: async () => (await dailyReportApi.period(clusterId, end, period as 'week' | 'month', rankBy)).data,
    enabled: !!clusterId && !!end && !!period,
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useNsOwners(enabled: boolean) {
  return useQuery({
    queryKey: ['ns-owners'],
    queryFn: async () => (await dailyReportApi.owners()).data,
    enabled,
  });
}

export function useSaveNsOwners() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<NsOwnersSettings>) => (await dailyReportApi.putOwners(body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['ns-owners'] });
      void qc.invalidateQueries({ queryKey: ['daily-report'] });
      void qc.invalidateQueries({ queryKey: ['daily-report-period'] });
      void qc.invalidateQueries({ queryKey: ['daily-report-search'] });
      void qc.invalidateQueries({ queryKey: ['external-services'] });
    },
  });
}

export function useDailyReportSettings(enabled: boolean) {
  return useQuery({
    queryKey: ['daily-report-settings'],
    queryFn: async () => (await dailyReportApi.settings()).data,
    enabled,
  });
}

export function useSaveDailyReportSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: Partial<DailyReportSettings>) => (await dailyReportApi.putSettings(body)).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['daily-report-settings'] });
      void qc.invalidateQueries({ queryKey: ['daily-report-clusters'] });
      void qc.invalidateQueries({ queryKey: ['daily-report'] });
    },
  });
}
