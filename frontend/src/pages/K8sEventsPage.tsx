import { Fragment, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, Bell, Info, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { ClusterSidebar } from '@/components/common/ClusterSidebar';
import { ConfirmDialog, useToast, PageHeader, PageShell, LoadingState, EmptyState, LogViewer } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useK8sEventsPaged, useK8sEventStats, useDeleteK8sEvent } from '@/hooks/useK8sEvents';
import { K8sEventAnalysisPanel } from '@/components/k8s/K8sEventAnalysisPanel';
import type { K8sEvent, K8sEventSeverity } from '@/types';
import { formatApiError, parseUTC } from '@/lib/utils';

const SEVERITY_TABS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '전체' },
  { value: 'critical', label: 'Critical' },
  { value: 'warning', label: 'Warning' },
  { value: 'info', label: 'Info' },
];

function SeverityBadge({ severity }: { severity: K8sEventSeverity }) {
  if (severity === 'critical') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-status-critical/10 text-status-critical">
        <AlertCircle className="w-3 h-3" /> Critical
      </span>
    );
  }
  if (severity === 'warning') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-status-warning/10 text-status-warning">
        <AlertTriangle className="w-3 h-3" /> Warning
      </span>
    );
  }
  // info(= K8s Normal 이벤트)는 정상 범주라 무채색 (§12.12-3, D-119)
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-secondary text-muted-foreground">
      <Info className="w-3 h-3" /> Info
    </span>
  );
}

