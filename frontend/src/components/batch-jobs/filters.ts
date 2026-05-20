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
  missing_creds: (j) => !!j.cron && !j.hasSavedPassword && !j.hasSavedPrivateKey,
};

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
