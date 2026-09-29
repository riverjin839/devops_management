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

// ── 클러스터 요약 상세(큰 카드) 펼침 여부 ──────────────────────────────────────
// 기본은 접힘 — 압축 스트립만 두고 "노드별 자원 / 네임스페이스별 자원" 탭이 화면 위쪽에
// 오도록 한다. 펼친 선택은 사용자별로 유지한다.
const SUMMARY_DETAIL_KEY = 'pep.k8s-allocation.summaryDetail';
export function readSummaryDetailPref(): boolean {
  try { return localStorage.getItem(SUMMARY_DETAIL_KEY) === '1'; } catch { return false; }
}
export function writeSummaryDetailPref(v: boolean) {
  try { localStorage.setItem(SUMMARY_DETAIL_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

/** 자원 집계 스냅샷의 현재 단계(`phase`)를 사람이 읽는 문장으로. 대형 클러스터에서 첫 Pod 페이지를
 *  기다리는 동안 "0 처리됨"만 보이면 멈춘 건지 진행 중인지 구분이 안 되기 때문. 모르면 undefined. */
export function allocPhaseText(phase: string | undefined, processed: number | undefined): string | undefined {
  if (!phase) return undefined;
  if (phase === 'nodes') return '노드·네임스페이스 목록 조회 중';
  if (phase === 'pod_metrics') return '실사용량(metrics) 조회 중';
  const ns = /^ns:(\d+)\/(\d+)$/.exec(phase);
  if (ns) return `네임스페이스 ${ns[1]} / ${ns[2]} 수집 완료 (NS 단위 수집)`;
  const m = /^pods:(\d+)$/.exec(phase);
  if (m) return `Pod 목록 ${m[1]}번째 페이지 ${processed ? '처리 중' : '응답 대기 중'}`;
  return undefined;
}
