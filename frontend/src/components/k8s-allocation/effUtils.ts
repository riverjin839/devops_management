// 효율화 탭 공용 상수/헬퍼 — 컴포넌트가 아닌 export 는 react-refresh 규칙상 별도 파일.
import type { RunLogEntry } from '@/hooks/useRunLog';
import type { AllocNamespacesResponse, EffRun } from '@/types';

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

export const TRIGGER_LABEL: Record<EffRun['trigger'], string> = {
  manual: '수동', auto: '자동', rollback: '롤백', schedule: '스케줄',
};

export function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—';
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

// ── 화면 보기 설정(노드 보기 방식·정렬 등) — 새로고침 후에도 사용자가 고른 대로 ─────────
/** 허용 목록 안의 값만 돌려준다 — 예전 값·손상된 값은 기본값으로. */
export function readAllocPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = localStorage.getItem(`pep.k8s-allocation.${key}`);
    return v != null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch { return fallback; }
}
export function writeAllocPref(key: string, v: string) {
  try { localStorage.setItem(`pep.k8s-allocation.${key}`, v); } catch { /* ignore */ }
}

// ── "다시 집계" 실행 로그 줄 ─────────────────────────────────────────────────────
/** 집계 스냅샷 → 실행 로그 줄. `prev` 와 비교해 새로 생긴 변화(단계 전환·진행·완료 요약·실패 NS)만 돌려준다. */
export function allocRunLines(s: AllocNamespacesResponse, prev?: AllocNamespacesResponse): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  const phase = allocPhaseText(s.phase, s.processed);
  if (s.status === 'computing') {
    if (phase && (!prev || prev.phase !== s.phase)) out.push(['info', phase]);
    else if (!prev || prev.processed !== s.processed) out.push(['info', `Pod ${(s.processed ?? 0).toLocaleString()}개 처리${s.total ? ` / ${s.total.toLocaleString()}` : ''}`]);
    return out;
  }
  if (s.status === 'error') { out.push(['error', '집계 실패 — 클러스터 연결(kubeconfig)·apiserver 상태를 확인하세요']); return out; }
  const sm = s.summary;
  if (sm) out.push(['info', `완료 — 노드 ${sm.nodeCount} · 네임스페이스 ${sm.namespaceCount} · Pod ${sm.podCount}`]);
  if (s.podUsageSkipped) out.push(['warn', 'metrics-server 미가용 — 실사용량 없이 request 만 집계']);
  const failed = s.failedNamespaces ?? [];
  if (failed.length) out.push(['warn', `수집 실패·절단된 네임스페이스 ${failed.length}개 — ${failed.slice(0, 10).join(', ')}${failed.length > 10 ? ` 외 ${failed.length - 10}개` : ''}`]);
  else if (s.partial) out.push(['warn', '일부만 집계된 잠정 결과 — 자동으로 다시 시도됩니다']);
  return out;
}

/** epoch 초 → "n초/분/시간 전"(NS 롤링 갱신 데이터 나이 표시용). 값이 없으면 undefined. */
export function allocAgeText(epochSec: number | null | undefined): string | undefined {
  if (!epochSec) return undefined;
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - epochSec));
  if (sec < 60) return `${sec}초 전`;
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  return `${Math.floor(sec / 3600)}시간 전`;
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
