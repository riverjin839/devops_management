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
  // 입력 중 빈 값/범위 밖 값을 그대로 숫자로 바꾸면 0·99999 가 저장됐다 — 문자열로 들고 검증한다.
  const [retentionDays, setRetentionDays] = useState('90');
  const retentionId = useId();
  const titleId = useId();
  const dialogRef = useModalA11y(isOpen, onClose);

  useEffect(() => {
    if (isOpen && settings) setRetentionDays(String(settings.retentionDays));
  }, [isOpen, settings]);

  if (!isOpen) return null;

  const days = Number(retentionDays);
  const valid = retentionDays.trim() !== '' && Number.isInteger(days) && days >= 1 && days <= 3650;

  const handleSave = async () => {
    if (!valid) return;
    try {
      await updateMut.mutateAsync(days);
      toast.success('보관 주기 저장됨');
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
          <button
            onClick={onClose}
            title="닫기"
            aria-label="닫기"
            className="p-1 hover:bg-secondary rounded-xl transition-colors"
          >
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
            onChange={(e) => setRetentionDays(e.target.value)}
            aria-invalid={!valid || undefined}
            className={`w-full text-sm border rounded-xl px-3 py-2 bg-background ${valid ? 'border-border' : 'border-status-critical'}`}
          />
          {!valid && <p className="text-xs text-status-critical">1~3650 사이의 정수(일)를 입력하세요.</p>}
          <p className="text-xs text-muted-foreground">
            보관 기간을 넘긴 셀 값 이력(추이·변경 이력)과 실행 기록은 매일 03:00 에 자동으로 정리됩니다.
            DB 용량을 고려해 설정하세요(기본 90일).
          </p>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button onClick={onClose} className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-xl">
            취소
          </button>
          <button
            onClick={handleSave}
            disabled={updateMut.isPending || !valid}
            className="px-4 py-1.5 text-sm font-semibold bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
          >
            {updateMut.isPending ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
