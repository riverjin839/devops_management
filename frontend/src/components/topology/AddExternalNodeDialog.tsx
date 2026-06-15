import { useState } from 'react';
import { X, Server, Loader2 } from 'lucide-react';

const NODE_TYPES: { value: string; label: string }[] = [
  { value: 'database', label: '데이터베이스' },
  { value: 'api', label: '외부 API' },
  { value: 'queue', label: '메시지 큐' },
  { value: 'other', label: '기타' },
];

interface Props {
  pending: boolean;
  onSubmit: (data: { name: string; nodeType: string; note?: string }) => void;
  onClose: () => void;
}

export function AddExternalNodeDialog({ pending, onSubmit, onClose }: Props) {
  const [name, setName] = useState('');
  const [nodeType, setNodeType] = useState('database');
  const [note, setNote] = useState('');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => !pending && onClose()} />
      <div className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-sm mx-4">
        <div className="flex items-center gap-2 px-5 pt-4 pb-3 border-b border-border">
          <Server className="w-4 h-4 text-slate-500" />
          <h2 className="text-sm font-semibold flex-1">외부 노드 추가</h2>
          <button onClick={onClose} disabled={pending} className="p-1 rounded-lg text-muted-foreground hover:bg-secondary disabled:opacity-50">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">이름 *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus aria-label="외부 노드 이름"
              placeholder="예) prod-postgres, payments-api…"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">유형</span>
            <select value={nodeType} onChange={(e) => setNodeType(e.target.value)} aria-label="외부 노드 유형"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm">
              {NODE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <span className="text-sm font-medium text-muted-foreground mb-1 block">메모 (선택)</span>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} aria-label="메모"
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm resize-none" />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border bg-muted/30">
          <button onClick={onClose} disabled={pending}
            className="px-3.5 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl disabled:opacity-50">
            취소
          </button>
          <button
            onClick={() => name.trim() && onSubmit({ name: name.trim(), nodeType, note: note.trim() || undefined })}
            disabled={pending || !name.trim()}
            className="px-3.5 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-xl inline-flex items-center gap-1.5 disabled:opacity-50">
            {pending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Server className="w-3.5 h-3.5" />}
            추가
          </button>
        </div>
      </div>
    </div>
  );
}
