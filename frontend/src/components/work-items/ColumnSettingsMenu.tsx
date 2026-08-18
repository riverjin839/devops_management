import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal, RotateCcw, Check, Save } from 'lucide-react';
import type { WorkItemColumnKey } from './workItemColumns';
import { WORK_ITEM_COLUMNS } from './workItemColumns';

interface ColumnSettingsMenuProps {
  /** 전체 컬럼 순서 (표시/숨김 무관) — 메뉴 항목 순서로 사용. */
  order: WorkItemColumnKey[];
  isVisible: (k: WorkItemColumnKey) => boolean;
  onToggle: (k: WorkItemColumnKey) => void;
  onReset: () => void;
  /** 지금 순서/표시여부/폭을 "내 기본값"으로 즉시 저장(디바운스 우회) + 토스트 확인.
   *  드래그/토글은 이미 자동 저장되지만, 사용자가 "지금 이 설정이 저장됐다"를
   *  명시적으로 확인할 방법이 없어 추가한 액션이다. */
  onSave: () => void;
}

/** 컬럼 표시/숨김 토글 + 기본값 저장/복원 팝오버. 순서 변경은 헤더 드래그로 별도 처리. */
export function ColumnSettingsMenu({ order, isVisible, onToggle, onReset, onSave }: ColumnSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors inline-flex items-center gap-1.5 ${
          open
            ? 'bg-primary/10 text-primary border-primary/30'
            : 'bg-secondary border-border text-muted-foreground hover:text-foreground'
        }`}
        title="표시할 컬럼 선택 (순서는 헤더를 드래그)"
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        컬럼
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 z-30 w-52 rounded-xl border border-border bg-card shadow-lg p-1.5">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">표시할 컬럼</div>
          <div className="max-h-72 overflow-y-auto">
            {order.map((k) => {
              const meta = WORK_ITEM_COLUMNS[k];
              const checked = isVisible(k);
              return (
                <button
                  key={k}
                  type="button"
                  disabled={!meta.hideable}
                  onClick={() => onToggle(k)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg hover:bg-muted/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-left"
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                      checked ? 'bg-primary border-primary text-primary-foreground' : 'border-border'
                    }`}
                  >
                    {checked && <Check className="w-3 h-3" />}
                  </span>
                  <span className="flex-1 text-foreground">{meta.label}</span>
                  {!meta.hideable && <span className="text-xs text-muted-foreground">고정</span>}
                </button>
              );
            })}
          </div>
          <div className="border-t border-border mt-1.5 pt-1.5">
            <button
              type="button"
              onClick={() => { onSave(); setOpen(false); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg hover:bg-primary/10 text-primary transition-colors"
              title="지금 순서·표시여부·폭을 내 기본값으로 저장"
            >
              <Save className="w-3.5 h-3.5" />
              현재 설정을 기본값으로 저장
            </button>
            <button
              type="button"
              onClick={() => { onReset(); setOpen(false); }}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-sm rounded-lg hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              기본값으로 복원
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
