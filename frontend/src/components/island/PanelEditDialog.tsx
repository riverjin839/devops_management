import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ClusterIconPicker } from '@/components/common';
import { resolveClusterIcon } from '@/lib/clusterIcons';
import type { IslandPanelView } from './IslandTabBar';

interface PanelEditDialogProps {
  panel: IslandPanelView;
  /** 오버라이드가 없을 때 쓰이는 기본 라벨 (navLabels/NAV_MAP 유래) — placeholder 로 보여준다. */
  fallbackLabel: string;
  onClose: () => void;
  onSave: (patch: { label: string | null; icon: string | null }) => void;
}

/**
 * 패널 하나의 표시 이름/아이콘 오버라이드 편집.
 *
 * 값을 비우면 `null` 로 저장되어 사이드바와 같은 기본값(navLabels → NAV_MAP)으로 되돌아간다 —
 * 즉 "빈 문자열"과 "미설정"을 구분하지 않는다. 백엔드 `_normalize_panels()` 도 공백 문자열을
 * null 로 접기 때문에 두 계층의 동작이 일치한다.
 */
export function PanelEditDialog({ panel, fallbackLabel, onClose, onSave }: PanelEditDialogProps) {
  const [label, setLabel] = useState(panel.label ?? '');
  const [icon, setIcon] = useState<string | null>(panel.icon ?? null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  const resolved = resolveClusterIcon(icon);
  const PreviewIcon = resolved?.kind === 'lucide' ? resolved.Component : panel.Icon;

  const save = () => {
    onSave({ label: label.trim() || null, icon });
    onClose();
  };

  const reset = () => {
    setLabel('');
    setIcon(null);
  };

  return (
    <>
      <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>패널 표시 설정</DialogTitle>
          </DialogHeader>

          <div className="px-5 pb-5 space-y-4">
            <p className="text-xs text-muted-foreground font-mono truncate">{panel.path}</p>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIconPickerOpen(true)}
                title="아이콘 변경"
                aria-label="패널 아이콘 변경"
                className="flex items-center justify-center w-10 h-10 rounded-lg bg-secondary text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              >
                {resolved?.kind === 'image'
                  ? <img src={resolved.value} alt="" className="w-5 h-5 object-contain rounded-sm" />
                  : resolved?.kind === 'text'
                    ? <span className="text-base leading-none">{resolved.value}</span>
                    : <PreviewIcon className="w-5 h-5" />}
              </button>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
                placeholder={fallbackLabel}
                aria-label="패널 표시 이름"
                autoFocus
                className="flex-1 min-w-0 px-3 py-2 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              비워두면 기본 이름 · 아이콘({fallbackLabel})을 사용합니다.
            </p>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-1 px-3 py-2 text-sm rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <RotateCcw className="w-4 h-4" />
                기본값으로
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={onClose}
                className="px-3 py-2 text-sm rounded-xl text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                취소
              </button>
              <button
                type="button"
                onClick={save}
                className="px-3 py-2 text-sm font-medium rounded-xl bg-primary text-primary-foreground"
              >
                저장
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {iconPickerOpen && (
        <ClusterIconPicker
          value={icon}
          title="패널 아이콘 선택"
          clusterName={label || fallbackLabel}
          onChange={setIcon}
          onClose={() => setIconPickerOpen(false)}
        />
      )}
    </>
  );
}
