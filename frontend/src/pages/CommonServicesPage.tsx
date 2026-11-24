// 공통 서비스 — 여러 K8S 클러스터가 함께 쓰는 서비스(LDAP AD·KEYCLOAK·JENKINS·ARGOCD·NEXUS)를 등록하고
// 설정값을 가져와 보고(배포 수준 + 앱 설정), 바뀌면 감지(변경 이력·알람)하고, 수집 실행 로그를 남긴다.
// 좌 서비스 레일 → 인스턴스 탭(+ 등록) → 인스턴스: 호스팅·사용 클러스터·상태 / 접속 테스트·지금 수집(SSE 실시간 로그, 로그 보기 토글)
// / 설정 · 변경 이력 · 수집 로그 탭. URL: ?service=&instance=&tab=.
import { useEffect, useMemo, useState } from 'react';
import { Network, Pencil, Play, PlugZap, Plus, Settings2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ConfirmDialog, EmptyState, InfoHint, LoadingState, PageShell, RunLogPanel, SegTabs, StatusBadge, useToast,
} from '@/components/common';
import type { StatusVariant } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { ServiceConfigRail } from '@/components/service-config';
import { ChangesView, ConfigView, InstanceDialog, RunsView, WatchSettingsDialog } from '@/components/common-services';
import {
  useCommonServiceCatalog, useCommonServiceInstances, useCommonServiceStatus, useDeleteCommonService,
  useInvalidateCommonServices, useSaveCommonService,
} from '@/hooks/useCommonServices';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useLogPref } from '@/hooks/useLogPref';
import { streamLogged, useRunLog } from '@/hooks/useRunLog';
import { useUrlParams } from '@/hooks/useUrlParams';
import { formatApiError, formatDateTime, formatRelativeTime } from '@/lib/utils';
import { commonServicesApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import type { CommonServiceInstance, CommonServiceInstanceInput, CommonServiceRunResult } from '@/types';

type Tab = 'config' | 'changes' | 'runs';
const TABS = [['config', '설정'], ['changes', '변경 이력'], ['runs', '수집 로그']] as const;
const INST_STATUS: Record<CommonServiceInstance['status'], { label: string; variant: StatusVariant }> = {
  unknown: { label: '수집 전', variant: 'neutral' },
  ok: { label: '정상', variant: 'neutral' },
  partial: { label: '일부 실패', variant: 'warning' },
  error: { label: '수집 실패', variant: 'critical' },
};

function hostText(i: CommonServiceInstance): string {
  if (i.hostKind === 'k8s') return `K8S ${i.clusterName ?? '?'} · ${i.namespace}/${i.workloadName} (${i.workloadKind})`;
  if (i.hostKind === 'podman') return `Podman ${i.sshHost}:${i.sshPort ?? 22} · ${i.containerName}`;
  return '외부';
}

export function CommonServicesPage() {
  const toast = useToast();
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const { data: catalog = [], isLoading: catalogLoading } = useCommonServiceCatalog();
  const { data: statusMap } = useCommonServiceStatus();
  const [params, setParams] = useUrlParams({ service: '', instance: '', tab: 'config' });
  const service = params.service || catalog[0]?.key || '';
  const def = catalog.find((s) => s.key === service);
  const { data: instances = [], isLoading: instLoading } = useCommonServiceInstances(service);
  const instance = instances.find((i) => i.id === params.instance) ?? instances[0] ?? null;
  const tab = (TABS.some(([k]) => k === params.tab) ? params.tab : 'config') as Tab;
  const { canOperate, withHint, ariaWithHint } = useCanOperate(instance?.hostKind === 'k8s' ? instance.clusterId : null);

  const save = useSaveCommonService();
  const del = useDeleteCommonService();
  const invalidate = useInvalidateCommonServices();
  const [editing, setEditing] = useState<CommonServiceInstance | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const runLog = useRunLog();
  const [showLog, setShowLog] = useLogPref('common-services-collect');
  const [runningKind, setRunningKind] = useState<'collect' | 'test' | null>(null);
  const [runFor, setRunFor] = useState<string | null>(null);
  // 다른 인스턴스로 옮기면 이전 실행 로그 패널은 접는다(진행 중이면 그대로 둔다).
  useEffect(() => { if (!runningKind && instance?.id !== runFor) setRunFor(null); }, [instance?.id, runFor, runningKind]);

  const levels = useMemo(() => Object.fromEntries(Object.entries(statusMap ?? {}).map(([k, v]) => [k, { level: v.level, reasons: v.reasons }])), [statusMap]);

  const runNow = async (kind: 'collect' | 'test') => {
    if (!instance) return;
    setRunningKind(kind);
    setRunFor(instance.id);
    const label = kind === 'collect' ? '지금 수집' : '접속 테스트';
    const res = await streamLogged<CommonServiceRunResult>(runLog, {
      title: `${label} — ${instance.name}`,
      url: commonServicesApi.runStreamUrl(instance.id, kind),
      body: {},
      summarize: (r) => [
        ['info', `컴포넌트 ${r.components ?? 0} · 설정 ${r.keys ?? 0}개${kind === 'collect' ? ` · 변경 ${r.changed ?? 0}건` : ' (저장 안 함)'}`],
        ...(r.errors ?? []).map((e) => ['error', e] as ['error', string]),
      ],
    });
    setRunningKind(null);
    invalidate();
    if (res.ok) {
      const st = res.data.status;
      const msg = `${label} ${st === 'succeeded' ? '완료' : st === 'partial' ? '일부 실패' : '실패'}`;
      if (st === 'succeeded') toast.success(msg, kind === 'collect' && res.data.changed ? `변경 ${res.data.changed}건` : undefined);
      else toast.error(msg, res.data.errors?.[0]);
    } else if (!res.aborted) {
      toast.error(`${label} 실패`, formatApiError(res.error));
    }
  };

  const onSave = (body: CommonServiceInstanceInput) => {
    const id = editing && editing !== 'new' ? editing.id : undefined;
    save.mutate({ id, body }, {
      onSuccess: (inst) => {
        toast.success(id ? '저장했습니다.' : '등록했습니다.', id ? undefined : "'지금 수집'으로 현재 설정을 가져오세요.");
        setEditing(null);
        setParams({ instance: inst.id });
      },
      onError: (e) => toast.error('저장 실패', formatApiError(e)),
    });
  };

  const busy = runningKind !== null;
  const opTitle = (t: string) => withHint(t);

  return (
    <PageShell density="hub">
      <PageHeader
        icon={Network}
        title="공통 서비스"
        description="여러 클러스터가 함께 쓰는 서비스의 설정값을 가져와 보고, 바뀌면 감지합니다."
        className="mb-3"
        actions={(
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} title="주기 수집·알람 설정" aria-label="감시 설정">
            <Settings2 className="w-3.5 h-3.5 mr-1" />감시 설정
          </Button>
        )}
      />
      {catalogLoading ? <LoadingState /> : (
        <div className="flex gap-0 border border-border rounded-md bg-card min-h-[480px]">
          <ServiceConfigRail services={catalog} selected={service} levels={levels} ariaLabel="공통 서비스"
            onSelect={(key) => setParams({ service: key, instance: '', tab: 'config' })} />
          <div className="flex-1 min-w-0 p-4 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-foreground">{def?.label}</h2>
              {def && <InfoHint text={def.description} />}
              <div className="flex-1" />
              {instances.length > 0 && (
                <SegTabs
                  label="인스턴스"
                  value={instance?.id ?? ''}
                  onChange={(v) => setParams({ instance: v })}
                  options={instances.map((i) => [i.id, i.name] as const)}
                />
              )}
              <Button size="sm" onClick={() => setEditing('new')} disabled={!canOperate || !def} title={opTitle('인스턴스 등록')} aria-label={ariaWithHint('인스턴스 등록')}>
                <Plus className="w-3.5 h-3.5 mr-1" />등록
              </Button>
            </div>

            {instLoading ? <LoadingState /> : !instance ? (
              <EmptyState
                title={`등록된 ${def?.label ?? ''} 가 없습니다`}
                description="K8S 에 있으면 '등록 ▸ K8S 에서 가져오기'로, 일반 노드의 Podman 이나 외부 시스템이면 주소를 직접 입력합니다."
                action={canOperate ? { label: '등록', onClick: () => setEditing('new') } : undefined}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1 space-y-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge variant={INST_STATUS[instance.status].variant} label={INST_STATUS[instance.status].label} />
                      <span className="text-foreground">{hostText(instance)}</span>
                      {instance.endpointUrl && <span className="font-mono text-xs text-muted-foreground">{instance.endpointUrl}</span>}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                      <span>사용 클러스터</span>
                      {instance.links.length === 0 ? <span>—</span> : instance.links.map((l) => (
                        <span key={l.clusterId} className="px-2 py-0.5 rounded-xl border border-border text-foreground">{l.clusterName ?? l.clusterId}</span>
                      ))}
                      <span className="ml-2" title={instance.lastCollectedAt ? formatDateTime(instance.lastCollectedAt) : undefined}>
                        · 마지막 수집 {instance.lastCollectedAt ? formatRelativeTime(instance.lastCollectedAt) : '없음'}
                        {instance.watchEnabled ? '' : ' · 주기 수집 꺼짐'}
                      </span>
                    </div>
                    {instance.lastError && <p className="text-xs text-status-critical break-all">{instance.lastError}</p>}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => runNow('test')} disabled={!canOperate || busy}
                      title={opTitle('저장하지 않고 접속·수집만 시험')} aria-label={ariaWithHint('접속 테스트')}>
                      <PlugZap className="w-3.5 h-3.5 mr-1" />{runningKind === 'test' ? '테스트 중…' : '접속 테스트'}
                    </Button>
                    <Button size="sm" onClick={() => runNow('collect')} disabled={!canOperate || busy}
                      title={opTitle('지금 설정값을 가져와 직전 값과 비교')} aria-label={ariaWithHint('지금 수집')}>
                      <Play className="w-3.5 h-3.5 mr-1" />{runningKind === 'collect' ? '수집 중…' : '지금 수집'}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditing(instance)} disabled={!canOperate || busy}
                      title={opTitle('편집')} aria-label={ariaWithHint('편집')}>
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)} disabled={!canOperate || busy}
                      title={opTitle('삭제')} aria-label={ariaWithHint('삭제')}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>

                {runFor === instance.id && (
                  <RunLogPanel run={runLog} show={showLog} onShowChange={setShowLog} maxHeight="max-h-80" />
                )}

                <SegTabs mode="tabs" label="인스턴스 보기" value={tab} onChange={(v) => setParams({ tab: v })} options={TABS} />
                {tab === 'config' && <ConfigView instanceId={instance.id} />}
                {tab === 'changes' && <ChangesView instanceId={instance.id} />}
                {tab === 'runs' && <RunsView instanceId={instance.id} />}
              </>
            )}
          </div>
        </div>
      )}

      {def && (
        <InstanceDialog
          open={editing !== null}
          def={def}
          instance={editing && editing !== 'new' ? editing : null}
          busy={save.isPending}
          onClose={() => setEditing(null)}
          onSave={onSave}
        />
      )}
      <WatchSettingsDialog open={settingsOpen} isAdmin={isAdmin} onClose={() => setSettingsOpen(false)} />
      <ConfirmDialog
        open={confirmDelete}
        title={`${instance?.name ?? ''} 삭제`}
        description="등록 정보·저장된 접속 정보·수집 스냅샷·변경 이력·실행 로그가 함께 지워집니다. 서비스 자체는 그대로입니다."
        confirmLabel="삭제"
        danger
        busy={del.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => instance && del.mutate(instance.id, {
          onSuccess: () => { toast.success('삭제했습니다.'); setConfirmDelete(false); setParams({ instance: '' }); },
          onError: (e) => toast.error('삭제 실패', formatApiError(e)),
        })}
      />
    </PageShell>
  );
}
