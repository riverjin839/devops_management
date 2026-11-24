import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Play, Search, RefreshCw, Loader2, Circle, AlertTriangle, ListChecks,
} from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { StatusBadge, StatusIcon, statusToVariant } from '@/components/common/StatusBadge';
import { useToast, ConfirmDialog, EmptyState, LoadingState } from '@/components/common';
import { ExecTechBadge } from '@/components/platform-status/ExecTechBadge';
import { formatApiError, parseUTC } from '@/lib/utils';
import { useOpsCheckCatalog, useStartOpsRun, useOpsRun, useOpsRunItems } from '@/hooks/useOpsCheck';
import { useCanOperate } from '@/hooks/useCanOperate';
import type { OpsCheckCatalogItem, OpsCheckRunItem } from '@/types';
import { OpsRunProgressCard } from './OpsRunProgressCard';
import { OpsRunItemDetailModal } from './OpsRunItemDetailModal';
import { CATEGORY_LABEL, SOURCE_LABEL, itemKey } from './opsCheckLabels';

/** 마지막 결과가 경고·실패인 항목 — 클러스터 상태 아이콘(`/ops-checks/summary`)과 같은 기준. */
function isProblem(c: OpsCheckCatalogItem) {
  const v = statusToVariant(c.lastStatus);
  return v === 'warning' || v === 'critical';
}

interface Props {
  clusterId: string | undefined;
  clusterName?: string;
}

/**
 * 클러스터 하나의 점검 카탈로그 + 실행 + 진행 상황 + 결과 상세 — 등록/수정은 다루지 않는다
 * (그건 `/daily-check/settings`). `OpsCheckConsolePage`(K8s 허브 점검 ▸ 점검 항목 `/k8s/:clusterId/checks`)가
 * 마운트한다 — 클러스터 사이드바·헤더 같은 크롬은 페이지가 맡고, 이 패널은 클러스터 하나를 받아 카탈로그만 그린다.
 * 실행 진행 카드는 `OpsRunProgressCard` 로 분리돼 허브 개요의 「전체 점검」과 공유한다.
 */
