import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';

interface SearchableSelectProps<T> {
  value: string;
  onChange: (key: string) => void;
  options: T[];
  getKey: (o: T) => string;
  getLabel: (o: T) => string;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
  clearable?: boolean;
  className?: string;
  id?: string;
  /**
   * 드롭다운을 document.body 로 portal 렌더(fixed 포지셔닝)한다.
   * 부모가 `overflow-hidden`(예: 짧은 MacCard 툴바)이라 inline absolute 드롭다운이
   * 잘리는 경우 켠다. 기본 false — 기존 소비처 동작 유지.
   */
  menuPortal?: boolean;
}

/** 단일 선택 검색 가능 콤보박스.
 *
 *  - Input 클릭/focus 시 dropdown 열림
 *  - 타이핑 → label 에 대해 case-insensitive includes 필터
 *  - ↑/↓ navigate, Enter 선택, Esc 닫기
 *  - IME 조합 중 Enter 는 무시 (한글 입력 안전)
 *  - max-h-72 + overflow-auto, 가상 스크롤 없음
 */
export function SearchableSelect<T>({
  value,
  onChange,
  options,
  getKey,
  getLabel,
  placeholder = '검색...',
  disabled = false,
  loading = false,
  emptyText = '항목 없음',
  clearable = true,
  className = '',
  id,
  menuPortal = false,
}: SearchableSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [composing, setComposing] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = useMemo(
    () => options.find((o) => getKey(o) === value),
    [options, value, getKey],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return options;
    const q = query.toLowerCase();
    return options.filter((o) => getLabel(o).toLowerCase().includes(q));
  }, [options, query, getLabel]);

  // open 상태 변화 시 highlight 초기화
  useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  // click outside → 닫기 (portal 리스트도 "내부"로 취급)
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
      setQuery('');
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // portal 모드: 열릴 때 input 위치를 측정해 fixed 앵커링(스크롤/리사이즈 추적)
  useEffect(() => {
    if (!open || !menuPortal) { setMenuPos(null); return; }
    const update = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open, menuPortal]);

  // highlight 변경 시 항목이 보이게 스크롤
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[highlight] as HTMLElement | undefined;
    if (el) el.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const select = (opt: T) => {
    onChange(getKey(opt));
    setOpen(false);
    setQuery('');
  };

  const clear = () => {
    onChange('');
    setQuery('');
    inputRef.current?.focus();
  };

  const display = open ? query : (selected ? getLabel(selected) : '');

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
        <input
          ref={inputRef}
          id={id}
          type="text"
          value={display}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          onFocus={() => !disabled && setOpen(true)}
          onClick={() => !disabled && setOpen(true)}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(e) => {
            if (composing) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setHighlight((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (open && filtered[highlight]) select(filtered[highlight]);
            } else if (e.key === 'Escape') {
              setOpen(false);
              setQuery('');
              inputRef.current?.blur();
            } else if (e.key === 'Tab') {
              setOpen(false);
              setQuery('');
            }
          }}
          className="w-full pl-8 pr-16 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-60 disabled:cursor-not-allowed"
        />
        <div className="absolute right-1.5 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
          {clearable && value && !disabled && (
            <button
              type="button"
              onClick={clear}
              aria-label="선택 지우기"
              className="p-1 text-muted-foreground hover:text-foreground rounded"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
          <ChevronDown
            className={`w-4 h-4 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </div>
      </div>

      {open && !disabled && (() => {
        const list = (
          <ul
            ref={listRef}
            role="listbox"
            style={menuPortal && menuPos ? { position: 'fixed', top: menuPos.top, left: menuPos.left, width: menuPos.width } : undefined}
            className={`${menuPortal ? 'z-50' : 'absolute z-30 mt-1 w-full'} max-h-72 overflow-auto rounded-lg border border-border bg-card shadow-lg py-1`}
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted-foreground italic">
                {options.length === 0 ? emptyText : '검색 결과 없음'}
              </li>
            ) : (
              filtered.map((opt, i) => {
                const key = getKey(opt);
                const isSelected = key === value;
                const isHighlighted = i === highlight;
                return (
                  <li
                    key={key}
                    role="option"
                    aria-selected={isSelected}
                    onMouseDown={(e) => { e.preventDefault(); select(opt); }}
                    onMouseEnter={() => setHighlight(i)}
                    className={`px-3 py-1.5 text-sm cursor-pointer truncate
                      ${isHighlighted ? 'bg-primary/10 text-foreground' : 'text-foreground'}
                      ${isSelected ? 'font-medium' : ''}
                    `}
                  >
                    {getLabel(opt)}
                  </li>
                );
              })
            )}
          </ul>
        );
        return menuPortal ? (menuPos ? createPortal(list, document.body) : null) : list;
      })()}
    </div>
  );
}
