// frontend/src/components/playbooks/runLogLines.ts
// 플레이북 실행 결과(백그라운드 실행 종료 시점 요약) → 실행 로그 줄(D-135, DESIGN_SYSTEM.md §12.9.1).
// 실행 중 진행 줄(PLAY·TASK·호스트 결과)은 useRunPlaybook 이 서버 로그를 그대로 흘린다(R1).
// 전체 출력·이력은 PlaybookLogDialog 가 보여주므로 여기서는 상태·통계·실패 태스크 요약만 남긴다.
import type { PlaybookRunResult } from '@/types';
import type { RunLogEntry, RunLogLevel } from '@/hooks/useRunLog';

const STATUS_KO: Record<string, string> = {
  healthy: '정상',
  warning: '경고',
  critical: '실패',
  unknown: '알 수 없음',
  running: '실행 중',
  cancelled: '취소됨',
};

export function playbookStatusLevel(status: string): RunLogLevel {
  return status === 'critical' ? 'error' : status === 'healthy' ? 'info' : 'warn';
}

interface TaskIssue { play?: string; task?: string; host?: string; msg?: string }

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function asIssues(v: unknown): TaskIssue[] {
  return Array.isArray(v) ? (v as TaskIssue[]) : [];
}

/** `prefix` 를 주면 Run All 처럼 여러 플레이북을 한 로그에 쌓을 때 줄 앞에 이름을 붙인다. */
export function playbookRunLines(res: PlaybookRunResult, prefix = ''): RunLogEntry[] {
  const p = prefix ? `[${prefix}] ` : '';
  const out: RunLogEntry[] = [];
  const level = playbookStatusLevel(res.status);
  out.push([level, `${p}결과 ${STATUS_KO[res.status] ?? res.status} · 서버 소요 ${res.durationMs}ms`]);
  const stats = res.stats ?? {};
  const totals = (stats.totals ?? null) as Record<string, unknown> | null;
  if (totals) {
    out.push([
      num(totals.failures) > 0 ? 'error' : num(totals.unreachable) > 0 ? 'warn' : 'info',
      `${p}호스트 ${num(totals.host_count ?? totals.hostCount)} · ok ${num(totals.ok)} · changed ${num(totals.changed)} · failed ${num(totals.failures)} · unreachable ${num(totals.unreachable)} · skipped ${num(totals.skipped)}`,
    ]);
  }
  const failed = asIssues(stats.failed_tasks ?? stats.failedTasks);
  const unreachable = asIssues(stats.unreachable_tasks ?? stats.unreachableTasks);
  for (const t of failed.slice(0, 5)) {
    out.push(['error', `${p}실패 태스크 [${t.host ?? '?'}] ${t.task ?? ''}${t.play ? ` (${t.play})` : ''} — ${String(t.msg ?? '').slice(0, 200)}`]);
  }
  for (const t of unreachable.slice(0, 5)) {
    out.push(['warn', `${p}도달 불가 [${t.host ?? '?'}] ${t.task ?? ''} — ${String(t.msg ?? '').slice(0, 200)}`]);
  }
  if (failed.length > 5 || unreachable.length > 5) out.push(['info', `${p}나머지 태스크 이슈는 실행 이력에서 확인`]);
  if (res.message) out.push([level, `${p}${res.message.slice(0, 300)}`]);
  return out;
}
