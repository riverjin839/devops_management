import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BellPlus, BookMarked, Plus, SlidersHorizontal } from 'lucide-react';
import { PageShell } from '@/components/common/PageShell';
import { PageHeader } from '@/components/common/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '@/components/common/EmptyState';
import { StatusBadge } from '@/components/common/StatusBadge';
import { SegTabs } from '@/components/common/SegTabs';
import { useToast } from '@/components/common/Toast';
import { MacCard } from '@/components/ui/MacCard';
import {
  AlarmCatalogDialog, AlarmRequestDetail, ApplySettingsDialog, AlarmRequestForm, emptyDraft,
  STATUS_LABEL, STATUS_VARIANT, type AlarmRequestDraft,
} from '@/components/alarm-requests';
import { BTN, BTN_PRIMARY, INPUT } from '@/components/alarm-requests/styles';
import {
  useActOnAlarmRequest, useAlarmCatalog, useAlarmRequestMeta, useAlarmRequests,
  useCancelAlarmRequest, useSaveAlarmRequest,
} from '@/hooks/useAlarmRequests';
import { useClusters } from '@/hooks/useCluster';
import { useCanOperate } from '@/hooks/useCanOperate';
import { useAuthStore } from '@/stores/authStore';
import { cn, formatApiError, parseUTC } from '@/lib/utils';
import type { AlarmRequest, AlarmRequestActionKind, AlarmRequestStatus } from '@/types';

type StatusFilter = 'all' | AlarmRequestStatus;
const STATUS_OPTIONS: readonly (readonly [StatusFilter, string])[] = [
  ['all', '전체'],
  ...(Object.keys(STATUS_LABEL) as AlarmRequestStatus[]).map((k) => [k, STATUS_LABEL[k]] as const),
];

