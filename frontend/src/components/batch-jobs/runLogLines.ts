// frontend/src/components/batch-jobs/runLogLines.ts
// 배치잡 실행/연결 테스트 응답 → 실행 로그 줄(D-135, DESIGN_SYSTEM.md §12.9.1).
// 출력 본문(stdout/stderr·명령 trace)은 BatchJobLogDetail 이 보여주므로 여기서는 단계·상태·사유만 남긴다.
import type { BatchJobRun, BatchJobTestConnectionResponse } from '@/services/api';
import type { RunLogEntry } from '@/hooks/useRunLog';

export const PREFLIGHT_CHECK_LABEL: Record<string, string> = {
  kubeconfig: 'kubeconfig 해석',
  kubectl_binary: 'kubectl 바이너리',
  api_server: 'API 서버 (인증 프로브)',
  rbac_jobs: 'Job 조회 권한 (RBAC)',
};

const STEP_STATUS_LABEL: Record<string, string> = {
  success: '완료',
  failed: '실패',
  skipped: '건너뜀',
  running: '진행 중',
};

const CONN_STATUS_LABEL: Record<string, string> = {
  ok: '연결 성공',
  auth_error: '인증 실패',
  connect_error: '연결 실패',
  timeout: '타임아웃',
  error: '오류',
};

function oneLine(s: string | null | undefined, max = 200): string {
  const first = (s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return first.length > max ? `${first.slice(0, max)}…` : first;
}

/** 배치잡 실행 1회 응답 → 단계별 줄 + 상태·소요 요약 + 실패 사유. */
export function batchJobRunLines(run: BatchJobRun): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  for (const s of run.steps ?? []) {
    const parts = [`단계 ${s.label || s.id}`, STEP_STATUS_LABEL[s.status] ?? s.status];
    if (s.durationMs != null) parts.push(`${s.durationMs}ms`);
    const detail = oneLine(s.detail);
    out.push([s.status === 'failed' ? 'error' : 'info', detail ? `${parts.join(' · ')} — ${detail}` : parts.join(' · ')]);
  }
  const ok = run.status === 'ok';
  const head = [`결과 ${ok ? '완료' : run.status}`];
  if (run.host) head.push(run.host);
  if (run.exitCode != null) head.push(`exit ${run.exitCode}`);
  head.push(`서버 소요 ${run.durationMs}ms`);
  out.push([ok ? 'info' : 'error', head.join(' · ')]);
  if (!ok) {
    const reason = oneLine(run.error) || oneLine(run.stderr);
    if (reason) out.push(['error', `실패 사유 — ${reason}`]);
  }
  return out;
}

/** 연결 테스트 / 사전 점검 응답 → 체크별 줄 + 결과 요약. */
export function testConnectionLines(res: BatchJobTestConnectionResponse): RunLogEntry[] {
  const out: RunLogEntry[] = [];
  for (const c of res.checks ?? []) {
    const label = PREFLIGHT_CHECK_LABEL[c.check] ?? c.check;
    const st = c.ok === true ? '통과' : c.ok === false ? '실패' : '확인 불가';
    out.push([c.ok === false ? 'error' : c.ok == null ? 'warn' : 'info', `${label} · ${st}${c.detail ? ` — ${oneLine(c.detail)}` : ''}`]);
  }
  const ok = res.status === 'ok';
  const target = res.mode === 'k8s' ? `클러스터 ${res.host}` : `${res.username}@${res.host}:${res.port}`;
  out.push([ok ? 'info' : 'error', `${CONN_STATUS_LABEL[res.status] ?? res.status} · ${target} · ${res.latencyMs}ms`]);
  if (!ok && res.error) out.push(['error', `실패 사유 — ${oneLine(res.error)}`]);
  return out;
}
