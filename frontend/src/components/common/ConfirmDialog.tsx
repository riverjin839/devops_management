import { useEffect } from 'react';
import { AlertTriangle, X } from 'lucide-react';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;  // 추가 상세 (실행 대상 요약 등)
}

/** 중요 액션(ssh/etcdctl 실행 등) 실행 전에 확인을 받는 모달.
 *  Enter = 확인 / Escape = 취소.
 */
export function ConfirmDialog({
  open, title, description, confirmLabel = '실행', cancelLabel = '취소',
  danger = false, onConfirm, onCancel, children,
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onConfirm, onCancel]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} />
      <div className="relative bg-card border border-border rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden">
        <div className={`flex items-start gap-3 px-5 py-4 border-b border-border ${
          danger ? 'bg-red-500/5' : 'bg-muted/30'
        }`}>
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
            danger ? 'bg-red-500/10 text-red-400' : 'bg-primary/10 text-primary'
          }`}>
            <AlertTriangle className="w-4 h-4" />
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="text-sm font-semibold">{title}</h2>
            {description && <p className="text-sm text-muted-foreground mt-0.5">{description}</p>}
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-secondary text-muted-foreground flex-shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        {children && <div className="px-5 py-4 text-sm">{children}</div>}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button
            onClick={onCancel}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            autoFocus
            className={`px-4 py-1.5 text-sm font-semibold rounded-lg text-primary-foreground ${
              danger
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-primary hover:bg-primary/90'
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
