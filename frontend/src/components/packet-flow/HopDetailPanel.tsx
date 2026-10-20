import { CheckCircle2, XCircle, AlertTriangle, Info, X, ShieldAlert, Tag, Timer, Link as LinkIcon } from 'lucide-react';
import type { TopologyTraceHopV2, HopVerdict, HopPolicy } from '@/types';

interface Props {
  hop: TopologyTraceHopV2;
  index: number;
  totalHops: number;
  onClose: () => void;
}

const VERDICT_META: Record<HopVerdict, { icon: typeof CheckCircle2; cls: string; label: string }> = {
  allow: { icon: CheckCircle2, cls: 'bg-secondary text-muted-foreground border-border', label: '허용' },
  deny:  { icon: XCircle,      cls: 'bg-status-critical/10 text-status-critical border-status-critical/30', label: '차단' },
  warn:  { icon: AlertTriangle,cls: 'bg-status-warning/10 text-status-warning border-status-warning/30',    label: '경고' },
  // 정보는 상태가 아니다 — 중립색(§12.12-3)
  info:  { icon: Info,         cls: 'bg-secondary text-muted-foreground border-border',                     label: '정보' },
};

const ENTITY_TEXT: Record<string, string> = {
  external: '외부', dns: 'DNS', ingress_controller: 'Ingress 파드', ingress: 'Ingress',
  service: '서비스', pod: '파드', node: '노드', switch: '스위치', error: '오류',
};

function PolicyItem({ p }: { p: HopPolicy }) {
  const kindColor = p.kind.startsWith('Cilium')
    ? 'bg-chart-4/10 text-chart-4-text border-chart-4/30'
    : 'bg-status-info/10 text-status-info border-status-info/30';
  return (
    <div className="border border-border rounded p-2 bg-muted/20">
      <div className="flex items-center gap-1.5 mb-1 flex-wrap">
        <span className={`text-xs px-1.5 py-0.5 rounded border ${kindColor}`}>{p.kind}</span>
        <span className="text-xs text-muted-foreground">{p.direction}</span>
        <span className="text-sm font-mono text-foreground truncate" title={p.name}>{p.name}</span>
      </div>
      <p className="text-xs font-mono text-muted-foreground break-all">{p.summary}</p>
    </div>
  );
}

export function HopDetailPanel({ hop, index, totalHops, onClose }: Props) {
  const meta = VERDICT_META[hop.verdict] ?? VERDICT_META.info;
  const Icon = meta.icon;

  return (
    <div role="region" aria-label={`홉 ${index + 1} 상세`} className="absolute top-3 right-3 w-96 max-h-[calc(100%-1.5rem)] bg-card border border-border rounded-md shadow-card overflow-hidden flex flex-col z-10">
      <header className="flex items-start gap-2 px-4 py-3 border-b border-border bg-muted/20">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground">
            홉 {index + 1} / {totalHops} · {ENTITY_TEXT[hop.entityType] ?? hop.entityType}
          </p>
          <p className="text-sm font-semibold truncate" title={hop.name}>{hop.name}</p>
          {hop.interface && (
            <p className="text-xs font-mono text-muted-foreground truncate mt-0.5" title={hop.interface}>
              {hop.interface}
            </p>
          )}
        </div>
        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium ${meta.cls}`}>
          <Icon className="w-3 h-3" aria-hidden />
          {meta.label}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label={`홉 ${index + 1} 상세 닫기`}
          title="홉 상세 닫기"
          className="p-1 rounded-xl hover:bg-secondary text-muted-foreground"
        >
          <X className="w-4 h-4" aria-hidden />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-sm">
        {/* 메트릭 */}
        {(hop.latencyMs != null || hop.errorCount != null) && (
          <div className="flex gap-3 text-xs text-muted-foreground">
            {hop.latencyMs != null && <span className="inline-flex items-center gap-1"><Timer className="w-3 h-3" aria-hidden />{hop.latencyMs}ms</span>}
            {hop.errorCount != null && <span className={`inline-flex items-center gap-1 ${hop.errorCount > 0 ? 'text-status-warning' : ''}`}>
              <AlertTriangle className="w-3 h-3" aria-hidden /> 오류 {hop.errorCount}건
            </span>}
          </div>
        )}

        {/* notes */}
        {hop.notes.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">메모</p>
            <ul className="space-y-0.5">
              {hop.notes.map((n, i) => (
                <li key={i} className="text-sm text-foreground">• {n}</li>
              ))}
            </ul>
          </div>
        )}

        {/* policies */}
        {hop.policies.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <ShieldAlert className="w-3 h-3" aria-hidden /> 적용 정책 ({hop.policies.length})
            </p>
            <div className="space-y-1.5">
              {hop.policies.map((p, i) => <PolicyItem key={i} p={p} />)}
            </div>
          </div>
        )}

        {/* identity */}
        {hop.identity && (
          <div>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <Tag className="w-3 h-3" aria-hidden /> Cilium Identity
            </p>
            <pre className="text-xs font-mono bg-background border border-border rounded p-2 overflow-auto max-h-32 whitespace-pre-wrap">
              {JSON.stringify(hop.identity, null, 2)}
            </pre>
          </div>
        )}

        {/* refs */}
        {hop.refs.length > 0 && (
          <div>
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              <LinkIcon className="w-3 h-3" aria-hidden /> 연관 리소스
            </p>
            <ul className="space-y-0.5">
              {hop.refs.map((r, i) => (
                <li key={i} className="font-mono text-xs">
                  <span className="text-muted-foreground">{r.kind}:</span> <span className="text-foreground">{r.name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
