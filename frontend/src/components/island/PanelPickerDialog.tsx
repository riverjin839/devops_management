import { useCallback, useMemo } from 'react';
import { Check } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScreenCatalogList } from '@/components/common';
import { isEmbeddable, MAX_PANELS } from './panelRegistry';

interface PanelPickerDialogProps {
  open: boolean;
  onClose: () => void;
  /** 이미 담겨 있는 경로들 — 체크 표시용(중복 추가 자체는 허용). */
  existingPaths: string[];
  onPick: (path: string) => void;
}

/**
 * 아일랜드에 담을 화면을 고르는 다이얼로그.
 *
 * 목록 자체는 `ScreenCatalogList`(공용 — Settings 의 화면별 노출 관리자와 공유)를 쓰고,
 * 여기서는 `panelRegistry` 에 등록돼 임베드 가능한 화면만 남기는 필터와 "이미 추가됨"
 * 체크마크만 얹는다.
 */
export function PanelPickerDialog({ open, onClose, existingPaths, onPick }: PanelPickerDialogProps) {
  const existing = useMemo(() => new Set(existingPaths), [existingPaths]);
  // 서버 스키마가 max 20 으로 422 를 내므로, 프론트에서 미리 막고 이유를 알려준다.
  const atCapacity = existingPaths.length >= MAX_PANELS;

  const handlePick = useCallback((path: string) => {
    onPick(path);
  }, [onPick]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>화면 추가</DialogTitle>
        </DialogHeader>

        <div className="px-5 pb-5 space-y-3">
          {atCapacity && (
            <p className="px-3 py-2 text-sm rounded-xl bg-status-warning-soft text-foreground">
              패널은 아일랜드당 최대 {MAX_PANELS}개까지 담을 수 있습니다. 더 추가하려면 기존 패널을
              제거하거나 새 아일랜드를 만드세요.
            </p>
          )}
          <ScreenCatalogList
            filter={isEmbeddable}
            onSelect={handlePick}
            autoFocusSearch
            isRowDisabled={() => atCapacity}
            renderTrailing={(path) => existing.has(path) && (
              <Check className="w-3.5 h-3.5 flex-shrink-0 text-primary" aria-label="이미 추가됨" />
            )}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
