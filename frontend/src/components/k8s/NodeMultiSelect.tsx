import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';
import { useNodeList } from '@/hooks/useNodeLabels';

interface Props {
  clusterId: string;
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  max?: number;            // 선택 상한 (과수집 방지). 도달 시 추가 비활성.
}

const PANEL_W = 260;

/** 노드 멀티셀렉트 드롭다운 (NamespaceMultiSelect 패턴). 상한(max) 도달 시 미선택 항목 비활성.
 *  패널은 createPortal 로 body 에 fixed 렌더 — 부모 overflow-hidden 에 잘리지 않음. */
export function NodeMultiSelect({ clusterId, selected, onChange, max }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const { data: nodes = [] } = useNodeList(clusterId);
  const names = useMemo(() => nodes.map((n) => n.name).sort(), [nodes]);
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

  const atCap = max != null && selected.size >= max;

  const toggle = (node: string) => {
    const next = new Set(selected);
    if (next.has(node)) next.delete(node);
    else {
      if (atCap) return;       // 상한 도달 → 추가 불가
      next.add(node);
    }
    onChange(next);
  };

  const label =
    selected.size === 0 ? '노드 선택' : `${selected.size}개 노드${max ? ` / 최대 ${max}` : ''}`;

  return (
    <>
      <button ref={btnRef} onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-secondary/60 whitespace-nowrap">
        {label} <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && pos && createPortal(
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} aria-hidden />
          <div
            style={{ top: pos.top, left: pos.left, width: PANEL_W, maxHeight: pos.maxHeight }}
            className="fixed z-[61] rounded-xl border border-border bg-card shadow-lg py-1 flex flex-col"
          >
            <div className="px-2 pb-1">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="노드 검색" autoFocus
                  className="w-full rounded-lg border border-border bg-background pl-7 pr-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
            </div>
            {atCap && (
              <div className="px-3 py-1 text-xs text-amber-600">
                최대 {max}개까지 선택 가능 (과수집 방지)
              </div>
            )}
            <div className="overflow-auto">
              {selected.size > 0 && (
                <>
                  <button onClick={() => onChange(new Set())}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm text-muted-foreground hover:bg-secondary/60">
                    <span className="w-3.5 h-3.5" />선택 해제
                  </button>
                  <div className="my-1 border-t border-border" />
                </>
              )}
              {shown.map((node) => {
                const on = selected.has(node);
                const disabled = !on && atCap;
                return (
                  <button key={node} onClick={() => toggle(node)} disabled={disabled}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-secondary/60'}`}>
                    <span className={`w-3.5 h-3.5 flex items-center justify-center ${on ? 'text-primary' : 'text-transparent'}`}><Check className="w-3 h-3" /></span>
                    <span className="truncate">{node}</span>
                  </button>
                );
              })}
              {shown.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">결과 없음</div>}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
