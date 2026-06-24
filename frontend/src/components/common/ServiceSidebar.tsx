import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayoutGrid, type LucideIcon } from 'lucide-react';
import type { ServiceDef } from '@/components/services/serviceCatalog';

const ICON_RAIL_WIDTH = 56;

interface RailButtonProps {
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  active?: boolean;
  onClick: () => void;
}

/** 클러스터 사이드바(ClusterSidebar)의 아이콘 레일 버튼과 동일 패턴 — 호버 시 우측 포털 툴팁. */
function RailButton({ label, Icon, active, onClick }: RailButtonProps) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const show = () => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.top + r.height / 2, left: r.right + 8 });
  };
  const hide = () => setPos(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        onClick={onClick}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        className={`relative flex items-center justify-center w-10 h-10 rounded-md transition-colors ${
          active ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
        }`}
      >
        {active && <span aria-hidden className="absolute left-0 top-1.5 -translate-x-[3px] w-1 h-7 bg-primary rounded-r" />}
        <Icon className="w-5 h-5" />
      </button>
      {pos && createPortal(
        <span
          role="tooltip"
          style={{ top: pos.top, left: pos.left, transform: 'translateY(-50%)' }}
          className="fixed px-2 py-1 text-sm font-medium whitespace-nowrap bg-zinc-700 text-white rounded shadow-lg pointer-events-none z-[60]"
        >
          {label}
        </span>,
        document.body,
      )}
    </>
  );
}

interface ServiceSidebarProps {
  services: ServiceDef[];
  /** 선택된 서비스 key — null 이면 전체. */
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  allLabel?: string;
}

/**
 * 서비스 선택 아이콘 레일 — Settings→서비스 목록(useServiceCatalog)을 메인 사이드바 옆에
 * k8s 클러스터 사이드바와 같은 형태(아이콘 전용 56px 레일)로 표시. 지식 허브 등에서 서비스 필터.
 */
export function ServiceSidebar({ services, selectedKey, onSelect, allLabel = '전체' }: ServiceSidebarProps) {
  const list = services.filter((s) => s.key !== 'other');
  return (
    <aside
      style={{ width: ICON_RAIL_WIDTH }}
      className="flex-shrink-0 bg-card border border-border rounded-xl py-2 h-fit sticky top-4"
    >
      <div className="flex flex-col items-center gap-1">
        <RailButton
          label={`${allLabel} (${list.length})`}
          Icon={LayoutGrid as LucideIcon}
          active={selectedKey === null}
          onClick={() => onSelect(null)}
        />
        {list.map((s) => (
          <RailButton
            key={s.key}
            label={s.label}
            Icon={s.icon}
            active={selectedKey === s.key}
            onClick={() => onSelect(selectedKey === s.key ? null : s.key)}
          />
        ))}
      </div>
    </aside>
  );
}