export function ClusterOpsCheckPanel({ clusterId, clusterName }: Props) {
  const { data: catalog = [], isLoading, isError, refetch } = useOpsCheckCatalog(clusterId);
  const startRun = useStartOpsRun();
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate(clusterId);
  // `?run=<id>` — 개요의 「전체 점검」이 만든 실행 묶음을 이 화면에서 이어 본다.
  const [searchParams, setSearchParams] = useSearchParams();
  // `?filter=problem` — 클러스터 상태 아이콘(사이드바·허브 헤더)을 눌러 들어오면 경고·실패 항목만 보인다.
  const problemOnly = searchParams.get('filter') === 'problem';
  const setProblemOnly = (on: boolean) => setSearchParams((prev) => {
    const next = new URLSearchParams(prev);
    if (on) next.set('filter', 'problem'); else next.delete('filter');
    return next;
  }, { replace: true });

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [category, setCategory] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [activeRunId, setActiveRunId] = useState<string | null>(() => searchParams.get('run'));
  const [detail, setDetail] = useState<OpsCheckRunItem | null>(null);
  // 운영 점검 실행은 모두 운영 위험 레벨 — 실행 전 대상/건수 확인 (D-014)
  const [confirmRun, setConfirmRun] = useState<OpsCheckCatalogItem[] | null>(null);

  // 표의 행별 실시간 상태용 — 진행 카드와 같은 쿼리 키라 폴링은 한 번만 나간다.
  const { data: run } = useOpsRun(activeRunId ?? undefined);
  const isRunning = !!run && (run.status === 'pending' || run.status === 'running');
  const { data: runItems = [] } = useOpsRunItems(activeRunId ?? undefined, isRunning);

  // 클러스터 변경 시 선택/실행 초기화
  // (첫 마운트는 건너뛴다 — `?run=` 으로 받은 실행 묶음을 지우지 않게)
  const prevClusterId = useRef(clusterId);
  useEffect(() => {
    if (prevClusterId.current === clusterId) return;
    prevClusterId.current = clusterId;
    setSelected(new Set());
    setActiveRunId(null);
  }, [clusterId]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    catalog.forEach((c) => set.add(String(c.category)));
    return Array.from(set);
  }, [catalog]);

  const problemCount = catalog.filter(isProblem).length;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return catalog.filter((c) => {
      if (problemOnly && !isProblem(c)) return false;
      if (category !== 'all' && String(c.category) !== category) return false;
      if (q && !`${c.name ?? ''} ${c.checkType ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [catalog, category, search, problemOnly]);

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
    <div className="space-y-4">
      {/* catalog + bulk run */}
      <MacCard
        title="점검 항목"
        bodyPadding="p-0"
        actions={<>
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
          {(problemCount > 0 || problemOnly) && (
            <button
              type="button"
              aria-pressed={problemOnly}
              onClick={() => setProblemOnly(!problemOnly)}
              title={problemOnly ? '전체 항목 보기' : '경고·실패 항목만 보기'}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm font-medium border ${problemOnly ? 'bg-primary text-primary-foreground border-primary' : 'bg-card text-muted-foreground border-border hover:bg-secondary/60'}`}>
              <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
              문제만 <span className="text-xs font-mono opacity-60">{problemCount}</span>
            </button>
          )}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="이름/타입 검색"
              className="rounded-xl border border-border bg-card pl-7 pr-2 py-1 text-sm w-44 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </>}
      >

        {/* bulk action bar */}
        <div className="flex items-center gap-3 px-4 py-2 bg-secondary/30 border-b border-border">
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground cursor-pointer">
            <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} className="accent-primary" />
            전체 선택
          </label>
          <span className="text-sm text-muted-foreground">선택 {selected.size}개</span>
          <button
            onClick={requestRunSelected}
            disabled={!canOperate || selected.size === 0 || startRun.isPending}
            title={withHint('선택한 점검 실행')}
            className="ml-auto inline-flex items-center gap-1.5 rounded-xl bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-primary/90">
            {startRun.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            선택 {selected.size}개 실행
          </button>
        </div>

        {/* list */}
        {isLoading ? (
          <LoadingState compact />
        ) : isError ? (
          <div className="m-4 rounded-md border border-status-critical/30 bg-status-critical/10 p-4">
            <div className="flex items-start gap-2 text-sm text-status-critical">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">점검 항목을 불러오지 못했습니다.</p>
                <p className="text-status-critical/80 mt-0.5">네트워크 또는 서버 상태를 확인한 뒤 다시 시도해 주세요.</p>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3">
              <RefreshCw className="w-3.5 h-3.5" /> 다시 시도
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            compact
            icon={ListChecks}
            title={problemOnly ? '문제가 있는 점검 항목이 없습니다' : '표시할 점검 항목이 없습니다'}
            description={problemOnly ? '마지막 결과가 경고·실패인 항목이 없습니다. 「문제만」을 끄면 전체 항목이 보입니다.' : '분류 필터나 검색어를 바꾸거나, 점검 항목 관리에서 항목을 활성화하세요.'}
          />
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
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
                          <span className="text-xs rounded px-1 py-0.5 bg-muted text-muted-foreground border border-border" title="비활성 — cron 미실행, 수동 실행만">비활성</span>
                        )}
                      </div>
                      {c.checkType && c.name && (
                        <div className="text-xs text-muted-foreground font-mono">{c.checkType}</div>
                      )}
                    </td>
                    <td className="px-2 py-2 text-sm text-muted-foreground">{CATEGORY_LABEL[String(c.category)] ?? c.category}</td>
                    <td className="px-2 py-2">
                      {c.execTech ? (
                        <ExecTechBadge execTech={c.execTech} />
                      ) : (
                        <span className="text-xs rounded-full border border-border px-2 py-0.5 text-muted-foreground">
                          {SOURCE_LABEL[c.source] ?? c.source}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {live ? (
                        live.status === 'done' ? (
                          <StatusIcon variant={statusToVariant(live.resultStatus)} />
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
                          <StatusIcon variant={statusToVariant(c.lastStatus)} />
                          {c.lastRunAt && (
                            <span className="text-xs text-muted-foreground">{parseUTC(c.lastRunAt).toLocaleString()}</span>
                          )}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Circle className="w-3 h-3" /> 미실행
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <button
                        onClick={() => requestRunOne(c)}
                        disabled={!canOperate || startRun.isPending}
                        title={withHint('이 점검 실행')}
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
          </div>
        )}
      </MacCard>

      {/* run progress */}
      {activeRunId && (
        <OpsRunProgressCard
          runId={activeRunId}
          clusterId={clusterId}
          clusterName={clusterName}
          onClose={() => setActiveRunId(null)}
        />
      )}

      {/* 실행 확인 (운영 위험 레벨 — 모든 실행 공통) */}
      {confirmRun && (
        <ConfirmDialog
          open={!!confirmRun}
          danger
          title="운영 점검 실행"
          description={`${clusterName ?? '이 클러스터'}에서 점검 ${confirmRun.length}개를 실행합니다. 실제 서버에 명령(SSH · Ansible · kubectl 등)이 전송될 수 있으니 대상을 확인하세요.`}
          confirmLabel={`${confirmRun.length}개 실행`}
          onCancel={() => setConfirmRun(null)}
          onConfirm={doRun}
        >
          <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-secondary/30 divide-y divide-border/50 text-sm">
            {confirmRun.map((c) => (
              <li key={itemKey(c)} className="flex items-center gap-2 px-2.5 py-1.5">
                {c.execTech ? (
                  <ExecTechBadge execTech={c.execTech} />
                ) : (
                  <span className="text-xs rounded-full border border-border px-1.5 py-0.5 text-muted-foreground shrink-0">
                    {SOURCE_LABEL[c.source] ?? c.source}
                  </span>
                )}
                <span className="truncate">{c.name || c.checkType}</span>
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}

      <OpsRunItemDetailModal item={detail} onClose={() => setDetail(null)} />
    </div>
  );
}
