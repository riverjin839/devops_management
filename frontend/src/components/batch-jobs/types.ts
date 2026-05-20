// frontend/src/components/batch-jobs/types.ts
// BatchJobsPage 전용 로컬 타입.

/** 상태 필터 칩에서 사용하는 키. 'all' 은 reset(모두 표시). */
export type FilterKey =
  | 'all'
  | 'failed'      // error / timeout / auth_error / connect_error
  | 'running'
  | 'ok'
  | 'missing_creds';

/** 정렬 키. 정렬 방향은 별도 boolean. */
export type SortKey = 'status' | 'name' | 'lastRunAt';

export interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** 상태 칩 메타 정보 — chip 색·라벨·필터 술어. */
export interface FilterChipMeta {
  key: FilterKey;
  label: string;
  className: string; // tailwind: 활성/비활성에 따라 페이지에서 분기
  match: (job: { lastStatus: string; cron?: string | null; hasSavedPassword: boolean; hasSavedPrivateKey: boolean }) => boolean;
}

export const FAILED_STATUSES = new Set(['error', 'timeout', 'auth_error', 'connect_error']);
