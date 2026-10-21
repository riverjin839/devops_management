import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components/common/EmptyState';
import { useNodeList } from '@/hooks/useNodeLabels';

interface Props {
  clusterId: string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  max?: number;            // 선택 상한 (과수집 방지). 도달 시 추가 비활성.
}

const PANEL_W = 260;      // 패널 폭(px) — 클래스 `w-[260px]` 와 같은 값(화면 밖으로 안 나가게 위치 계산에 쓴다).

/** 노드 멀티셀렉트 드롭다운 (NamespaceMultiSelect 패턴). 상한(max) 도달 시 미선택 항목 비활성.
 *  패널은 createPortal 로 body 에 fixed 렌더 — 부모 overflow-hidden 에 잘리지 않음.
 *
 *  D-189: 검색 입력이 combobox, 목록이 `listbox`(aria-multiselectable). 포커스는 입력에 두고
 *  ↑↓·Home·End 로 활성 항목을 옮기고 Enter 로 선택/해제, Esc 로 닫고 트리거로 포커스를 돌려준다.
 *  패널 밖으로 포커스가 나가면 닫는다.
 *  D-184 ⑥ / D-188: 노드 목록 조회 실패는 "결과 없음"이 아니라 `ErrorState compact` + 다시 시도.
 *  클러스터를 바꾸면 이전 클러스터 목록(keepPreviousData)을 보여주지 않고 불러오는 중으로 둔다.
 *  패널·검색어 초기화는 호출 측이 `key={clusterId}` 로 다시 마운트해 처리한다. */
export function NodeMultiSelect({ clusterId, selected, onChange, max }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const inputId = `${uid}-q`;
  const optId = (i: number) => `${uid}-opt-${i}`;

  const nodesQ = useNodeList(clusterId);
  // 다른 클러스터의 목록이 자리표시로 남아 있으면 쓰지 않는다.
  const stale = nodesQ.isPlaceholderData;
  const names = useMemo(
    () => (stale ? [] : (nodesQ.data ?? []).map((n) => n.name).sort()),
    [nodesQ.data, stale],
  );
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? names.filter((n) => n.toLowerCase().includes(s)) : names;
  }, [names, q]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - PANEL_W - 8);
    const top = r.bottom + 4;
    setPos({ top, left: Math.max(8, left), maxHeight: window.innerHeight - top - 12 });
  }, [open]);

  // 활성 항목이 보이도록 스크롤.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector(`#${CSS.escape(`${uid}-opt-${active}`)}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, uid]);

  const atCap = max != null && selected.size >= max;
  const activeIdx = shown.length === 0 ? -1 : Math.min(active, shown.length - 1);

  const toggle = (node: string) => {
    const next = new Set(selected);
    if (next.has(node)) next.delete(node);
    else {
      if (atCap) return;       // 상한 도달 → 추가 불가
      next.add(node);
    }
    onChange(next);
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((a) => Math.min(last, a + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(Math.max(0, last));
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIdx >= 0) toggle(shown[activeIdx]);
        break;
      default:
        break;
    }
  };

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  const label =
    selected.size === 0 ? '노드 선택' : `${selected.size}개 노드${max ? ` / 최대 ${max}` : ''}`;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary/60 whitespace-nowrap"
      >
        {label} <ChevronDown className="w-3.5 h-3.5" aria-hidden />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => close(false)} aria-hidden />
          <div
            ref={panelRef}
            onKeyDown={onPanelKey}
            onBlur={(e) => {
              const to = e.relatedTarget as Node | null;
              if (to && (panelRef.current?.contains(to) || btnRef.current?.contains(to))) return;
              if (to) setOpen(false);
            }}
            // 위치는 트리거 좌표에서 계산되는 동적 값이라 style 로 둔다(폭은 클래스).
            style={{ top: pos.top, left: pos.left, maxHeight: pos.maxHeight }}
            className="fixed z-[61] w-[260px] rounded-md border border-border bg-popover text-popover-foreground shadow-lg py-1 flex flex-col"
          >
            <div className="px-2 pb-1">
              <label htmlFor={inputId} className="sr-only">노드 검색</label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" aria-hidden />
                <input
                  id={inputId}
                  value={q}
                  onChange={(e) => { setQ(e.target.value); setActive(0); }}
                  onKeyDown={onInputKey}
                  placeholder="노드 검색"
                  autoFocus
                  role="combobox"
                  aria-expanded
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeIdx >= 0 ? optId(activeIdx) : undefined}
                  className="w-full rounded-xl border border-border bg-background pl-7 pr-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
            {atCap && (
              <div className="px-3 py-1 text-xs text-status-warning" role="status">
                최대 {max}개까지 선택 가능 (과수집 방지)
              </div>
            )}
            <div className="overflow-auto">
              {selected.size > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => onChange(new Set())}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary/60"
                  >
                    <span className="w-3.5 h-3.5" aria-hidden />선택 해제
                  </button>
                  <div className="my-1 border-t border-border" />
                </>
              )}
              {nodesQ.isError && !nodesQ.data ? (
                <ErrorState
                  compact
                  error={nodesQ.error}
                  title="노드 목록을 불러오지 못했습니다"
                  onRetry={() => { void nodesQ.refetch(); }}
                />
              ) : nodesQ.isLoading || stale ? (
                <LoadingState compact />
              ) : (
                <ul
                  ref={listRef}
                  id={listId}
                  role="listbox"
                  aria-multiselectable="true"
                  aria-label="노드"
                >
                  {shown.map((node, i) => {
                    const on = selected.has(node);
                    const disabled = !on && atCap;
                    return (
                      <li
                        key={node}
                        id={optId(i)}
                        role="option"
                        aria-selected={on}
                        aria-disabled={disabled || undefined}
                        // 포커스는 검색 입력에 남긴다(aria-activedescendant 패턴).
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => { setActive(i); if (!disabled) toggle(node); }}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer ${
                          i === activeIdx ? 'bg-secondary' : ''
                        } ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-secondary/60'}`}
                      >
                        <span className={`w-3.5 h-3.5 flex items-center justify-center ${on ? 'text-primary' : 'text-transparent'}`} aria-hidden>
                          <Check className="w-3 h-3" />
                        </span>
                        <span className="truncate">{node}</span>
                      </li>
                    );
                  })}
                  {shown.length === 0 && (
                    <li role="presentation" className="px-3 py-2 text-sm text-muted-foreground">
                      {names.length === 0 ? '노드가 없습니다' : '검색 결과가 없습니다'}
                    </li>
                  )}
                </ul>
              )}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
