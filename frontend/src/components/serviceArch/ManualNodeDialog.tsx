import { useId, useState } from 'react';
import { X, Boxes, Loader2 } from 'lucide-react';
import { useModalA11y } from '@/components/common/useModalA11y';
import type { ArchManualNode } from '@/types';

const NODE_KINDS: { value: string; label: string }[] = [
  { value: 'database', label: '데이터베이스' },
  { value: 'queue', label: '메시지 큐' },
  { value: 'api', label: '외부 API' },
  { value: 'external', label: '외부 시스템' },
  { value: 'user', label: '사용자/클라이언트' },
  { value: 'custom', label: '기타' },
];

interface Props {
  /** 수정 모드면 기존 노드 전달. */
  editing?: ArchManualNode | null;
  pending: boolean;
  onSubmit: (data: { label: string; kind: string; description?: string | null }) => void;
  onClose: () => void;
}

export function ManualNodeDialog({ editing, pending, onSubmit, onClose }: Props) {
  const [label, setLabel] = useState(editing?.label ?? '');
  const [kind, setKind] = useState(editing?.kind ?? 'database');
  const [description, setDescription] = useState(editing?.description ?? '');
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
          <Boxes className="w-4 h-4 text-muted-foreground" />
          <h2 id={titleId} className="text-sm font-semibold flex-1">
            {editing ? '수동 노드 수정' : '수동 노드 추가'}
          </h2>
          <button onClick={onClose} disabled={pending} aria-label="닫기" title="닫기"
            className="p-1 rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">이름 *</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} autoFocus aria-label="노드 이름"
              placeholder="예) prod-postgres, 결제 게이트웨이…"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">유형</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="노드 유형"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm">
              {NODE_KINDS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">설명 (선택)</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2}
              aria-label="노드 설명"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} disabled={pending}
            className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            취소
          </button>
          <button
            onClick={() => label.trim() && onSubmit({
              label: label.trim(), kind, description: description.trim() || null,
            })}
            disabled={pending || !label.trim()}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50">
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Boxes className="w-3.5 h-3.5" />}
            {editing ? '저장' : '추가'}
          </button>
        </div>
      </div>
    </div>
  );
}
