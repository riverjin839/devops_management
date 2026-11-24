import { useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronRight, Plus, Search } from 'lucide-react';
import { ErrorState, LoadingState } from '@/components/common';
import { bulkExecApi } from '@/services/api';
import { nodeTarget, type SshTarget } from './sshTarget';
import type { Cluster } from '@/types';

interface Props {
  clusters: Cluster[];
  /** 허브가 고른 클러스터 — 맨 위에 펼쳐 둔다. */
  currentClusterId: string;
  selected: SshTarget[];
  onChange: (next: SshTarget[]) => void;
  /** 이미 열린 세션의 칸 표기(키 → "Ⅰ" / "2쪽 Ⅳ"). */
  openLabels: ReadonlyMap<string, string>;
  /** 이 클러스터에 실행 권한이 없으면 사유, 있으면 undefined. */
  blockedReason: (clusterId: string) => string | undefined;
}

/**
 * 대상 노드 리스트박스 — 허브 2행 「SSH」 탭 바로 옆에 붙는다. 클러스터별로 묶어 여러 노드를 고르고
 * (다른 K8S 클러스터 노드도), 호스트를 직접 더할 수 있다. 노드 목록은 펼친 클러스터만 불러온다
 * (노드 일괄 실행과 같은 `bulkExecApi.nodeList` 캐시를 공유).
 */
