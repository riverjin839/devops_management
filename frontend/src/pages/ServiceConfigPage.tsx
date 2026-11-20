// 서비스 구성 — K8S 허브 ▸ 구성 ▸ 서비스 구성(`/k8s/:clusterId/services?service=&group=&version=`).
// 서비스(ETCD·CONTAINERD·CILIUM·LINUX)별 설정을 편집 → 의존 변경 즉시 표시 → 저장 전 확인 → 새 버전(저장됨·미적용).
// 버전 비교·되돌리기, 노드 그룹 재정의. 저장은 노드에 아무것도 하지 않고, 별도의 적용(LINUX·CILIUM·ETCD·CONTAINERD)이 실제로 반영한다.
// '현재 값 수집' 은 노드 설정을 읽기만 하며 실시간 실행 로그를 남긴다.
import { useEffect, useMemo, useState } from 'react';
import { Database, GitCompare, History, Layers, Pencil, Play, Plus, Search, Settings2, Trash2 } from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import { useK8sHub } from '@/lib/k8sHub';
import { useUrlParams } from '@/hooks/useUrlParams';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useLogPref } from '@/hooks/useLogPref';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { applyRunEvent, runLogged, useRunLog, type RunLogEntry } from '@/hooks/useRunLog';
import { postSse } from '@/lib/sse';
import { useAuthStore } from '@/stores/authStore';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import {
  useDeleteServiceConfigGroup, useImportServiceConfig, useInvalidateServiceConfig, useRevertServiceConfig,
  useSaveServiceConfigGroup, useSaveServiceConfigVersion, useServiceConfigEvaluate, useServiceConfigServices,
  useServiceConfigStatus, useServiceConfigStatusAll,
  useServiceConfigView, useServiceConfigApplyRun, useStopServiceConfigApply,
} from '@/hooks/useServiceConfig';
import {
  ClusterSidebar, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageShell, RunLogPanel, SegTabs,
  SelectClusterEmptyState, useToast,
} from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { MacCard } from '@/components/ui/MacCard';
import { Button } from '@/components/ui/button';
import {
  ApplyDialog, ApplyHistoryDialog, ApplyRunPanel, ApplySettingsDialog, DriftBanner, GroupDialog, SaveVersionDialog, ServiceConfigRail,
  ServiceSummary,
  ServiceConfigSections, VersionCompareDialog, type ApplyRequest, type DraftChange,
} from '@/components/service-config';
import { afterModalClose } from '@/components/service-config/afterModalClose';
import { RUN_STATUS } from '@/components/service-config/runStatus';
import { ContainerdConfigCollectModal, EtcdSystemdModal, KernelParamsCollectModal } from '@/components/versions';
import { camelizeKeys, serviceConfigApi, versionsApi } from '@/services/api';
import { formatApiError, formatRelativeTime } from '@/lib/utils';
import type { ServiceConfigApplyRun, ServiceConfigCollectKind, ServiceConfigRuleResult, ServiceConfigView } from '@/types';

const COLLECT_LABEL: Record<ServiceConfigCollectKind, string> = {
  versions: 'K8S API 로 수집',
  'etcd-systemd': 'SSH 로 수집 (systemd)',
  'containerd-config': 'SSH 로 수집',
  'kernel-params': 'SSH 로 수집',
};
const STATUS_LABEL: Record<string, string> = { imported: '가져옴', saved: '저장됨·미적용', applied: '적용됨', superseded: '대체됨' };

type Filter = 'all' | 'flagged' | 'edited';
const APPLY_SUPPORTED = new Set(['linux', 'cilium', 'etcd', 'containerd']);

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

