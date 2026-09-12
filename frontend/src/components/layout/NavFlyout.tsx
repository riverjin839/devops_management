import { useEffect, useRef, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { Check, ChevronRight, Star, X } from 'lucide-react';
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
  /** D-080 — 클릭/키보드로 열었을 때 true: 첫 메뉴 항목으로 포커스를 옮기고, 닫힐 때
   *  `returnFocusTo`(보통 트리거 버튼)로 되돌린다. hover 로 열린 flyout 은 포커스를 건드리지
   *  않는다(마우스 사용자의 포커스가 뜬금없이 튀지 않게). */
  autoFocus?: boolean;
  returnFocusTo?: HTMLElement | null;
}

const MENU_ITEM_SELECTOR = '[role="menuitem"]:not([disabled]),[role="menuitemradio"]:not([disabled])';

export function FlyoutShell({
  title, anchorRect, placement = 'right', children, onClose, onMouseEnter, onMouseLeave,
  autoFocus = false, returnFocusTo = null,
}: FlyoutProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 최신 콜백/트리거를 effect 재실행 없이 참조 — flyout 은 열려 있는 동안 anchor 가 바뀌지 않는다.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnRef = useRef(returnFocusTo);
  returnRef.current = returnFocusTo;

  // D-080 — 열릴 때 첫 항목 포커스(클릭/키보드 열기만), 닫힐 때 트리거로 복귀.
  // portal 이 document.body 끝에 붙어 Tab 순서로는 레일 버튼에서 도달할 수 없으므로,
  // 포커스를 프로그램적으로 넣고 빼는 것이 키보드 사용자에게 유일한 진입로다.
  useEffect(() => {
    if (!autoFocus) return;
    const container = ref.current;
    const first = container?.querySelector<HTMLElement>(MENU_ITEM_SELECTOR);
    (first ?? container)?.focus();
    return () => {
      const back = returnRef.current;
      if (back && document.contains(back)) back.focus();
    };
  }, [autoFocus]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const container = ref.current;
    if (!container) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current();
      return;
    }
    const items = Array.from(container.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = items.findIndex((el) => el === active || el.contains(active));
    const focusAt = (i: number) => { e.preventDefault(); items[(i + items.length) % items.length].focus(); };
    switch (e.key) {
      case 'ArrowDown': focusAt(idx + 1); break;
      case 'ArrowUp': focusAt(idx - 1); break;
      case 'Home': focusAt(0); break;
      case 'End': focusAt(items.length - 1); break;
      case 'Tab': {
        // 메뉴 안에서만 순환 — portal 뒤(body 끝)로 새어 나가면 돌아올 길이 없다.
        const focusables = Array.from(
          container.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'),
        );
        if (focusables.length === 0) break;
        const cur = focusables.findIndex((el) => el === active);
        const next = e.shiftKey ? (cur <= 0 ? focusables.length - 1 : cur - 1) : (cur >= focusables.length - 1 ? 0 : cur + 1);
        e.preventDefault();
        focusables[next].focus();
        break;
      }
      default: break;
    }
  };

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
      ref={ref}
      style={style}
      tabIndex={-1}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onKeyDown={handleKeyDown}
      className="fixed z-50 bg-popover text-popover-foreground border border-border rounded-md shadow-xl flex flex-col overflow-hidden min-w-[180px] max-w-[260px] outline-none"
      role="menu"
      aria-label={title}
    >
      <div className="px-3 py-1.5 border-b border-border flex items-center justify-between bg-muted/40">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider truncate">{title}</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="닫기"
          className="p-0.5 rounded text-muted-foreground hover:bg-secondary hover:text-foreground"
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
const FLYOUT_LINK_INACTIVE = 'text-foreground hover:bg-secondary';
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
        role="menuitem"
        aria-current={active ? 'page' : undefined}
        onClick={onSelect}
        className={`${FLYOUT_LINK_BASE} ${active ? FLYOUT_LINK_ACTIVE : FLYOUT_LINK_INACTIVE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}
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
              ? 'text-status-warning opacity-100'
              : 'text-muted-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-status-warning'
          }`}
        >
          <Star className="w-3.5 h-3.5" fill={isPinned ? 'currentColor' : 'none'} />
        </button>
      )}
    </div>
  );
}

/**
 * 라우팅이 아닌 동작(테마 선택 / 패널 열기 / 로그아웃 등)을 flyout 한 줄로 그린다 — FlyoutLink 와
 * 같은 스타일·키보드 규약(role=menuitem). `checked` 를 주면 우측에 체크 표시(라디오 성격).
 */
export function FlyoutAction({
  label, Icon, onSelect, checked, trailing, tone = 'default', disabled, title,
}: {
  label: string;
  Icon: ComponentType<{ className?: string }>;
  onSelect: () => void;
  checked?: boolean;
  /** 우측 보조 표시 — 단축키 힌트 등. `checked` 와 함께 주면 체크가 우선. */
  trailing?: React.ReactNode;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  title?: string;
}) {
  return (
    <div className="flex items-center mx-1">
      <button
        type="button"
        role={checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={checked === undefined ? undefined : checked}
        onClick={onSelect}
        disabled={disabled}
        title={title}
        className={`${FLYOUT_LINK_BASE} text-left disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
          checked ? FLYOUT_LINK_ACTIVE : tone === 'danger' ? 'text-destructive hover:bg-destructive/10' : FLYOUT_LINK_INACTIVE
        }`}
      >
        <Icon className="w-4 h-4 flex-shrink-0" />
        <span className="flex-1 min-w-0 break-keep">{label}</span>
        {checked ? (
          <Check className="w-3.5 h-3.5 flex-shrink-0 text-primary" aria-hidden="true" />
        ) : trailing}
      </button>
    </div>
  );
}
