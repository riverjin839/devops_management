import { useId } from 'react';
import { Check, X, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import type { NodeVerifyResult, NodeHealthEntry } from '@/types';
import { ExecutionStepsTimeline } from '@/components/daily-check';
import { useModalA11y } from '@/components/common/useModalA11y';
import { RunLogPanel } from '@/components/common/RunLogPanel';
import type { RunLog } from '@/hooks/useRunLog';

interface NodeVerifyModalProps {
  result: NodeVerifyResult | null;
  loading: boolean;
  onClose: () => void;
  /** 이 모달에서 막 실행한 검증의 실시간 로그 — 모달이 화면의 실행 로그 패널을 가리므로 안에서 보여준다(D-089). */
  run?: RunLog;
  showLog?: boolean;
  onShowLogChange?: (v: boolean) => void;
}

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  healthy: { bg: 'bg-status-healthy/10 border-status-healthy/30', text: 'text-status-healthy', label: '정상' },
  warning: { bg: 'bg-status-warning/10 border-status-warning/30', text: 'text-status-warning', label: '경고' },
  critical: { bg: 'bg-status-critical/10 border-status-critical/30', text: 'text-status-critical', label: '심각' },
  pending: { bg: 'bg-status-unknown/10 border-status-unknown/30', text: 'text-status-unknown', label: '대기' },
  error: { bg: 'bg-status-critical/10 border-status-critical/30', text: 'text-status-critical', label: '오류' },
};

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {ok ? (
        <Check className="w-4 h-4 text-status-healthy mt-0.5 shrink-0" />
      ) : (
        <X className="w-4 h-4 text-status-critical mt-0.5 shrink-0" />
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
        <div className="py-1.5 text-xs text-status-critical">누락: {net.missing.join(', ')}</div>
      )}
    </div>
  );
}

export function NodeVerifyModal({ result, loading, onClose, run, showLog = true, onShowLogChange }: NodeVerifyModalProps) {
  const dialogRef = useModalA11y(true, onClose);
  const titleId = useId();
  const style = result ? (STATUS_STYLE[result.status] ?? STATUS_STYLE.pending) : STATUS_STYLE.pending;
  const entry = result?.details?.nodes?.[0];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card border border-border rounded-xl w-full max-w-lg max-h-[85vh] overflow-auto shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <h3 id={titleId} className="font-semibold text-foreground">노드 추가 검증</h3>
            {result && <span className="text-sm text-muted-foreground">— {result.hostname}</span>}
          </div>
          <button type="button" onClick={onClose} title="닫기" aria-label="닫기" className="p-1.5 rounded-xl hover:bg-muted text-muted-foreground">
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
              <div className={`flex items-center gap-2 rounded-md border px-3 py-2 ${style.bg}`}>
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
          {run && onShowLogChange && (
            <RunLogPanel run={run} show={showLog} onShowChange={onShowLogChange} maxHeight="max-h-56" />
          )}
        </div>
      </div>
    </div>
  );
}
