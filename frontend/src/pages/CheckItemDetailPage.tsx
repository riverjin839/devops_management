import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Clock, Loader2, Play, Save } from 'lucide-react';
import { MacCard } from '@/components/ui/MacCard';
import { StatusBadge, useToast, DoubleScrollX } from '@/components/common';
import { useClusters } from '@/hooks/useCluster';
import { useAuthStore, hasRole } from '@/stores/authStore';
import { useCanOperate } from '@/hooks/useCanOperate';
import { formatApiError, parseUTC } from '@/lib/utils';
import type { CheckMatrixItemDetailCell, DeepCheckDefinition, DeepCheckDefinitionInput } from '@/types';
import {
  useCheckMatrixItemDetail, usePutSchedule, usePutClusterCron, useRunCheckMatrixCell,
  useRunCheckMatrixItem, useCheckMatrixRunbook, useCheckMatrixRuns, useCheckMatrixRun,
  usePreviewCheckMatrixItem,
} from '@/hooks/useCheckMatrix';
import {
  useDeepCheckDefinitionsByType, useCreateDefinition, useUpdateDefinition, useDeleteDefinition,
} from '@/hooks/useDeepCheckDefinitions';
import { DeepCheckDefinitionForm } from '@/components/daily-check';
import { ExecTechBadge } from '@/components/platform-status/ExecTechBadge';
import { CheckMatrixRunbookPanel } from '@/components/platform-status/CheckMatrixRunbookPanel';
import { CheckMatrixRunList, CheckMatrixRunDetailView } from '@/components/platform-status/CheckMatrixRunLog';
import { CheckMatrixHistoryPanel } from '@/components/platform-status/CheckMatrixHistoryPanel';

const CATEGORY_LABEL: Record<string, string> = {
  k8s: 'K8s', network: '네트워크', storage: '스토리지', os: 'OS', app: '애플리케이션',
};

type Tab = 'definition' | 'test' | 'apply' | 'runbook' | 'logs' | 'history';
const TABS: { value: Tab; label: string }[] = [
  { value: 'definition', label: '정의' },
  { value: 'test', label: '테스트' },
  { value: 'apply', label: '적용' },
  { value: 'runbook', label: '실행 방식' },
  { value: 'logs', label: '로그' },
  { value: 'history', label: '히스토리' },
];

export function CheckItemDetailPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { data: detail, isLoading } = useCheckMatrixItemDetail(itemId);
  const { data: clusters = [] } = useClusters();
  const [tab, setTab] = useState<Tab>('definition');

  if (isLoading) {
    return <div className="app-min-h-screen bg-background py-3 pr-3 pl-3 text-sm text-muted-foreground">불러오는 중…</div>;
  }
  if (!detail) {
    return (
      <div className="app-min-h-screen bg-background py-3 pr-3 pl-3 space-y-3">
        <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">
          <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
        </Link>
        <p className="text-sm text-muted-foreground">항목을 찾을 수 없습니다.</p>
      </div>
    );
  }

  const { item, cells } = detail;
  const categoryLabel = item.category ? (CATEGORY_LABEL[item.category] ?? item.category) : null;

  return (
    <div className="app-min-h-screen bg-background py-3 pr-3 pl-3">
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-start gap-3">
          <Link to="/" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted flex-shrink-0">
            <ArrowLeft className="w-3.5 h-3.5" /> 대시보드
          </Link>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-semibold truncate">{item.name}</h1>
              <ExecTechBadge execTech={item.execTech} />
              {categoryLabel && (
                <span className="flex-shrink-0 px-1.5 py-0.5 rounded border border-border text-[10px] font-medium text-muted-foreground">
                  {categoryLabel}
                </span>
              )}
            </div>
            {item.description && <p className="text-xs text-muted-foreground mt-0.5">{item.description}</p>}
            <p className="text-[11px] text-muted-foreground mt-0.5">
              소스: <span className="font-mono">{item.sourceType}</span>
              {item.sourceRef && <span className="font-mono"> · {item.sourceRef}</span>}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1 border-b border-border">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-t-lg border-b-2 transition-colors ${
                tab === t.value
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'definition' && <DefinitionTab item={item} clusters={clusters} />}
        {tab === 'test' && <TestTab item={item} clusters={clusters} />}
        {tab === 'apply' && <ApplyTab item={item} cells={cells} />}
        {tab === 'runbook' && <RunbookTab itemId={item.id} clusters={clusters} />}
        {tab === 'logs' && <LogsTab itemId={item.id} />}
        {tab === 'history' && <HistoryTab itemId={item.id} unit={item.unit} itemName={item.name} clusters={clusters} />}
      </div>
    </div>
  );
}

