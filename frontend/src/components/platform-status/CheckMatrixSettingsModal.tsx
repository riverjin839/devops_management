import { useEffect, useId, useState } from 'react';
import { X } from 'lucide-react';
import { useToast } from '@/components/common';
import { useModalA11y } from '@/components/common/useModalA11y';
import { useCheckMatrixSettings, useUpdateCheckMatrixSettings } from '@/hooks/useCheckMatrix';
import { formatApiError } from '@/lib/utils';

interface Props {
  isOpen: boolean;
  onClose: () => void;
}

export function CheckMatrixSettingsModal({ isOpen, onClose }: Props) {
  const toast = useToast();
  const { data: settings } = useCheckMatrixSettings();
  const updateMut = useUpdateCheckMatrixSettings();
  const [retentionDays, setRetentionDays] = useState(90);
  const retentionId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(isOpen, onClose);

  useEffect(() => {
    if (isOpen && settings) setRetentionDays(settings.retentionDays);
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const handleSave = async () => {
    try {
      await updateMut.mutateAsync(retentionDays);
      toast.success('보관 주기를 저장했습니다.');
      onClose();
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-sm mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 id={titleId} className="text-lg font-semibold">매트릭스 설정</h2>
          <button onClick={onClose} className="p-1 hover:bg-secondary rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-2">
          <label htmlFor={retentionId} className="text-xs font-medium text-muted-foreground block">이력 보관 주기 (일)</label>
          <input
            id={retentionId}
            type="number"
            min={1}
            max={3650}
            value={retentionDays}
            onChange={(e) => setRetentionDays(Number(e.target.value))}
            className="w-full text-sm border border-border rounded-lg px-3 py-2 bg-background"
          />
          <p className="text-xs text-muted-foreground">
            보관 주기를 초과한 셀 이력(추이/변경 이력)은 매일 자동으로 정리됩니다. DB 용량을 고려해 설정하세요.
          </p>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={updateMut.isPending}
            className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
