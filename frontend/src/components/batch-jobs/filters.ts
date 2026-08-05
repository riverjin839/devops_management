// frontend/src/components/batch-jobs/filters.ts
// 필터 술어 + applyFilter 헬퍼.
// react-refresh/only-export-components 룰을 충족하기 위해 컴포넌트 파일과 분리.

import type { BatchJob } from '@/services/api';
import { FAILED_STATUSES, type FilterKey } from './types';

export const FILTER_PREDICATES: Record<FilterKey, (j: BatchJob) => boolean> = {
  all: () => true,
  failed: (j) => FAILED_STATUSES.has(j.lastStatus),
  running: (j) => j.lastStatus === 'running',
  ok: (j) => j.lastStatus === 'ok',
  // non-SSH(클러스터 스코프) 잡은 자격증명이 필요 없으므로 제외.
  missing_creds: (j) =>
    j.requiresSsh !== false && !!j.cron && !j.hasSavedPassword && !j.hasSavedPrivateKey,
};

/** cron 잡 건강 상태 — 테이블 행/클러스터 그룹 테두리 색상의 판정 기준.
 *  stopped(회색): 비활성 또는 cron 미설정(수동 전용)
 *  failed(레드): 스케줄이 걸려 있는데 최근 실패/평가 오류/자격증명 없음
 *  running(블루): 지금 실행 중
 *  ok(초록): 스케줄 정상 동작 중
 */
export type CronHealth = 'ok' | 'failed' | 'running' | 'stopped';

export function cronHealth(j: BatchJob): CronHealth {
  if (!j.enabled || !j.cron) return 'stopped';
  if (j.lastStatus === 'running') return 'running';
  if (FAILED_STATUSES.has(j.lastStatus)) return 'failed';
  if (/오류/.test(j.lastScheduleNote ?? '')) return 'failed';
  if (j.requiresSsh !== false && !j.hasSavedPassword && !j.hasSavedPrivateKey) return 'failed';
  return 'ok';
}

/** 클러스터 그룹(여러 잡) 집계 — 하나라도 실패면 레드, 실행 중이 있으면 블루,
 *  cron 잡이 하나라도 정상이면 초록, cron 잡이 없거나 전부 중지면 회색. */
export function aggregateCronHealth(jobs: BatchJob[]): CronHealth {
  const states = jobs.map(cronHealth);
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  if (states.includes('ok')) return 'ok';
  return 'stopped';
}

/** 페이지에서 jobs 를 필터링할 때 사용하는 헬퍼. */
export function applyFilter(jobs: BatchJob[], active: FilterKey, search: string): BatchJob[] {
  const pred = FILTER_PREDICATES[active] ?? FILTER_PREDICATES.all;
  const q = search.trim().toLowerCase();
  return jobs.filter((j) => {
    if (!pred(j)) return false;
    if (!q) return true;
    return (
      j.name.toLowerCase().includes(q) ||
      j.jobType.toLowerCase().includes(q) ||
      (j.cron ?? '').toLowerCase().includes(q) ||
      (j.defaultHost ?? '').toLowerCase().includes(q)
    );
  });
}
