import type { ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { ChevronRight, Star, X } from 'lucide-react';
import { NAV_WIDTH } from '@/stores/sidebarStore';

/**
 * 그룹 하위 메뉴 popover — 사이드바(우측 anchor)와 상단바(하단 anchor)가 공유한다.
 * `placement='right'`(기본, 사이드바)는 아이콘 우측에 고정폭으로 붙고,
 * `placement='bottom'`(상단바)은 클릭한 버튼 바로 아래 좌측 정렬로 뜬다.
 */
interface FlyoutProps {
  title: string;
  /** 앵커 아이콘/버튼의 viewport 좌표. */
  anchorRect: DOMRect;
  placement?: 'right' | 'bottom';
  children: React.ReactNode;
  onClose: () => void;
  /** 호버로 연 flyout 을 유지하기 위한 hover-intent 콜백 — 패널 위로 마우스가 들어오면
   *  예약된 닫기를 취소하고(onMouseEnter), 패널을 벗어나면 다시 닫기를 예약한다(onMouseLeave).
   *  클릭으로 연 flyout(호버 콜백 미전달)에는 영향 없다. */
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

export function FlyoutShell({ title, anchorRect, placement = 'right', children, onClose, onMouseEnter, onMouseLeave }: FlyoutProps) {
  const style = placement === 'bottom'
    ? {
        top: anchorRect.bottom + 6,
        left: Math.min(anchorRect.left, window.innerWidth - 280),
        maxHeight: window.innerHeight - (anchorRect.bottom + 6) - 8,
      }
    : {
        // popover top 은 아이콘의 top 에 맞추되, 화면 아래로 넘치면 위로 끌어올림.
        top: Math.min(anchorRect.top, window.innerHeight - 100),
        left: NAV_WIDTH,
        maxHeight: window.innerHeight - Math.min(anchorRect.top, window.innerHeight - 100) - 8,
      };

  return createPortal(
    <div
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="fixed z-50 bg-white text-black border border-zinc-200 rounded-md shadow-xl flex flex-col overflow-hidden min-w-[180px] max-w-[260px]"
      role="dialog"
      aria-label={title}
    >
      <div className="px-3 py-1.5 border-b border-zinc-200 flex items-center justify-between bg-zinc-50">
        <span className="text-xs font-semibold text-zinc-700 uppercase tracking-wider truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="p-0.5 rounded text-zinc-400 hover:bg-zinc-200 hover:text-zinc-900"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
      <div className="overflow-y-auto py-1">{children}</div>
    </div>,
    document.body,
  );
}

// flyout 내부에서 항목 한 줄을 그릴 때 쓰는 공통 스타일.
const FLYOUT_LINK_BASE = 'flex-1 min-w-0 flex items-center gap-2 px-2.5 py-1.5 rounded text-[13px] transition-colors';
const FLYOUT_LINK_INACTIVE = 'text-black hover:bg-zinc-100';
const FLYOUT_LINK_ACTIVE = 'bg-primary/10 text-primary font-semibold';

export function FlyoutLink({
  to, label, Icon, active, onSelect, iconColor, iconSize, isPinned, onTogglePin,
}: {
  to: string;
  label: string;
  Icon: ComponentType<{ className?: string }>;
  active: boolean;
  onSelect: () => void;
  iconColor?: string;
  iconSize?: string;
  /** 즐겨찾기 여부 — 지정하면 hover 시(또는 이미 즐겨찾기면 항상) 별 토글 버튼이 함께 뜬다. */
  isPinned?: boolean;
  onTogglePin?: () => void;
}) {
  return (
    <div className="group flex items-center mx-1">
      <Link
        to={to}
        onClick={onSelect}
        className={`${FLYOUT_LINK_BASE} ${active ? FLYOUT_LINK_ACTIVE : FLYOUT_LINK_INACTIVE}`}
      >
        <Icon className={`${iconSize || 'w-4 h-4'} flex-shrink-0 ${iconColor || ''}`} />
        <span className="flex-1 min-w-0 break-keep">{label}</span>
        {active && <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 text-primary" />}
      </Link>
      {onTogglePin && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(); }}
          aria-label={isPinned ? `${label} 즐겨찾기 해제` : `${label} 즐겨찾기 추가`}
          title={isPinned ? '즐겨찾기 해제' : '즐겨찾기 추가'}
          className={`flex-shrink-0 ml-0.5 p-1 rounded transition-opacity ${
            isPinned
              ? 'text-amber-500 opacity-100'
              : 'text-zinc-400 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-amber-500'
          }`}
        >
          <Star className="w-3.5 h-3.5" fill={isPinned ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );
}
