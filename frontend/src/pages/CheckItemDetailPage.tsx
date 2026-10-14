import { useId, useState } from 'react';
import { PageHeader } from '@/components/common/PageHeader';
import { Link, useParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Play, Save } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, useToast, DoubleScrollX, LogViewer, ConfirmDialog, PageShell } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useAuthStore, hasRole } from '@/stores/authStore';
import { useCanOperate } from '@/hooks/useCanOperate';
import { formatApiError, parseUTC } from '@/lib/utils';
import { checkCron, DEFAULT_CRON_TIMEZONE } from '@/lib/cron';
import type {
  CheckMatrixItem, CheckMatrixItemDetailCell, CheckMatrixItemPreviewResult, Cluster,
  DeepCheckDefinition, DeepCheckDefinitionInput,
} from '@/types';
import {
  useCheckMatrixItemDetail, usePutSchedule, usePutClusterCron, useRunCheckMatrixCell,
  useRunCheckMatrixItem, useCheckMatrixRunbook, useCheckMatrixRuns, useCheckMatrixRun,
  usePreviewCheckMatrixItem, useCheckMatrixGrid,
} from '@/hooks/useCheckMatrix';
import {
  useDeepCheckDefinitionsByType, useCreateDefinition, useUpdateDefinition, useDeleteDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import { DeepCheckDefinitionForm } from '@/components/daily-check';
import { ExecTechBadge } from '@/components/platform-status/ExecTechBadge';
import { TargetDuplicateBadge } from '@/components/platform-status/TargetDuplicateBadge';
import { CheckMatrixRunbookPanel } from '@/components/platform-status/CheckMatrixRunbookPanel';
import { CheckMatrixRunList, CheckMatrixRunDetailView } from '@/components/platform-status/CheckMatrixRunLog';
import { CheckMatrixHistoryPanel } from '@/components/platform-status/CheckMatrixHistoryPanel';
import { CheckMatrixRunLogPanel } from '@/components/platform-status/CheckMatrixRunLogPanel';
import { CronInput } from '@/components/platform-status/CronInput';
import { useRunFeedback } from '@/components/platform-status/useRunFeedback';

const CATEGORY_LABEL: Record<string, string> = {
  k8s: 'K8s', network: '네트워크', storage: '스토리지', os: 'OS', app: '애플리케이션',
};

type Tab = 'definition' | 'test' | 'apply' | 'runbook' | 'logs' | 'history';
const TABS: { value: Tab; label: string }[] = [
  { value: 'definition', label: '정의' },
  { value: 'test', label: '테스트' },
  { value: 'apply', label: '실행 주기' },
  { value: 'runbook', label: '실행 계획' },
  { value: 'logs', label: '실행 기록' },
  { value: 'history', label: '추이·이력' },
];

/**
 * 클러스터 선택 기본값 — 클러스터 목록이 늦게 와도(첫 렌더엔 빈 배열) 화면의 select 와 실제 상태가
 * 어긋나지 않게, 고르지 않았거나 고른 클러스터가 사라졌으면 첫 클러스터를 쓴다.
 */
function useClusterPick(clusters: Cluster[]): [string, (id: string) => void] {
  const [picked, setPicked] = useState('');
  const effective = picked && clusters.some((c) => c.id === picked) ? picked : (clusters[0]?.id ?? '');
  return [effective, setPicked];
}

function ClusterSelect({ clusters, value, onChange, label = '클러스터' }: {
  clusters: Cluster[]; value: string; onChange: (id: string) => void; label?: string;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={clusters.length === 0}
        className="text-sm border border-border rounded-xl px-2 py-1.5 bg-background disabled:opacity-60"
      >
        {clusters.length === 0 && <option value="">클러스터 없음</option>}
        {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </div>
  );
}

export function CheckItemDetailPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { data: detail, isLoading } = useCheckMatrixItemDetail(itemId);
  const { data: clusters = [] } = useClusters();
  const [tab, setTab] = useState<Tab>('definition');
  const tabsId = useId();

  if (isLoading) {
    return (
      <div className="app-min-h-screen bg-background">
        <PageShell density="console" sidebar={false} className="text-sm text-muted-foreground">불러오는 중…</PageShell>
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="app-min-h-screen bg-background">
        <PageShell density="console" sidebar={false} className="space-y-3">
          <PageHeader back={{ to: '/', label: '홈' }} title="점검 항목" description="항목을 찾을 수 없습니다." />
        </PageShell>
      </div>
    );
  }

  const { item, cells } = detail;
  const categoryLabel = item.category ? (CATEGORY_LABEL[item.category] ?? item.category) : null;

  const onTabKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const idx = TABS.findIndex((t) => t.value === tab);
    const next = TABS[(idx + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.value);
    document.getElementById(`${tabsId}-tab-${next.value}`)?.focus();
  };

  return (
    <div className="app-min-h-screen bg-background">
      <PageShell density="console" sidebar={false} className="space-y-4">
        <div className="flex items-start gap-3">
          <PageHeader
            back={{ to: '/', label: '홈' }}
            title={item.name}
            titleExtra={
              <>
                <ExecTechBadge execTech={item.execTech} />
                <TargetDuplicateBadge item={item} />
                {categoryLabel && (
                  <span className="flex-shrink-0 px-1.5 py-0.5 rounded border border-border text-[11px] font-medium text-muted-foreground">
                    {categoryLabel}
                  </span>
                )}
              </>
            }
            className="flex-1 min-w-0"
            description={<>
            {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
            <p className="text-[11px] text-muted-foreground mt-0.5">
              소스: <span className="font-mono">{item.sourceType}</span>
              {item.sourceRef && <span className="font-mono"> · {item.sourceRef}</span>}
              {item.targetKey && <span className="font-mono"> · 대상: {item.targetKey}</span>}
            </p>
            {!!item.targetDuplicateCount && (
              <p className="text-[11px] text-status-warning mt-0.5">
                이 대상을 {item.targetDuplicateCount}개 다른 실행기술도 점검 중:{' '}
                {(item.targetPeers ?? []).map((p) => p.name).join(', ')}
              </p>
            )}
            </>}
          />
        </div>

        <div
          role="tablist"
          aria-label="점검 항목 상세"
          className="flex items-center gap-1 border-b border-border overflow-x-auto"
        >
          {TABS.map((t) => (
            <button
              key={t.value}
              id={`${tabsId}-tab-${t.value}`}
              role="tab"
              type="button"
              aria-selected={tab === t.value}
              aria-controls={`${tabsId}-panel`}
              tabIndex={tab === t.value ? 0 : -1}
              onClick={() => setTab(t.value)}
              onKeyDown={onTabKey}
              className={`px-3 py-1.5 text-xs font-medium whitespace-nowrap rounded-t-xl border-b-2 transition-colors ${
                tab === t.value
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${tab}`}>
          {tab === 'definition' && <DefinitionTab item={item} clusters={clusters} />}
          {tab === 'test' && <TestTab item={item} clusters={clusters} />}
          {tab === 'apply' && <ApplyTab item={item} cells={cells} />}
          {tab === 'runbook' && <RunbookTab itemId={item.id} clusters={clusters} />}
          {tab === 'logs' && <LogsTab itemId={item.id} />}
          {tab === 'history' && <HistoryTab itemId={item.id} unit={item.unit} itemName={item.name} clusters={clusters} />}
        </div>
      </PageShell>
      {/* 이 화면의 ▶ / 전체 실행 로그 — 매트릭스 화면과 같은 패널을 쓴다. */}
      <CheckMatrixRunLogPanel />
    </div>
  );
}

// ── 정의 ─────────────────────────────────────────────────────────────────────
function DefinitionTab({ item, clusters }: { item: CheckMatrixItem; clusters: Cluster[] }) {
  const toast = useToast();
  const user = useAuthStore((s) => s.user);
  const isAdmin = hasRole(user, 'admin');
  const adminHint = isAdmin ? undefined : 'admin 권한이 필요합니다';

  const { data: defs = [], isLoading } = useDeepCheckDefinitionsByType(
    item.sourceType === 'deep_check' ? (item.sourceRef ?? undefined) : undefined,
  );
  const create = useCreateDefinition();
  const update = useUpdateDefinition();
  const del = useDeleteDefinition();
  const [editingKey, setEditingKey] = useState<string | null>(null); // 'global' | clusterId
  const [revertTarget, setRevertTarget] = useState<{ def: DeepCheckDefinition; clusterName: string } | null>(null);

  if (item.sourceType !== 'deep_check') {
    return (
      <p className="text-sm text-muted-foreground">
        {item.sourceType === 'core_bundle' && '핵심 점검 번들 — 별도 정의가 없습니다. "실행 주기" 탭에서 클러스터별 cron 을 켜고 끕니다.'}
        {item.sourceType === 'addon' && '애드온 — 접속 주소/인증 등 설정은 "실행 계획" 탭의 설정 편집에서 클러스터별로 관리합니다.'}
        {(item.sourceType === 'batch_job' || item.sourceType === 'playbook') && (
          <>등록된 {item.sourceType === 'batch_job' ? '배치잡' : '플레이북'} <span className="font-mono">{item.sourceRef}</span> 을(를) 이름으로 연결한 항목입니다.
            값/자격증명 편집은 <Link to={item.sourceType === 'batch_job' ? '/batch-jobs' : '/playbooks'} className="text-primary underline">해당 화면</Link>에서 합니다.</>
        )}
        {item.sourceType === 'manual' && '수동 입력 항목 — 자동 실행이 없습니다. "실행 주기" 탭 대신 매트릭스 셀에서 값을 직접 기록합니다.'}
      </p>
    );
  }

  if (isLoading) return <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중…</div>;

  const globalDef = defs.find((d) => !d.clusterId);
  const overrideByCluster = new Map(defs.filter((d) => d.clusterId).map((d) => [d.clusterId as string, d]));

  const submitDefinition = async (id: string, body: DeepCheckDefinitionInput) => {
    try {
      await update.mutateAsync({ id, body });
      toast.success('저장됨');
      setEditingKey(null);
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const separateToCluster = async (clusterId: string, clusterName: string) => {
    if (!globalDef) return;
    try {
      await create.mutateAsync({
        clusterId,
        checkType: globalDef.checkType,
        name: `${globalDef.name} (${clusterName})`,
        description: globalDef.description ?? null,
        enabled: globalDef.enabled,
        affectsClusterStatus: globalDef.affectsClusterStatus,
        scheduleCron: globalDef.scheduleCron ?? null,
        thresholds: globalDef.thresholds ?? null,
        params: globalDef.params ?? null,
        sortOrder: globalDef.sortOrder,
      });
      toast.success('클러스터 전용 정의로 분리됨', `${clusterName} — 값을 바꾸려면 "편집"을 누르세요.`);
    } catch (e) {
      toast.error('분리 실패', formatApiError(e));
    }
  };

  const confirmRevert = async () => {
    if (!revertTarget) return;
    try {
      await del.mutateAsync(revertTarget.def.id);
      toast.success('글로벌 값으로 복귀됨', revertTarget.clusterName);
      if (editingKey === revertTarget.def.clusterId) setEditingKey(null);
      setRevertTarget(null);
    } catch (e) {
      toast.error('복귀 실패', formatApiError(e));
    }
  };

  return (
    <div className="space-y-4">
      <MacCard title="기본값 (모든 클러스터)">
        {!globalDef ? (
          <p className="text-sm text-muted-foreground italic">글로벌 정의가 없습니다 — 매트릭스 등록 마법사에서 다시 등록해 주세요.</p>
        ) : editingKey === 'global' ? (
          <DeepCheckDefinitionForm
            initial={globalDef}
            onSubmit={(body) => submitDefinition(globalDef.id, body)}
            onCancel={() => setEditingKey(null)}
            hideScheduleCron
          />
        ) : (
          <div className="flex items-start justify-between gap-3">
            <div className="text-sm space-y-1 min-w-0">
              <div className="font-medium">{globalDef.name}</div>
              {globalDef.description && <div className="text-muted-foreground">{globalDef.description}</div>}
              <div className="text-xs text-muted-foreground">
                활성: {globalDef.enabled ? '예' : '아니오'} · 클러스터 상태 반영: {globalDef.affectsClusterStatus ? '예' : '아니오'}
              </div>
            </div>
            <button
              onClick={() => setEditingKey('global')}
              disabled={!isAdmin}
              title={adminHint ?? '기본값 편집'}
              className="flex-shrink-0 px-3 py-1.5 text-xs font-medium bg-secondary rounded-xl hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              편집
            </button>
          </div>
        )}
      </MacCard>

      <MacCard title="클러스터별 오버라이드">
        <p className="text-xs text-muted-foreground mb-3">
          값을 지정하지 않은 클러스터는 위 기본값을 그대로 쓴다("글로벌 상속"). 클러스터별로 다르게 두려면
          "전용으로 분리"로 그 클러스터만의 정의를 만든다 — 기본값은 영향받지 않는다.
        </p>
        <ul className="space-y-2">
          {clusters.map((c) => {
            const override = overrideByCluster.get(c.id);
            const key = c.id;
            return (
              <li key={c.id} className="rounded-xl border border-border p-2.5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    {override ? (
                      <span className="flex-shrink-0 px-1.5 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary text-[11px] font-medium">전용</span>
                    ) : (
                      <span className="flex-shrink-0 text-[11px] text-muted-foreground">글로벌 상속</span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {override ? (
                      <>
                        <button
                          onClick={() => setEditingKey((k) => (k === key ? null : key))}
                          disabled={!isAdmin}
                          title={adminHint ?? '편집'}
                          className="px-2.5 py-1 text-xs font-medium bg-secondary rounded-xl hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          편집
                        </button>
                        <button
                          onClick={() => setRevertTarget({ def: override, clusterName: c.name })}
                          disabled={!isAdmin || del.isPending}
                          title={adminHint ?? '전용 정의를 지우고 글로벌 값으로 복귀'}
                          className="px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground rounded-xl disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          글로벌로 복귀
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => separateToCluster(c.id, c.name)}
                        disabled={!isAdmin || !globalDef || create.isPending}
                        title={adminHint ?? '이 클러스터만의 전용 정의 생성'}
                        className="px-2.5 py-1 text-xs font-medium bg-secondary rounded-xl hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        전용으로 분리
                      </button>
                    )}
                  </div>
                </div>
                {override && editingKey === key && (
                  <div className="mt-3 border-t border-border pt-3">
                    <DeepCheckDefinitionForm
                      initial={override}
                      clusterId={c.id}
                      onSubmit={(body) => submitDefinition(override.id, body)}
                      onCancel={() => setEditingKey(null)}
                      hideScheduleCron
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </MacCard>

      <ConfirmDialog
        open={!!revertTarget}
        danger
        title="글로벌 값으로 복귀할까요?"
        description={revertTarget ? `${revertTarget.clusterName} 의 전용 정의를 삭제합니다.` : undefined}
        confirmLabel="전용 정의 삭제"
        busy={del.isPending}
        onConfirm={() => { void confirmRevert(); }}
        onCancel={() => { if (!del.isPending) setRevertTarget(null); }}
      >
        이 클러스터에만 지정한 임계값·파라미터가 사라지고, 다음 실행부터 기본값(모든 클러스터)을 씁니다.
        되돌릴 수 없습니다.
      </ConfirmDialog>
    </div>
  );
}

// ── 테스트 ───────────────────────────────────────────────────────────────────
function TestTab({ item, clusters }: { item: CheckMatrixItem; clusters: Cluster[] }) {
  const toast = useToast();
  const [clusterId, setClusterId] = useClusterPick(clusters);
  const { canOperate, withHint } = useCanOperate(clusterId || null);
  const preview = usePreviewCheckMatrixItem();
  // 결과는 실행한 클러스터와 함께 보관 — 다른 클러스터를 고르면 이전 결과를 그 클러스터 결과처럼 보이지 않는다.
  const [result, setResult] = useState<{ clusterId: string; data: CheckMatrixItemPreviewResult } | null>(null);
  const shown = result && result.clusterId === clusterId ? result.data : null;

  const explanation = (() => {
    switch (item.sourceType) {
      case 'manual': return '수동 입력 항목은 자동 실행이 없어 테스트할 것이 없습니다.';
      case 'core_bundle':
        return '핵심 점검 번들은 미리 실행을 지원하지 않습니다 — "실행 주기" 탭의 실행 버튼으로 실제 점검을 실행하면 실시간 로그로 결과를 볼 수 있습니다.';
      case 'batch_job':
      case 'playbook':
        return `등록된 ${item.sourceType === 'batch_job' ? '배치잡' : '플레이북'}은 안전상 미리 실행하지 않습니다(실제 변경이 나갈 수 있음) — "실행 주기" 탭의 실행 버튼으로 실행하면 실시간 로그로 결과를 볼 수 있습니다.`;
      default: return null;
    }
  })();

  const handlePreview = async () => {
    if (!clusterId) return;
    const target = clusterId;
    try {
      const r = await preview.mutateAsync({
        sourceType: item.sourceType, sourceRef: item.sourceRef, clusterId: target, itemId: item.id,
      });
      setResult({ clusterId: target, data: r });
    } catch (e) {
      const msg = formatApiError(e, '테스트 실행 중 오류가 발생했습니다.');
      setResult({ clusterId: target, data: { status: 'critical', message: msg } });
      toast.error('테스트 실행 실패', msg);
    }
  };

  const log = shown
    ? (shown.log || (shown.details ? JSON.stringify(shown.details, null, 2) : '') || '(상세 로그 없음)')
    : '';

  return (
    <MacCard title="저장 없이 미리 실행">
      {explanation ? (
        <p className="text-sm text-muted-foreground">{explanation}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            선택한 클러스터에서 이 항목의 지금 설정(클러스터 전용 값 포함)으로 1회 실행해 결과와 상세 로그를 본다 — 아무것도 저장하지 않는다.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <ClusterSelect clusters={clusters} value={clusterId} onChange={setClusterId} label="테스트할 클러스터" />
            <button
              onClick={handlePreview}
              disabled={!canOperate || !clusterId || preview.isPending}
              title={withHint('미리 실행')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {preview.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
              {preview.isPending ? '실행 중…' : '미리 실행'}
            </button>
          </div>
          {preview.isPending ? (
            <div className="rounded-xl border border-border p-3 flex items-center gap-2 text-sm" role="status" aria-live="polite">
              <Loader2 className="w-4 h-4 animate-spin text-primary" aria-hidden="true" />
              실행 중… <span className="text-xs text-muted-foreground">끝나면 결과와 상세 로그가 표시됩니다.</span>
            </div>
          ) : shown && (
            <div className="rounded-xl border border-border p-3 space-y-2" aria-live="polite">
              <div className="flex items-center gap-2">
                {shown.skipped
                  ? <StatusBadge variant="neutral" label="실행 안 함" size="sm" />
                  : <StatusBadge variant={shown.status} size="sm" />}
                {shown.durationMs != null && <span className="text-[11px] text-muted-foreground tabular-nums">{shown.durationMs}ms</span>}
              </div>
              {shown.message && <p className="text-sm whitespace-pre-wrap break-words">{shown.message}</p>}
              <div>
                <span className="text-[11px] font-medium text-muted-foreground mb-1 block">상세 로그</span>
                <LogViewer text={log} maxHeight="max-h-96" />
              </div>
            </div>
          )}
        </div>
      )}
    </MacCard>
  );
}

// ── 실행 주기 ────────────────────────────────────────────────────────────────
function ApplyTab({ item, cells }: { item: CheckMatrixItem; cells: CheckMatrixItemDetailCell[] }) {
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate();
  const runItem = useRunCheckMatrixItem();
  const { batchQueued } = useRunFeedback();
  const timezone = useCheckMatrixGrid().data?.timezone ?? DEFAULT_CRON_TIMEZONE;

  const runnable = item.sourceType !== 'manual';
  const isCoreBundle = item.sourceType === 'core_bundle';

  const runAll = async () => {
    try {
      const r = await runItem.mutateAsync(item.id);
      batchQueued(r, `${item.name} · 전체 클러스터`);
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    }
  };

  return (
    <MacCard
      title="클러스터별 실행 주기"
      bodyPadding="p-0"
      actions={runnable ? (
        <button
          onClick={runAll}
          disabled={!canOperate || runItem.isPending || cells.length === 0}
          title={withHint('모든 클러스터에서 지금 실행')}
          className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {runItem.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Play className="w-3.5 h-3.5" aria-hidden="true" />}
          전체 실행
        </button>
      ) : undefined}
    >
      <p className="px-4 py-2.5 text-xs text-muted-foreground">
        {isCoreBundle
          ? '핵심 점검 번들의 cron 은 클러스터 단위 — 여기서 클러스터별로 켜고 끕니다.'
          : 'cron 을 비워두면 자동 실행되지 않습니다(수동/매트릭스 일괄 실행만 가능).'}
        {runnable && ' 실행 버튼은 실시간 로그 패널로 진행 상황을 보여줍니다.'}
      </p>
      <DoubleScrollX className="border-t border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground border-b border-border">
              <th className="px-4 py-2 font-medium">클러스터</th>
              <th className="px-3 py-2 font-medium">최근 상태</th>
              <th className="px-3 py-2 font-medium">실행 주기 (cron)</th>
              <th className="px-3 py-2 font-medium">활성화</th>
              <th className="px-3 py-2 font-medium">마지막 확인</th>
              <th className="px-4 py-2 font-medium">작업</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => (
              <ApplyRow
                key={cell.clusterId}
                item={item}
                cell={cell}
                timezone={timezone}
                runnable={runnable}
                isCoreBundle={isCoreBundle}
              />
            ))}
            {cells.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-6 text-center text-xs text-muted-foreground">대상 클러스터가 없습니다.</td></tr>
            )}
          </tbody>
        </table>
      </DoubleScrollX>
    </MacCard>
  );
}

function lastRunNotice(cell: CheckMatrixItemDetailCell): { label: string; message: string } | null {
  if (cell.lastRunState !== 'failed' && cell.lastRunState !== 'skipped') return null;
  if (cell.lastRunAt && cell.checkedAt && parseUTC(cell.lastRunAt).getTime() <= parseUTC(cell.checkedAt).getTime()) {
    return null;
  }
  return {
    label: cell.lastRunState === 'failed' ? '최근 실행 실패' : '최근 실행 건너뜀',
    message: cell.lastRunMessage || (cell.lastRunState === 'failed' ? '최근 실행이 실패했습니다.' : '최근 실행이 건너뛰어졌습니다.'),
  };
}

function ApplyRow({ item, cell, timezone, runnable, isCoreBundle }: {
  item: CheckMatrixItem;
  cell: CheckMatrixItemDetailCell;
  timezone: string;
  runnable: boolean;
  isCoreBundle: boolean;
}) {
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate(cell.clusterId);
  const putSchedule = usePutSchedule();
  const putClusterCron = usePutClusterCron();
  const runCell = useRunCheckMatrixCell();
  const { cellQueued } = useRunFeedback();

  // 서버 값(cell) 위에 이 행에서 고친 것만 얹는다 — 재조회·새 셀이 와도 초안이 굳거나 비지 않는다.
  const [cronEdit, setCronEdit] = useState<string | null>(null);
  const [enabledEdit, setEnabledEdit] = useState<boolean | null>(null);
  const cron = cronEdit ?? cell.cronExpr ?? '';
  const enabled = enabledEdit ?? cell.scheduleEnabled;
  const dirty = cron.trim() !== (cell.cronExpr ?? '').trim() || enabled !== cell.scheduleEnabled;
  const cronOk = checkCron(cron, timezone).ok;
  const saving = putSchedule.isPending || putClusterCron.isPending;
  const notice = lastRunNotice(cell);

  const saveCron = async () => {
    if (!cronOk) return;
    try {
      if (isCoreBundle) {
        await putClusterCron.mutateAsync({
          clusterId: cell.clusterId, checkCronExpr: cron.trim() || null, checkCronEnabled: enabled,
        });
      } else {
        await putSchedule.mutateAsync({
          itemId: item.id, clusterId: cell.clusterId, cronExpr: cron.trim() || null, enabled,
        });
      }
      setCronEdit(null);
      setEnabledEdit(null);
      toast.success('실행 주기 저장됨', cell.clusterName);
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const runOne = async () => {
    try {
      const run = await runCell.mutateAsync({ itemId: item.id, clusterId: cell.clusterId });
      cellQueued(run, `${item.name} · ${cell.clusterName}`);
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    }
  };

  const saveTitle = !cronOk ? 'cron 형식을 고쳐야 저장할 수 있습니다' : !dirty ? '바뀐 내용이 없습니다' : '실행 주기 저장';

  return (
    <tr className="border-b border-border last:border-0 align-top">
      <td className="px-4 py-2 font-medium whitespace-nowrap">{cell.clusterName}</td>
      <td className="px-3 py-2">
        <div className="flex flex-col items-start gap-1">
          {cell.status ? <StatusBadge variant={cell.status} size="sm" /> : <span className="text-muted-foreground text-xs">—</span>}
          {notice && (
            <span
              title={notice.message}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-status-warning/40 bg-status-warning/10 text-status-warning text-[11px] whitespace-nowrap"
            >
              <AlertTriangle className="w-3 h-3" aria-hidden="true" />
              {notice.label}
              <span className="sr-only">: {notice.message}</span>
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 min-w-[16rem]">
        <CronInput
          value={cron}
          onChange={setCronEdit}
          timezone={timezone}
          label={`${cell.clusterName} cron`}
          hidePresets
          disabled={!canOperate}
        />
      </td>
      <td className="px-3 py-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!canOperate}
          onChange={(e) => setEnabledEdit(e.target.checked)}
          aria-label={`${cell.clusterName} 실행 주기 활성화`}
        />
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
        {cell.checkedAt ? parseUTC(cell.checkedAt).toLocaleString('ko-KR') : '—'}
      </td>
      <td className="px-4 py-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={saveCron}
            disabled={!canOperate || saving || !dirty || !cronOk}
            title={withHint(saveTitle)}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary rounded-xl hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Save className="w-3 h-3" aria-hidden="true" />}
            저장
          </button>
          {runnable && (
            <button
              onClick={runOne}
              disabled={!canOperate || runCell.isPending}
              title={withHint(`${cell.clusterName}에서 지금 실행 (실시간 로그)`)}
              aria-label={`${cell.clusterName}에서 지금 실행`}
              className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {runCell.isPending ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Play className="w-3 h-3" aria-hidden="true" />}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ── 실행 계획 ─────────────────────────────────────────────────────────────────
function RunbookTab({ itemId, clusters }: { itemId: string; clusters: Cluster[] }) {
  const [clusterId, setClusterId] = useClusterPick(clusters);
  const { data: runbook, isLoading } = useCheckMatrixRunbook(itemId, clusterId, !!clusterId);
  const { data: recentRuns } = useCheckMatrixRuns({ itemId, clusterId, limit: 1 }, !!clusterId, true);
  const latestRunId = recentRuns?.runs[0]?.id;
  const { data: latestRun } = useCheckMatrixRun(latestRunId);

  return (
    <div className="space-y-3">
      <ClusterSelect clusters={clusters} value={clusterId} onChange={setClusterId} />
      {clusterId && (
        <CheckMatrixRunbookPanel
          runbook={runbook}
          isLoading={isLoading}
          editTarget={{ itemId, clusterId }}
          latestRun={latestRun}
        />
      )}
    </div>
  );
}

// ── 실행 기록 ────────────────────────────────────────────────────────────────
function LogsTab({ itemId }: { itemId: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  return (
    <MacCard title="실행 기록 (전 클러스터)">
      <div className="space-y-4">
        <CheckMatrixRunList
          filter={{ itemId, limit: 50 }}
          live
          showCell
          selectedId={selectedRunId}
          onSelect={(id) => setSelectedRunId((cur) => (cur === id ? null : id))}
          emptyText="이 항목의 수행 기록이 아직 없습니다."
        />
        {selectedRunId && (
          <div className="border-t border-border pt-4">
            <CheckMatrixRunDetailView runId={selectedRunId} />
          </div>
        )}
      </div>
    </MacCard>
  );
}

// ── 추이·이력 ────────────────────────────────────────────────────────────────
function HistoryTab({
  itemId, unit, itemName, clusters,
}: { itemId: string; unit?: string | null; itemName: string; clusters: Cluster[] }) {
  const [clusterId, setClusterId] = useClusterPick(clusters);
  return (
    <MacCard
      title="추이 · 이력"
      actions={<ClusterSelect clusters={clusters} value={clusterId} onChange={setClusterId} />}
    >
      {clusterId && <CheckMatrixHistoryPanel itemId={itemId} clusterId={clusterId} unit={unit} seriesName={itemName} />}
    </MacCard>
  );
}