const ymd = (iso: string) => {
  const d = parseUTC(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const changedCount = (r: AlarmRequest) =>
  r.thresholds.filter((t) => t.newExpr && (t.newExpr.trim() !== t.baseExpr.trim() || t.newFor.trim() !== t.baseFor.trim())).length;

/**
 * 알람 등록 요청 — 서비스 담당자가 운영 알람 추가·임계치 변경을 요청하고 관리자가 검토·반영한다.
 * 좌: 요청 목록(필터) / 우: 요청서(새 요청·수정) 또는 선택한 요청 상세. 선택은 `?id=` 로 공유된다.
 */
export function AlarmRequestsPage() {
  const toast = useToast();
  const user = useAuthStore((s) => s.user);
  const perm = useCanOperate();
  const [params, setParams] = useSearchParams();
  const selectedId = Number(params.get('id')) || null;

  const meta = useAlarmRequestMeta();
  const list = useAlarmRequests();
  const catalog = useAlarmCatalog(false);
  const { data: clusters = [] } = useClusters();
  const save = useSaveAlarmRequest();
  const cancel = useCancelAlarmRequest();
  const act = useActOnAlarmRequest();

  const [draft, setDraft] = useState<AlarmRequestDraft | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [applySettingsOpen, setApplySettingsOpen] = useState(false);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [service, setService] = useState('all');
  const [mine, setMine] = useState(false);
  const [q, setQ] = useState('');

  const services = meta.data?.services ?? [];
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (list.data ?? []).filter((r) =>
      (status === 'all' || r.status === status)
      && (service === 'all' || r.service === service)
      && (!mine || r.requestedBy === user?.username)
      && (!needle || `${r.code} ${r.metricName} ${r.meaning ?? ''} ${r.requesterName ?? ''}`.toLowerCase().includes(needle)));
  }, [list.data, status, service, mine, q, user?.username]);
  const selected = (list.data ?? []).find((r) => r.id === selectedId) ?? null;

  const select = (id: number | null) => {
    setDraft(null);
    const next = new URLSearchParams(params);
    if (id) next.set('id', String(id)); else next.delete('id');
    setParams(next, { replace: true });
  };
  const fromRequest = (r: AlarmRequest, editId: number | null): AlarmRequestDraft => ({
    editId, service: r.service, metricName: r.metricName, meaning: r.meaning ?? '', catalogItemId: r.catalogItemId ?? null,
    thresholds: r.thresholds.map((t) => ({ ...t })), clusterIds: r.clusters.filter((c) => !c.hidden).map((c) => c.id), note: r.note ?? '',
  });

  const submit = () => {
    if (!draft) return;
    const { editId, ...data } = draft;
    save.mutate({ id: editId, data }, {
      onSuccess: (r) => {
        toast.success(editId ? '요청을 수정했습니다' : '요청을 제출했습니다', `${r.code} · ${r.metricName}`);
        select(r.id);
      },
      onError: (e) => toast.error('요청을 저장하지 못했습니다', formatApiError(e)),
    });
  };
  const onAct = (r: AlarmRequest, action: AlarmRequestActionKind, comment?: string) =>
    act.mutate({ id: r.id, action, comment }, {
      onSuccess: (res) => toast.success(`${res.code} ${STATUS_LABEL[res.status]}`),
      onError: (e) => toast.error('처리하지 못했습니다', formatApiError(e)),
    });
  const onCancel = (r: AlarmRequest) =>
    cancel.mutate(r.id, {
      onSuccess: () => { toast.success(`${r.code} 요청을 취소했습니다`); select(null); },
      onError: (e) => toast.error('취소하지 못했습니다', formatApiError(e)),
    });

  const requesterName = user?.displayName || user?.username || '';

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="hub" className="space-y-4">
        <PageHeader
          title="알람 등록 요청"
          icon={BellPlus}
          description="서비스 담당자가 운영 알람 추가·임계치 변경을 요청하고, 관리자가 검토한 뒤 클러스터에 PrometheusRule 로 적용합니다."
          actions={
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BTN} onClick={() => setApplySettingsOpen(true)}
                title="PrometheusRule 을 만들 네임스페이스·라벨">
                <SlidersHorizontal className="w-4 h-4" /> 적용 설정
              </button>
              <button type="button" className={BTN} onClick={() => setCatalogOpen(true)}
                title={perm.canOperate ? '알람 카탈로그 편집' : '알람 카탈로그 보기'}>
                <BookMarked className="w-4 h-4" /> 알람 카탈로그
              </button>
              <button type="button" className={BTN_PRIMARY}
                onClick={() => { setDraft(emptyDraft(services[0] ?? 'k8s')); }}>
                <Plus className="w-4 h-4" /> 새 요청
              </button>
            </div>
          }
        />

        <div className="grid xl:grid-cols-[minmax(0,1fr)_minmax(0,560px)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,680px)] gap-4 items-start">
          <MacCard title="요청 목록" description={list.data ? `${rows.length}건` : undefined} bodyPadding="p-0">
            <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-border">
              <SegTabs label="상태" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
              <select className={cn(INPUT, 'w-auto text-xs py-1')} value={service} aria-label="서비스" onChange={(e) => setService(e.target.value)}>
                <option value="all">전체 서비스</option>
                {services.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" className="accent-primary" checked={mine} onChange={(e) => setMine(e.target.checked)} /> 내 요청만
              </label>
              <input className={cn(INPUT, 'max-w-[220px] text-xs py-1')} value={q} placeholder="번호·알람 항목·의미 검색"
                aria-label="요청 검색" onChange={(e) => setQ(e.target.value)} />
            </div>
            {list.isLoading ? (
              <LoadingState label="요청 목록을 불러오는 중" />
            ) : list.isError ? (
              <ErrorState error={list.error} onRetry={() => list.refetch()} />
            ) : rows.length === 0 ? (
              <EmptyState
                compact
                title={(list.data ?? []).length ? '조건에 맞는 요청이 없습니다' : '아직 등록된 요청이 없습니다'}
                description={(list.data ?? []).length ? '필터를 바꿔 보세요.' : '새 요청으로 알람 추가나 임계치 변경을 요청하세요.'}
                action={(list.data ?? []).length ? undefined : { label: '새 요청', onClick: () => setDraft(emptyDraft(services[0] ?? 'k8s')) }}
              />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      {['번호', '상태', '서비스', '알람 항목', '임계치 변경', '적용 클러스터', '요청자 · 요청일'].map((h) => (
                        <th key={h} className="px-3 py-2 text-left font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const n = changedCount(r);
                      const on = r.id === selectedId && !draft;
                      return (
                        <tr key={r.id} onClick={() => select(r.id)} aria-selected={on}
                          className={cn('border-b border-border cursor-pointer align-top', on ? 'bg-primary/10' : 'hover:bg-secondary/60')}>
                          <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            <button type="button" className="hover:underline" onClick={(e) => { e.stopPropagation(); select(r.id); }}>{r.code}</button>
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap"><StatusBadge variant={STATUS_VARIANT[r.status]} label={STATUS_LABEL[r.status]} size="sm" /></td>
                          <td className="px-3 py-2"><span className="text-xs font-mono border border-border rounded-md px-1.5 py-0.5">{r.service}</span></td>
                          <td className="px-3 py-2 min-w-[200px]">
                            <div className="font-mono text-xs">{r.metricName}</div>
                            <div className="text-xs text-muted-foreground line-clamp-1">{r.meaning}</div>
                          </td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            {!r.catalogItemId && r.status !== 'applied' ? '신규 알람' : n ? `${n}개 심각도 변경` : <span className="text-muted-foreground">기본값 유지</span>}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {r.clusters.slice(0, 2).map((c) => (
                                <span key={c.id} className="text-xs px-1.5 py-0.5 rounded-full border border-border bg-secondary/60 whitespace-nowrap">{c.name}</span>
                              ))}
                              {r.clusters.length > 2 && <span className="text-xs px-1.5 py-0.5 rounded-full border border-border">+{r.clusters.length - 2}</span>}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap">
                            <div>{r.requesterName || r.requestedBy}</div>
                            <div className="text-muted-foreground tabular-nums">{ymd(r.createdAt)}</div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </MacCard>

          <div className="min-w-0 xl:sticky xl:top-4">
            {draft ? (
              <AlarmRequestForm
                draft={draft}
                onDraftChange={setDraft}
                services={services.length ? services : [draft.service]}
                catalog={catalog.data ?? []}
                clusters={clusters}
                requesterName={requesterName}
                saving={save.isPending}
                onSubmit={submit}
                onClose={() => setDraft(null)}
              />
            ) : selected ? (
              <AlarmRequestDetail
                key={selected.id}
                req={selected}
                username={user?.username ?? ''}
                perm={perm}
                busy={act.isPending || cancel.isPending}
                onEdit={() => setDraft(fromRequest(selected, selected.id))}
                onCopy={() => setDraft(fromRequest(selected, null))}
                onCancel={() => onCancel(selected)}
                onAct={(a, c) => onAct(selected, a, c)}
              />
            ) : (
              <MacCard>
                <EmptyState
                  icon={BellPlus}
                  title={selectedId && list.data ? '요청을 찾을 수 없습니다' : '요청을 선택하세요'}
                  description="목록에서 요청을 고르면 상세와 처리 이력이 보입니다. 새 알람이나 임계치 변경은 새 요청으로 등록합니다."
                  action={{ label: '새 요청', onClick: () => setDraft(emptyDraft(services[0] ?? 'k8s')) }}
                />
              </MacCard>
            )}
          </div>
        </div>
      </PageShell>

      <ApplySettingsDialog open={applySettingsOpen} onClose={() => setApplySettingsOpen(false)} />
      <AlarmCatalogDialog open={catalogOpen} onClose={() => setCatalogOpen(false)} services={services} />
    </div>
  );
}
