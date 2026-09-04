// "효율화" 탭 — 추천 목록 · NS 추이/저효율 랭킹 · 정책 · 실행 로그. 모든 실행 버튼은 run 을 만들고
// 실시간 로그(EfficiencyRunLog)를 띄운다("로그 보기" 토글로 접기 가능).
import { useCallback, useMemo, useState } from 'react';
import { Play, RefreshCcw, Settings2, Sparkles } from 'lucide-react';
import { RoleGate } from '@/components/auth/RoleGate';
import { ConfirmDialog, useToast } from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
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

export function EfficiencyTab({ clusterId }: { clusterId: string; clusterName?: string }) {
  const toast = useToast();
  const [activeRun, setActiveRun] = useState<string | null>(null);
  const onRun = useCallback((runId: string) => { if (readLogPref()) setActiveRun(runId); }, []);
  const m = useEffMutations(clusterId, onRun);
  const recsQ = useEffRecommendations(clusterId);
  const defaultsQ = useEffPolicyDefaults();
  const scheduleQ = useEffSchedule();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [applyOpen, setApplyOpen] = useState(false);
  const [collectConfirm, setCollectConfirm] = useState(false);
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

  const runGuard = async (fn: () => Promise<unknown>, okMsg: string) => {
    try { await fn(); toast.success(okMsg, '실행 로그에서 진행 상황을 확인하세요.'); }
    catch (e) { toast.error('실행 실패', effErrMsg(e)); }
  };
  const mine = scheduleQ.data?.clusters?.[clusterId];
  const automationOn = defaultsQ.data?.automationEnabled;
  const totals = recsQ.data?.totals;

  return (
    <div className="space-y-2">
      {/* 툴바 */}
      <MacCard bodyPadding="p-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Sparkles className="w-4 h-4 text-primary" />
          <span className="text-sm font-medium">자원 효율화</span>
          <span className="text-xs text-muted-foreground">
            수집 {scheduleQ.data?.enabled === false ? '중지' : (mine?.effectiveCron ?? scheduleQ.data?.defaultCron ?? '-')}
            {mine?.lastRunAt ? ` · 마지막 ${fmtTs(mine.lastRunAt)}` : ''}
            {' · '}자동 적용 <b className={automationOn ? 'text-status-warning' : 'text-muted-foreground'}>{automationOn ? 'ON' : 'OFF'}</b>
            {' · '}사용률 소스 {defaultsQ.data?.usageSource ?? '-'}
          </span>
          {totals && (
            <span className="text-xs text-muted-foreground">
              · 절감 가능 CPU <b className="text-foreground">{fmtCores(totals.cpuM)}</b> / MEM <b className="text-foreground">{fmtGi(totals.memB)}</b>
              {' '}(적용 가능 {fmtN(totals.applicable)} · 추천만 {fmtN(totals.recommendOnly)})
            </span>
          )}
          <div className="ml-auto flex items-center gap-2" data-export-ignore>
            <RoleGate allow={['admin', 'operator']}>
              <button type="button" className={BTN} onClick={() => setCollectConfirm(true)} disabled={m.collect.isPending} title="지금 샘플을 한 번 수집(전수 순회 → 추천 → 자동화 평가)">
                <Play className="w-3.5 h-3.5" /> 지금 수집
              </button>
              <button type="button" className={BTN} onClick={() => void runGuard(() => m.generate.mutateAsync(), '추천 재생성 시작')} disabled={m.generate.isPending} title="수집 없이 현재 샘플로 추천만 다시 계산">
                <RefreshCcw className="w-3.5 h-3.5" /> 추천 재생성
              </button>
            </RoleGate>
            <button type="button" className={BTN} onClick={() => setPolicyOpen(true)} title="전역 기본값 · NS 정책 · 수집 스케줄">
              <Settings2 className="w-3.5 h-3.5" /> 정책 설정
            </button>
          </div>
        </div>
      </MacCard>

      {/* 실행 중 로그 (실행 버튼 직후) */}
      {activeRun && (
        <EfficiencyRunLog runId={activeRun} onClose={() => setActiveRun(null)}
          onRollback={(id) => void runGuard(() => m.rollback.mutateAsync(id), '롤백 시작')} rollbackPending={m.rollback.isPending} />
      )}

      {/* 추천 */}
      <MacCard title="request 축소 추천" bodyPadding="p-0">
        <RecommendationTable
          items={items} isLoading={recsQ.isLoading} isError={recsQ.isError} computedAt={recsQ.data?.computedAt ?? null}
          selected={selected} onToggle={toggle} onSelectAll={selectAll}
          onDismiss={(id) => void runGuard(() => m.dismiss.mutateAsync(id), '추천 무시됨')}
          onApply={() => setApplyOpen(true)}
        />
      </MacCard>

      {/* 추이 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        <MacCard title="네임스페이스 자원 추이 (request · 실사용 · Quota)" bodyPadding="p-3">
          <div className="flex items-center gap-2 mb-2"><RangeToggle value={range} onChange={setRange} /><MetricToggle value={metric} onChange={setMetric} /></div>
          <NsTrendChart clusterId={clusterId} range={range} metric={metric} namespace={ns} onNamespace={setNs} />
        </MacCard>
        <MacCard title="저효율 네임스페이스 추이 (사용효율 낮은 순)" bodyPadding="p-3">
          <div className="flex items-center gap-2 mb-2"><RangeToggle value={range} onChange={setRange} /><MetricToggle value={metric} onChange={setMetric} /></div>
          <LowEfficiencyRankingChart clusterId={clusterId} range={range} metric={metric} onPick={setNs} />
        </MacCard>
      </div>

      {/* 실행 이력 */}
      <MacCard title="실행 이력 (수집 · 적용 · 롤백 · Quota 조정)" bodyPadding="p-0">
        <EfficiencyRunPanel clusterId={clusterId}
          onRollback={(id) => void runGuard(() => m.rollback.mutateAsync(id), '롤백 시작')} rollbackPending={m.rollback.isPending} />
      </MacCard>

      <ApplyDialog open={applyOpen} recs={selectedRecs} onCancel={() => setApplyOpen(false)}
        onConfirm={(dryRun) => {
          setApplyOpen(false);
          void runGuard(async () => {
            await m.apply.mutateAsync({ recommendationIds: selectedRecs.map((r) => r.id), dryRun });
            setSelected(new Set());
          }, dryRun ? '드라이런 시작' : '적용 시작');
        }} />
      <ConfirmDialog open={collectConfirm} title="지금 수집" confirmLabel="수집 실행"
        description="클러스터 전수 순회(노드/파드) → ResourceQuota/워크로드 메타 → 사용률 → 샘플 저장 → 추천 생성 → 자동화 평가 순으로 Celery 워커가 실행합니다. 대형 클러스터는 수 분 걸릴 수 있습니다."
        onCancel={() => setCollectConfirm(false)}
        onConfirm={() => { setCollectConfirm(false); void runGuard(() => m.collect.mutateAsync(), '수집 시작'); }} />
      <PolicyDialog clusterId={clusterId} open={policyOpen} onClose={() => setPolicyOpen(false)} initialNamespace={ns || undefined} />
    </div>
  );
}
