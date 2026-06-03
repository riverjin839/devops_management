import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Play, ClipboardCheck, Settings, Search, RefreshCw,
  CheckCircle2, Loader2, Circle, X,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { StatusBadge, StatusDot, statusToVariant } from '@/components/common/StatusBadge';
import { LogViewer } from '@/components/common/LogViewer';
import { useClusters } from '@/hooks/useCluster';
import {
  useOpsCheckCatalog, useStartOpsRun, useOpsRun, useOpsRunItems,
} from '@/hooks/useOpsCheck';
import type { OpsCheckCatalogItem, OpsCheckRunItem } from '@/types';

const CATEGORY_LABEL: Record<string, string> = {
  os: 'OS', k8s: 'K8s', storage: 'Storage', network: 'Network', app: '앱서비스',
};
const SOURCE_LABEL: Record<string, string> = {
  deep_check: '점검', addon: '애드온', batch_job: 'SSH', playbook: 'Ansible',
};

const itemKey = (i: { source: string; itemRefId: string }) => `${i.source}::${i.itemRefId}`;

export function OpsCheckConsolePage() {
  const { clusterId = '' } = useParams<{ clusterId: string }>();
  const navigate = useNavigate();
  const { data: clusters = [] } = useClusters();

  useEffect(() => {
    if (!clusterId && clusters.length > 0) {
      navigate(`/ops-checks/${clusters[0].id}`, { replace: true });
    }
  }, [clusterId, clusters, navigate]);

  const cluster = clusters.find((c) => c.id === clusterId);

  const { data: catalog = [], isLoading } = useOpsCheckCatalog(clusterId);
  const startRun = useStartOpsRun();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpsCheckRunItem | null>(null);

  const { data: run } = useOpsRun(activeRunId ?? undefined);
  const isRunning = !!run && (run.status === 'pending' || run.status === 'running');
  const { data: runItems = [] } = useOpsRunItems(activeRunId ?? undefined, isRunning);

  // 클러스터 변경 시 선택/실행 초기화
  useEffect(() => {
    setSelected(new Set());
    setActiveRunId(null);
  }, [clusterId]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    catalog.forEach((c) => set.add(String(c.category)));
    return Array.from(set);
  }, [catalog]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((c) => {
      if (category !== 'all' && String(c.category) !== category) return false;
      if (q && !`${c.name ?? ''} ${c.checkType ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog, category, search]);

  const allVisibleSelected = filtered.length > 0 && filtered.every((c) => selected.has(itemKey(c)));

  const toggle = (i: OpsCheckCatalogItem) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = itemKey(i);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };
  const toggleAll = () => {
    setSelected((prev) => {
      if (filtered.every((c) => prev.has(itemKey(c)))) {
        const next = new Set(prev);
        filtered.forEach((c) => next.delete(itemKey(c)));
        return next;
      }
      const next = new Set(prev);
      filtered.forEach((c) => next.add(itemKey(c)));
      return next;
    });
  };

  const runItemsToRequest = (items: OpsCheckCatalogItem[]) =>
    items.map((c) => ({ source: c.source, itemRefId: c.itemRefId, checkType: c.checkType, name: c.name }));

  const runSelected = () => {
    const chosen = catalog.filter((c) => selected.has(itemKey(c)));
    if (chosen.length === 0 || !clusterId) return;
    startRun.mutate(
      { clusterId, items: runItemsToRequest(chosen) },
      { onSuccess: (r) => setActiveRunId(r.id) },
    );
  };
  const runOne = (c: OpsCheckCatalogItem) => {
    if (!clusterId) return;
    startRun.mutate(
      { clusterId, items: runItemsToRequest([c]) },
      { onSuccess: (r) => setActiveRunId(r.id) },
    );
  };

  // run 진행 시 결과를 itemKey 로 매핑 (리스트 행에 실시간 상태 표시)
  const runItemByKey = useMemo(() => {
    const m = new Map<string, OpsCheckRunItem>();
    runItems.forEach((it) => m.set(itemKey(it), it));
    return m;
  }, [runItems]);

  return (
    <div className="min-h-screen bg-background p-5">
      <div className="flex gap-4 max-w-[1600px] mx-auto">
        <div className="sticky top-4 self-start">
          <ClusterSidebar
            clusters={clusters}
            selectedId={clusterId || null}
            onSelect={(id) => { if (id) navigate(`/ops-checks/${id}`); }}
            iconOnly
          />
        </div>

        <div className="flex-1 min-w-0 space-y-4">
          {/* header */}
          <div className="flex items-center gap-3 flex-wrap">
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1 min-w-[200px]">
              {cluster ? `${cluster.name} — 운영 점검` : '운영 점검'}
            </h1>
            {clusterId && (
              <>
                <Link to={`/daily-check/review/${clusterId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted">
                  <ClipboardCheck className="w-3.5 h-3.5" /> 결과 리뷰
                </Link>
                <Link to="/daily-check/settings" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-xs hover:bg-muted">
                  <Settings className="w-3.5 h-3.5" /> 점검 항목 관리
                </Link>
              </>
            )}
          </div>

          {/* catalog + bulk run */}
          <MacCard title="점검 항목" bodyPadding="p-0">
            {/* toolbar */}
            <div className="flex items-center gap-2 flex-wrap px-4 py-3 border-b border-border">
              <button
                onClick={() => setCategory('all')}
                className={`rounded-full px-3 py-1 text-xs font-medium border ${category === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:bg-secondary/60'}`}>
                전체 <span className="text-[10px] font-mono opacity-60">{catalog.length}</span>
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border ${category === cat ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:bg-secondary/60'}`}>
                  {CATEGORY_LABEL[cat] ?? cat}
                  <span className="ml-1 text-[10px] font-mono opacity-60">
                    {catalog.filter((c) => String(c.category) === cat).length}
                  </span>
                </button>
              ))}
              <div className="relative ml-auto">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="이름/타입 검색"
                  className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-xs w-44 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            {/* bulk action bar */}
            <div className="flex items-center gap-3 px-4 py-2 bg-secondary/30 border-b border-border">
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} className="accent-primary" />
                전체 선택
              </label>
              <span className="text-xs text-muted-foreground">선택 {selected.size}개</span>
              <button
                onClick={runSelected}
                disabled={selected.size === 0 || startRun.isPending}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90">
                {startRun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                선택 {selected.size}개 실행
              </button>
            </div>

            {/* list */}
            {isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
            ) : filtered.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">표시할 점검 항목이 없습니다.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-muted-foreground border-b border-border">
                    <th className="w-9 px-3 py-2"></th>
                    <th className="text-left px-2 py-2 font-medium">이름</th>
                    <th className="text-left px-2 py-2 font-medium w-24">분류</th>
                    <th className="text-left px-2 py-2 font-medium w-20">소스</th>
                    <th className="text-left px-2 py-2 font-medium w-28">상태</th>
                    <th className="text-right px-3 py-2 font-medium w-32">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((c) => {
                    const k = itemKey(c);
                    const live = runItemByKey.get(k);
                    return (
                      <tr key={k} className="border-b border-border/50 hover:bg-secondary/20">
                        <td className="px-3 py-2">
                          <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(c)} className="accent-primary" />
                        </td>
                        <td className="px-2 py-2">
                          <div className="font-medium truncate max-w-[280px]">{c.name || c.checkType}</div>
                          {c.checkType && c.name && (
                            <div className="text-[10px] text-muted-foreground font-mono">{c.checkType}</div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{CATEGORY_LABEL[String(c.category)] ?? c.category}</td>
                        <td className="px-2 py-2">
                          <span className="text-[10px] rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                            {SOURCE_LABEL[c.source] ?? c.source}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          {live ? (
                            live.status === 'done' ? (
                              <StatusBadge variant={statusToVariant(live.resultStatus)} />
                            ) : live.status === 'error' ? (
                              <StatusBadge variant="critical" label="실패" />
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {live.status === 'running' ? '실행중' : '대기'}
                              </span>
                            )
                          ) : c.lastStatus ? (
                            <span className="inline-flex items-center gap-1">
                              <StatusDot variant={statusToVariant(c.lastStatus)} />
                              <span className="text-[11px] text-muted-foreground">{c.lastRunAt ? new Date(c.lastRunAt).toLocaleString() : ''}</span>
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/60">
                              <Circle className="w-3 h-3" /> 미실행
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => runOne(c)}
                            disabled={startRun.isPending}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] hover:bg-secondary disabled:opacity-40">
                            <Play className="w-3 h-3" /> 실행
                          </button>
                          {live && (live.status === 'done' || live.status === 'error') && (
                            <button
                              onClick={() => setDetail(live)}
                              className="ml-1 inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] hover:bg-secondary">
                              상세
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </MacCard>

          {/* run progress */}
          {activeRunId && run && (
            <MacCard title="실행 진행">
              <div className="flex items-center gap-3 mb-3 text-sm">
                {isRunning ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <CheckCircle2 className="w-4 h-4 text-emerald-500" />}
                <span className="font-medium">{isRunning ? '실행 중…' : '완료'}</span>
                <span className="text-xs text-muted-foreground">
                  총 {run.total} · 정상 {run.okCount} · 경고 {run.warnCount} · 위험 {run.critCount} · 실패 {run.errorCount}
                </span>
                <button onClick={() => setActiveRunId(null)} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="닫기">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="divide-y divide-border/50">
                {runItems.map((it) => (
                  <button
                    key={it.id}
                    onClick={() => (it.status === 'done' || it.status === 'error') && setDetail(it)}
                    className="w-full flex items-center gap-3 py-2 text-left hover:bg-secondary/20 px-1">
                    <span className="w-32 text-xs truncate">{it.name || it.checkType}</span>
                    {it.status === 'done' ? (
                      <StatusBadge variant={statusToVariant(it.resultStatus)} />
                    ) : it.status === 'error' ? (
                      <StatusBadge variant="critical" label="실패" />
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" /> {it.status === 'running' ? '실행중' : '대기'}
                      </span>
                    )}
                    <span className="flex-1 text-xs text-muted-foreground truncate">{it.message}</span>
                    {it.durationMs > 0 && <span className="text-[10px] text-muted-foreground/70 font-mono">{it.durationMs}ms</span>}
                  </button>
                ))}
              </div>
            </MacCard>
          )}
        </div>
      </div>

      {/* item detail modal */}
      {detail && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
          <div className="bg-card rounded-2xl border border-border w-full max-w-3xl max-h-[85vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-card flex items-center gap-2 px-5 py-3 border-b border-border">
              {detail.status === 'done'
                ? <StatusBadge variant={statusToVariant(detail.resultStatus)} />
                : <StatusBadge variant="critical" label="실패" />}
              <h2 className="font-semibold text-sm truncate">{detail.name || detail.checkType}</h2>
              <span className="text-[10px] text-muted-foreground font-mono ml-1">{detail.durationMs}ms</span>
              <button onClick={() => setDetail(null)} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="닫기">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {detail.message && <p className="text-sm">{detail.message}</p>}
              <div>
                <div className="text-[11px] font-semibold text-muted-foreground mb-1 flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> 상세 로그
                </div>
                <LogViewer text={detail.details ? JSON.stringify(detail.details, null, 2) : '(상세 없음)'} maxHeight="max-h-[55vh]" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
