import { X, Trash2, Cpu, MemoryStick, RotateCcw, Box } from 'lucide-react';
import type { TopoNode, TopoEdge } from '@/types';
import {
  fmtCpu, fmtMem, usageRatio, statusColor, kindAccent, KIND_ABBR, EDGE_TYPE_LABEL,
} from './topologyShared';

interface Props {
  node: TopoNode;
  edges: TopoEdge[];
  nodeName: (id: string) => string;
  onClose: () => void;
  onDeleteLink?: (manualId: string) => void;
  onDeleteExternal?: (node: TopoNode) => void;
}

export function NodeDetailPanel({ node, edges, nodeName, onClose, onDeleteLink, onDeleteExternal }: Props) {
  const related = edges.filter((e) => e.source === node.id || e.target === node.id);
  const cpuR = usageRatio(node.metrics.cpu.usage, node.metrics.cpu.request, node.metrics.cpu.limit);
  const memR = usageRatio(node.metrics.mem.usage, node.metrics.mem.request, node.metrics.mem.limit);

  return (
    <div className="absolute top-3 right-3 w-72 max-h-[calc(100%-1.5rem)] overflow-y-auto bg-card/95 backdrop-blur border border-border rounded-2xl mac-shadow z-20">
      <div className="flex items-start gap-2 px-4 pt-3.5 pb-2 border-b border-border">
        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded mt-0.5" style={{ background: `${kindAccent(node.kind)}22`, color: kindAccent(node.kind) }}>
          {KIND_ABBR[node.kind] ?? node.kind}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight break-all">{node.name}</p>
          <p className="text-[11px] text-muted-foreground">{node.namespace}{node.ghost ? ' · (없음)' : ''}</p>
        </div>
        <button onClick={onClose} className="p-1 rounded-lg text-muted-foreground hover:bg-secondary" aria-label="닫기">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 space-y-3">
        {/* 상태 */}
        <div className="flex items-center gap-2 text-xs">
          <span className="w-2 h-2 rounded-full" style={{ background: statusColor(node.status) }} />
          <span className="font-medium capitalize">{node.status}</span>
          {node.podCount > 0 && (
            <span className="text-muted-foreground flex items-center gap-1 ml-auto">
              <Box className="w-3 h-3" /> {node.readyCount}/{node.podCount}
              {node.restartCount > 0 && <><RotateCcw className="w-3 h-3 ml-1" /> {node.restartCount}</>}
            </span>
          )}
        </div>

        {node.detail && <p className="text-[11px] text-muted-foreground break-all">{node.detail}</p>}

        {/* 메트릭 */}
        {(node.kind !== 'ConfigMap' && node.kind !== 'Secret' && node.kind !== 'External') && (
          <div className="space-y-2">
            <MetricBar icon={<Cpu className="w-3 h-3" />} label="CPU" ratio={cpuR}
              usage={fmtCpu(node.metrics.cpu.usage)} req={fmtCpu(node.metrics.cpu.request)} lim={fmtCpu(node.metrics.cpu.limit)} />
            <MetricBar icon={<MemoryStick className="w-3 h-3" />} label="MEM" ratio={memR}
              usage={fmtMem(node.metrics.mem.usage)} req={fmtMem(node.metrics.mem.request)} lim={fmtMem(node.metrics.mem.limit)} />
          </div>
        )}

        {/* external 삭제 */}
        {node.kind === 'External' && onDeleteExternal && (
          <button onClick={() => onDeleteExternal(node)}
            className="w-full inline-flex items-center justify-center gap-1.5 px-2 py-1.5 text-[11px] rounded-lg border border-red-500/30 text-red-500 hover:bg-red-500/10">
            <Trash2 className="w-3 h-3" /> 외부 노드 삭제
          </button>
        )}

        {/* 연결된 엣지 */}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
            연결 · {related.length}
          </p>
          <div className="space-y-1">
            {related.map((e) => {
              const out = e.source === node.id;
              const other = out ? e.target : e.source;
              return (
                <div key={e.id} className="flex items-center gap-1.5 text-[11px] rounded-lg bg-secondary/40 px-2 py-1">
                  <span className="text-muted-foreground">{out ? '→' : '←'}</span>
                  <span className="flex-1 min-w-0 truncate" title={nodeName(other)}>{nodeName(other)}</span>
                  <span className="text-[9px] px-1 py-0.5 rounded bg-card text-muted-foreground flex-shrink-0">
                    {EDGE_TYPE_LABEL[e.type] ?? e.type}
                  </span>
                  {e.type === 'manual' && e.manualId && onDeleteLink && (
                    <button onClick={() => onDeleteLink(e.manualId!)} className="text-red-500 hover:text-red-600 flex-shrink-0" aria-label="링크 삭제">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
            {related.length === 0 && <p className="text-[11px] text-muted-foreground">연결 없음</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricBar({ icon, label, ratio, usage, req, lim }: {
  icon: React.ReactNode; label: string; ratio: number | null; usage: string; req: string; lim: string;
}) {
  const pct = ratio == null ? 0 : ratio * 100;
  const color = ratio == null ? '#94a3b8' : ratio > 0.9 ? '#ef4444' : ratio > 0.7 ? '#f59e0b' : '#10b981';
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] mb-0.5">
        <span className="text-muted-foreground">{icon}</span>
        <span className="font-medium">{label}</span>
        <span className="ml-auto tabular-nums text-muted-foreground">
          {usage} <span className="opacity-50">/ req {req} · lim {lim}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-secondary overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