/** 서버 422 의 {message, violations} 상세까지 한 줄로. */
function saveError(e: unknown): string {
  const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (detail && typeof detail === 'object' && 'violations' in detail) {
    const d = detail as { message?: string; violations?: { targetKey?: string; reason?: string }[] };
    return `${d.message ?? ''} ${(d.violations ?? []).map((v) => `${v.targetKey}: ${v.reason}`).join(' / ')}`.trim();
  }
  return formatApiError(e);
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
  const [params, setParams] = useUrlParams({ service: 'etcd', version: '', group: '' });
  const service = services.some((s) => s.key === params.service) ? params.service : (services[0]?.key ?? 'etcd');
  const groupId = params.group || null;
  const versionNo = params.version ? Number(params.version) : undefined;
  // 편집 중이 아니면 현재 값을 60초마다 다시 읽는다(노드 파라미터 에이전트 보고 주기). 편집 중엔 초안이 흔들리지 않게 멈춘다.
  const [liveView, setLiveView] = useState(true);
  const viewQ = useServiceConfigView(clusterId, service, versionNo, groupId, liveView);
  const view = viewQ.data;
  const statusQ = useServiceConfigStatus(clusterId, service);
  const status = statusQ.data;
  const statusAllQ = useServiceConfigStatusAll(clusterId);
  /** 드리프트 '다시 적용' — 기준 버전·그 범위·다른 노드로 적용 대화상자를 연다. */
  const [applyTarget, setApplyTarget] = useState<{ versionNo: number; groupId: string | null; nodes: string[] } | null>(null);

  const [tab, setTab] = useState<'config' | 'summary'>('config');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [modal, setModal] = useState<ServiceConfigCollectKind | null>(null);
  const [confirmImport, setConfirmImport] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [revertNo, setRevertNo] = useState<number | null>(null);
  const [groupDialog, setGroupDialog] = useState<'new' | 'edit' | null>(null);
  const [deleteGroupOpen, setDeleteGroupOpen] = useState(false);
  const [discard, setDiscard] = useState<(() => void) | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applyRunId, setApplyRunId] = useState<string | null>(null);
  const [applyStreaming, setApplyStreaming] = useState(false);
  const [applyTitle, setApplyTitle] = useState('');
  const [applyResult, setApplyResult] = useState<ServiceConfigApplyRun | null>(null);
  const isAdmin = useAuthStore((st) => st.user?.role === 'admin');

  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const invalidate = useInvalidateServiceConfig();
  const importMut = useImportServiceConfig(clusterId, service);
  const saveMut = useSaveServiceConfigVersion(clusterId, service);
  const revertMut = useRevertServiceConfig(clusterId, service);
  const groupMut = useSaveServiceConfigGroup(clusterId, service);
  const deleteGroupMut = useDeleteServiceConfigGroup(clusterId, service);
  const stopMut = useStopServiceConfigApply(clusterId, service);
  const applyRunQ = useServiceConfigApplyRun(clusterId, service, applyRunId);
  const applyRun = applyRunQ.data ?? applyResult ?? undefined;

  // ── 초안 ── 기본 그룹은 전체 값, 노드 그룹은 재정의 값만(빈 칸 = 기본 상속).
  const groupMode = !!view?.group.id;
  const initial = useMemo(() => {
    const out: Record<string, string> = {};
    for (const sec of view?.sections ?? []) {
      for (const r of sec.items) out[r.key] = (groupMode ? r.overrideValue : r.versionValue) ?? '';
    }
    return out;
  }, [view, groupMode]);
  const scopeKey = `${clusterId}|${service}|${groupId ?? ''}|${view?.version?.id ?? 'none'}|${view?.defaultVersionNo ?? ''}`;
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [draftScope, setDraftScope] = useState('');
  useEffect(() => {
    if (view && draftScope !== scopeKey) {
      setDraft(initial);
      setDraftScope(scopeKey);
    }
  }, [view, scopeKey, draftScope, initial]);
  const changes: DraftChange[] = useMemo(() => Object.keys(initial)
    .filter((k) => (draft[k] ?? '') !== (initial[k] ?? ''))
    .map((k) => ({ key: k, before: initial[k] ?? '', after: draft[k] ?? '' })), [draft, initial]);
  const dirty = changes.length > 0;
  useEffect(() => { setLiveView(!dirty); }, [dirty]);
  const signalMap = useMemo(() => Object.fromEntries((status?.keySignals ?? []).map((sg) => [sg.key, sg])), [status]);
  const changesHref = (key?: string) => `/k8s/${clusterId}/os-param-watch?tab=changes${key ? `&param=${encodeURIComponent(key)}` : ''}`;
  const reapply = (gid: string | null, nodes: string[]) => {
    const row = status?.drift.rows.find((r) => (r.groupId ?? null) === gid);
    const vno = row?.baselineVersionNo ?? status?.drift.baselineVersionNo;
    if (!vno) return;
    setApplyTarget({ versionNo: vno, groupId: gid, nodes });
    setApplyOpen(true);
  };
  const draftValues = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(draft)) if (v.trim()) out[k] = v.trim();
    return out;
  }, [draft]);
  const debounced = useDebouncedValue(draftValues, 300);
  const evalQ = useServiceConfigEvaluate(clusterId, service, groupId, debounced, dirty);
  const results: ServiceConfigRuleResult[] = useMemo(() => (dirty ? evalQ.data?.results ?? [] : []), [dirty, evalQ.data]);
  const hints = useMemo(() => {
    const out: Record<string, ServiceConfigRuleResult[]> = {};
    for (const r of results) {
      const key = r.targetService === service && r.targetKey ? r.targetKey : r.sourceKey;
      (out[key] ??= []).push(r);
    }
    return out;
  }, [results, service]);
  const unplaced = results.filter((r) => r.sourceKey === '*' && !(r.targetService === service && r.targetKey));
  const blocking = results.filter((r) => r.blocking).length;
  const recommends = results.filter((r) => r.kind === 'recommend').length;

  /** 저장하지 않은 편집이 있으면 버릴지 묻고 진행한다(서비스·그룹·버전 전환). */
  const guard = (action: () => void) => { if (dirty) setDiscard(() => action); else action(); };

  // ── K8S API 수집(etcd 정적 파드 플래그·cilium-config) — 실시간 실행 로그 + 로그 보기 토글(CLAUDE.md 실행 버튼 규칙).
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
  // ── 적용 — SSE 실시간 실행 로그(로그 보기 토글 `service-config-apply`), 진행·노드 결과는 실행 이력 행을 다시 읽는다.
  const applyLog = useRunLog();
  const [showApplyLog, setShowApplyLog] = useLogPref('service-config-apply');
  const startApply = async (req: ApplyRequest) => {
    setApplyOpen(false);
    setApplyResult(null);
    setApplyRunId(null);
    setApplyStreaming(true);
    const label = `${meta?.label ?? service} · ${view?.group.name ?? '기본'} V${req.version_no}`;
    setApplyTitle(label);
    applyLog.clear();
    const run = applyLog.begin(`적용 — ${label}`, `${clusterName || clusterId} — ${label} 적용 요청 (${req.target_mode === 'nodes' ? `고른 노드 ${req.nodes.length}개` : '범위 전체'})`);
    let failed: string | null = null;
    let final: ServiceConfigApplyRun | null = null;
    try {
      await postSse(serviceConfigApi.applyStreamUrl(clusterId, service), req, (evt) => {
        if (evt.type === 'run') setApplyRunId(String(evt.runId ?? evt.run_id ?? ''));
        else if (evt.type === 'result') { final = camelizeKeys<ServiceConfigApplyRun>(evt.result); setApplyResult(final); }
        else if (evt.type === 'error') failed = String(evt.message ?? '실패');
        else applyRunEvent(run, evt);
      });
    } catch (e) {
      failed = formatApiError(e);
    }
    if (failed) {
      run.log('error', failed);
      toast.error('적용 실패', failed);
    }
    run.end();
    setApplyStreaming(false);
    void invalidate();
    const done = final as ServiceConfigApplyRun | null;
    if (done) {
      if (done.status === 'succeeded') toast.success('적용을 마쳤습니다', `대상 ${done.nodeResults.length}개 모두 성공`);
      else toast.warning(`적용 결과: ${RUN_STATUS[done.status].label}`, '노드별 결과와 실행 로그를 확인하세요');
    }
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

  const latestNo = view?.versions[0]?.versionNo ?? 0;
  const onSave = async (note: string, accepted: Record<string, string>) => {
    try {
      const r = await saveMut.mutateAsync({
        baseVersionNo: latestNo, groupId, values: { ...draftValues, ...accepted }, note: note || undefined,
      });
      setSaveOpen(false);
      setDraftScope('');  // 새 버전 기준으로 초안을 다시 잡는다
      setParams({ version: '' });
      toast.success(`V${r.version.versionNo} 로 저장했습니다`, `변경 ${r.changes.length}건 · 노드에는 아직 반영되지 않았습니다`);
    } catch (e) {
      const status = (e as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        toast.error('다른 사람이 먼저 저장했습니다', '화면을 새로 읽었습니다. 편집 내용을 확인하고 다시 저장하세요.');
        void viewQ.refetch();
      } else {
        toast.error('저장 실패', saveError(e));
      }
    }
  };

  const onRevert = async () => {
    if (revertNo == null) return;
    try {
      const r = await revertMut.mutateAsync({ versionNo: revertNo, groupId });
      setRevertNo(null);
      setCompareOpen(false);
      setDraftScope('');
      setParams({ version: '' });
      toast.success(`V${revertNo} 값으로 V${r.version.versionNo} 을 저장했습니다`, '노드 반영은 적용으로 따로 합니다');
    } catch (e) {
      toast.error('되돌리기 실패', saveError(e));
    }
  };

  const currentGroup = view?.groups.find((g) => g.id === groupId) ?? null;
  const onSaveGroup = async (body: { name: string; nodePattern: string; description: string | null }) => {
    try {
      const g = await groupMut.mutateAsync({ id: groupDialog === 'edit' ? currentGroup?.id : undefined, body });
      setGroupDialog(null);
      if (groupDialog === 'new') afterModalClose(() => setParams({ group: g.id, version: '' }));
      toast.success('노드 그룹을 저장했습니다');
    } catch (e) {
      toast.error('그룹 저장 실패', formatApiError(e));
    }
  };
  const onDeleteGroup = async () => {
    if (!currentGroup) return;
    try {
      await deleteGroupMut.mutateAsync(currentGroup.id);
      setDeleteGroupOpen(false);
      setDraftScope('');
      afterModalClose(() => setParams({ group: '', version: '' }));
      toast.success(`${currentGroup.name} 그룹을 지웠습니다`, '그 노드들은 기본 그룹 값을 따릅니다');
    } catch (e) {
      toast.error('그룹 삭제 실패', formatApiError(e));
    }
  };

  const sections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (view?.sections ?? []).map((s) => ({
      ...s,
      items: s.items.filter((r) => (filter === 'all'
          || (filter === 'flagged' && (r.status !== 'same' || (hints[r.key]?.length ?? 0) > 0))
          || (filter === 'edited' && (draft[r.key] ?? '') !== (initial[r.key] ?? '')))
        && (!q || r.key.toLowerCase().includes(q) || (r.label ?? '').toLowerCase().includes(q))),
    })).filter((s) => s.items.length > 0);
  }, [view, query, filter, hints, draft, initial]);

  const meta = view?.service ?? services.find((s) => s.key === service);
  const counts = view?.counts;
  const isLatest = !view?.version || view.version.versionNo === latestNo;
  const hasBase = groupMode ? view?.defaultVersionNo != null : !!view?.version;
  const editable = canOperate && isLatest && hasBase;
  const lockReason = !canOperate ? withHint('편집')
    : !hasBase ? '먼저 기본 그룹의 V1 을 만드세요'
      : !isLatest ? '이전 버전을 보는 중입니다 — 최신 버전에서 편집하세요' : undefined;
  const scopeLabel = `${meta?.label ?? service} · ${view?.group.name ?? '기본'}`;
  const groupOptions = useMemo(() => {
    if (!view || !view.service.groupSupported) return null;
    return [['', `기본 (${view.defaultNodes.length})`] as const, ...view.groups.map((g) => [g.id, `${g.name} (${g.nodes.length})`] as const)];
  }, [view]);

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" className="flex gap-3">
        <ClusterSidebar clusters={clusters} selectedId={clusterId || null} onSelect={(id) => guard(() => setSelectedCluster(id ?? ''))} iconOnly />
        <div className="flex-1 min-w-0">
          <PageHeader
            icon={Layers}
            title="서비스 구성"
            titleExtra={clusterName ? <span className="text-sm text-muted-foreground">— <span className="font-medium text-foreground">{clusterName}</span></span> : undefined}
            className="mb-3"
          />
          {clustersLoading || servicesQ.isLoading ? <LoadingState /> : !clusterId ? <SelectClusterEmptyState /> : (
            <div className="flex gap-0 border border-border rounded-md bg-card min-h-[480px]">
              <ServiceConfigRail services={services} selected={service} levels={statusAllQ.data?.services}
                onSelect={(key) => guard(() => { setParams({ service: key, version: '', group: '' }); setQuery(''); })} />
              <main className="flex-1 min-w-0 p-4 pb-0 space-y-3 flex flex-col">
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="text-lg font-semibold text-foreground">{meta?.label ?? service}</h2>
                  <SegTabs mode="tabs" label="서비스 보기" value={tab} onChange={setTab}
                    options={[['config', '설정'], ['summary', '요약']] as const} />
                  <div className="ml-auto flex flex-wrap items-center gap-2">
                    {view && view.versions.length > 0 && (
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">버전
                        <select value={view.version?.versionNo ?? ''} aria-label="설정 버전"
                          onChange={(e) => { const v = e.target.value; guard(() => setParams({ version: v === String(latestNo) ? '' : v })); }}
                          className="px-2 py-1 text-sm rounded-xl border border-border bg-card text-foreground">
                          {view.versions.map((v) => (
                            <option key={v.id} value={v.versionNo}>V{v.versionNo} · {STATUS_LABEL[v.status] ?? v.status}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    {view && view.versions.length > 1 && (
                      <Button size="sm" variant="outline" onClick={() => setCompareOpen(true)} title="두 버전의 값 차이" aria-label="버전 비교">
                        <GitCompare /> 비교
                      </Button>
                    )}
                    {view?.version && (
                      <Button size="sm" variant="outline"
                        disabled={!canOperate || !APPLY_SUPPORTED.has(service) || applyStreaming || dirty}
                        onClick={() => setApplyOpen(true)}
                        title={!APPLY_SUPPORTED.has(service) ? `${meta?.label ?? service} 은(는) 적용을 지원하지 않습니다`
                          : dirty ? '저장하지 않은 편집이 있습니다 — 먼저 저장하세요' : withHint(`V${view.version.versionNo} 을(를) 노드에 적용`)}
                        aria-label={ariaWithHint(`V${view.version.versionNo} 적용`)}>
                        <Play /> 적용…
                      </Button>
                    )}
                    <Button size="sm" variant="outline" onClick={() => setHistoryOpen(true)} title="적용 이력" aria-label="적용 이력"><History /></Button>
                    <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)} title="적용 설정" aria-label="적용 설정"><Settings2 /></Button>
                    {(meta?.collectKinds ?? []).map((k) => (
                      <Button key={k} size="sm" variant="outline" disabled={!canOperate || (k === 'versions' && collectApi.isPending)}
                        onClick={() => onCollect(k)} title={withHint(`현재 값 수집 — ${COLLECT_LABEL[k]} (노드 설정은 바꾸지 않는다)`)}
                        aria-label={ariaWithHint(`현재 값 ${COLLECT_LABEL[k]}`)}>
                        {k === 'versions' && collectApi.isPending ? '수집 중…' : COLLECT_LABEL[k]}
                      </Button>
                    ))}
                  </div>
                </div>
                {meta?.description && <p className="text-xs text-muted-foreground">{meta.description}</p>}

                {runLog.lines.length > 0 && (
                  <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-56" />
                )}

                {tab === 'summary' ? (
                  statusQ.isLoading && !status ? <LoadingState /> : statusQ.isError ? (
                    <ErrorState error={statusQ.error} title="서비스 상태를 불러오지 못했습니다" onRetry={() => { void statusQ.refetch(); }} />
                  ) : status ? (
                    <ServiceSummary status={status} clusterId={clusterId}
                      hasAgentData={(view?.sources ?? []).some((src) => src.component.startsWith('node_params:'))}
                      canApply={canOperate && APPLY_SUPPORTED.has(service) && !applyStreaming && !dirty}
                      applyHint={dirty ? '저장하지 않은 편집이 있습니다 — 먼저 저장하세요' : withHint('기준 버전 다시 적용')}
                      changesHref={changesHref} onReapply={reapply} onOpenHistory={() => setHistoryOpen(true)} />
                  ) : null
                ) : viewQ.isLoading && !view ? <LoadingState /> : viewQ.isError ? (
                  <ErrorState error={viewQ.error} title="설정을 불러오지 못했습니다" onRetry={() => { void viewQ.refetch(); }} />
                ) : view ? (
                  <>
                    {(applyStreaming || applyRunId || applyResult) && (
                      <ApplyRunPanel title={applyTitle} runLog={applyLog} showLog={showApplyLog} onShowLogChange={setShowApplyLog}
                        run={applyRun} streaming={applyStreaming} canStop={canOperate} stopHint={withHint('중지')}
                        stopping={stopMut.isPending}
                        onStop={() => { if (applyRunId) stopMut.mutate(applyRunId, { onError: (e) => toast.error('중지 요청 실패', formatApiError(e)) }); }}
                        onClose={() => { setApplyRunId(null); setApplyResult(null); applyLog.clear(); }} />
                    )}

                    {groupOptions && (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-muted-foreground">노드 그룹</span>
                        <SegTabs label="노드 그룹" value={groupId ?? ''} options={groupOptions}
                          onChange={(g) => guard(() => setParams({ group: g, version: '' }))} />
                        <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => setGroupDialog('new')}
                          title={withHint('노드 그룹 추가')} aria-label={ariaWithHint('노드 그룹 추가')}>
                          <Plus /> 그룹
                        </Button>
                        {currentGroup && (
                          <>
                            <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => setGroupDialog('edit')}
                              title={withHint('그룹 편집')} aria-label={ariaWithHint(`${currentGroup.name} 그룹 편집`)}><Pencil /></Button>
                            <Button size="sm" variant="outline" disabled={!canOperate} onClick={() => setDeleteGroupOpen(true)}
                              title={withHint('그룹 삭제')} aria-label={ariaWithHint(`${currentGroup.name} 그룹 삭제`)}><Trash2 /></Button>
                            <span className="text-xs text-muted-foreground font-mono">{currentGroup.nodePattern}</span>
                          </>
                        )}
                      </div>
                    )}

                    <p className="text-xs text-muted-foreground">
                      {groupMode ? `이 그룹 노드 ${view.nodes.length}개` : `기본 그룹 노드 ${view.nodes.length}개`} · 현재 값 출처: {sourceSummary(view)}
                    </p>

                    {!groupMode && !view.version && (
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
                          노드 {view.allNodes.length}개에서 값을 읽었다. 노드마다 값이 다른 항목은 가장 많은 노드의 값을 V1 에 넣고, 화면에는 계속 &lsquo;노드 간 다름&rsquo; 으로 표시한다.
                        </p>
                      </MacCard>
                    )}

                    {status && (
                      <DriftBanner status={status} groupId={groupId}
                        canApply={canOperate && APPLY_SUPPORTED.has(service) && !applyStreaming && !dirty}
                        applyHint={dirty ? '저장하지 않은 편집이 있습니다 — 먼저 저장하세요' : withHint('기준 버전 다시 적용')}
                        onShowSummary={() => setTab('summary')} onReapply={(nodes) => reapply(groupId, nodes)} />
                    )}

                    {view.pending && view.pending.count > 0 && (
                      <MacCard
                        title={`저장됨 · 미적용 ${view.pending.count}건`}
                        description={`V${view.pending.versionNo}${view.pending.createdBy ? ` · ${view.pending.createdBy}` : ''}${view.pending.createdAt ? ` · ${formatRelativeTime(view.pending.createdAt)}` : ''}${view.pending.note ? ` · ${view.pending.note}` : ''}`}
                        actions={(
                          <>
                            <Button size="sm" variant="outline" onClick={() => setCompareOpen(true)}>변경 보기</Button>
                            <Button size="sm" disabled={!canOperate || !APPLY_SUPPORTED.has(service) || applyStreaming || dirty}
                              onClick={() => setApplyOpen(true)}
                              title={!APPLY_SUPPORTED.has(service) ? `${meta?.label ?? service} 은(는) 적용을 지원하지 않습니다` : withHint('노드에 적용')}
                              aria-label={ariaWithHint('저장된 변경 적용')}>적용…</Button>
                          </>
                        )}
                      >
                        <p className="text-sm text-muted-foreground">
                          저장된 값은 아직 노드에 반영되지 않았다. 노드 상태는 &lsquo;버전과 다름&rsquo; 으로 보인다.{!APPLY_SUPPORTED.has(service) && ` ${meta?.label ?? service} 은(는) 적용을 지원하지 않는다.`}
                        </p>
                      </MacCard>
                    )}

                    {view.version && view.version.versionNo !== latestNo && (
                      <p className="text-xs text-status-warning">V{view.version.versionNo} 을(를) 보는 중 — 편집은 최신 V{latestNo} 에서 한다.</p>
                    )}

                    <div className="flex flex-wrap items-center gap-3">
                      <div className="relative">
                        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
                        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="키·설명 검색" aria-label="설정 키 검색"
                          className="pl-8 pr-2.5 py-1 text-sm rounded-xl border border-border bg-card focus:outline-none focus:ring-1 focus:ring-primary" />
                      </div>
                      <SegTabs label="표시 범위" value={filter} onChange={setFilter}
                        options={[['all', '전체'], ['flagged', '확인 필요만'], ['edited', '편집한 것만']] as const} />
                      {counts && (
                        <span className="text-xs text-muted-foreground">
                          항목 {counts.items} · 노드 간 다름 {counts.mixed} · 버전과 다름 {counts.differs} · 값 없음 {counts.unknown}
                        </span>
                      )}
                    </div>

                    {unplaced.length > 0 && (
                      <ul className="text-xs text-muted-foreground list-disc pl-5">
                        {unplaced.map((r) => <li key={r.ruleId}>{r.reason}</li>)}
                      </ul>
                    )}

                    {sections.length === 0 ? (
                      <EmptyState compact title={filter === 'all' ? '조건에 맞는 설정이 없습니다' : '해당하는 항목이 없습니다'} />
                    ) : (
                      <ServiceConfigSections sections={sections} groupMode={groupMode}
                        versionLabel={view.version ? `V${view.version.versionNo}` : '버전 없음'} nodeCount={view.nodes.length}
                        editable={editable} lockReason={lockReason} initial={initial} draft={draft} hints={hints}
                        onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
                        signals={signalMap} signalHref={service === 'linux' ? (k) => changesHref(k) : undefined} />
                    )}

                    <div className="sticky bottom-0 -mx-4 mt-auto flex flex-wrap items-center gap-3 px-4 py-3 border-t border-border bg-card">
                      {dirty ? (
                        <>
                          <span className="text-sm font-semibold text-foreground">변경 {changes.length}건</span>
                          <span className="text-xs text-muted-foreground">
                            {evalQ.isFetching ? '의존 관계 확인 중…' : `의존 제안 ${recommends}건${blocking ? ` · 필수 조건 위반 ${blocking}건` : ''}`} · {scopeLabel}
                          </span>
                          <Button size="sm" variant="outline" className="ml-auto" onClick={() => setDraft(initial)}>변경 취소</Button>
                          <Button size="sm" disabled={!editable} onClick={() => setSaveOpen(true)}
                            title={withHint('저장 전 확인')} aria-label={ariaWithHint('저장')}>저장…</Button>
                        </>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {editable ? '값을 바꾸면 여기서 저장한다. 저장은 새 버전을 만들 뿐 노드는 그대로다.' : (lockReason ?? '')}
                        </span>
                      )}
                    </div>
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
        description={view ? `노드 ${view.allNodes.length}개에서 읽은 값으로 설정 버전 V1 을 저장합니다. 노드에는 아무것도 하지 않습니다.` : undefined}
        confirmLabel="V1 만들기"
        busy={importMut.isPending}
        onConfirm={() => { void onImport(); }}
        onCancel={() => setConfirmImport(false)}
      />
      <SaveVersionDialog
        open={saveOpen}
        scopeLabel={scopeLabel}
        nextVersionNo={latestNo + 1}
        changes={changes}
        results={results}
        evaluating={evalQ.isFetching}
        busy={saveMut.isPending}
        onClose={() => setSaveOpen(false)}
        onSave={(note, accepted) => { void onSave(note, accepted); }}
      />
      {view && (
        <VersionCompareDialog
          open={compareOpen}
          clusterId={clusterId}
          service={service}
          groupId={groupId}
          versions={view.versions}
          initialA={view.pending?.baselineVersionNo ?? view.versions[1]?.versionNo ?? view.versions[0]?.versionNo ?? null}
          initialB={view.versions[0]?.versionNo ?? null}
          canRevert={canOperate}
          revertHint={withHint('되돌리기')}
          onClose={() => setCompareOpen(false)}
          onRevert={(no) => setRevertNo(no)}
        />
      )}
      <ConfirmDialog
        open={revertNo != null}
        title={`V${revertNo} 값으로 되돌리기`}
        description={`V${revertNo} 의 값으로 새 버전 V${latestNo + 1} 을 저장합니다. 편집 중인 내용은 버려지고, 노드 반영은 적용으로 따로 합니다.`}
        confirmLabel="새 버전으로 저장"
        busy={revertMut.isPending}
        onConfirm={() => { void onRevert(); }}
        onCancel={() => setRevertNo(null)}
      />
      {view && (
        <GroupDialog
          open={groupDialog != null}
          group={groupDialog === 'edit' ? currentGroup : null}
          allNodes={view.allNodes}
          busy={groupMut.isPending}
          onClose={() => setGroupDialog(null)}
          onSave={(body) => { void onSaveGroup(body); }}
        />
      )}
      <ConfirmDialog
        open={deleteGroupOpen}
        danger
        title={`${currentGroup?.name ?? ''} 그룹 삭제`}
        description="그룹과 그 그룹의 재정의 버전을 지웁니다. 그 노드들은 기본 그룹 값을 따르게 됩니다(노드 반영은 적용으로 따로)."
        confirmLabel="삭제"
        busy={deleteGroupMut.isPending}
        onConfirm={() => { void onDeleteGroup(); }}
        onCancel={() => setDeleteGroupOpen(false)}
      />
      {view && (
        <ApplyDialog open={applyOpen} clusterId={clusterId} service={service} serviceLabel={meta?.label ?? service}
          groupId={applyTarget ? applyTarget.groupId : groupId} versionNo={applyTarget?.versionNo ?? view.version?.versionNo ?? null}
          initialNodes={applyTarget?.nodes ?? null}
          driftRows={applyTarget ? (status?.drift.rows ?? []).filter((r) => (r.groupId ?? null) === applyTarget.groupId) : null}
          showLog={showApplyLog} onShowLogChange={setShowApplyLog}
          onClose={() => { setApplyOpen(false); setApplyTarget(null); }} onStart={(req) => { setApplyTarget(null); void startApply(req); }} />
      )}
      <ApplyHistoryDialog open={historyOpen} clusterId={clusterId} service={service} serviceLabel={meta?.label ?? service}
        onClose={() => setHistoryOpen(false)} />
      <ApplySettingsDialog open={settingsOpen} isAdmin={isAdmin} onClose={() => setSettingsOpen(false)} />
      <ConfirmDialog
        open={discard != null}
        title="저장하지 않은 변경을 버릴까요?"
        description={`편집한 ${changes.length}건이 사라집니다.`}
        confirmLabel="버리고 이동"
        onConfirm={() => { const go = discard; setDiscard(null); setDraftScope(''); if (go) afterModalClose(go); }}
        onCancel={() => setDiscard(null)}
      />
    </div>
  );
}