function formatTime(iso: string) {
  try {
    return parseUTC(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function K8sEventsPage() {
  const { data: clusters = [] } = useClusters();
  const [selectedClusterId, setSelectedClusterId] = useState<string | null>(null);
  const [severityTab, setSeverityTab] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // D-111 — 100건 offset 페이지 + "더 보기". 30초 refetch 는 불러온 페이지 전체를 다시 받는다.
  const {
    data, isLoading, isError, error, refetch, isFetching,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useK8sEventsPaged({
    clusterId: selectedClusterId ?? undefined,
    severity: severityTab === 'all' ? undefined : severityTab,
    pageSize: 100,
  });
  // D-111 — 심각도 카운터는 서버 집계(필터·페이지와 무관). 예전엔 받아온 200건만 셌다.
  const stats = useK8sEventStats(selectedClusterId);
  const refreshAll = () => {
    void refetch();
    void stats.refetch();
  };

  const toast = useToast();
  const deleteEvent = useDeleteK8sEvent();
  // D-102 — 삭제는 서버가 operator + 클러스터 operate 를 요구한다. viewer 에겐 숨기지 않고 사유와 함께 막는다.
  const { canOperate, withHint, ariaWithHint } = useCanOperate(selectedClusterId);
  const [pendingDelete, setPendingDelete] = useState<K8sEvent | null>(null);

  const confirmDelete = async () => {
    const ev = pendingDelete;
    setPendingDelete(null);
    if (!ev) return;
    try {
      await deleteEvent.mutateAsync(ev.id);
      toast.success('이벤트 삭제됨');
    } catch (err) {
      toast.error(formatApiError(err, '이벤트 삭제 실패'));
    }
  };

  // 페이지 사이에 새 이벤트가 들어오면 경계 행이 다음 페이지에 다시 실린다 — id 로 중복을 걷는다(D-111).
  const events: K8sEvent[] = useMemo(() => {
    const seen = new Set<string>();
    return (data?.pages.flatMap((p) => p.data) ?? []).filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  }, [data]);
  // 첫 페이지 기준 total — 이후 페이지가 받은 시점의 total 보다 최신이다.
  const total = data?.pages[0]?.total;
  const selectedClusterName = clusters.find((c) => c.id === selectedClusterId)?.name;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" as="div" className="flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={selectedClusterId}
          onSelect={(id) => setSelectedClusterId(id ?? null)}
          allowAll
          allLabel="전체 클러스터"
          iconOnly
        />

        <div className="flex-1 min-w-0 space-y-3">
          <PageHeader
            icon={Bell}
            title="K8s 실시간 이벤트"
            description="kubewatch 웹훅으로 받은 리소스 이벤트를 심각도별로 확인하고 분석합니다."
          />
          <MacCard
            title="수신 이벤트"
            titleExtra={total !== undefined ? (
              <span className="text-xs text-muted-foreground tabular-nums">총 {total}건 중 {events.length}건</span>
            ) : undefined}
            actions={
              <>
                <div className="flex gap-1">
                  {SEVERITY_TABS.map((tab) => (
                    <button
                      key={tab.value}
                      type="button"
                      aria-pressed={severityTab === tab.value}
                      onClick={() => setSeverityTab(tab.value)}
                      className={`px-3 py-1.5 rounded-xl text-sm font-medium transition-colors ${
                        severityTab === tab.value
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary text-muted-foreground hover:bg-secondary/80'
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={refreshAll}
                  disabled={isFetching}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm bg-secondary text-muted-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
                  새로고침
                </button>
              </>
            }
          >
            {/* 요약 카운터 — 서버 집계(심각도 탭·페이지와 무관, D-111) */}
            {stats.data ? (
              <div className="flex gap-3 mb-4">
                {(['critical', 'warning', 'info'] as K8sEventSeverity[]).map((sev) => {
                  const count = stats.data.bySeverity[sev] ?? 0;
                  const colors = {
                    critical: 'bg-status-critical/10 border-status-critical/30 text-status-critical',
                    warning: 'bg-status-warning/10 border-status-warning/30 text-status-warning',
                    info: 'bg-secondary border-border text-muted-foreground',
                  };
                  // 값이 0 이면 중립색 (§12.12-2)
                  return (
                    <div key={sev} className={`px-3 py-1.5 rounded-xl border text-sm font-medium tabular-nums ${count > 0 ? colors[sev] : colors.info}`}>
                      {sev.charAt(0).toUpperCase() + sev.slice(1)}: {count}
                    </div>
                  );
                })}
              </div>
            ) : stats.isError ? (
              <p className="mb-4 text-xs text-muted-foreground">
                심각도 집계를 불러오지 못했습니다 — {formatApiError(stats.error)}
              </p>
            ) : null}

            {/* D-104 — 데이터가 있는데 백그라운드 갱신만 실패하면 목록은 유지하고 낡았음을 알린다. */}
            {isError && data && (
              <p className="mb-3 text-xs text-status-warning" role="status">
                최근 갱신 실패 — {formatApiError(error)}{' '}
                <button type="button" onClick={refreshAll} className="underline underline-offset-2 hover:text-foreground">
                  다시 시도
                </button>
              </p>
            )}

            {/* 이벤트 테이블 */}
            {isLoading ? (
              <LoadingState />
            ) : isError && !data ? (
              <EmptyState
                icon={AlertTriangle}
                title="이벤트 목록을 불러오지 못했습니다"
                description={formatApiError(error)}
                action={{ label: '다시 시도', onClick: refreshAll, variant: 'secondary' }}
              />
            ) : events.length === 0 ? (
              <EmptyState
                icon={Bell}
                title="수신된 이벤트가 없습니다."
                description={severityTab === 'all' ? 'kubewatch 가 이 서버로 이벤트를 보내면 여기에 쌓입니다.' : '다른 심각도 탭을 선택해 보세요.'}
              >
                {selectedClusterId && (
                  // D-101 — kubewatch 페이로드에는 클러스터 정보가 없다. 웹훅 URL 에 클러스터를 붙여야 이 필터에 모인다.
                  <p className="mt-2 max-w-md text-xs text-muted-foreground">
                    클러스터별로 모으려면 이 클러스터의 kubewatch 웹훅 URL 끝에{' '}
                    <code className="font-mono text-foreground">?cluster={selectedClusterName ?? '<클러스터 이름>'}</code>
                    {' '}를 붙인다. 붙이지 않은 이벤트는 "전체 클러스터"에만 보인다.
                  </p>
                )}
              </EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs">
                      <th className="text-left py-2 pr-3 font-medium w-36">시각</th>
                      <th className="text-left py-2 pr-3 font-medium w-20">심각도</th>
                      <th className="text-left py-2 pr-3 font-medium w-24">Kind</th>
                      <th className="text-left py-2 pr-3 font-medium">이름</th>
                      <th className="text-left py-2 pr-3 font-medium w-32">네임스페이스</th>
                      <th className="text-left py-2 pr-3 font-medium w-36">Reason</th>
                      <th className="text-left py-2 font-medium">메시지</th>
                      <th className="w-8"><span className="sr-only">작업</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {events.map((ev) => {
                      const open = expandedId === ev.id;
                      const detailId = `k8s-event-detail-${ev.id}`;
                      const toggle = () => setExpandedId(open ? null : ev.id);
                      return (
                      <Fragment key={ev.id}>
                        {/* 행 클릭은 마우스 편의 — 키보드 조작은 이름 셀 버튼이 담당한다(D-107). */}
                        <tr
                          onClick={toggle}
                          className="border-b border-border/50 hover:bg-muted/30 cursor-pointer transition-colors"
                        >
                          <td className="py-2 pr-3 text-muted-foreground text-xs whitespace-nowrap">
                            {formatTime(ev.receivedAt)}
                          </td>
                          <td className="py-2 pr-3">
                            <SeverityBadge severity={ev.severity} />
                          </td>
                          <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                            {ev.resourceKind}
                          </td>
                          <td className="py-2 pr-3 font-medium max-w-[180px]">
                            <button
                              type="button"
                              aria-expanded={open}
                              aria-controls={detailId}
                              title={open ? '상세 접기' : '상세 펼치기'}
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle();
                              }}
                              className="block w-full truncate text-left rounded-xl hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              {ev.resourceName}
                            </button>
                          </td>
                          <td className="py-2 pr-3 text-muted-foreground text-xs truncate">
                            {ev.namespace ?? '—'}
                          </td>
                          <td className="py-2 pr-3 text-xs text-muted-foreground">
                            {ev.reason ?? '—'}
                          </td>
                          <td className="py-2 text-xs text-muted-foreground truncate max-w-[200px]">
                            {ev.message ?? '—'}
                          </td>
                          <td className="py-2 pl-2">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPendingDelete(ev);
                              }}
                              disabled={!canOperate || (deleteEvent.isPending && deleteEvent.variables === ev.id)}
                              title={withHint('이벤트 삭제')}
                              aria-label={ariaWithHint('이벤트 삭제')}
                              className="p-1 rounded-xl hover:bg-status-critical/10 hover:text-status-critical text-muted-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              {deleteEvent.isPending && deleteEvent.variables === ev.id
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                                : <Trash2 className="w-3.5 h-3.5" aria-hidden />}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr id={detailId} className="bg-muted/20">
                            <td colSpan={8} className="px-4 py-3 space-y-3">
                              <K8sEventAnalysisPanel event={ev} />
                              {/* D-116 — 원본 페이로드는 LogViewer(JSON 자동 감지·하이라이트·검색·복사) */}
                              <LogViewer text={JSON.stringify(ev.raw ?? {}, null, 2)} maxHeight="max-h-80" />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <div className="flex items-center justify-between gap-2 pt-3 text-xs text-muted-foreground">
                  <span className="tabular-nums">{events.length} / {total ?? events.length}건</span>
                  {hasNextPage && (
                    <button
                      type="button"
                      onClick={() => void fetchNextPage()}
                      disabled={isFetchingNextPage}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-secondary px-3 py-1.5 text-sm text-foreground hover:bg-secondary/80 disabled:opacity-50"
                    >
                      {isFetchingNextPage && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />}
                      더 보기
                    </button>
                  )}
                </div>
              </div>
            )}
          </MacCard>
        </div>
      </PageShell>
      <ConfirmDialog
        open={pendingDelete !== null}
        danger
        title="이벤트 삭제"
        description={pendingDelete
          ? `${pendingDelete.resourceKind}/${pendingDelete.resourceName} 이벤트(${pendingDelete.reason ?? pendingDelete.eventType})를 삭제한다. 되돌릴 수 없다.`
          : ''}
        confirmLabel="삭제"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
