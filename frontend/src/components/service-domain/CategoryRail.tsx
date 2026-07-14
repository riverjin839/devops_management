import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid, Boxes } from 'lucide-react';
import type { ServiceCategory } from '@/types';
import { resolveClusterIcon } from '@/lib/clusterIcons';

/** ClusterSidebar(iconOnly) 시각 컨벤션을 준용한 56px 아이콘 전용 카테고리 레일.
 *  PEP 서비스/APP 서비스 페이지의 "상위 카테고리 → 하위 서비스" 1차 네비게이션. */
const RAIL_WIDTH = 56;
const BTN_SIZE = 44;
const ICON_SIZE = 20;

interface RailButtonProps {
  label: string;
  Icon?: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  emojiText?: string;
  imageSrc?: string;
  active: boolean;
  onClick: () => void;
}

function RailButton({ label, Icon, emojiText, imageSrc, active, onClick }: RailButtonProps) {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const showTooltip = () => {
    const el = buttonRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setTooltipPos({ top: rect.top + rect.height / 2, left: rect.right + 8 });
  };
  const hideTooltip = () => setTooltipPos(null);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        onClick={onClick}
        onMouseEnter={showTooltip}
        onMouseLeave={hideTooltip}
        onFocus={showTooltip}
        onBlur={hideTooltip}
        style={{ width: BTN_SIZE, height: BTN_SIZE }}
        className={`relative flex items-center justify-center rounded-md transition-colors ${
          active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        {active && (
          <span aria-hidden className="absolute left-0 top-1.5 -translate-x-[3px] w-1 h-7 bg-primary rounded-r" />
        )}
        {imageSrc
          ? <img src={imageSrc} alt="" style={{ width: 32, height: 32 }} className="rounded object-cover" />
          : emojiText
            ? <span style={{ fontSize: 20 }} className="leading-none select-none" aria-hidden>{emojiText}</span>
            : Icon
              ? <Icon className="flex-shrink-0" style={{ width: ICON_SIZE, height: ICON_SIZE } as React.CSSProperties} />
              : <Boxes className="flex-shrink-0" style={{ width: ICON_SIZE, height: ICON_SIZE } as React.CSSProperties} />}
      </button>
      {tooltipPos && createPortal(
        <span
          role="tooltip"
          style={{ top: tooltipPos.top, left: tooltipPos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

interface CategoryRailProps {
  categories: ServiceCategory[];
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  allLabel?: string;
}

export function CategoryRail({ categories, selectedKey, onSelect, allLabel = '전체' }: CategoryRailProps) {
  return (
    <aside
      style={{ width: RAIL_WIDTH }}
      className="flex-shrink-0 bg-card border border-border rounded-xl py-2 h-fit sticky top-4"
    >
      <div className="flex flex-col items-center gap-1">
        <RailButton
          label={`${allLabel} (${categories.length})`}
          Icon={LayoutGrid}
          active={selectedKey === null}
          onClick={() => onSelect(null)}
        />
        {categories.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground/70 text-center">카테고리 없음</p>
        ) : (
          categories.map((c) => {
            const resolved = resolveClusterIcon(c.icon);
            const Icon = resolved?.kind === 'lucide' ? resolved.Component : undefined;
            const emojiText = resolved?.kind === 'text' ? resolved.value : undefined;
            const imageSrc = resolved?.kind === 'image' ? resolved.value : undefined;
            return (
              <RailButton
                key={c.id}
                label={c.label}
                Icon={Icon}
                emojiText={emojiText}
                imageSrc={imageSrc}
                active={selectedKey === c.key}
                onClick={() => onSelect(c.key)}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}
