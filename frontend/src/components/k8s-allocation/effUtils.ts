// 효율화 탭 공용 상수/헬퍼 — 컴포넌트가 아닌 export 는 react-refresh 규칙상 별도 파일.
import type { EffRun } from '@/types';

export type EffRange = '24h' | '7d' | '30d';
export const RANGE_OPTIONS: EffRange[] = ['24h', '7d', '30d'];

const LOG_PREF_KEY = 'pep.k8s-efficiency.showLog';
export function readLogPref(): boolean {
  try { return localStorage.getItem(LOG_PREF_KEY) !== '0'; } catch { return true; }
}
export function writeLogPref(v: boolean) {
  try { localStorage.setItem(LOG_PREF_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

export const RUN_TYPE_LABEL: Record<EffRun['runType'], string> = {
  collect: '수집', recommend: '추천 생성', rightsize_apply: 'request 적용', quota_adjust: 'Quota 조정', custom_scale: 'CR 스케일',
};

export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z');
  if (isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
