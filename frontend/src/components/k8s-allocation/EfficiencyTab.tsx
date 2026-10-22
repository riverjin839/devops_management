// "효율화" 탭 — 추천 목록 · NS 추이/저효율 랭킹 · 정책 · 실행 로그. 모든 실행 버튼은 run 을 만들고
// 실시간 로그(EfficiencyRunLog)를 띄운다("로그 보기" 토글로 접기 가능).
import { useCallback, useMemo, useRef, useState } from 'react';
import { Play, RefreshCcw, Settings2, TrendingDown } from 'lucide-react';
import { ConfirmDialog, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useCanOperate } from '@/hooks/useCanOperate';
import {
  effErrMsg, useEffMutations, useEffPolicyDefaults, useEffRecommendations, useEffSchedule,
} from '@/hooks/useK8sEfficiency';
import { fmtCores, fmtGi, fmtN } from './format';
import { ApplyDialog } from './ApplyDialog';
import { EfficiencyRunLog } from './EfficiencyRunLog';
import { fmtTs, readLogPref } from './effUtils';
import type { EffRange } from './effUtils';
import { EfficiencyRunPanel } from './EfficiencyRunPanel';
import { LowEfficiencyRankingChart } from './LowEfficiencyRankingChart';
import { MetricToggle, NsTrendChart, RangeToggle } from './NsTrendChart';
import { PolicyDialog } from './PolicyDialog';
import { RecommendationTable } from './RecommendationTable';

const BTN = 'text-sm inline-flex items-center gap-1 px-3 py-1 rounded-xl border border-border bg-card hover:bg-secondary disabled:opacity-50';
const selectionKey = (ids: Iterable<string>) => [...ids].sort().join(',');

