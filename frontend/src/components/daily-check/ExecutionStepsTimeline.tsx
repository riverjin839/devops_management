import { useEffect, useMemo, useState } from 'react';
import { Play, Check, X, Loader2, Circle } from 'lucide-react';
import type { DeepCheckExecStep, DeepCheckStepPlanItem } from '@/types';

interface Props {
  stepPlan?: DeepCheckStepPlanItem[];
  steps?: DeepCheckExecStep[];
}

type NodeStatus = 'success' | 'failed' | 'running' | 'skipped' | 'pending';

const RING: Record<NodeStatus, string> = {
  success: 'border-status-healthy text-status-healthy bg-status-healthy-soft',
  failed: 'border-status-critical text-status-critical bg-status-critical-soft',
  running: 'border-status-warning text-status-warning bg-status-warning-soft animate-pulse',
  skipped: 'border-status-unknown text-muted-foreground bg-secondary/40',
  pending: 'border-border text-muted-foreground bg-card',
};
const LINE: Record<NodeStatus, string> = {
  success: 'bg-status-healthy', failed: 'bg-status-critical', running: 'bg-status-warning',
  skipped: 'bg-status-unknown', pending: 'bg-border',
};

function StatusIcon({ s }: { s: NodeStatus }) {
  if (s === 'success') return <Check className="w-4 h-4" />;
  if (s === 'failed') return <X className="w-4 h-4" />;
  if (s === 'running') return <Loader2 className="w-4 h-4 animate-spin" />;
  return <Circle className="w-3 h-3" />;
}

/** Deep check 실행 메커니즘 — step_plan 노드를 순차 점등(애니메이션) + 실시간 steps 상태 덧칠. */
export function ExecutionStepsTimeline({ stepPlan, steps }: Props) {
  const nodes = useMemo(() => {
    const plan = (stepPlan && stepPlan.length)
      ? stepPlan
      : (steps ?? []).map((s) => ({ id: s.id, label: s.label }));
    const byId = new Map((steps ?? []).map((s) => [s.id, s]));
    return plan.map((p) => {
      const live = byId.get(p.id);
      const status: NodeStatus = (live?.status as NodeStatus) ?? 'pending';
      return { id: p.id, label: p.label, status, detail: live?.detail, durationMs: live?.durationMs };
    });
  }, [stepPlan, steps]);

  // 순차 점등 애니메이션
  const [visible, setVisible] = useState(0);
  const replay = () => setVisible(0);
  useEffect(() => {
    setVisible(0);
  }, [stepPlan, steps]);
  useEffect(() => {
    if (visible >= nodes.length) return;
    const t = window.setTimeout(() => setVisible((v) => v + 1), 280);
    return () => window.clearTimeout(t);
  }, [visible, nodes.length]);

  if (nodes.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">실행 단계 (메커니즘)</span>
        <button onClick={replay} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary">
          <Play className="w-3 h-3" /> 재생
        </button>
      </div>
      <div className="flex items-start overflow-x-auto pb-1">
        {nodes.map((n, i) => {
          const shown = i < visible;
          const st: NodeStatus = shown ? n.status : 'pending';
          return (
            <div key={n.id} className="flex items-start flex-shrink-0">
              <div className="flex flex-col items-center w-28 px-1">
                <div
                  title={`${n.label}${n.detail ? `\n${n.detail}` : ''}${n.durationMs != null ? `\n${n.durationMs}ms` : ''}`}
                  className={`flex items-center justify-center w-9 h-9 rounded-full border-2 transition-all duration-300 ${RING[st]} ${shown ? 'scale-100 opacity-100' : 'scale-90 opacity-40'}`}
                >
                  <StatusIcon s={st} />
                </div>
                <span className={`mt-1.5 text-[11px] text-center leading-tight ${st === 'failed' ? 'text-status-critical font-medium' : 'text-muted-foreground'}`}>{n.label}</span>
                {shown && n.detail && (
                  <span className="mt-0.5 text-[10px] text-center text-muted-foreground/80 line-clamp-2" title={n.detail}>{n.detail}</span>
                )}
                {shown && n.durationMs != null && (
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums">{n.durationMs}ms</span>
                )}
              </div>
              {i < nodes.length - 1 && (
                <div className={`h-9 flex items-center`}>
                  <div className={`h-0.5 w-6 rounded transition-colors duration-300 ${i < visible - 1 ? LINE[nodes[i].status] : 'bg-border'}`} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] text-muted-foreground">
        ● 초록=성공 · 빨강=실패 · 노랑=진행 · 회색=대기 — 계측되지 않은 항목은 단계 흐름(설계)만 표시됩니다.
      </div>
    </div>
  );
}
