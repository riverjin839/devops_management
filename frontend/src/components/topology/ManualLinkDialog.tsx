import { useState } from 'react';
import { X, Link2, Loader2 } from 'lucide-react';
import type { TopoNode } from '@/types';
import { KIND_ABBR } from './topologyShared';

const LINK_TYPES: { value: string; label: string }[] = [
  { value: 'depends_on', label: '의존 (depends on)' },
  { value: 'calls', label: '호출 (calls)' },
  { value: 'reads', label: '읽기 (reads)' },
  { value: 'writes', label: '쓰기 (writes)' },
  { value: 'custom', label: '커스텀' },
];

interface Props {
  source: TopoNode;
  target: TopoNode;
  pending: boolean;
  onSubmit: (data: { linkType: string; label?: string; note?: string }) => void;
  onClose: () => void;
}

export function ManualLinkDialog({ source, target, pending, onSubmit, onClose }: Props) {
  const [linkType, setLinkType] = useState('depends_on');
  const [label, setLabel] = useState('');
  const [note, setNote] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !pending && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-sm mx-4">
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-border">
          <Link2 className="w-4 h-4 text-orange-500" />
          <h2 className="text-sm font-semibold flex-1">수동 연계 추가</h2>
          <button onClick={onClose} disabled={pending} className="p-1 rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <div className="flex items-center gap-2 text-sm">
            <NodeChip node={source} />
            <span className="text-muted-foreground">→</span>
            <NodeChip node={target} />
          </div>

          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">연계 유형</span>
            <select value={linkType} onChange={(e) => setLinkType(e.target.value)} aria-label="연계 유형"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm">
              {LINK_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>

          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">라벨 (선택)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="연계 라벨"
              placeholder="예) gRPC, REST, JDBC…"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>

          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">메모 (선택)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label="연계 메모"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} disabled={pending}
            className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            취소
          </button>
          <button
            onClick={() => onSubmit({ linkType, label: label.trim() || undefined, note: note.trim() || undefined })}
            disabled={pending}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50">
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
            연계 추가
          </button>
        </div>
      </div>
    </div>
  );
}

function NodeChip({ node }: { node: TopoNode }) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-secondary/60 min-w-0 max-w-[45%]">
      <span className="text-[10px] font-bold text-muted-foreground flex-shrink-0">{KIND_ABBR[node.kind] ?? node.kind}</span>
      <span className="truncate font-medium" title={node.name}>{node.name}</span>
    </span>
  );
}