export function NodeMultiSelect({ clusters, currentClusterId, selected, onChange, openLabels, blockedReason }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'current'>('all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([currentClusterId]));
  const [manualHost, setManualHost] = useState('');

  const selectedKeys = useMemo(() => new Set(selected.map((t) => t.key)), [selected]);
  const q = query.trim().toLowerCase();
  const ordered = useMemo(() => {
    const cur = clusters.filter((c) => c.id === currentClusterId);
    const rest = scope === 'current' ? [] : clusters.filter((c) => c.id !== currentClusterId);
    return [...cur, ...rest];
  }, [clusters, currentClusterId, scope]);
  // 검색 중이면 보이는 클러스터 전부를, 아니면 펼친 클러스터만 불러온다.
  const isLoaded = (id: string) => open && (expanded.has(id) || q.length > 0 || id === currentClusterId);
  const nodeQs = useQueries({
    queries: ordered.map((c) => ({
      queryKey: ['bulk-exec', 'nodes', c.id],
      queryFn: () => bulkExecApi.nodeList(c.id).then((r) => r.data),
      enabled: isLoaded(c.id),
      staleTime: 60_000,
    })),
  });

  const toggle = (t: SshTarget) => {
    onChange(selectedKeys.has(t.key) ? selected.filter((s) => s.key !== t.key) : [...selected, t]);
  };
  const toggleGroup = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const addManual = () => {
    const host = manualHost.trim();
    if (!host) return;
    const key = `host:${host}`;
    if (!selectedKeys.has(key)) {
      const cur = clusters.find((c) => c.id === currentClusterId);
      onChange([...selected, { key, clusterId: currentClusterId || null, clusterName: cur ? `${cur.name} · 직접 입력` : '직접 입력', host }]);
    }
    setManualHost('');
  };

  const clusterCount = new Set(selected.map((t) => t.clusterId ?? 'manual')).size;
  const summary = selected.length === 0 ? '고르세요' : `${selected.length}개 선택${clusterCount > 1 ? ` · 클러스터 ${clusterCount}` : ''}`;

  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 min-w-[260px] px-3 py-1.5 text-sm rounded-xl border bg-card text-left transition-colors ${
          open ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-secondary'
        }`}
      >
        <span className="text-muted-foreground">대상 노드</span>
        <span className="font-medium text-foreground truncate">{summary}</span>
        <ChevronDown className="w-3.5 h-3.5 ml-auto text-muted-foreground" aria-hidden="true" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div
            onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
            className="absolute left-0 top-full mt-1 z-40 w-[400px] max-w-[calc(100vw_-_32px)] bg-popover text-popover-foreground border border-border rounded-md shadow-lg p-2 flex flex-col gap-1">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="노드 이름 / IP / 클러스터 검색"
                aria-label="노드 검색"
                autoFocus
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="flex items-center gap-1.5 text-xs px-0.5 py-1">
              {(['all', 'current'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={scope === s}
                  onClick={() => setScope(s)}
                  className={`px-2 py-0.5 rounded-xl border ${scope === s ? 'bg-primary text-primary-foreground border-primary' : 'bg-secondary text-muted-foreground border-border hover:text-foreground'}`}
                >
                  {s === 'all' ? '전체 클러스터' : '현재 클러스터만'}
                </button>
              ))}
              {selected.length > 0 && (
                <button type="button" onClick={() => onChange([])} className="ml-auto text-primary hover:underline">
                  선택 해제
                </button>
              )}
            </div>

            <div role="listbox" aria-multiselectable="true" aria-label="대상 노드" className="max-h-[50vh] overflow-y-auto flex flex-col gap-0.5">
              {ordered.map((c, i) => {
                const nq = nodeQs[i];
                const blocked = blockedReason(c.id);
                const showNodes = expanded.has(c.id) || q.length > 0 || c.id === currentClusterId;
                const nodes = (nq.data?.nodes ?? []).filter((n) =>
                  !q || n.name.toLowerCase().includes(q) || (n.internalIp ?? '').includes(q) || c.name.toLowerCase().includes(q));
                if (q && nq.data && nodes.length === 0) return null;
                const picked = selected.filter((t) => t.clusterId === c.id && t.nodeName).length;
                return (
                  <div key={c.id} className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      onClick={() => toggleGroup(c.id)}
                      aria-expanded={showNodes}
                      className="flex items-center gap-1 px-2 pt-2 pb-1 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      {showNodes ? <ChevronDown className="w-3 h-3" aria-hidden="true" /> : <ChevronRight className="w-3 h-3" aria-hidden="true" />}
                      <span className="truncate">{c.name}</span>
                      {c.id === currentClusterId && <span className="font-normal">· 현재 클러스터</span>}
                      {picked > 0 && <span className="font-normal">· {picked}개 선택</span>}
                      {blocked && <span className="font-normal text-status-warning">· 실행 권한 없음</span>}
                    </button>
                    {showNodes && (
                      nq.isLoading ? <LoadingState compact />
                      : nq.isError ? (
                        <ErrorState compact error={nq.error} title={`${c.name} 노드 목록을 불러오지 못했습니다`} onRetry={() => { void nq.refetch(); }} />
                      ) : nodes.length === 0 ? (
                        <p className="px-3 py-1.5 text-xs text-muted-foreground">노드가 없습니다.</p>
                      ) : nodes.map((n) => {
                        const t = nodeTarget(c, n);
                        const checked = t ? selectedKeys.has(t.key) : false;
                        const disabled = !t || !!blocked;
                        const slotLabel = t ? openLabels.get(t.key) : undefined;
                        return (
                          <button
                            key={n.name}
                            type="button"
                            role="option"
                            aria-selected={checked}
                            disabled={disabled}
                            title={blocked ?? (!t ? '접속할 IP 가 없습니다' : undefined)}
                            onClick={() => t && toggle(t)}
                            className={`w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 text-sm disabled:opacity-50 ${
                              checked ? 'bg-accent' : 'hover:bg-secondary'
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className={`w-3.5 h-3.5 shrink-0 rounded-[4px] border flex items-center justify-center ${
                                checked ? 'bg-primary border-primary text-primary-foreground' : 'border-muted-foreground/50'
                              }`}
                            >
                              {checked && <Check className="w-2.5 h-2.5" />}
                            </span>
                            <span className="truncate text-foreground">{n.name}</span>
                            {!n.ready && <span className="text-xs text-status-critical shrink-0">준비 안 됨</span>}
                            {n.roles.includes('control-plane') && (
                              <span className="text-xs px-1.5 rounded-full bg-chart-7/15 text-chart-7-text border border-chart-7/30 shrink-0">컨트롤 플레인</span>
                            )}
                            <span className="ml-auto text-xs font-mono text-muted-foreground shrink-0">
                              {n.internalIp ?? '—'}{slotLabel ? ` · ${slotLabel}` : ''}
                            </span>
                          </button>
                        );
                      })
                    )}
                  </div>
                );
              })}
              {selected.filter((t) => !t.nodeName).map((t) => (
                <button
                  key={t.key}
                  type="button"
                  role="option"
                  aria-selected
                  onClick={() => toggle(t)}
                  className="w-full text-left px-2 py-1.5 rounded-md flex items-center gap-2 text-sm bg-accent"
                >
                  <span aria-hidden="true" className="w-3.5 h-3.5 shrink-0 rounded-[4px] border bg-primary border-primary text-primary-foreground flex items-center justify-center">
                    <Check className="w-2.5 h-2.5" />
                  </span>
                  <span className="font-mono text-foreground">{t.host}</span>
                  <span className="text-xs text-muted-foreground">직접 입력</span>
                  {openLabels.get(t.key) && <span className="ml-auto text-xs text-muted-foreground">{openLabels.get(t.key)}</span>}
                </button>
              ))}
            </div>

            <div className="border-t border-border mt-1 pt-2 px-1 flex items-center gap-2">
              <label htmlFor="ssh-manual-host" className="text-xs text-muted-foreground shrink-0">호스트 직접 입력</label>
              <input
                id="ssh-manual-host"
                type="text"
                value={manualHost}
                onChange={(e) => setManualHost(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }}
                placeholder="192.168.10.11"
                className="flex-1 min-w-0 px-2 py-1 text-xs font-mono bg-background border border-border rounded-xl focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <button
                type="button"
                onClick={addManual}
                disabled={!manualHost.trim()}
                title="이 호스트를 대상에 더하기"
                aria-label="직접 입력한 호스트를 대상에 더하기"
                className="p-1 rounded-xl border border-border hover:bg-secondary disabled:opacity-50"
              >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
