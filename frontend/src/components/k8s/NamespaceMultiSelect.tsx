import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Check, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { k8sResourcesApi } from '@/services/api';

interface Props {
  clusterId: string;
  selected: Set<string>;            // 비어있으면 전체
  onChange: (next: Set<string>) => void;
}

const PANEL_W = 240;

/** OpenLens 식 네임스페이스 멀티셀렉트 드롭다운. 빈 선택 = 전체. 여러 리소스 뷰에서 공용.
 *  패널은 createPortal 로 body 에 fixed 렌더 — 부모 MacCard 의 overflow-hidden 에 잘리지 않음. */
export function NamespaceMultiSelect({ clusterId, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const { data } = useQuery({
    queryKey: ['k8s-namespaces', clusterId],
    queryFn: async () => (await k8sResourcesApi.list(clusterId, 'namespaces')).data,
    enabled: !!clusterId,
    staleTime: 60_000,
    retry: false,
  });
  const namespaces = useMemo(() => (data?.items ?? []).map((r) => r.name).sort(), [data]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? namespaces.filter((n) => n.toLowerCase().includes(s)) : namespaces;
  }, [namespaces, q]);

  // 열릴 때 버튼 위치 기준으로 패널 좌표 계산(viewport clamp).
  useLayoutEffect(() => {
    if (!open) return;
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - PANEL_W - 8);
    const top = r.bottom + 4;
    setPos({ top, left: Math.max(8, left), maxHeight: window.innerHeight - top - 12 });
  }, [open]);

  const toggle = (ns: string) => {
    const next = new Set(selected);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    onChange(next);
  };

  const label = selected.size === 0 ? '전체 네임스페이스' : `${selected.size}개 네임스페이스`;

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
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="네임스페이스 검색" autoFocus
                  className="w-full rounded-lg border border-border bg-background pl-7 pr-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
            </div>
            <div className="overflow-auto">
              <button onClick={() => onChange(new Set())}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary/60">
                <span className={`w-3.5 h-3.5 flex items-center justify-center ${selected.size === 0 ? 'text-primary' : 'text-transparent'}`}><Check className="w-3 h-3" /></span>
                전체 네임스페이스
              </button>
              <div className="my-1 border-t border-border" />
              {shown.map((ns) => (
                <button key={ns} onClick={() => toggle(ns)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-secondary/60">
                  <span className={`w-3.5 h-3.5 flex items-center justify-center ${selected.has(ns) ? 'text-primary' : 'text-transparent'}`}><Check className="w-3 h-3" /></span>
                  <span className="truncate">{ns}</span>
                </button>
              ))}
              {shown.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">결과 없음</div>}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
