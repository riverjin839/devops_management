// 적용 실행 화면 — 로그 중심 패턴(DESIGN_SYSTEM §12.6.1): 좌 제어(상태·진행·중지) / 우 상단 실시간 실행 로그 / 우 하단 노드별 결과.
// 노드별 결과는 실행 이력 행을 2초마다 다시 읽어 채운다(배치마다 서버가 커밋).
import { X } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { RunLogPanel, StatusBadge } from '@/components/common';
import type { StatusVariant } from '@/components/common';
import type { RunLog } from '@/hooks/useRunLog';
import type { ServiceConfigApplyRun } from '@/types';
import { RUN_STATUS } from './runStatus';

const NODE_STATUS: Record<string, { label: string; variant: StatusVariant }> = {
  ok: { label: '성공', variant: 'healthy' },
  failed: { label: '실패', variant: 'critical' },
  skipped: { label: '건너뜀', variant: 'pending' },
};
const TH = 'text-left px-3 py-2 text-xs font-medium text-muted-foreground border-b border-border';
const TD = 'px-3 py-2 border-b border-border align-top text-sm';

export function NodeResultsTable({ run }: { run: ServiceConfigApplyRun }) {
  const keys = run.changes.map((c) => c.key).slice(0, 2);
  const done = new Map(run.nodeResults.map((r) => [r.node, r]));
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px]">
        <thead>
          <tr><th className={TH}>노드</th><th className={TH}>결과</th><th className={TH}>적용 전 → 후{keys[0] ? ` (${keys[0]})` : ''}</th><th className={TH}>소요</th><th className={TH}>오류</th></tr>
        </thead>
        <tbody>
          {run.targets.map((t) => {
            const r = done.get(t.node);
            const st = r ? NODE_STATUS[r.status] : null;
            return (
              <tr key={t.node}>
                <td className={`${TD} whitespace-nowrap`}>{t.node}{t.host !== t.node && <span className="block text-xs text-muted-foreground font-mono">{t.host}</span>}</td>
                <td className={`${TD} whitespace-nowrap`}>{st ? <StatusBadge variant={st.variant} label={st.label} /> : <StatusBadge variant={run.status === 'running' ? 'loading' : 'neutral'} label={run.status === 'running' ? '대기·진행' : '—'} />}</td>
                <td className={`${TD} font-mono text-xs`}>{r && keys[0] ? `${r.before?.[keys[0]] ?? '—'} → ${r.after?.[keys[0]] ?? '—'}` : '—'}</td>
                <td className={`${TD} text-xs text-muted-foreground`}>{r?.durationMs ? `${(r.durationMs / 1000).toFixed(1)}초` : '—'}</td>
                <td className={`${TD} text-xs text-status-critical break-all`}>{r?.error ?? ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface Props {
  title: string;
  runLog: RunLog;
  showLog: boolean;
  onShowLogChange: (v: boolean) => void;
  run: ServiceConfigApplyRun | undefined;
  streaming: boolean;
  canStop: boolean;
  stopHint?: string;
  stopping: boolean;
  onStop: () => void;
  onClose: () => void;
}

export function ApplyRunPanel({ title, runLog, showLog, onShowLogChange, run, streaming, canStop, stopHint, stopping, onStop, onClose }: Props) {
  const st = run ? RUN_STATUS[run.status] : null;
  const total = run?.targets.length ?? 0;
  const finished = run?.nodeResults.length ?? 0;
  const pct = total ? Math.round((finished / total) * 100) : 0;
  const active = streaming || run?.status === 'running';
  return (
    <div className="flex flex-wrap gap-3 items-stretch">
      <MacCard title="적용 실행" rootClassName="flex-[1_1_260px] max-w-[320px]"
        actions={!active ? (
          <button type="button" onClick={onClose} title="닫기" aria-label="적용 실행 닫기"
            className="inline-flex items-center justify-center w-7 h-7 rounded-xl border border-border bg-card hover:bg-secondary">
            <X className="w-3.5 h-3.5" />
          </button>
        ) : undefined}>
        <div className="space-y-3 text-sm">
          <div><span className="block text-xs text-muted-foreground">대상</span>{title}</div>
          <div>
            <span className="block text-xs text-muted-foreground">진행</span>
            <div className="h-2 mt-1 rounded-xl bg-secondary overflow-hidden" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="적용 진행">
              <div className={`h-2 bg-primary ${pct >= 100 ? 'w-full' : pct >= 75 ? 'w-3/4' : pct >= 50 ? 'w-1/2' : pct >= 25 ? 'w-1/4' : pct > 0 ? 'w-1/12' : 'w-0'}`} />
            </div>
            <span className="block mt-1 text-xs text-muted-foreground">{finished} / {total} 노드 처리</span>
          </div>
          <div><span className="block text-xs text-muted-foreground">상태</span>{st ? <StatusBadge variant={st.variant} label={st.label} /> : <StatusBadge variant="loading" label="시작 중" />}</div>
          {active && (
            <Button size="sm" variant="outline" className="w-full" disabled={!canStop || stopping || !run || run.stopRequested} onClick={onStop}
              title={canStop ? '진행 중인 노드는 마치고 다음 배치부터 멈춘다' : stopHint} aria-label="적용 중지">
              {run?.stopRequested ? '중지 요청됨' : stopping ? '중지 요청 중…' : '중지'}
            </Button>
          )}
        </div>
      </MacCard>
      <div className="flex-[999_1_560px] min-w-0 flex flex-col gap-3">
        <div className="min-h-[260px] flex flex-col">
          <RunLogPanel run={runLog} show={showLog} onShowChange={onShowLogChange} fill idleHint="적용을 시작하면 접속·백업·기록·확인 과정이 여기에 실시간으로 쌓입니다." />
        </div>
        {run && (
          <MacCard title="노드별 결과" titleExtra={<span className="text-xs text-muted-foreground">{finished}/{total}</span>} bodyPadding="p-0">
            <NodeResultsTable run={run} />
          </MacCard>
        )}
      </div>
    </div>
  );
}
