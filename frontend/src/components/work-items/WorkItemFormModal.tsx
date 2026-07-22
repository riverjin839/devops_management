import { X, ListTodo } from 'lucide-react';
import { WorkItemForm } from './WorkItemForm';
import { useModalA11y } from '@/components/common/useModalA11y';
import type { WorkItem, WorkItemType } from '@/types';

interface WorkItemFormModalProps {
  open: boolean;
  /** 신규 등록 시 기본 type. */
  defaultType?: WorkItemType;
  /** 하위 업무 등록 시 상위 업무. */
  parentItem?: WorkItem | null;
  /** 신규 등록 시 초기 시작일. */
  defaultStartedAt?: string;
  onClose: () => void;
  /** 저장 완료 후 콜백 — 모달은 자동으로 닫힌다. */
  onSaved?: (savedId?: string) => void;
}

/** 업무 등록/하위 업무 등록을 페이지 전환 없이 팝업으로 띄운다 — 전체 폼(WorkItemForm)을 그대로 감싼다. */
export function WorkItemFormModal({
  open, defaultType, parentItem, defaultStartedAt, onClose, onSaved,
}: WorkItemFormModalProps) {
  const dialogRef = useModalA11y(open, onClose);
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="work-item-form-modal-title" className="relative bg-card border border-border rounded-2xl mac-shadow w-full max-w-6xl mx-4 max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center gap-2 px-5 py-3 bg-card/95 backdrop-blur-md border-b border-border">
          <ListTodo className="w-4 h-4 text-muted-foreground" />
          <span id="work-item-form-modal-title" className="text-sm font-semibold flex-1">{parentItem ? '하위 업무 등록' : '업무 등록'}</span>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="닫기"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5">
          <WorkItemForm
            defaultType={defaultType}
            parentItem={parentItem}
            defaultStartedAt={defaultStartedAt}
            onCancel={onClose}
            onSaved={(savedId) => { onSaved?.(savedId); onClose(); }}
            embedded
          />
        </div>
      </div>
    </div>
  );
}
