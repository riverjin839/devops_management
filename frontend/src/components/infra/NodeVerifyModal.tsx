import { Check, X, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { NodeVerifyResult, NodeHealthEntry } from '@/types';
import { ExecutionStepsTimeline } from '@/components/daily-check';

interface NodeVerifyModalProps {
  result: NodeVerifyResult | null;
  loading: boolean;
  onClose: () => void;
}

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  healthy: { bg: 'bg-emerald-500/10 border-emerald-500/30', text: 'text-emerald-600', label: '정상' },
  warning: { bg: 'bg-amber-500/10 border-amber-500/30', text: 'text-amber-600', label: '경고' },
  critical: { bg: 'bg-red-500/10 border-red-500/30', text: 'text-red-600', label: '심각' },
  pending: { bg: 'bg-zinc-500/10 border-zinc-500/30', text: 'text-zinc-500', label: '대기' },
  error: { bg: 'bg-red-500/10 border-red-500/30', text: 'text-red-600', label: '오류' },
};

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {ok ? (
        <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
      ) : (
        <X className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
      )}
      <div className="min-w-0">
        <span className="text-sm text-foreground">{label}</span>
        {detail && <span className="text-xs text-muted-foreground ml-2">{detail}</span>}
      </div>
    </div>
  );
}

function NodeChecklist({ entry }: { entry: NodeHealthEntry }) {
  const net = entry.networking;
  return (
    <div className="divide-y divide-border">
      <CheckRow label="Ready" ok={entry.ready} detail={entry.ready ? undefined : 'NotReady'} />
      <CheckRow
        label="Pressure / NetworkUnavailable"
        ok={entry.pressure.length === 0}
        detail={entry.pressure.length ? entry.pressure.join(', ') : undefined}
      />
      <CheckRow
        label="Taint / 스케줄 가능"
        ok={entry.taints.length === 0}
        detail={entry.taints.length ? entry.taints.join(', ') : undefined}
      />
      <CheckRow
        label="Allocatable (CPU/MEM)"
        ok={entry.allocatableOk}
        detail={`cpu ${entry.allocatable?.cpu ?? '-'} / mem ${entry.allocatable?.memory ?? '-'}`}
      />
      <CheckRow
        label="CNI 데몬셋"
        ok={net.cni}
        detail={net.cniFamily ? net.cniFamily : (net.cni ? undefined : '미실행/없음')}
      />
      <CheckRow label="kube-proxy" ok={net.kubeProxy} />
      {net.missing.length > 0 && (
        <div className="py-1.5 text-xs text-red-500">누락: {net.missing.join(', ')}</div>
      )}
    </div>
  );
}

export function NodeVerifyModal({ result, loading, onClose }: NodeVerifyModalProps) {
  const style = result ? (STATUS_STYLE[result.status] ?? STATUS_STYLE.pending) : STATUS_STYLE.pending;
  const entry = result?.details?.nodes?.[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="bg-card border border-border rounded-xl w-full max-w-lg max-h-[85vh] overflow-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h3 className="font-semibold text-foreground">노드 추가 검증</h3>
            {result && <span className="text-sm text-muted-foreground">— {result.hostname}</span>}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {loading || !result ? (
            <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
              <Loader2 className="w-7 h-7 animate-spin text-primary" />
              <span className="text-sm">검증 중…</span>
            </div>
          ) : (
            <>
              <div className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${style.bg}`}>
                {result.ok ? (
                  <Check className={`w-5 h-5 ${style.text}`} />
                ) : (
                  <AlertTriangle className={`w-5 h-5 ${style.text}`} />
                )}
                <span className={`font-medium ${style.text}`}>{style.label}</span>
                <span className="text-sm text-muted-foreground">{result.message}</span>
              </div>

              {entry ? (
                <NodeChecklist entry={entry} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {result.details?.found === false
                    ? '노드를 아직 클러스터에서 찾을 수 없습니다 (조인 진행 중일 수 있음).'
                    : '표시할 노드 상세가 없습니다.'}
                </p>
              )}

              {(result.stepPlan?.length || result.steps?.length) ? (
                <div className="pt-2 border-t border-border">
                  <ExecutionStepsTimeline stepPlan={result.stepPlan} steps={result.steps} />
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
