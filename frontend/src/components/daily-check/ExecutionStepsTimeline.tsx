import { useEffect, useMemo, useState } from 'react';
import { Play, Check, X, Loader2, Circle, ChevronDown } from 'lucide-react';
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

const STATUS_LABEL: Record<NodeStatus, string> = {
  success: '성공', failed: '실패', running: '진행 중', skipped: '건너뜀', pending: '대기',
};

/** Deep check 실행 메커니즘 — step_plan 노드를 순차 점등(애니메이션) + 실시간 steps 상태 덧칠.
 *  단계 아이콘을 클릭하면 그 단계의 상세 로그(전체 텍스트·metrics·소요시간)를 펼쳐 본다. */
export function ExecutionStepsTimeline({ stepPlan, steps }: Props) {
  const nodes = useMemo(() => {
    const plan = (stepPlan && stepPlan.length)
      ? stepPlan
      : (steps ?? []).map((s) => ({ id: s.id, label: s.label }));
    const byId = new Map((steps ?? []).map((s) => [s.id, s]));
    return plan.map((p) => {
      const live = byId.get(p.id);
      const status: NodeStatus = (live?.status as NodeStatus) ?? 'pending';
      return {
        id: p.id, label: p.label, status, detail: live?.detail,
        durationMs: live?.durationMs, metrics: live?.metrics,
      };
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

  const [expandedId, setExpandedId] = useState<string | null>(null);
  useEffect(() => setExpandedId(null), [stepPlan, steps]);
  const expanded = nodes.find((n) => n.id === expandedId) ?? null;

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
          const hasLog = !!(n.detail || n.durationMs != null || (n.metrics && Object.keys(n.metrics).length));
          return (
            <div key={n.id} className="flex items-start flex-shrink-0">
              <div className="flex flex-col items-center w-28 px-1">
                <button
                  type="button"
                  onClick={() => setExpandedId((cur) => (cur === n.id ? null : n.id))}
                  title={`${n.label}${n.detail ? `\n${n.detail}` : ''}${n.durationMs != null ? `\n${n.durationMs}ms` : ''}\n(클릭해서 상세 로그 보기)`}
                  aria-label={`${n.label} 단계 상세 로그 ${expandedId === n.id ? '닫기' : '열기'}`}
                  aria-expanded={expandedId === n.id}
                  className={`flex items-center justify-center w-9 h-9 rounded-full border-2 transition-all duration-300 cursor-pointer hover:brightness-95 ${RING[st]} ${shown ? 'scale-100 opacity-100' : 'scale-90 opacity-40'} ${expandedId === n.id ? 'ring-2 ring-offset-1 ring-offset-card ring-primary/50' : ''}`}
                >
                  <StatusIcon s={st} />
                </button>
                <span className={`mt-1.5 text-[11px] text-center leading-tight ${st === 'failed' ? 'text-status-critical font-medium' : 'text-muted-foreground'}`}>{n.label}</span>
                {shown && n.detail && (
                  <span className="mt-0.5 text-[10px] text-center text-muted-foreground/80 line-clamp-2" title={n.detail}>{n.detail}</span>
                )}
                {shown && n.durationMs != null && (
                  <span className="text-[10px] text-muted-foreground/60 tabular-nums">{n.durationMs}ms</span>
                )}
                {shown && hasLog && (
                  <ChevronDown className={`w-3 h-3 mt-0.5 text-muted-foreground/50 transition-transform ${expandedId === n.id ? 'rotate-180' : ''}`} />
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

      {expanded && (
        <div className="mt-2 rounded-lg border border-border bg-secondary/30 p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${RING[expanded.status]}`}>
              <StatusIcon s={expanded.status} /> {STATUS_LABEL[expanded.status]}
            </span>
            <span className="text-xs font-semibold">{expanded.label}</span>
            {expanded.durationMs != null && (
              <span className="text-[11px] text-muted-foreground tabular-nums ml-auto">{expanded.durationMs}ms</span>
            )}
          </div>
          {expanded.detail ? (
            <p className="text-xs whitespace-pre-wrap break-all text-foreground/90">{expanded.detail}</p>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              {expanded.status === 'pending' ? '아직 실행되지 않은 단계입니다.' : '기록된 상세 로그가 없습니다.'}
            </p>
          )}
          {expanded.metrics && Object.keys(expanded.metrics).length > 0 && (
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] pt-1 border-t border-border/60">
              {Object.entries(expanded.metrics).map(([k, v]) => (
                <div key={k} className="flex gap-1.5 min-w-0">
                  <dt className="font-mono text-muted-foreground flex-shrink-0">{k}</dt>
                  <dd className="font-mono truncate text-foreground/90">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      )}

      <div className="mt-2 text-[10px] text-muted-foreground">
        ● 초록=성공 · 빨강=실패 · 노랑=진행 · 회색=대기 — 계측되지 않은 항목은 단계 흐름(설계)만 표시됩니다.
        아이콘을 클릭하면 그 단계의 상세 로그를 볼 수 있습니다.
      </div>
    </div>
  );
}
