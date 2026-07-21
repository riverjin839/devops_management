import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Play, ClipboardCheck, Settings, Search, RefreshCw,
  CheckCircle2, Loader2, Circle, X, AlertTriangle,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { StatusBadge, statusToVariant } from '@/components/common/StatusBadge';
import { LogViewer } from '@/components/common/LogViewer';
import { useToast, ConfirmDialog, useModalA11y } from '@/components/common';
import { ExecutionStepsTimeline } from '@/components/daily-check/ExecutionStepsTimeline';
import { formatApiError, parseUTC } from '@/lib/utils';
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

  const { data: catalog = [], isLoading, isError, refetch } = useOpsCheckCatalog(clusterId);
  const startRun = useStartOpsRun();
  const toast = useToast();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<OpsCheckRunItem | null>(null);
  // 운영 점검 실행은 모두 운영 위험 레벨 — 실행 전 대상/건수 확인 (D-014)
  const [confirmRun, setConfirmRun] = useState<OpsCheckCatalogItem[] | null>(null);
  const closeDetail = useCallback(() => setDetail(null), []);
  const detailRef = useModalA11y(!!detail, closeDetail, { historyClose: true });

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

  // 실행 요청 → 확인 다이얼로그 오픈 (즉시 실행 금지 — 실서버 명령 오클릭 방지)
  const requestRunSelected = () => {
    const chosen = catalog.filter((c) => selected.has(itemKey(c)));
    if (chosen.length === 0 || !clusterId) return;
    setConfirmRun(chosen);
  };
  const requestRunOne = (c: OpsCheckCatalogItem) => {
    if (!clusterId) return;
    setConfirmRun([c]);
  };
  // 확인 후 실제 실행
  const doRun = () => {
    const chosen = confirmRun;
    setConfirmRun(null);
    if (!chosen || chosen.length === 0 || !clusterId) return;
    startRun.mutate(
      { clusterId, items: runItemsToRequest(chosen) },
      {
        onSuccess: (r) => setActiveRunId(r.id),
        onError: (e) => toast.error('실행 시작 실패', formatApiError(e)),
      },
    );
  };

  // run 진행 시 결과를 itemKey 로 매핑 (리스트 행에 실시간 상태 표시)
  const runItemByKey = useMemo(() => {
    const m = new Map<string, OpsCheckRunItem>();
    runItems.forEach((it) => m.set(itemKey(it), it));
    return m;
  }, [runItems]);

  return (
    <div className="min-h-screen bg-background py-3 pr-3">
      <div className="flex gap-3">
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
            <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
              <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
            </Link>
            <h1 className="text-lg font-semibold flex-1 min-w-[200px]">
              {cluster ? `${cluster.name} — 운영 점검` : '운영 점검'}
            </h1>
            {clusterId && (
              <>
                <Link to={`/daily-check/review/${clusterId}`} className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
                  <ClipboardCheck className="w-3.5 h-3.5" /> 결과 리뷰
                </Link>
                <Link to="/daily-check/settings" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
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
                className={`rounded-full px-3 py-1 text-sm font-medium border ${category === 'all' ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:bg-secondary/60'}`}>
                전체 <span className="text-xs font-mono opacity-60">{catalog.length}</span>
              </button>
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setCategory(cat)}
                  className={`rounded-full px-3 py-1 text-sm font-medium border ${category === cat ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:bg-secondary/60'}`}>
                  {CATEGORY_LABEL[cat] ?? cat}
                  <span className="ml-1 text-xs font-mono opacity-60">
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
                  className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>

            {/* bulk action bar */}
            <div className="flex items-center gap-3 px-4 py-2 bg-secondary/30 border-b border-border">
              <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} className="accent-primary" />
                전체 선택
              </label>
              <span className="text-sm text-muted-foreground">선택 {selected.size}개</span>
              <button
                onClick={requestRunSelected}
                disabled={selected.size === 0 || startRun.isPending}
                className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90">
                {startRun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                선택 {selected.size}개 실행
              </button>
            </div>

            {/* list */}
            {isLoading ? (
              <div className="p-6 text-sm text-muted-foreground">불러오는 중…</div>
            ) : isError ? (
              <div className="m-4 rounded-md border border-destructive/30 bg-destructive/10 p-4">
                <div className="flex items-start gap-2 text-sm text-destructive">
                  <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div>
                    <p className="font-medium">점검 항목을 불러오지 못했습니다.</p>
                    <p className="text-destructive/80 mt-0.5">네트워크 또는 서버 상태를 확인한 뒤 다시 시도해 주세요.</p>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3">
                  <RefreshCw className="w-3.5 h-3.5" /> 다시 시도
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted-foreground">표시할 점검 항목이 없습니다.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="w-9 px-3 py-2"><span className="sr-only">선택</span></th>
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
                          <input type="checkbox" checked={selected.has(k)} onChange={() => toggle(c)} className="accent-primary" aria-label="선택" />
                        </td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium truncate max-w-[260px]">{c.name || c.checkType}</span>
                            {c.enabled === false && (
                              <span className="text-[10px] rounded px-1 py-0.5 bg-muted text-muted-foreground border border-border" title="비활성 — cron 미실행, 수동 실행만">비활성</span>
                            )}
                          </div>
                          {c.checkType && c.name && (
                            <div className="text-xs text-muted-foreground font-mono">{c.checkType}</div>
                          )}
                        </td>
                        <td className="px-2 py-2 text-sm text-muted-foreground">{CATEGORY_LABEL[String(c.category)] ?? c.category}</td>
                        <td className="px-2 py-2">
                          <span className="text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground">
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
                              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                {live.status === 'running' ? '실행중' : '대기'}
                              </span>
                            )
                          ) : c.lastStatus ? (
                            <span className="inline-flex items-center gap-1.5">
                              <StatusBadge variant={statusToVariant(c.lastStatus)} />
                              {c.lastRunAt && (
                                <span className="text-xs text-muted-foreground">{parseUTC(c.lastRunAt).toLocaleString()}</span>
                              )}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground/60">
                              <Circle className="w-3 h-3" /> 미실행
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right whitespace-nowrap">
                          <button
                            onClick={() => requestRunOne(c)}
                            disabled={startRun.isPending}
                            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary disabled:opacity-40">
                            <Play className="w-3 h-3" /> 실행
                          </button>
                          {live && (live.status === 'done' || live.status === 'error') && (
                            <button
                              onClick={() => setDetail(live)}
                              className="ml-1 inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs hover:bg-secondary">
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
                {isRunning ? <Loader2 className="w-4 h-4 animate-spin text-primary" /> : <CheckCircle2 className="w-4 h-4 text-status-healthy" />}
                <span className="font-medium">{isRunning ? '실행 중…' : '완료'}</span>
                <span className="text-sm text-muted-foreground">
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
                    <span className="w-32 text-sm truncate">{it.name || it.checkType}</span>
                    {it.status === 'done' ? (
                      <StatusBadge variant={statusToVariant(it.resultStatus)} />
                    ) : it.status === 'error' ? (
                      <StatusBadge variant="critical" label="실패" />
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="w-3 h-3 animate-spin" /> {it.status === 'running' ? '실행중' : '대기'}
                      </span>
                    )}
                    <span className="flex-1 text-sm text-muted-foreground truncate">{it.message}</span>
                    {it.durationMs > 0 && <span className="text-xs text-muted-foreground/70 font-mono">{it.durationMs}ms</span>}
                  </button>
                ))}
              </div>
            </MacCard>
          )}
        </div>
      </div>

      {/* 실행 확인 (운영 위험 레벨 — 모든 실행 공통) */}
      {confirmRun && (
        <ConfirmDialog
          open={!!confirmRun}
          danger
          title="운영 점검 실행"
          description={`${cluster?.name ?? '이 클러스터'}에서 점검 ${confirmRun.length}개를 실행합니다. 실제 서버에 명령(SSH · Ansible · kubectl 등)이 전송될 수 있으니 대상을 확인하세요.`}
          confirmLabel={`${confirmRun.length}개 실행`}
          onCancel={() => setConfirmRun(null)}
          onConfirm={doRun}
        >
          <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-secondary/30 divide-y divide-border/50 text-sm">
            {confirmRun.map((c) => (
              <li key={itemKey(c)} className="flex items-center gap-2 px-2.5 py-1.5">
                <span className="text-xs rounded-full border border-border px-1.5 py-0.5 text-muted-foreground shrink-0">
                  {SOURCE_LABEL[c.source] ?? c.source}
                </span>
                <span className="truncate">{c.name || c.checkType}</span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}

      {/* item detail modal */}
      {detail && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setDetail(null)}>
          <div
            ref={detailRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="ops-detail-title"
            className="bg-card rounded-2xl border border-border w-full max-w-3xl max-h-[85vh] overflow-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 bg-card flex items-center gap-2 px-5 py-3 border-b border-border">
              {detail.status === 'done'
                ? <StatusBadge variant={statusToVariant(detail.resultStatus)} />
                : <StatusBadge variant="critical" label="실패" />}
              <h2 id="ops-detail-title" className="font-semibold text-sm truncate">{detail.name || detail.checkType}</h2>
              <span className="text-xs text-muted-foreground font-mono ml-1">{detail.durationMs}ms</span>
              <button onClick={() => setDetail(null)} className="ml-auto text-muted-foreground hover:text-foreground" aria-label="닫기">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              {detail.message && <p className="text-sm">{detail.message}</p>}
              {Array.isArray(detail.details?._steps) && detail.details!._steps.length > 0 && (
                <ExecutionStepsTimeline steps={detail.details!._steps} />
              )}
              <div>
                <div className="text-xs font-semibold text-muted-foreground mb-1 flex items-center gap-1">
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