// ── 정의 ─────────────────────────────────────────────────────────────────────
function DefinitionTab({
  item, clusters,
}: { item: import('@/types').CheckMatrixItem; clusters: import('@/types').Cluster[] }) {
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

  if (item.sourceType !== 'deep_check') {
    return (
      <MacCard title="정의">
        <p className="text-sm text-muted-foreground">
          {item.sourceType === 'core_bundle' && '핵심 점검 번들 — 별도 정의가 없습니다. 적용 탭에서 클러스터별 cron 을 켜고 끕니다.'}
          {item.sourceType === 'addon' && '애드온 — 접속 주소/인증 등 설정은 "실행 방식" 탭의 설정 편집에서 클러스터별로 관리합니다.'}
          {(item.sourceType === 'batch_job' || item.sourceType === 'playbook') && (
            <>등록된 {item.sourceType === 'batch_job' ? '배치잡' : '플레이북'} <span className="font-mono">{item.sourceRef}</span> 을(를) 이름으로 연결한 항목입니다.
              값/자격증명 편집은 <Link to={item.sourceType === 'batch_job' ? '/' : '/playbooks'} className="text-primary underline">해당 화면</Link>에서 합니다.</>
          )}
          {item.sourceType === 'manual' && '수동 입력 항목 — 자동 실행이 없습니다. "적용" 탭 대신 매트릭스 셀에서 값을 직접 기록합니다.'}
        </p>
      </MacCard>
    );
  }

  if (isLoading) return <div className="text-sm text-muted-foreground py-8 text-center">불러오는 중…</div>;

  const globalDef = defs.find((d) => !d.clusterId);
  const overrideByCluster = new Map(defs.filter((d) => d.clusterId).map((d) => [d.clusterId as string, d]));

  const submitDefinition = async (id: string, body: DeepCheckDefinitionInput) => {
    try {
      await update.mutateAsync({ id, body });
      toast.success('저장했습니다.');
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
      toast.success('클러스터 전용 정의로 분리했습니다.', `${clusterName} — 값을 바꾸려면 "편집"을 누르세요.`);
    } catch (e) {
      toast.error('분리 실패', formatApiError(e));
    }
  };

  const revertToGlobal = async (def: DeepCheckDefinition, clusterName: string) => {
    try {
      await del.mutateAsync(def.id);
      toast.success('글로벌 값으로 복귀했습니다.', clusterName);
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
              <li key={c.id} className="rounded-lg border border-border p-2.5">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm font-medium truncate">{c.name}</span>
                    {override ? (
                      <span className="flex-shrink-0 px-1.5 py-0.5 rounded border border-primary/40 bg-primary/10 text-primary text-[10px] font-medium">전용</span>
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
                          className="px-2.5 py-1 text-xs font-medium bg-secondary rounded-lg hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          편집
                        </button>
                        <button
                          onClick={() => revertToGlobal(override, c.name)}
                          disabled={!isAdmin || del.isPending}
                          title={adminHint ?? '전용 정의를 지우고 글로벌 값으로 복귀'}
                          className="px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          글로벌로 복귀
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={() => separateToCluster(c.id, c.name)}
                        disabled={!isAdmin || !globalDef || create.isPending}
                        title={adminHint ?? '이 클러스터만의 전용 정의 생성'}
                        className="px-2.5 py-1 text-xs font-medium bg-secondary rounded-lg hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
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
    </div>
  );
}

// ── 테스트 ───────────────────────────────────────────────────────────────────
function TestTab({
  item, clusters,
}: { item: import('@/types').CheckMatrixItem; clusters: import('@/types').Cluster[] }) {
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate();
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? '');
  const preview = usePreviewCheckMatrixItem();
  const [result, setResult] = useState<import('@/types').CheckMatrixItemPreviewResult | null>(null);

  const runnable = item.sourceType !== 'manual';

  const handlePreview = async () => {
    if (!clusterId) return;
    try {
      const r = await preview.mutateAsync({
        sourceType: item.sourceType, sourceRef: item.sourceRef, clusterId,
      });
      setResult(r);
    } catch (e) {
      toast.error('테스트 실행 실패', formatApiError(e));
    }
  };

  return (
    <MacCard title="저장 없이 미리 실행">
      {!runnable ? (
        <p className="text-sm text-muted-foreground">수동 입력 항목은 자동 실행이 없습니다.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            선택한 클러스터에서 지금 설정으로 1회 실행해 결과를 미리 본다 — 아무것도 저장하지 않는다.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={clusterId}
              onChange={(e) => setClusterId(e.target.value)}
              className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background"
            >
              {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button
              onClick={handlePreview}
              disabled={!canOperate || !clusterId || preview.isPending}
              title={withHint('미리 실행')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {preview.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
              미리 실행
            </button>
          </div>
          {result && (
            <div className="rounded-lg border border-border p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <StatusBadge variant={result.status} size="sm" />
                {result.durationMs != null && <span className="text-[11px] text-muted-foreground tabular-nums">{result.durationMs}ms</span>}
              </div>
              {result.message && <p className="text-sm">{result.message}</p>}
            </div>
          )}
        </div>
      )}
    </MacCard>
  );
}

// ── 적용 ─────────────────────────────────────────────────────────────────────
function ApplyTab({
  item, cells,
}: { item: import('@/types').CheckMatrixItem; cells: CheckMatrixItemDetailCell[] }) {
  const toast = useToast();
  const { canOperate, withHint } = useCanOperate();
  const putSchedule = usePutSchedule();
  const putClusterCron = usePutClusterCron();
  const runCell = useRunCheckMatrixCell();
  const runItem = useRunCheckMatrixItem();
  const [drafts, setDrafts] = useState<Record<string, { cron: string; enabled: boolean }>>(
    () => Object.fromEntries(cells.map((c) => [c.clusterId, { cron: c.cronExpr ?? '', enabled: c.scheduleEnabled }])),
  );

  const runnable = item.sourceType !== 'manual';
  const isCoreBundle = item.sourceType === 'core_bundle';

  const setDraft = (clusterId: string, patch: Partial<{ cron: string; enabled: boolean }>) => {
    setDrafts((d) => ({ ...d, [clusterId]: { ...d[clusterId], ...patch } }));
  };

  const saveCron = async (clusterId: string) => {
    const draft = drafts[clusterId];
    try {
      if (isCoreBundle) {
        await putClusterCron.mutateAsync({
          clusterId, checkCronExpr: draft.cron.trim() || null, checkCronEnabled: draft.enabled,
        });
      } else {
        await putSchedule.mutateAsync({
          itemId: item.id, clusterId, cronExpr: draft.cron.trim() || null, enabled: draft.enabled,
        });
      }
      toast.success('실행 주기를 저장했습니다.');
    } catch (e) {
      toast.error('저장 실패', formatApiError(e));
    }
  };

  const runOne = async (clusterId: string) => {
    try {
      const run = await runCell.mutateAsync({ itemId: item.id, clusterId });
      if (run.runState === 'skipped') toast.warning('실행 대상 없음', run.message ?? undefined);
      else if (run.runState === 'failed') toast.error('실행 실패', run.error ?? run.message ?? undefined);
      else toast.success('지금 실행했습니다.', run.message ?? undefined);
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    }
  };

  const runAll = async () => {
    try {
      const r = await runItem.mutateAsync(item.id);
      toast.success('전체 클러스터 실행을 큐잉했습니다.', `batchId: ${r.batchId}`);
    } catch (e) {
      toast.error('실행 실패', formatApiError(e));
    }
  };

  return (
    <MacCard
      title="클러스터별 운영 적용"
      className="p-0"
    >
      <div className="p-4 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {isCoreBundle
            ? '핵심 점검 번들의 cron 은 클러스터 단위 — 여기서 클러스터별로 켜고 끕니다.'
            : 'cron 을 비워두면 자동 실행되지 않습니다(수동/매트릭스 일괄 실행만 가능).'}
        </p>
        {runnable && (
          <button
            onClick={runAll}
            disabled={!canOperate || runItem.isPending}
            title={withHint('모든 클러스터에서 지금 실행')}
            className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {runItem.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            전체 실행
          </button>
        )}
      </div>
      <DoubleScrollX className="border-t border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-muted-foreground border-b border-border">
              <th className="px-4 py-2 font-medium">클러스터</th>
              <th className="px-3 py-2 font-medium">최근 상태</th>
              <th className="px-3 py-2 font-medium">cron</th>
              <th className="px-3 py-2 font-medium">활성화</th>
              <th className="px-3 py-2 font-medium">마지막 확인</th>
              <th className="px-4 py-2 font-medium">작업</th>
            </tr>
          </thead>
          <tbody>
            {cells.map((cell) => {
              const draft = drafts[cell.clusterId] ?? { cron: '', enabled: false };
              return (
                <tr key={cell.clusterId} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium whitespace-nowrap">{cell.clusterName}</td>
                  <td className="px-3 py-2">
                    {cell.status ? <StatusBadge variant={cell.status} size="sm" /> : <span className="text-muted-foreground text-xs">—</span>}
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="text"
                      value={draft.cron}
                      onChange={(e) => setDraft(cell.clusterId, { cron: e.target.value })}
                      placeholder="예: */15 * * * *"
                      aria-label={`${cell.clusterName} 실행 주기(cron)`}
                      className="text-xs border border-border rounded-lg px-2 py-1 bg-background w-40 font-mono"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(e) => setDraft(cell.clusterId, { enabled: e.target.checked })}
                      aria-label={`${cell.clusterName} 실행 주기 활성화`}
                    />
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">
                    {cell.checkedAt ? parseUTC(cell.checkedAt).toLocaleString('ko-KR') : '—'}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => saveCron(cell.clusterId)}
                        disabled={!canOperate || putSchedule.isPending || putClusterCron.isPending}
                        title={withHint('실행 주기 저장')}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-secondary rounded-lg hover:bg-secondary/80 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <Save className="w-3 h-3" /> 저장
                      </button>
                      {runnable && (
                        <button
                          onClick={() => runOne(cell.clusterId)}
                          disabled={!canOperate || runCell.isPending}
                          title={withHint('지금 실행')}
                          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          <Play className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </DoubleScrollX>
    </MacCard>
  );
}

// ── 실행 방식 ─────────────────────────────────────────────────────────────────
function RunbookTab({
  itemId, clusters,
}: { itemId: string; clusters: import('@/types').Cluster[] }) {
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? '');
  const { data: runbook, isLoading } = useCheckMatrixRunbook(itemId, clusterId, !!clusterId);
  const { data: recentRuns } = useCheckMatrixRuns({ itemId, clusterId, limit: 1 }, !!clusterId, true);
  const latestRunId = recentRuns?.runs[0]?.id;
  const { data: latestRun } = useCheckMatrixRun(latestRunId);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="w-3.5 h-3.5 text-muted-foreground" />
        <select
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
          className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background"
        >
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
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

// ── 로그 ─────────────────────────────────────────────────────────────────────
function LogsTab({ itemId }: { itemId: string }) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  return (
    <MacCard title="수행 로그 (전 클러스터)">
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

// ── 히스토리 ─────────────────────────────────────────────────────────────────
function HistoryTab({
  itemId, unit, itemName, clusters,
}: { itemId: string; unit?: string | null; itemName: string; clusters: import('@/types').Cluster[] }) {
  const [clusterId, setClusterId] = useState(clusters[0]?.id ?? '');
  return (
    <MacCard title="추이 · 이력">
      <div className="space-y-4">
        <select
          value={clusterId}
          onChange={(e) => setClusterId(e.target.value)}
          className="text-sm border border-border rounded-lg px-2 py-1.5 bg-background"
        >
          {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {clusterId && <CheckMatrixHistoryPanel itemId={itemId} clusterId={clusterId} unit={unit} seriesName={itemName} />}
      </div>
    </MacCard>
  );
}
