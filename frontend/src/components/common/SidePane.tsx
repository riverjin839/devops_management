import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ResizeHandle } from './ResizeHandle';

interface SidePaneProps {
  open: boolean;
  onClose: () => void;
  /** 헤더에 표시될 타이틀 — 패널 폭의 60% 까지 truncate. */
  title?: ReactNode;
  /** 헤더 우측에 추가 액션(예: 편집 토글, 메뉴 등). 닫기 버튼 옆. */
  headerActions?: ReactNode;
  /** 본문. 스크롤은 본문 영역에서 발생. */
  children: ReactNode;
  /** 본문 패딩. 기본 `p-5`. */
  bodyClassName?: string;
  /** 패널 폭. 기본 `70%`. CSS 길이값 그대로 받음 (예: `'60%'`, `'960px'`).
   *  `resizable` 이 true 면 초기 폭으로만 쓰이고(px 파싱), 이후 사용자가 드래그한 값이 우선한다. */
  width?: string;
  /** 푸터 (선택). 저장/취소 등 sticky 액션용. */
  footer?: ReactNode;
  /** ESC 키 닫힘 비활성화 (예: 폼 입력 중 안전 가드). 기본 false. */
  disableEscape?: boolean;
  /** 백드롭 클릭 닫힘 비활성화 (예: 미저장 변경 보호). 기본 false. */
  disableBackdropClose?: boolean;
  /** 왼쪽 가장자리 드래그로 폭 조절 가능하게. 기본 false. */
  resizable?: boolean;
  /** resizable 일 때 드래그한 폭을 저장할 localStorage 키. 생략하면 새로고침 시 초기화. */
  widthStorageKey?: string;
  /** resizable 폭 최소/최대(px). 기본 360~1200. */
  minWidth?: number;
  maxWidth?: number;
}

function parseWidthPx(w: string | undefined, fallback: number): number {
  const n = parseInt(w ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 우측 슬라이드 인 디테일 패널. 모달의 대체.
 *
 * - `open=true` 일 때 우측에서 슬라이드 인.
 * - 좌측에 백드롭 — 클릭 시 닫힘 (disableBackdropClose 로 끌 수 있음).
 * - ESC 닫힘 — disableEscape 로 끌 수 있음.
 * - 본문 영역만 스크롤. 헤더/푸터는 sticky.
 *
 * 모바일에서는 폭 무시하고 `min(100vw, width)` 로 풀폭 폴백 — 좁은 화면에선 사실상 풀페이지.
 */
const RESIZE_MIN_DEFAULT = 360;
const RESIZE_MAX_DEFAULT = 1200;

export function SidePane({
  open,
  onClose,
  title,
  headerActions,
  children,
  bodyClassName = 'p-5',
  width = '70%',
  footer,
  disableEscape = false,
  disableBackdropClose = false,
  resizable = false,
  widthStorageKey,
  minWidth = RESIZE_MIN_DEFAULT,
  maxWidth = RESIZE_MAX_DEFAULT,
}: SidePaneProps) {
  useEffect(() => {
    if (!open || disableEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, disableEscape, onClose]);

  // 드래그 폭 — resizable 일 때만 사용. 초기값은 width prop(px 파싱) → localStorage 순.
  const initialPx = parseWidthPx(width, 480);
  const [dragWidth, setDragWidth] = useState<number>(() => {
    if (!resizable) return initialPx;
    if (widthStorageKey) {
      try {
        const v = localStorage.getItem(widthStorageKey);
        const n = v ? parseInt(v, 10) : NaN;
        if (Number.isFinite(n)) return Math.max(minWidth, Math.min(maxWidth, n));
      } catch { /* ignore */ }
    }
    return initialPx;
  });

  const handleResize = (next: number) => {
    const clamped = Math.max(minWidth, Math.min(maxWidth, Math.round(next)));
    setDragWidth(clamped);
    if (widthStorageKey) {
      try { localStorage.setItem(widthStorageKey, String(clamped)); } catch { /* ignore */ }
    }
  };
  const handleResetWidth = () => {
    setDragWidth(initialPx);
    if (widthStorageKey) {
      try { localStorage.setItem(widthStorageKey, String(initialPx)); } catch { /* ignore */ }
    }
  };

  const effectiveWidth = resizable ? `${dragWidth}px` : width;

  return (
    <>
      {/* 백드롭 — 패널이 열렸을 때만 마운트. 페이드 인. */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px] animate-in fade-in duration-200"
          onClick={disableBackdropClose ? undefined : onClose}
          aria-hidden
        />
      )}
      {/* 패널 본체 — 항상 마운트해 슬라이드 transition 가 살아남음. */}
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        style={{ width: `min(100vw, ${effectiveWidth})` }}
        className={`fixed top-0 right-0 h-full bg-card border-l border-border shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-out relative ${
          open ? 'translate-x-0' : 'translate-x-full pointer-events-none'
        }`}
      >
        {resizable && open && (
          <ResizeHandle width={dragWidth} onResize={handleResize} onReset={handleResetWidth} side="left" />
        )}
        {(title || headerActions) && (
          <header className="flex items-center gap-2 px-5 py-3 border-b border-border flex-shrink-0">
            <div className="flex-1 min-w-0">
              {typeof title === 'string'
                ? <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
                : title}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {headerActions}
              <button
                type="button"
                onClick={onClose}
                aria-label="닫기"
                className="p-1.5 rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </header>
        )}
        <div className={`flex-1 overflow-y-auto ${bodyClassName}`}>{children}</div>
        {footer && (
          <footer className="border-t border-border flex-shrink-0 px-5 py-3 bg-card">
            {footer}
          </footer>
        )}
      </aside>
    </>
  );
}