export function EfficiencyTab({ clusterId }: { clusterId: string; clusterName?: string }) {
  const toast = useToast();
  const { canOperate, withHint, ariaWithHint } = useCanOperate(clusterId);
  const [activeRun, setActiveRun] = useState<string | null>(null);
  // 마지막으로 시작한 실행 — "로그 보기" 를 꺼 둔 사용자도 토스트의 "로그 보기" 로 언제든 연다.
  const lastRunRef = useRef<string | null>(null);
  const onRun = useCallback((runId: string) => {
    lastRunRef.current = runId;
    if (readLogPref()) setActiveRun(runId);
  }, []);
  const m = useEffMutations(clusterId, onRun);
  const recsQ = useEffRecommendations(clusterId);
  const defaultsQ = useEffPolicyDefaults();
  const scheduleQ = useEffSchedule();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyOpen, setApplyOpen] = useState(false);
  // 직전 드라이런의 대상 — 같은 선택으로 다시 열면 "결과 확인 후 실제 적용" 을 안내한다.
  const [dryRunKey, setDryRunKey] = useState<string | null>(null);
  const [collectConfirm, setCollectConfirm] = useState(false);
  const [dismissConfirm, setDismissConfirm] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [range, setRange] = useState<EffRange>('7d');
  const [metric, setMetric] = useState<'cpu' | 'mem'>('cpu');
  const [ns, setNs] = useState('');

  const items = useMemo(() => recsQ.data?.items ?? [], [recsQ.data]);
  const selectedRecs = useMemo(() => items.filter((r) => selected.has(r.id)), [items, selected]);
  const toggle = useCallback((id: string) => setSelected((s) => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n;
  }), []);
  const selectAll = useCallback((ids: string[]) => setSelected(new Set(ids)), []);

  /** 실행을 만드는 동작 — 성공 토스트가 실행 로그로 안내한다. */
  const runGuard = async (fn: () => Promise<unknown>, okMsg: string, extra?: string) => {
    lastRunRef.current = null;
    try {
      await fn();
      const runId = lastRunRef.current;
      toast.show({
        variant: 'success', title: okMsg,
        description: [runId ? '실행 로그에서 진행 상황을 확인하세요.' : '', extra ?? ''].filter(Boolean).join(' ') || undefined,
        action: runId && !readLogPref() ? { label: '로그 보기', onClick: () => setActiveRun(runId) } : undefined,
      });
    }
    catch (e) { toast.error('실행 실패', effErrMsg(e)); }
  };
  /** 실행을 만들지 않는 동작(추천 무시) — 실행 로그 안내 없이 결과만 알린다. */
  const dismissMany = async (ids: string[]) => {
    try {
      for (const id of ids) await m.dismiss.mutateAsync(id);
      setSelected((s) => { const n = new Set(s); ids.forEach((id) => n.delete(id)); return n; });
      toast.show({ variant: 'success', title: ids.length > 1 ? `추천 ${ids.length}건 무시됨` : '추천 무시됨' });
    }
    catch (e) { toast.error('무시 실패', effErrMsg(e)); }
  };
  const mine = scheduleQ.data?.clusters?.[clusterId];
  const automationOn = defaultsQ.data?.automationEnabled;
  const totals = recsQ.data?.totals;
  const onRollback = (id: string) => void runGuard(() => m.rollback.mutateAsync(id), '롤백 시작');

  return (
    <div className="space-y-2">
      {/* 툴바 */}
      <MacCard
        title="자원 효율화"
        icon={TrendingDown}
        bodyPadding="px-4 py-2"
        actions={
          <div className="flex items-center gap-2" data-export-ignore>
            <button type="button" className={BTN} onClick={() => setCollectConfirm(true)} disabled={m.collect.isPending || !canOperate}
              title={withHint('지금 샘플을 한 번 수집(전수 순회 → 추천 → 자동화 평가)')} aria-label={ariaWithHint('지금 수집')}>
              <Play className="w-3.5 h-3.5" aria-hidden="true" /> 지금 수집
            </button>
            <button type="button" className={BTN} onClick={() => void runGuard(() => m.generate.mutateAsync(), '추천 재생성 시작')}
              disabled={m.generate.isPending || !canOperate}
              title={withHint('수집 없이 현재 샘플로 추천만 다시 계산')} aria-label={ariaWithHint('추천 재생성')}>
              <RefreshCcw className="w-3.5 h-3.5" aria-hidden="true" /> 추천 재생성
            </button>
            <button type="button" className={BTN} onClick={() => setPolicyOpen(true)} title="전역 기본값 · NS 정책 · 수집 스케줄">
              <Settings2 className="w-3.5 h-3.5" aria-hidden="true" /> 정책 설정
            </button>
          </div>
        }
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">
            수집 {scheduleQ.data?.enabled === false ? '중지' : (mine?.effectiveCron ?? scheduleQ.data?.defaultCron ?? '—')}
            {mine?.lastRunAt ? ` · 마지막 ${fmtTs(mine.lastRunAt)}` : ''}
            {' · '}자동 적용 <b className={automationOn ? 'text-foreground' : 'text-muted-foreground'}>{automationOn ? '켜짐' : '꺼짐'}</b>
            {' · '}사용률 소스 {defaultsQ.data?.usageSource ?? '—'}
          </span>
          {totals && (
            <span className="text-xs text-muted-foreground">
              · 절감 가능 CPU <b className="text-foreground">{fmtCores(totals.cpuM)}</b> / MEM <b className="text-foreground">{fmtGi(totals.memB)}</b>
              {' '}(적용 가능 {fmtN(totals.applicable)} · 추천만 {fmtN(totals.recommendOnly)})
            </span>
          )}
        </div>
      </MacCard>

      {/* 실행 중 로그 (실행 버튼 직후) */}
      {activeRun && (
        <EfficiencyRunLog runId={activeRun} onClose={() => setActiveRun(null)}
          onRollback={onRollback} rollbackPending={m.rollback.isPending} />
      )}

      {/* 추천 */}
      <MacCard title="request 축소 추천" bodyPadding="p-0">
        <RecommendationTable
          clusterId={clusterId}
          items={items} isLoading={recsQ.isLoading} isError={recsQ.isError} computedAt={recsQ.data?.computedAt ?? null}
          selected={selected} onToggle={toggle} onSelectAll={selectAll}
          onDismiss={(id) => void dismissMany([id])}
          onDismissSelected={() => setDismissConfirm(true)}
          onApply={() => setApplyOpen(true)}
        />
      </MacCard>

      {/* 추이 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        <MacCard
          title="네임스페이스 자원 추이"
          description="request · 실사용 · Quota"
          bodyPadding="p-3"
          actions={<><RangeToggle value={range} onChange={setRange} /><MetricToggle value={metric} onChange={setMetric} /></>}
        >
          <NsTrendChart clusterId={clusterId} range={range} metric={metric} namespace={ns} onNamespace={setNs} />
        </MacCard>
        <MacCard
          title="저효율 네임스페이스 추이"
          description="사용효율 낮은 순"
          bodyPadding="p-3"
          actions={<><RangeToggle value={range} onChange={setRange} /><MetricToggle value={metric} onChange={setMetric} /></>}
        >
          <LowEfficiencyRankingChart clusterId={clusterId} range={range} metric={metric} onPick={setNs} />
        </MacCard>
      </div>

      {/* 실행 이력 */}
      <MacCard title="실행 이력" description="수집 · 적용 · 롤백 · Quota 조정" bodyPadding="p-0">
        <EfficiencyRunPanel clusterId={clusterId} onRollback={onRollback} rollbackPending={m.rollback.isPending} />
      </MacCard>

      {/* 열 때만 마운트 — 드라이런 체크가 매번 켜진 상태로 시작한다. */}
      {applyOpen && (
        <ApplyDialog recs={selectedRecs} dryRunDone={dryRunKey === selectionKey(selected)} onCancel={() => setApplyOpen(false)}
          onConfirm={(dryRun) => {
            setApplyOpen(false);
            const ids = selectedRecs.map((r) => r.id);
            void runGuard(async () => {
              await m.apply.mutateAsync({ recommendationIds: ids, dryRun });
              // 드라이런은 선택을 유지한다 — 결과를 보고 같은 대상으로 바로 실제 적용할 수 있게.
              if (dryRun) setDryRunKey(selectionKey(ids));
              else { setSelected(new Set()); setDryRunKey(null); }
            }, dryRun ? '드라이런 시작' : '적용 시작', dryRun ? '선택은 그대로 유지됩니다.' : undefined);
          }} />
      )}
      <ConfirmDialog open={collectConfirm} title="지금 수집" confirmLabel="수집 실행"
        description="클러스터 전수 순회(노드/Pod) → ResourceQuota/워크로드 메타 → 사용률 → 샘플 저장 → 추천 생성 → 자동화 평가 순으로 Celery 워커가 실행합니다. 대형 클러스터는 수 분 걸릴 수 있습니다."
        onCancel={() => setCollectConfirm(false)}
        onConfirm={() => { setCollectConfirm(false); void runGuard(() => m.collect.mutateAsync(), '수집 시작'); }} />
      <ConfirmDialog open={dismissConfirm} title={`추천 ${selected.size}건 무시`} confirmLabel="무시"
        description="선택한 추천을 목록에서 내립니다. 클러스터는 바뀌지 않으며, 다음 추천 생성 때 조건이 맞으면 다시 나타날 수 있습니다."
        busy={m.dismiss.isPending}
        onCancel={() => setDismissConfirm(false)}
        onConfirm={() => { setDismissConfirm(false); void dismissMany([...selected]); }} />
      <PolicyDialog clusterId={clusterId} open={policyOpen} onClose={() => setPolicyOpen(false)} initialNamespace={ns || undefined} />
    </div>
  );
}
