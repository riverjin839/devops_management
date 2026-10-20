// 일일 리포트 포맷 헬퍼 — 값이 없을 때(사용량 미수집) 0 으로 위장하지 않고 "—" 로 표시한다.
import { fmtCores, fmtGi } from '@/components/k8s-allocation/format';
import type { DailyReportRankBy } from '@/types';

export const DASH = '—';
export const cores = (m: number | null | undefined) => (m == null ? DASH : fmtCores(m));
export const gi = (b: number | null | undefined) => (b == null ? DASH : fmtGi(b));
export const pct = (r: number | null | undefined) => (r == null ? DASH : `${Math.round(r * 100)}%`);

/** 사용률 30% 미만은 비효율 — 이 화면에서 강조할 "비정상" 상태다. */
export const LOW_RATE = 0.3;
export const rateCls = (r: number | null | undefined) =>
  r != null && r < LOW_RATE ? 'text-status-warning font-semibold' : 'text-foreground';

export const RANK_OPTIONS: { value: DailyReportRankBy; label: string; help: string }[] = [
  { value: 'cpu_rate', label: 'CPU 사용률', help: 'CPU 평균 사용량 ÷ request 가 낮은 순' },
  { value: 'mem_rate', label: '메모리 사용률', help: '메모리 평균 사용량 ÷ request 가 낮은 순' },
  { value: 'cpu_slack', label: 'CPU 유휴량', help: 'CPU request − 평균 사용량이 큰 순' },
  { value: 'mem_slack', label: '메모리 유휴량', help: '메모리 request − 평균 사용량이 큰 순' },
];

/** ISO 날짜(YYYY-MM-DD) ± n 일 — 시간대 영향 없이 UTC 로 계산. */
export function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
export function dateLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${iso} (${WEEKDAYS[d.getUTCDay()]})`;
}
