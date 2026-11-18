// 서비스 구성 — K8S 허브 ▸ 구성 ▸ 서비스 구성(`/k8s/:clusterId/services?service=`).
// 1단계: 서비스(ETCD·CONTAINERD·CILIUM·LINUX)별 관리 대상 설정과 노드에서 수집된 현재 값, 현재 값으로 V1 만들기.
// 편집·의존 변경·저장·적용은 다음 단계. '현재 값 수집' 은 노드 설정을 읽기만 하며 실시간 실행 로그를 남긴다.
import { useMemo, useState } from 'react';
import { Database, Layers, Search } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { useUrlParams } from '@/hooks/useUrlParams';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useLogPref } from '@/hooks/useLogPref';
import { runLogged, useRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  useImportServiceConfig, useInvalidateServiceConfig, useServiceConfigServices, useServiceConfigView,
} from '@/hooks/useServiceConfig';
import {
  ClusterSidebar, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageShell, RunLogPanel, SegTabs,
  SelectClusterEmptyState, useToast,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import { ServiceConfigRail, ServiceConfigSections } from '@/components/service-config';
import { ContainerdConfigCollectModal, EtcdSystemdModal, KernelParamsCollectModal } from '@/components/versions';
import { versionsApi } from '@/services/api';
import { formatApiError, formatRelativeTime } from '@/lib/utils';
import type { ServiceConfigCollectKind, ServiceConfigView } from '@/types';

const COLLECT_LABEL: Record<ServiceConfigCollectKind, string> = {
  versions: 'K8S API 로 수집',
  'etcd-systemd': 'SSH 로 수집 (systemd)',
  'containerd-config': 'SSH 로 수집',
  'kernel-params': 'SSH 로 수집',
};

type Filter = 'all' | 'flagged';

function sourceSummary(view: ServiceConfigView | undefined): string {
  if (!view || view.sources.length === 0) return '아직 수집된 값이 없다';
  const bySource = new Map<string, number>();
  let latest = '';
  for (const s of view.sources) {
    bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    if (s.collectedAt && s.collectedAt > latest) latest = s.collectedAt;
  }
  const parts = [...bySource.entries()].map(([src, n]) => (n > 1 ? `${src} ${n}` : src));
  return `${parts.join(' · ')}${latest ? ` · 마지막 수집 ${formatRelativeTime(latest)}` : ''}`;
}

export function ServiceConfigPage() {
  const toast = useToast();
  const { data: clusters = [], isLoading: clustersLoading } = useClusters();
  const hub = useK8sHub();
  const [selectedCluster, setSelectedCluster] = useState('');
  const clusterId = hub ? hub.clusterId : (selectedCluster || clusters[0]?.id || '');
  const clusterName = clusters.find((c) => c.id === clusterId)?.name ?? '';

  const servicesQ = useServiceConfigServices();
  const services = useMemo(() => servicesQ.data ?? [], [servicesQ.data]);
  const [params, setParams] = useUrlParams({ service: 'etcd', version: '' });
  const service = services.some((s) => s.key === params.service) ? params.service : (services[0]?.key ?? 'etcd');
  const versionNo = params.version ? Number(params.version) : undefined;
  const viewQ = useServiceConfigView(clusterId, service, versionNo);
  const view = viewQ.data;

  const [tab, setTab] = useState<'config' | 'summary'>('config');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [modal, setModal] = useState<ServiceConfigCollectKind | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);

  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const invalidate = useInvalidateServiceConfig();
  const importMut = useImportServiceConfig(clusterId, service);

  // K8S API 수집(etcd 정적 파드 플래그·cilium-config) — 실시간 실행 로그 + 로그 보기 토글(CLAUDE.md 실행 버튼 규칙).
  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('service-config-collect');
  const collectApi = useAbortableMutation({
    mutationFn: (_: void, signal) => versionsApi.collect(clusterId, signal),
    onSuccess: () => { void invalidate(); },
    onError: (e: unknown) => toast.error('수집 실패', formatApiError(e)),
  });
  const runApiCollect = () => {
    void runLogged(runLog, {
      title: 'K8S API 로 현재 값 수집',
      first: `${clusterName || clusterId} — kubeconfig 로 정적 파드 플래그(etcd 등)·cilium-config 수집 요청`,
      fn: () => collectApi.mutateAsync(),
      summarize: (res) => {
        const { changed, errors, components } = res.data;
        const out: RunLogEntry[] = (components ?? []).map((c): RunLogEntry => ['info', `${c.component}${c.version ? ` ${c.version}` : ''} · ${c.changed ? '변경 저장' : '변경 없음'}`]);
        errors.forEach((e) => out.push(['warn', `경고 — ${e}`]));
        out.push([errors.length ? 'warn' : 'info', `완료 — 변경 ${changed}건 · 경고 ${errors.length}건`]);
        return out;
      },
    });
  };
  const onCollect = (kind: ServiceConfigCollectKind) => {
    if (kind === 'versions') runApiCollect();
    else setModal(kind);
  };
  const closeModal = () => { setModal(null); void invalidate(); };

  const onImport = async () => {
    try {
      const r = await importMut.mutateAsync();
      setConfirmImport(false);
      setParams({ version: '' });
      toast.success('V1 을 만들었습니다', `항목 ${r.imported}/${r.total}${r.mixed.length ? ` · 노드 간 다른 값 ${r.mixed.length}개는 다수 값으로` : ''}`);
    } catch (e) {
      toast.error('V1 만들기 실패', formatApiError(e));
    }
  };

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (view?.sections ?? []).map((s) => ({
      ...s,
      items: s.items.filter((r) => (filter === 'all' || r.status !== 'same')
        && (!q || r.key.toLowerCase().includes(q) || (r.label ?? '').toLowerCase().includes(q))),
    })).filter((s) => s.items.length > 0);
  }, [view, query, filter]);

  const meta = view?.service ?? services.find((s) => s.key === service);
  const counts = view?.counts;
  const collectRunning = collectApi.isPending;

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => setSelectedCluster(id ?? '')} iconOnly />
        <div className="flex-1 min-w-0">
          <PageHeader
            icon={Layers}
            title="서비스 구성"
            titleExtra={clusterName ? <span className="text-sm text-muted-foreground">— <span className="font-medium text-foreground">{clusterName}</span></span> : undefined}
            className="mb-3"
          />
          {clustersLoading || servicesQ.isLoading ? <LoadingState /> : !clusterId ? <SelectClusterEmptyState /> : (
            <div className="flex gap-0 border border-border rounded-md bg-card min-h-[480px]">
              <ServiceConfigRail services={services} selected={service}
                onSelect={(key) => { setParams({ service: key, version: '' }); setQuery(''); }} />
              <main className="flex-1 min-w-0 p-4 space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-semibold text-foreground">{meta?.label ?? service}</h2>
                  <SegTabs mode="tabs" label="서비스 보기" value={tab} onChange={setTab}
                    options={[['config', '설정'], ['summary', '요약']] as const} />
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {view && view.versions.length > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">버전
                        <select value={view.version?.versionNo ?? ''} aria-label="설정 버전"
                          onChange={(e) => setParams({ version: e.target.value === String(view.versions[0].versionNo) ? '' : e.target.value })}
                          className="px-2 py-1 text-sm rounded-xl border border-border bg-card text-foreground">
                          {view.versions.map((v) => (
                            <option key={v.id} value={v.versionNo}>V{v.versionNo} · {v.status === 'imported' ? '가져옴' : v.status}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {(meta?.collectKinds ?? []).map((k) => (
                      <Button key={k} size="sm" variant="outline" disabled={!canOperate || (k === 'versions' && collectRunning)}
                        onClick={() => onCollect(k)} title={withHint(`현재 값 수집 — ${COLLECT_LABEL[k]} (노드 설정은 바꾸지 않는다)`)}
                        aria-label={ariaWithHint(`현재 값 ${COLLECT_LABEL[k]}`)}>
                        {k === 'versions' && collectRunning ? '수집 중…' : COLLECT_LABEL[k]}
                      </Button>
                    ))}
                  </div>
                </div>
                {meta?.description && <p className="text-xs text-muted-foreground">{meta.description}</p>}

                {runLog.lines.length > 0 && (
                  <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
                )}

                {tab === 'summary' ? (
                  <EmptyState icon={Layers} title="요약은 다음 단계에서 제공됩니다" description="서비스 상태·재시작 필요 여부·적용 이력을 한눈에 보여줄 예정이다." />
                ) : viewQ.isLoading ? <LoadingState /> : viewQ.isError ? (
                  <ErrorState error={viewQ.error} title="설정을 불러오지 못했습니다" onRetry={() => { void viewQ.refetch(); }} />
                ) : view ? (
                  <>
                    <p className="text-xs text-muted-foreground">현재 값 출처: {sourceSummary(view)}</p>
                    {!view.version && (
                      <MacCard
                        title="설정 버전이 아직 없습니다"
                        icon={Database}
                        description="현재 노드 값으로 V1 을 만들면 이후 변경·적용의 기준이 된다(DB 에 저장만, 노드는 그대로)"
                        actions={(
                          <Button size="sm" disabled={!canOperate || view.sources.length === 0} onClick={() => setConfirmImport(true)}
                            title={view.sources.length === 0 ? '먼저 현재 값을 수집하세요' : withHint('현재 값으로 V1 만들기')}
                            aria-label={ariaWithHint('현재 값으로 V1 만들기')}>
                            현재 값으로 V1 만들기
                          </Button>
                        )}
                      >
                        <p className="text-sm text-muted-foreground">
                          노드 {view.nodes.length}개에서 값을 읽었다. 노드마다 값이 다른 항목은 가장 많은 노드의 값을 V1 에 넣고, 화면에는 계속 &lsquo;노드 간 다름&rsquo; 으로 표시한다.
                        </p>
                      </MacCard>
                    )}
                    {view.version && (
                      <p className="text-xs text-muted-foreground">
                        V{view.version.versionNo} · {view.version.note ?? ''} · {view.version.createdBy ?? '—'}{view.version.createdAt ? ` · ${formatRelativeTime(view.version.createdAt)}` : ''}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="키·설명 검색" aria-label="설정 키 검색"
                          className="pl-8 pr-2.5 py-1 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary" />
                      </div>
                      <SegTabs label="표시 범위" value={filter} onChange={setFilter}
                        options={[['all', '전체'], ['flagged', '확인 필요만']] as const} />
                      {counts && (
                        <span className="text-xs text-muted-foreground">
                          항목 {counts.items} · 노드 간 다름 {counts.mixed} · 버전과 다름 {counts.differs} · 값 없음 {counts.unknown}
                        </span>
                      )}
                    </div>
                    {sections.length === 0 ? (
                      <EmptyState compact title={filter === 'flagged' ? '확인이 필요한 항목이 없습니다' : '조건에 맞는 설정이 없습니다'} />
                    ) : (
                      <ServiceConfigSections sections={sections} hasVersion={!!view.version}
                        versionNo={view.version?.versionNo ?? null} nodeCount={view.nodes.length} />
                    )}
                  </>
                ) : null}
              </main>
            </div>
          )}
        </div>
      </PageShell>

      <EtcdSystemdModal open={modal === 'etcd-systemd'} clusterId={clusterId} clusterName={clusterName} onClose={closeModal} />
      <KernelParamsCollectModal open={modal === 'kernel-params'} clusterId={clusterId} clusterName={clusterName} onClose={closeModal} />
      <ContainerdConfigCollectModal open={modal === 'containerd-config'} clusterId={clusterId} clusterName={clusterName}
        onClose={closeModal} onCollected={() => { void invalidate(); }} />
      <ConfirmDialog
        open={confirmImport}
        title={`${meta?.label ?? service} — 현재 값으로 V1 만들기`}
        description={view ? `노드 ${view.nodes.length}개에서 읽은 값으로 설정 버전 V1 을 저장합니다. 노드에는 아무것도 하지 않습니다.` : undefined}
        confirmLabel="V1 만들기"
        busy={importMut.isPending}
        onConfirm={() => { void onImport(); }}
        onCancel={() => setConfirmImport(false)}
      />
    </div>
  );
}
