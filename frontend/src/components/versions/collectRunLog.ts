// 수집 모달 공용 — 동기 1응답 수집(`{changed, hosts[], errors[]}`)을 실행 로그 줄로 요약한다(D-128).
// 다섯 수집 모달이 같은 모양의 호스트별 한 줄 + 요약 줄을 남기도록 여기에 모았다.
import type { RunLogEntry } from '@/hooks/useRunLog';

export interface CollectHostLike {
  host: string;
  status?: string;
  stored?: boolean;
  error?: string | null;
  rawStderr?: string | null;
  exitCode?: number | null;
}

export interface CollectResponseLike<H extends CollectHostLike> {
  changed: number;
  hosts: H[];
  errors: string[];
}

/** 실행 시작 줄 — "<클러스터> — 노드 N대 수집 요청 (sudo)" */
export function collectFirstLine(clusterName: string | undefined, hostCount: number, what: string, useSudo: boolean): string {
  const who = clusterName ? `${clusterName} — ` : '';
  return `${who}${what} · 노드 ${hostCount}대 수집 요청${useSudo ? ' (sudo)' : ''}`;
}

function firstLine(s?: string | null): string {
  return (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

/**
 * 호스트별 한 줄(호스트 · 상태 · exit · 저장 여부 · 오류/stderr 첫 줄) + 전체 오류 줄 + 요약 줄.
 * `detail(h)` 로 모달별 부가 정보(파라미터 수·NIC 수 등)를 덧붙인다.
 */
export function summarizeCollect<H extends CollectHostLike>(
  res: CollectResponseLike<H>,
  detail?: (h: H) => string | null | undefined,
): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  let failed = 0;
  const loggedHosts: string[] = [];
  for (const h of res.hosts) {
    const bad = !!h.error || (h.status !== undefined && h.status !== 'ok');
    const nonZero = h.exitCode !== null && h.exitCode !== undefined && h.exitCode !== 0;
    if (bad) { failed += 1; loggedHosts.push(h.host); }
    const parts: string[] = [h.host];
    if (h.status) parts.push(h.status);
    parts.push(`exit ${h.exitCode ?? '—'}`);
    if (h.stored !== undefined) parts.push(h.stored ? '저장됨' : '변경 없음');
    const extra = detail?.(h);
    if (extra) parts.push(extra);
    const reason = h.error || (bad || nonZero ? firstLine(h.rawStderr) : '');
    if (reason) parts.push(`오류 — ${reason}`);
    out.push([bad ? 'error' : nonZero ? 'warn' : 'info', parts.join(' · ')]);
  }
  // 백엔드 errors 는 대개 "<host>: <사유>" — 위 호스트 줄에 이미 나온 것은 건너뛰고 나머지만 남긴다.
  for (const e of res.errors) {
    if (!loggedHosts.some((host) => e.startsWith(`${host}:`))) out.push(['warn', e]);
  }
  out.push([
    failed > 0 || res.errors.length > 0 ? 'warn' : 'info',
    `호스트 ${res.hosts.length}대 · 변경 ${res.changed} · 실패 ${failed} · 오류 ${res.errors.length}`,
  ]);
  return out;
}
