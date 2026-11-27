import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Pencil, Star } from 'lucide-react';
import { favoriteIsDanger } from './favoriteDanger';
import type { SshFavorite } from '@/types';

/** 즐겨찾기 1건을 누른 방법 — `insertOnly` 면 저장된 동작과 무관하게 입력만 한다(Ctrl/⌘+클릭). */
export interface FavoritePick {
  fav: SshFavorite;
  insertOnly: boolean;
}

interface MenuProps {
  favorites: SshFavorite[];
  loading: boolean;
  onPick: (p: FavoritePick) => void;
  onEdit: () => void;
  broadcast: boolean;
  onBroadcastChange: (v: boolean) => void;
  /** 이 창이 열려 있지 않으면(연결 전·끊김) 보낼 수 없다. */
  disabled?: boolean;
}

const MENU_W = 320;

/**
 * 터미널 헤더의 ★ 즐겨찾기 메뉴. 창 칸이 `overflow-hidden` 이라 메뉴는 body 로 포털해 고정 좌표로 띄운다
 * (좌표만 동적 — `SshTerminalWindow` 드래그 창과 같은 예외).
 */
export function SshFavoritesMenu({ favorites, loading, onPick, onEdit, broadcast, onBroadcastChange, disabled }: MenuProps) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const top = r.bottom + 4;
    setPos({
      top,
      left: Math.max(8, Math.min(r.right - MENU_W, window.innerWidth - MENU_W - 8)),
      maxHeight: Math.max(200, window.innerHeight - top - 8),
    });
  };
  const pick = (fav: SshFavorite, e: React.MouseEvent) => {
    onPick({ fav, insertOnly: e.ctrlKey || e.metaKey });
    setPos(null);
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        title="즐겨찾기 명령"
        aria-label="즐겨찾기 명령"
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${pos ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-700'}`}
      >
        <Star className="w-3.5 h-3.5" aria-hidden="true" /> 즐겨찾기 <ChevronDown className="w-3 h-3" aria-hidden="true" />
      </button>
      {pos && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPos(null)} aria-hidden />
          <div
            role="menu"
            aria-label="즐겨찾기 명령"
            tabIndex={-1}
            onKeyDown={(e) => { if (e.key === 'Escape') { setPos(null); btnRef.current?.focus(); } }}
            className="fixed z-50 w-80 overflow-y-auto bg-popover text-popover-foreground border border-border rounded-md shadow-lg p-1.5 flex flex-col gap-0.5"
            style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
          >
            <p className="px-2 py-1 text-xs text-muted-foreground">
              클릭 = 저장된 동작(입력만·바로 실행) · Ctrl/⌘+클릭 = 입력만
              {disabled ? ' — 이 창은 연결돼 있지 않습니다' : ''}
            </p>
            {loading && <p className="px-2 py-1.5 text-sm text-muted-foreground">불러오는 중…</p>}
            {!loading && favorites.length === 0 && (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">즐겨찾기가 없습니다 — 아래 「추가·편집」에서 만드세요.</p>
            )}
            {favorites.map((f, i) => {
              const danger = favoriteIsDanger(f);
              return (
                <button
                  key={f.id}
                  type="button"
                  role="menuitem"
                  autoFocus={i === 0}
                  disabled={disabled}
                  onClick={(e) => pick(f, e)}
                  title={f.command}
                  className="w-full text-left px-2 py-1.5 rounded-md hover:bg-secondary focus:bg-secondary focus:outline-none disabled:opacity-50 flex flex-col"
                >
                  <span className="flex items-center gap-1.5 text-sm text-foreground">
                    <span className="truncate">{f.name}</span>
                    {danger && <span className="text-xs px-1.5 rounded-full bg-status-critical/10 text-status-critical border border-status-critical/30 shrink-0">변경 명령</span>}
                    <span className="ml-auto text-xs text-muted-foreground shrink-0">{f.runMode === 'run' ? '바로 실행' : '입력만'}</span>
                  </span>
                  {f.description && <span className="text-xs text-muted-foreground truncate">{f.description}</span>}
                </button>
              );
            })}
            <div className="border-t border-border mt-1 pt-1 flex flex-col gap-0.5">
              <button
                type="button"
                role="menuitem"
                onClick={() => { setPos(null); onEdit(); }}
                className="w-full text-left px-2 py-1.5 rounded-md hover:bg-secondary focus:bg-secondary focus:outline-none text-sm font-medium text-primary flex items-center gap-1.5"
              >
                <Pencil className="w-3.5 h-3.5" aria-hidden="true" /> 추가·편집…
              </button>
              <label className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={broadcast} onChange={(e) => onBroadcastChange(e.target.checked)} />
                지금 보이는 모든 분할 창에 동시에 보내기
              </label>
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

interface ChipsProps {
  favorites: SshFavorite[];
  onPick: (p: FavoritePick) => void;
  disabled?: boolean;
  /** 칩으로 보일 개수 — 나머지는 ★ 메뉴에. */
  max?: number;
}

/** 터미널 헤더 아래 칩 바 — 앞쪽 즐겨찾기 몇 개를 한 번에 누를 수 있게. */
export function SshFavoritesChips({ favorites, onPick, disabled, max = 5 }: ChipsProps) {
  if (favorites.length === 0) return null;
  const shown = favorites.slice(0, max);
  const rest = favorites.length - shown.length;
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 border-b border-zinc-700 overflow-x-auto" role="toolbar" aria-label="즐겨찾기 명령">
      {shown.map((f) => (
        <button
          key={f.id}
          type="button"
          disabled={disabled}
          onClick={(e) => onPick({ fav: f, insertOnly: e.ctrlKey || e.metaKey })}
          title={`${f.command}\n(${f.runMode === 'run' ? '바로 실행' : '입력만'} · Ctrl/⌘+클릭 = 입력만)`}
          className="shrink-0 text-xs px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-200 hover:bg-zinc-600 disabled:opacity-50 max-w-[180px] truncate"
        >
          {f.name}
        </button>
      ))}
      {rest > 0 && <span className="shrink-0 text-xs text-zinc-500">+{rest}개 더 — ★ 메뉴</span>}
    </div>
  );
}
