import { useMemo, useState } from 'react';
import { ChevronDown, Check, Search } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { k8sResourcesApi } from '@/services/api';

interface Props {
  clusterId: string;
  selected: Set<string>;            // 비어있으면 전체
  onChange: (next: Set<string>) => void;
}

/** OpenLens 식 네임스페이스 멀티셀렉트 드롭다운. 빈 선택 = 전체. 여러 리소스 뷰에서 공용. */
export function NamespaceMultiSelect({ clusterId, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

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

  const toggle = (ns: string) => {
    const next = new Set(selected);
    if (next.has(ns)) next.delete(ns); else next.add(ns);
    onChange(next);
  };

  const label = selected.size === 0 ? '전체 네임스페이스' : `${selected.size}개 네임스페이스`;

  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-secondary/60 whitespace-nowrap">
        {label} <ChevronDown className="w-3.5 h-3.5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute z-50 mt-1 w-60 rounded-xl border border-border bg-card shadow-lg py-1">
            <div className="px-2 pb-1">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="네임스페이스 검색"
                  className="w-full rounded-lg border border-border bg-background pl-7 pr-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary" />
              </div>
            </div>
            <div className="max-h-64 overflow-auto">
              <button onClick={() => onChange(new Set())}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/60">
                <span className={`w-3.5 h-3.5 flex items-center justify-center ${selected.size === 0 ? 'text-primary' : 'text-transparent'}`}><Check className="w-3 h-3" /></span>
                전체 네임스페이스
              </button>
              <div className="my-1 border-t border-border" />
              {shown.map((ns) => (
                <button key={ns} onClick={() => toggle(ns)}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/60">
                  <span className={`w-3.5 h-3.5 flex items-center justify-center ${selected.has(ns) ? 'text-primary' : 'text-transparent'}`}><Check className="w-3 h-3" /></span>
                  <span className="truncate">{ns}</span>
                </button>
              ))}
              {shown.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">결과 없음</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
