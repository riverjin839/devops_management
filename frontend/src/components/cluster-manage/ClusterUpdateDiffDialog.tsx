import { useEffect } from 'react';
import { X, ArrowRight, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';

export interface DiffRow {
  field: string;
  current: unknown;
  proposed: unknown;
  changed: boolean;
}

interface Props {
  open: boolean;
  clusterName: string;
  diff: DiffRow[];
  warnings: string[];
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const FIELD_LABELS: Record<string, string> = {
  nodeCount: '노드 수',
  hostname: 'Master 호스트명',
  maxPod: '노드당 Max Pod',
  cidr: 'INTERNAL_IP (집계 CIDR)',
  firstHost: 'Node 첫 호스트',
  lastHost: 'Node 마지막 호스트',
  svcCidr: 'Service CIDR',
  svcFirstHost: 'Service 첫 호스트',
  svcLastHost: 'Service 마지막 호스트',
  podCidr: 'Pod CIDR',
  podFirstHost: 'Pod 첫 호스트',
  podLastHost: 'Pod 마지막 호스트',
  ciliumConfig: 'Cilium Config',
  bgpEnabled: 'BGP 활성화',
  asNumber: 'AS Number',
  k8sVersion: 'Kubernetes 버전',
  ciliumVersion: 'Cilium 버전',
  nodeIps: '노드 IP 목록',
  bond0Ip:  'bond0 IP (master)',
  bond0Mac: 'bond0 MAC (master)',
  bond1Ip:  'bond1 IP (master)',
  bond1Mac: 'bond1 MAC (master)',
};

function renderValue(v: unknown, field?: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (field === 'nodeIps' && typeof v === 'string') {
    try {
      const arr = JSON.parse(v) as { name: string; ip?: string; ips?: string[] }[];
      if (Array.isArray(arr)) {
        const multi = arr.filter((n) => (n.ips?.length ?? 0) > 1).length;
        const preview = arr.slice(0, 3).map((n) => {
          const ips = n.ips && n.ips.length > 0 ? n.ips : (n.ip ? [n.ip] : []);
          return `${n.name}(${ips.join(',') || '?'})`;
        }).join(', ');
        const suffix = arr.length > 3 ? ' …' : '';
        const multiHint = multi > 0 ? ` · 다중IP ${multi}대` : '';
        return `${arr.length} 노드${multiHint} · ${preview}${suffix}`;
      }
    } catch { /* JSON 아님 */ }
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ClusterUpdateDiffDialog({
  open, clusterName, diff, warnings, applying, onCancel, onConfirm,
}: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !applying) onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, applying, onCancel]);

  if (!open) return null;

  const changed = diff.filter((d) => d.changed);
  const unchanged = diff.filter((d) => !d.changed);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={() => !applying && onCancel()} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border bg-muted/30">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-primary/10 text-primary">
            {changed.length > 0 ? <AlertTriangle className="w-4 h-4" /> : <CheckCircle2 className="w-4 h-4" />}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">클러스터 정보 수집 결과 — {clusterName}</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {changed.length > 0
                ? `${changed.length}개 필드에 변경사항이 있습니다. 적용하시겠습니까?`
                : '변경된 필드가 없습니다.'}
            </p>
          </div>
          <button onClick={onCancel} disabled={applying}
            className="p-1 rounded hover:bg-secondary text-muted-foreground disabled:opacity-40">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="max-h-[520px] overflow-y-auto">
          {warnings.length > 0 && (
            <div className="px-5 py-3 border-b border-border bg-amber-500/5">
              <p className="text-sm font-medium text-amber-400 mb-1 flex items-center gap-1">
                <AlertTriangle className="w-3 h-3" /> 경고 {warnings.length}건
              </p>
              <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          )}

          {changed.length > 0 && (
            <div className="px-5 py-3">
              <p className="text-xs font-medium text-muted-foreground uppercase mb-2">변경 예정</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border">
                    <th className="py-1.5 font-medium">필드</th>
                    <th className="py-1.5 font-medium">기존 값</th>
                    <th className="py-1.5 font-medium w-4"><span className="sr-only">변경 방향</span></th>
                    <th className="py-1.5 font-medium">신규 값</th>
                  </tr>
                </thead>
                <tbody>
                  {changed.map((d) => (
                    <tr key={d.field} className="border-b border-border/50">
                      <td className="py-1.5 pr-2 text-sm font-medium text-foreground">
                        {FIELD_LABELS[d.field] ?? d.field}
                      </td>
                      <td className="py-1.5 pr-2 font-mono text-xs text-muted-foreground max-w-[200px] truncate"
                        title={renderValue(d.current, d.field)}>
                        {renderValue(d.current, d.field)}
                      </td>
                      <td className="py-1.5"><ArrowRight className="w-3 h-3 text-muted-foreground/50" /></td>
                      <td className="py-1.5 font-mono text-xs text-primary max-w-[260px] truncate"
                        title={renderValue(d.proposed, d.field)}>
                        {renderValue(d.proposed, d.field)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {unchanged.length > 0 && (
            <details className="px-5 py-3 border-t border-border">
              <summary className="text-xs text-muted-foreground cursor-pointer">
                변경 없음 {unchanged.length}건 보기
              </summary>
              <ul className="mt-2 text-xs text-muted-foreground/80 space-y-0.5 font-mono">
                {unchanged.map((d) => (
                  <li key={d.field}>
                    {FIELD_LABELS[d.field] ?? d.field}: {renderValue(d.current, d.field)}
                  </li>
                ))}
              </ul>
            </details>
          )}

          {diff.length === 0 && (
            <div className="px-5 py-8 text-center text-sm text-muted-foreground">
              수집된 정보가 없습니다. (kubeconfig 접근은 성공했으나 추출 가능한 필드가 없음)
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onCancel} disabled={applying}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg disabled:opacity-40">
            취소
          </button>
          <button onClick={onConfirm} disabled={applying || changed.length === 0}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50">
            {applying && <Loader2 className="w-3 h-3 animate-spin" />}
            {changed.length > 0 ? `${changed.length}개 필드 적용` : '적용'}
          </button>
        </div>
      </div>
    </div>
  );
}
