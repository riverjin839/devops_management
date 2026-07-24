import { useId, useState } from 'react';
import { X, ArrowRight, Loader2 } from 'lucide-react';
import { useModalA11y } from '@/components/common/useModalA11y';
import type { ArchViewType } from '@/types';

const EDGE_TYPES: { value: string; label: string }[] = [
  { value: 'flow', label: '플로우 (요청 흐름)' },
  { value: 'calls', label: '호출' },
  { value: 'depends', label: '의존' },
  { value: 'custom', label: '기타' },
];

const VIEWS: { value: ArchViewType | 'both'; label: string }[] = [
  { value: 'both', label: '두 뷰 모두' },
  { value: 'architecture', label: '아키텍처 뷰만' },
  { value: 'flow', label: '플로우 뷰만' },
];

interface Props {
  sourceName: string;
  targetName: string;
  pending: boolean;
  onSubmit: (data: {
    edgeType: string; label?: string | null; description?: string | null;
    view: ArchViewType | 'both'; sortOrder?: number;
  }) => void;
  onClose: () => void;
}

export function ManualEdgeDialog({ sourceName, targetName, pending, onSubmit, onClose }: Props) {
  const [edgeType, setEdgeType] = useState('flow');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [view, setView] = useState<ArchViewType | 'both'>('both');
  const [sortOrder, setSortOrder] = useState('0');
  const titleId = useId();
  const dialogRef = useModalA11y(true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !pending && onClose()} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-sm mx-4"
      >
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-border">
          <ArrowRight className="w-4 h-4 text-muted-foreground" />
          <h2 id={titleId} className="text-sm font-semibold flex-1">수동 연결 추가</h2>
          <button onClick={onClose} disabled={pending} aria-label="닫기" title="닫기"
            className="p-1 rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <div className="flex items-center gap-2 text-sm bg-secondary/50 border border-border rounded-xl px-3 py-2">
            <span className="font-medium truncate max-w-[40%]">{sourceName}</span>
            <ArrowRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
            <span className="font-medium truncate max-w-[40%]">{targetName}</span>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">연결 유형</span>
            <select value={edgeType} onChange={(e) => setEdgeType(e.target.value)} aria-label="연결 유형"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm">
              {EDGE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-sm font-medium text-muted-foreground mb-1 block">표시 뷰</span>
              <select value={view} onChange={(e) => setView(e.target.value as ArchViewType | 'both')}
                aria-label="표시 뷰"
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm">
                {VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
              </select>
            </div>
            <div>
              <span className="text-sm font-medium text-muted-foreground mb-1 block">플로우 순서</span>
              <input type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)}
                aria-label="플로우 순서"
                className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
            </div>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">라벨 (선택)</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="연결 라벨"
              placeholder="예) 메타데이터 조회, 이벤트 발행…"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">메모 (선택)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              aria-label="연결 메모"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} disabled={pending}
            className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            취소
          </button>
          <button
            onClick={() => onSubmit({
              edgeType,
              label: label.trim() || null,
              description: description.trim() || null,
              view,
              sortOrder: Number(sortOrder) || 0,
            })}
            disabled={pending}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50">
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowRight className="w-3.5 h-3.5" />}
            추가
          </button>
        </div>
      </div>
    </div>
  );
}
